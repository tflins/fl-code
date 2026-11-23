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
import { derive } from "./IdAllocator.ts";
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
  // The remote parent delegated the parent thread, not its subagents.
  const { delegatedFrom: _delegatedFrom, ...inherited } = input.parentThread;
  return {
    ...inherited,
    decision: undefined,
    createdBy: input.createdBy,
    creationSource: input.creationSource,
    id: input.childThreadId,
    title: input.title,
    titleRegeneration: null,
    titleRenamed: false,
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

/** Run signal of the notice that carries a provider's stop reason on a completed run. */
export const PROVIDER_STOP_REASON_SIGNAL = "provider-stop-reason";

/** Turn item types `subagentResultForRun` reads; load at least these for its projection. */
export const SUBAGENT_RESULT_TURN_ITEM_TYPES = [
  "assistant_message",
  "error",
  "system_notice",
  "run_interrupt_result",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

/** The item carrying a provider's stop reason for a run, which its delegated result ends with. */
export function subagentStopNotice(
  projection: Pick<OrchestrationV2ThreadProjection, "turnItems">,
  run: OrchestrationV2Run,
) {
  // Codex ends a hook-stopped turn as completed or interrupted, depending on its version.
  const ids = [
    derive.runSignalTurnItem({ runId: run.id, signal: PROVIDER_STOP_REASON_SIGNAL }),
    derive.runSignalTurnItem({ runId: run.id, signal: "interrupt-result" }),
  ];
  return projection.turnItems.find(
    (
      item,
    ): item is Extract<
      OrchestrationV2TurnItem,
      { readonly type: "system_notice" | "run_interrupt_result" }
    > =>
      ids.includes(item.id) &&
      (item.type === "system_notice" || item.type === "run_interrupt_result"),
  );
}

function withStopNotice(
  projection: Pick<OrchestrationV2ThreadProjection, "turnItems">,
  run: OrchestrationV2Run,
  text: string,
): string {
  const notice = subagentStopNotice(projection, run);
  return notice === undefined ? text : `${text}\n\n${notice.message}`;
}

type MonitorNotice = Pick<OrchestrationV2ConversationMessage, "runId" | "notification">;

/** Runs that only acknowledge a monitor update are never a task's work. */
export function monitorUpdateRunIds(messages: ReadonlyArray<MonitorNotice>) {
  return new Set(
    messages
      .filter(
        (message) =>
          message.notification?.source.kind === "monitor" &&
          message.notification.outcome === "updated",
      )
      .map((message) => message.runId),
  );
}

/**
 * The same task's completed runs before `run`, latest first: where its report is when `run`
 * completed without saying anything. Ends at another task's run or at any other outcome.
 */
export function delegatedTaskReportRuns(
  projection: {
    readonly runs: ReadonlyArray<OrchestrationV2Run>;
    readonly messages: ReadonlyArray<MonitorNotice>;
  },
  run: OrchestrationV2Run,
): ReadonlyArray<OrchestrationV2Run> {
  if (run.status !== "completed") return [];
  const monitorRuns = monitorUpdateRunIds(projection.messages);
  const earlier = projection.runs
    .filter(
      (candidate) =>
        candidate.id !== run.id &&
        candidate.startedAt !== null &&
        candidate.status !== "rolled_back" &&
        !monitorRuns.has(candidate.id) &&
        runRanAfter(run, candidate),
    )
    .toSorted((a, b) => (runRanAfter(a, b) ? -1 : 1));
  const end = earlier.findIndex(
    (candidate) =>
      candidate.status !== "completed" || candidate.delegatedTaskId !== run.delegatedTaskId,
  );
  return end === -1 ? earlier : earlier.slice(0, end);
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
  const reportBeforeFailure =
    failure !== undefined && turnItem !== null && turnItem.ordinal < failure.ordinal
      ? (message?.text ?? turnItem.text)
      : undefined;
  const text =
    (failure?.type === "error"
      ? reportBeforeFailure === undefined
        ? failure.failure.message
        : `${failure.failure.message}\n\nLast assistant message before the run failed:\n\n${reportBeforeFailure}`
      : undefined) ??
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
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems" | "providerTurns"> & {
    readonly runs?: ReadonlyArray<OrchestrationV2Run>;
  },
  run: OrchestrationV2Run,
) {
  const result = resultOfRun(projection, run);
  if (
    run.status !== "completed" ||
    result.messageId !== null ||
    result.turnItemId !== null ||
    subagentStopNotice(projection, run) !== undefined
  )
    return result;
  for (const earlier of delegatedTaskReportRuns(
    { runs: projection.runs ?? [], messages: projection.messages },
    run,
  )) {
    const report = resultOfRun(projection, earlier);
    if (report.messageId !== null || report.turnItemId !== null) return report;
  }
  return result;
}

function resultOfRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems" | "providerTurns">,
  run: OrchestrationV2Run,
) {
  const original = subagentOriginalResultForRun(projection, run);
  const text =
    run.status === "failed" && original !== null
      ? original.text
      : withStopNotice(
          projection,
          run,
          original?.text ??
            (run.status === "completed"
              ? "Child task completed without an assistant result."
              : `Child task ended with status ${run.status}.`),
        );
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

/** A follow-up task's runs: those tagged with it, and the untagged wakes for subagents they started. */
export function delegatedTaskRuns<R extends Pick<OrchestrationV2Run, "id" | "delegatedTaskId">>(
  projection: {
    readonly runs: ReadonlyArray<R>;
    readonly messages: ReadonlyArray<
      Pick<OrchestrationV2ConversationMessage, "runId" | "delegatedCompletion">
    >;
  },
  taskId: NodeId,
): ReadonlyArray<R> {
  const owned = completionWakeRunIds(
    projection,
    new Set(projection.runs.filter((run) => run.delegatedTaskId === taskId).map((run) => run.id)),
  );
  return projection.runs.filter((run) => owned.has(run.id));
}

export function scopeDelegatedTask<
  T extends {
    readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "forkedFrom">;
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "delegatedTaskId">>;
    readonly subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "runId">>;
    readonly messages?: ReadonlyArray<
      Pick<OrchestrationV2ConversationMessage, "runId" | "delegatedCompletion">
    >;
  },
>(projection: T, taskId: NodeId): T {
  if (projection.runs.every((run) => run.delegatedTaskId === undefined)) return projection;
  const original =
    projection.thread.forkedFrom?.type === "node" && projection.thread.forkedFrom.nodeId === taskId;
  const records = { runs: projection.runs, messages: projection.messages ?? [] };
  const ownedRunIds = new Set(delegatedTaskRuns(records, taskId).map((run) => run.id));
  const foreignRunIds = original
    ? completionWakeRunIds(
        records,
        new Set(
          projection.runs
            .filter((run) => run.delegatedTaskId !== undefined && run.delegatedTaskId !== taskId)
            .map((run) => run.id),
        ),
      )
    : undefined;
  const runs = projection.runs.filter(
    (run) =>
      ownedRunIds.has(run.id) ||
      (original && run.delegatedTaskId === undefined && !foreignRunIds?.has(run.id)),
  );
  const runIds = new Set(runs.map((run) => run.id));
  return {
    ...projection,
    runs,
    subagents: projection.subagents.filter((task) => task.runId !== null && runIds.has(task.runId)),
  };
}

function completionWakeRunIds(
  projection: {
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "delegatedTaskId">>;
    readonly messages: ReadonlyArray<
      Pick<OrchestrationV2ConversationMessage, "runId" | "delegatedCompletion">
    >;
  },
  owned: Set<OrchestrationV2Run["id"]>,
): Set<OrchestrationV2Run["id"]> {
  const untagged = new Set(
    projection.runs.filter((run) => run.delegatedTaskId === undefined).map((run) => run.id),
  );
  for (let grew = owned.size > 0; grew;) {
    grew = false;
    for (const { runId, delegatedCompletion } of projection.messages) {
      if (
        runId === null ||
        !untagged.has(runId) ||
        owned.has(runId) ||
        delegatedCompletion === undefined ||
        !owned.has(delegatedCompletion.parentRunId)
      )
        continue;
      owned.add(runId);
      grew = true;
    }
  }
  return owned;
}

export function subagentHoldsCompletion(
  task: Pick<OrchestrationV2ThreadProjection["subagents"][number], "status" | "completionDelivery">,
): boolean {
  return (
    isOrchestrationV2WorkActive(task.status) ||
    // Publishing a child's result precedes scheduling its parent's wake.
    // The parent still owes that follow-up even between those transactions.
    (task.status !== "idle" &&
      (task.completionDelivery?.state === "pending" ||
        task.completionDelivery?.state === "claimed"))
  );
}

export function delegatedTaskProgress(projection: {
  readonly runs: OrchestrationV2ThreadProjection["runs"];
  readonly messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "runId" | "notification" | "createdBy">
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
  const monitorRuns = monitorUpdateRunIds(projection.messages);
  const workRuns = projection.runs.filter(
    (run) => !monitorRuns.has(run.id) && run.status !== "rolled_back",
  );
  const held = (run: OrchestrationV2Run) => run.status === "queued" && run.queueHeld === true;
  const active = workRuns.some((run) => !terminal(run.status) && !held(run));
  // Held wakes wait on nobody, but a held message the user wrote is the child's next work.
  const userRunIds = new Set(
    projection.messages.flatMap((message) =>
      message.createdBy === "user" && message.notification === undefined && message.runId !== null
        ? [message.runId]
        : [],
    ),
  );
  const awaitsUserRun = workRuns.some((run) => held(run) && userRunIds.has(run.id));
  const children =
    projection.subagents.some(subagentHoldsCompletion) ||
    projection.providerThreads.some((thread) =>
      backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []),
    );
  const resultRun = workRuns
    .filter((run) => terminal(run.status) && (run.startedAt !== null || run.ordinal === 1))
    .toSorted((a, b) => (runRanAfter(a, b) ? -1 : runRanAfter(b, a) ? 1 : 0))[0];
  return {
    state:
      active || awaitsUserRun || resultRun === undefined
        ? ("working" as const)
        : children
          ? ("waiting_for_children" as const)
          : ("result_available" as const),
    resultRun,
    /** Working only because of a held message the user wrote, which a cancel does not wait for. */
    onlyAwaitsUserRun: awaitsUserRun && !active && resultRun !== undefined,
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
