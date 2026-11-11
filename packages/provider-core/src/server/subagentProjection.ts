import type {
  EventId,
  MessageId,
  ModelSelection,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2Actor,
  OrchestrationV2ConversationMessage,
  OrchestrationV2CreationSource,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderRef,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { isOrchestrationV2WorkActive, latestProviderTurnForAttempt } from "@t3tools/contracts";

function trimmed(value: string | null | undefined): string | undefined {
  const result = value?.trim();
  return result && result.length > 0 ? result : undefined;
}

export function subagentThreadTitle(input: {
  readonly parentTitle: string;
  readonly title?: string | null;
  readonly prompt: string;
  readonly ordinal: number;
}): string {
  const detail = trimmed(input.title) ?? trimmed(input.prompt);
  if (detail === undefined) {
    return `${input.parentTitle} subagent ${input.ordinal}`;
  }
  if (detail.length <= 72) return detail;
  let end = 69;
  const previous = detail.charCodeAt(end - 1);
  const next = detail.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  return `${detail.slice(0, end)}...`;
}

export function makeSubagentChildThread(input: {
  readonly parentThread: OrchestrationV2AppThread;
  readonly childThreadId: ThreadId;
  readonly parentNodeId: NodeId;
  readonly activeProviderThreadId: ProviderThreadId | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
  readonly title: string;
  readonly now: DateTime.Utc;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}): OrchestrationV2AppThread {
  return {
    ...input.parentThread,
    createdBy: input.createdBy,
    creationSource: input.creationSource,
    id: input.childThreadId,
    title: input.title,
    titleRegeneration: null,
    linkedPullRequest: null,
    pullRequests: [],
    historyOrigin: undefined,
    providerInstanceId: input.providerInstanceId,
    modelSelection: input.modelSelection,
    activeProviderThreadId: input.activeProviderThreadId,
    lineage: {
      parentThreadId: input.parentThread.id,
      relationshipToParent: "subagent",
      rootThreadId: input.parentThread.lineage.rootThreadId,
    },
    forkedFrom: {
      type: "node",
      nodeId: input.parentNodeId,
    },
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    autoSettleDisabledAt: null,
    // A guest link belongs to the thread it was made for.
    guestShare: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

export function makeSubagentConversationArtifacts(input: {
  readonly messageId: MessageId;
  readonly senderThreadId?: ThreadId;
  readonly turnItemId: TurnItemId;
  readonly threadId: ThreadId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId | null;
  readonly providerTurnId: ProviderTurnId | null;
  readonly nativeItemRef: OrchestrationV2ProviderRef | null;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly workflowScript?: boolean;
  readonly ordinal: number;
  readonly now: DateTime.Utc;
}): {
  readonly message: OrchestrationV2ConversationMessage;
  readonly turnItem: OrchestrationV2TurnItem;
} {
  const message: OrchestrationV2ConversationMessage = {
    createdBy: "agent",
    creationSource: "provider",
    id: input.messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: input.rootNodeId,
    role: input.role,
    ...(input.role === "user" && input.senderThreadId !== undefined
      ? { senderThreadId: input.senderThreadId }
      : {}),
    ...(input.role === "user" && input.workflowScript !== undefined
      ? { workflowScript: input.workflowScript }
      : {}),
    text: input.text,
    attachments: [],
    streaming: false,
    createdAt: input.now,
    updatedAt: input.now,
  };
  const base = {
    id: input.turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: input.rootNodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: input.nativeItemRef,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed" as const,
    title: null,
    startedAt: input.now,
    completedAt: input.now,
    updatedAt: input.now,
    messageId: input.messageId,
    text: input.text,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.role === "user"
      ? {
          ...base,
          createdBy: "agent",
          creationSource: "provider",
          type: "user_message",
          ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
          ...(input.workflowScript === undefined ? {} : { workflowScript: input.workflowScript }),
          inputIntent: "turn_start",
          attachments: [],
        }
      : {
          ...base,
          type: "assistant_message",
          streaming: false,
        };
  return { message, turnItem };
}

/** A delegated result, led by a note when the provider reported running another model than requested. */
export function withExecutedModelNote(
  result: string,
  requestedModel: string,
  executedModel: string | null | undefined,
): string {
  return executedModel == null || executedModel === requestedModel
    ? result
    : `Requested model ${requestedModel}; the provider reported running ${executedModel}.\n\n${result}`;
}

export type DelegatedTaskRunAssociation =
  | "run_delegated_task_id"
  | "spawn_transfer"
  | "unavailable";

/**
 * An original task has no run binding before its first follow-up, so its spawn transfer is the
 * only reliable anchor. Its restart continuations inherit no task binding in that case, so follow
 * only explicit persisted continuation edges from that run. Follow-up tasks must use their own
 * delegatedTaskId; the shared spawn transfer belongs to the original task.
 */
export function resolveDelegatedTaskRunChain(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "contextTransfers">,
  task: Pick<OrchestrationV2Subagent, "id" | "threadId" | "childThreadId">,
): {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly run: OrchestrationV2Run | undefined;
  readonly association: DelegatedTaskRunAssociation;
} {
  const taskRuns = projection.runs
    .filter((run) => run.delegatedTaskId === task.id)
    .toSorted((left, right) => left.ordinal - right.ordinal);
  if (taskRuns.length > 0) {
    return {
      runs: taskRuns,
      run: taskRuns.at(-1),
      association: "run_delegated_task_id",
    };
  }
  const original =
    projection.thread.forkedFrom?.type === "node" &&
    projection.thread.forkedFrom.nodeId === task.id;
  if (!original || task.childThreadId === null) {
    return { runs: [], run: undefined, association: "unavailable" };
  }
  const targetRunIds = new Set(
    projection.contextTransfers.flatMap((transfer) =>
      transfer.type === "subagent_spawn" &&
      transfer.sourceThreadId === task.threadId &&
      transfer.targetThreadId === task.childThreadId &&
      transfer.targetRunId !== null &&
      projection.runs.some((run) => run.id === transfer.targetRunId)
        ? [transfer.targetRunId]
        : [],
    ),
  );
  if (targetRunIds.size !== 1) {
    return { runs: [], run: undefined, association: "unavailable" };
  }
  const runId = targetRunIds.values().next().value;
  const first = projection.runs.find((run) => run.id === runId);
  if (
    first === undefined ||
    (first.delegatedTaskId !== undefined && first.delegatedTaskId !== task.id)
  ) {
    return { runs: [], run: undefined, association: "unavailable" };
  }
  const runs = [first];
  const visited = new Set([first.id]);
  let current = first;
  for (let hops = 0; hops < projection.runs.length; hops++) {
    const continuations = projection.runs.filter(
      (candidate) =>
        !visited.has(candidate.id) &&
        (candidate.delegatedTaskId === undefined || candidate.delegatedTaskId === task.id) &&
        (candidate.restartContinuationOfRunId === current.id ||
          candidate.usageLimitContinuationOfRunId === current.id),
    );
    if (continuations.length !== 1) break;
    current = continuations[0]!;
    runs.push(current);
    visited.add(current.id);
  }
  return {
    runs,
    run: runs.at(-1),
    association: "spawn_transfer",
  };
}

export function subagentOriginalResultForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems">,
  run: OrchestrationV2Run,
  anchor?: {
    readonly messageId?: MessageId | null | undefined;
    readonly turnItemId?: TurnItemId | null | undefined;
  },
): {
  readonly text: string;
  readonly messageId: MessageId | null;
  readonly turnItemId: TurnItemId | null;
  readonly updatedAt: DateTime.Utc;
} | null {
  const anchoredTurnItemId = anchor?.turnItemId ?? null;
  const anchoredMessageId = anchor?.messageId ?? null;
  if (anchoredTurnItemId !== null) {
    const item = projection.turnItems.find(
      (
        candidate,
      ): candidate is Extract<
        OrchestrationV2TurnItem,
        { readonly type: "assistant_message" | "error" }
      > =>
        candidate.id === anchoredTurnItemId &&
        candidate.runId === run.id &&
        (candidate.type === "assistant_message" || candidate.type === "error"),
    );
    if (item === undefined) return null;
    if (item.type === "error") {
      return {
        text: item.failure.message,
        messageId: null,
        turnItemId: item.id,
        updatedAt: item.updatedAt,
      };
    }
    const message: OrchestrationV2ConversationMessage | undefined =
      item.messageId === null
        ? undefined
        : projection.messages.find(
            (candidate) =>
              candidate.id === item.messageId &&
              candidate.runId === run.id &&
              candidate.role === "assistant",
          );
    if (anchoredMessageId !== null && message?.id !== anchoredMessageId) return null;
    const text = message?.text.trim() ? message.text : item.text;
    return {
      text,
      messageId: message?.id ?? item.messageId ?? null,
      turnItemId: item.id,
      updatedAt: message?.updatedAt ?? item.updatedAt,
    };
  }
  if (anchoredMessageId !== null) {
    const message = projection.messages.find(
      (candidate) =>
        candidate.id === anchoredMessageId &&
        candidate.runId === run.id &&
        candidate.role === "assistant",
    );
    if (message === undefined) return null;
    const turnItem = projection.turnItems.find(
      (candidate) =>
        candidate.type === "assistant_message" &&
        candidate.messageId === message.id &&
        candidate.runId === run.id,
    );
    return {
      text: message.text,
      messageId: message.id,
      turnItemId: turnItem?.id ?? null,
      updatedAt: message.updatedAt,
    };
  }
  const turnItem =
    projection.turnItems
      .filter(
        (
          candidate,
        ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }> =>
          candidate.runId === run.id &&
          candidate.type === "assistant_message" &&
          candidate.text.trim().length > 0,
      )
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  const messages = projection.messages.filter(
    (candidate) =>
      candidate.runId === run.id &&
      candidate.role === "assistant" &&
      candidate.text.trim().length > 0,
  );
  // Prefer turn item order; providers can finalize messages with identical timestamps.
  const message =
    messages.find((candidate) => candidate.id === turnItem?.messageId) ??
    messages.toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
        DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
    )[0] ??
    null;
  const failure =
    run.status === "failed"
      ? projection.turnItems
          .filter((item) => item.runId === run.id && item.type === "error")
          .toSorted((left, right) => right.ordinal - left.ordinal)[0]
      : undefined;
  const text =
    (failure?.type === "error" ? failure.failure.message : undefined) ??
    message?.text ??
    turnItem?.text;
  return text === undefined
    ? null
    : {
        text,
        messageId: failure === undefined ? (message?.id ?? turnItem?.messageId ?? null) : null,
        turnItemId: failure?.id ?? turnItem?.id ?? null,
        updatedAt:
          failure?.updatedAt ??
          message?.updatedAt ??
          turnItem?.updatedAt ??
          run.completedAt ??
          run.requestedAt,
      };
}

export function subagentResultForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems" | "providerTurns">,
  run: OrchestrationV2Run,
): {
  readonly text: string;
  readonly messageId: OrchestrationV2ConversationMessage["id"] | null;
  readonly turnItemId: OrchestrationV2TurnItem["id"] | null;
} {
  const original = subagentOriginalResultForRun(projection, run);
  const text =
    original?.text ??
    (run.status === "completed"
      ? "Child task completed without an assistant result."
      : `Child task ended with status ${run.status}.`);
  const executedModel = latestProviderTurnForAttempt(
    projection.providerTurns,
    run.activeAttemptId,
  )?.model;
  return {
    text:
      executedModel === undefined
        ? text
        : withExecutedModelNote(text, run.modelSelection.model, executedModel),
    messageId: original?.messageId ?? null,
    turnItemId: original?.turnItemId ?? null,
  };
}

export function scopeDelegatedTask<
  T extends Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "subagents">,
>(projection: T, taskId: NodeId): T {
  if (projection.runs.every((run) => run.delegatedTaskId === undefined)) return projection;
  const original =
    projection.thread.forkedFrom?.type === "node" && projection.thread.forkedFrom.nodeId === taskId;
  const runs = projection.runs.filter(
    (run) => run.delegatedTaskId === taskId || (original && run.delegatedTaskId === undefined),
  );
  const runIds = new Set(runs.map((run) => run.id));
  return {
    ...projection,
    runs,
    subagents: projection.subagents.filter((task) => task.runId !== null && runIds.has(task.runId)),
  };
}

export function delegatedTaskProgress(projection: {
  readonly runs: OrchestrationV2ThreadProjection["runs"];
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "runId" | "notification">
  >;
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["subagents"][number], "status" | "completionDelivery">
  >;
  readonly providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["providerThreads"][number], "pendingBackgroundTasks">
  >;
}) {
  const terminal = (status: string) =>
    ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
  const monitorRuns = new Set(
    projection.messages
      .filter((message) => message.notification?.source.kind === "monitor")
      .map((message) => message.runId),
  );
  const workRuns = projection.runs.filter(
    (run) => !monitorRuns.has(run.id) && run.status !== "rolled_back",
  );
  const active = workRuns.some(
    (run) => !terminal(run.status) && !(run.status === "queued" && run.queueHeld === true),
  );
  const children =
    projection.subagents.some(
      (task) =>
        isOrchestrationV2WorkActive(task.status) ||
        // Publishing a child's result precedes scheduling its parent's wake.
        // The parent still owes that follow-up even between those transactions.
        (task.status !== "idle" &&
          (task.completionDelivery?.state === "pending" ||
            task.completionDelivery?.state === "claimed")),
    ) ||
    projection.providerThreads.some((thread) =>
      backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []),
    );
  const resultRun = workRuns
    .filter((run) => terminal(run.status) && (run.startedAt !== null || run.ordinal === 1))
    .toSorted((a, b) => (runRanAfter(a, b) ? -1 : runRanAfter(b, a) ? 1 : 0))[0];
  return {
    state:
      active || resultRun === undefined
        ? ("working" as const)
        : children
          ? ("waiting_for_children" as const)
          : ("result_available" as const),
    resultRun,
  };
}

function writtenIds(
  emitted: ReadonlyArray<OrchestrationV2DomainEvent>,
  type: "subagent.updated" | "node.updated" | "turn-item.updated" | "provider-turn.updated",
): ReadonlySet<string> {
  return new Set(emitted.flatMap((event) => (event.type === type ? [event.payload.id] : [])));
}

export const endOrphanedNativeSubagent = Effect.fn("subagentProjection.endOrphanedNativeSubagent")(
  function* <E>(input: {
    readonly projection: Pick<OrchestrationV2ThreadProjection, "nodes" | "subagents" | "turnItems">;
    readonly subagentId: NodeId;
    readonly status: "completed" | "failed" | "interrupted" | "cancelled";
    readonly completedAt?: DateTime.Utc;
    readonly result?: string | null;
    readonly now: DateTime.Utc;
    readonly emitted: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly allocateEventId: () => Effect.Effect<EventId, E>;
  }) {
    const { now, status, subagentId, completedAt = now } = input;
    const subagent = input.projection.subagents.find((entry) => entry.id === subagentId);
    if (subagent?.origin !== "provider_native") return [];
    const node = input.projection.nodes.find((entry) => entry.id === subagentId);
    const item = input.projection.turnItems.find(
      (entry) => entry.type === "subagent" && entry.subagentId === subagentId,
    );
    const scope = {
      threadId: subagent.threadId,
      ...(subagent.runId === null ? {} : { runId: subagent.runId }),
      nodeId: subagentId,
      providerInstanceId: subagent.providerInstanceId,
      occurredAt: now,
    };
    const events: Array<OrchestrationV2DomainEvent> = [];
    if (
      isOrchestrationV2WorkActive(subagent.status) &&
      !writtenIds(input.emitted, "subagent.updated").has(subagentId)
    ) {
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "subagent.updated",
        driver: subagent.driver,
        payload: {
          ...subagent,
          status,
          completedAt,
          updatedAt: now,
          ...(input.result === undefined ? {} : { result: input.result }),
        },
      });
    }
    if (
      node !== undefined &&
      isOrchestrationV2WorkActive(node.status) &&
      !writtenIds(input.emitted, "node.updated").has(subagentId)
    ) {
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "node.updated",
        payload: { ...node, status, completedAt },
      });
    }
    if (
      item !== undefined &&
      isOrchestrationV2WorkActive(item.status) &&
      !writtenIds(input.emitted, "turn-item.updated").has(item.id)
    ) {
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        payload: {
          ...item,
          status,
          completedAt,
          updatedAt: now,
          ...(input.result === undefined ? {} : { result: input.result }),
        },
      });
    }
    return events;
  },
);

export const endRunlessRootTurns = Effect.fn("subagentProjection.endRunlessRootTurns")(function* <
  E,
>(input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "nodes" | "providerTurns" | "turnItems"
  >;
  readonly status: "completed" | "failed" | "interrupted" | "cancelled";
  readonly completedAt?: DateTime.Utc;
  readonly now: DateTime.Utc;
  readonly emitted: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly allocateEventId: () => Effect.Effect<EventId, E>;
}) {
  const { now, status, completedAt = now } = input;
  const endedNodeIds = writtenIds(input.emitted, "node.updated");
  const endedItemIds = writtenIds(input.emitted, "turn-item.updated");
  const endedProviderTurnIds = writtenIds(input.emitted, "provider-turn.updated");
  const scope = {
    threadId: input.threadId,
    providerInstanceId: input.providerInstanceId,
    occurredAt: now,
  };
  const events: Array<OrchestrationV2DomainEvent> = [];
  for (const node of input.projection.nodes) {
    if (
      node.kind !== "root_turn" ||
      node.runId !== null ||
      !isOrchestrationV2WorkActive(node.status)
    ) {
      continue;
    }
    if (!endedNodeIds.has(node.id)) {
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "node.updated",
        nodeId: node.id,
        payload: { ...node, status, completedAt },
      });
    }
    for (const item of input.projection.turnItems) {
      if (
        item.nodeId !== node.id ||
        item.runId !== null ||
        !isOrchestrationV2WorkActive(item.status) ||
        endedItemIds.has(item.id)
      ) {
        continue;
      }
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        nodeId: node.id,
        payload: {
          ...item,
          status:
            status === "completed" &&
            (item.type === "command_execution" || item.type === "dynamic_tool")
              ? "failed"
              : status,
          completedAt,
          updatedAt: now,
          ...(item.type === "reasoning" || item.type === "assistant_message"
            ? { streaming: false }
            : {}),
        },
      });
    }
    for (const providerTurn of input.projection.providerTurns) {
      if (
        providerTurn.nodeId !== node.id ||
        providerTurn.runAttemptId !== null ||
        !isOrchestrationV2WorkActive(providerTurn.status) ||
        endedProviderTurnIds.has(providerTurn.id)
      ) {
        continue;
      }
      events.push({
        ...scope,
        id: yield* input.allocateEventId(),
        type: "provider-turn.updated",
        nodeId: node.id,
        payload: { ...providerTurn, status, completedAt },
      });
    }
  }
  return events;
});
