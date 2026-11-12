import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type ModelSelection,
  NodeId,
  RunId,
  RunAttemptId,
  MessageId,
  EventId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  makeSubagentChildThread,
  delegatedTaskProgress,
  resolveDelegatedTaskRunChain,
  subagentOriginalResultForRun,
  subagentResultForRun,
  makeSubagentConversationArtifacts,
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
} from "@t3tools/provider-core/server/subagentProjection";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { resolveAutoSettlementAt } from "./ThreadSettlementService.ts";

const parentThreadId = ThreadId.make("thread:subagent-snoozed-parent");
const childThreadId = ThreadId.make("thread:subagent-awake-child");
const parentProviderInstanceId = ProviderInstanceId.make("codex");
const childProviderInstanceId = ProviderInstanceId.make("claude");
const parentModelSelection = {
  instanceId: parentProviderInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const childModelSelection = {
  instanceId: childProviderInstanceId,
  model: "claude-opus-4-1",
} satisfies ModelSelection;
const parentCreatedAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
const snoozedAt = DateTime.makeUnsafe("2026-07-24T09:05:00.000Z");
const snoozedUntil = DateTime.makeUnsafe("2026-07-25T09:00:00.000Z");
const childCreatedAt = DateTime.makeUnsafe("2026-07-24T09:10:00.000Z");

function makeParentThread(): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: parentThreadId,
    projectId: ProjectId.make("project:subagent-snooze"),
    title: "Snoozed parent",
    providerInstanceId: parentProviderInstanceId,
    modelSelection: parentModelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    activeProviderThreadId: ProviderThreadId.make("provider-thread:subagent-snoozed-parent"),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: parentThreadId,
    },
    forkedFrom: null,
    createdAt: parentCreatedAt,
    updatedAt: snoozedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    snoozedUntil,
    snoozedAt,
    deletedAt: null,
    historyOrigin: "v1_import",
  };
}

it("keeps a subagent child awake when its parent thread is snoozed", () => {
  const parentThread: OrchestrationV2AppThread = {
    ...makeParentThread(),
    titleRegeneration: { requestId: CommandId.make("command:parent-title"), startedAt: snoozedAt },
  };
  const childProviderThreadId = ProviderThreadId.make("provider-thread:subagent-awake-child");
  const parentNodeId = NodeId.make("node:subagent-parent");
  const childThread = makeSubagentChildThread({
    parentThread,
    childThreadId,
    parentNodeId,
    activeProviderThreadId: childProviderThreadId,
    providerInstanceId: childProviderInstanceId,
    modelSelection: childModelSelection,
    title: "Awake child",
    now: childCreatedAt,
    createdBy: "agent",
    creationSource: "provider",
  });

  assert.isNull(childThread.snoozedUntil);
  assert.isNull(childThread.snoozedAt);
  assert.isNull(childThread.titleRegeneration);
  assert.equal(childThread.projectId, parentThread.projectId);
  assert.equal(childThread.runtimeMode, parentThread.runtimeMode);
  assert.equal(childThread.interactionMode, parentThread.interactionMode);
  assert.equal(childThread.branch, parentThread.branch);
  assert.equal(childThread.worktreePath, parentThread.worktreePath);
  assert.equal(childThread.providerInstanceId, childProviderInstanceId);
  assert.deepEqual(childThread.modelSelection, childModelSelection);
  assert.equal(childThread.activeProviderThreadId, childProviderThreadId);
  assert.isUndefined(childThread.historyOrigin);
  assert.deepEqual(childThread.lineage, {
    parentThreadId,
    relationshipToParent: "subagent",
    rootThreadId: parentThreadId,
  });
  assert.deepEqual(childThread.forkedFrom, {
    type: "node",
    nodeId: parentNodeId,
  });
});

it.effect.each(["provider", "mcp"] as const)(
  "a %s child does not inherit parent settlement protections and settles once its parent settles",
  (creationSource) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const parentThread = {
        ...makeParentThread(),
        pinnedAt: parentCreatedAt,
        pinOrderKey: "a0",
        autoSettleDisabledAt: parentCreatedAt,
        decision: {
          sourceThreadId: ThreadId.make("thread:decision-source"),
          question: "Keep the cache?",
          status: "discussing" as const,
          revision: 1,
          createdAt: parentCreatedAt,
          updatedAt: parentCreatedAt,
        },
      };
      const childThread = makeSubagentChildThread({
        parentThread,
        childThreadId,
        parentNodeId: NodeId.make("node:subagent-parent"),
        activeProviderThreadId: null,
        providerInstanceId: childProviderInstanceId,
        modelSelection: childModelSelection,
        title: "Child",
        now: childCreatedAt,
        createdBy: "agent",
        creationSource,
      });

      assert.isUndefined(childThread.decision);
      assert.equal(parentThread.pinnedAt, parentCreatedAt);
      assert.equal(parentThread.pinOrderKey, "a0");
      assert.isNull(childThread.pinnedAt);
      assert.isNull(childThread.pinOrderKey);
      assert.isNull(childThread.autoSettleDisabledAt);

      for (const thread of [parentThread, childThread]) {
        yield* store.apply({
          id: EventId.make(`event:${thread.id}`),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: thread.createdAt,
          payload: thread,
        });
      }
      const savedParent = yield* store.getThread(parentThreadId);
      assert.deepEqual(savedParent.pinnedAt, parentCreatedAt);
      assert.equal(savedParent.pinOrderKey, "a0");
      assert.deepEqual(savedParent.autoSettleDisabledAt, parentCreatedAt);
      // A subagent child waits for its parent, so settle the pinned parent first.
      assert.deepEqual(yield* store.getSettlementCandidates(), []);
      yield* store.apply({
        id: EventId.make(`event:${parentThreadId}:settled`),
        type: "thread.settled",
        threadId: parentThreadId,
        occurredAt: childCreatedAt,
        payload: {
          ...savedParent,
          settledOverride: "settled",
          settledAt: childCreatedAt,
          pinnedAt: null,
          pinOrderKey: null,
        },
      });
      const candidates = yield* store.getSettlementCandidates();
      assert.deepEqual(
        candidates.map((candidate) => candidate.id),
        [childThreadId],
      );
      const settledAt = resolveAutoSettlementAt({
        thread: candidates[0]!,
        pullRequest: null,
        nowMs: DateTime.toEpochMillis(DateTime.add(childCreatedAt, { days: 4 })),
        autoSettleAfterDays: 3,
        autoSettleOnMerge: false,
      });
      assert.equal(settledAt && DateTime.formatIso(settledAt), DateTime.formatIso(childCreatedAt));
    }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
);

function taskFixture() {
  const projection = ProjectionStore.emptyProjection({
    type: "thread.created",
    id: EventId.make("task-fixture"),
    threadId: parentThreadId,
    occurredAt: parentCreatedAt,
    payload: makeParentThread(),
  });
  const run: OrchestrationV2Run = {
    id: RunId.make("initial"),
    threadId: parentThreadId,
    ordinal: 1,
    providerInstanceId: parentProviderInstanceId,
    modelSelection: parentModelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("prompt"),
    rootNodeId: NodeId.make("root"),
    activeAttemptId: RunAttemptId.make("attempt"),
    status: "completed",
    requestedAt: parentCreatedAt,
    startedAt: parentCreatedAt,
    completedAt: childCreatedAt,
    checkpointId: null,
    contextHandoffId: null,
  };
  return { projection: { ...projection, runs: [run] }, run };
}

it("reports the run that ended last, not the highest ordinal", () => {
  const { projection, run } = taskFixture();
  const ended = (ordinal: number, completedAt: string): OrchestrationV2Run => ({
    ...run,
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    completedAt: DateTime.makeUnsafe(completedAt),
  });
  const progress = delegatedTaskProgress({
    ...projection,
    runs: [
      { ...run, status: "cancelled" },
      ended(4, "2026-07-24T10:00:00.000Z"),
      ended(2, "2026-07-24T10:05:00.000Z"),
      ended(3, "2026-07-24T10:10:00.000Z"),
    ],
  });
  assert.equal(progress.state, "result_available");
  assert.equal(progress.resultRun?.ordinal, 3);
});

it("waits for nested work and retains the report across monitor acknowledgements", () => {
  const { projection, run } = taskFixture();
  assert.equal(
    delegatedTaskProgress({ ...projection, subagents: [{ status: "running" }] }).state,
    "waiting_for_children",
  );
  assert.equal(
    delegatedTaskProgress({ ...projection, subagents: [{ status: "completed" }] }).state,
    "result_available",
  );
  assert.equal(
    delegatedTaskProgress({ ...projection, subagents: [{ status: "idle" }] }).state,
    "result_available",
  );
  for (const state of ["pending", "claimed"] as const) {
    assert.equal(
      delegatedTaskProgress({
        ...projection,
        subagents: [{ status: "idle", completionDelivery: { state, observedByRunId: null } }],
      }).state,
      "result_available",
    );
    assert.equal(
      delegatedTaskProgress({
        ...projection,
        subagents: [{ status: "completed", completionDelivery: { state, observedByRunId: null } }],
      }).state,
      "waiting_for_children",
    );
  }
  for (const state of ["acknowledged", "delivered", "disposed"] as const) {
    assert.equal(
      delegatedTaskProgress({
        ...projection,
        subagents: [{ status: "completed", completionDelivery: { state, observedByRunId: null } }],
      }).state,
      "result_available",
    );
  }
  for (const [awaited, state] of [
    [true, "waiting_for_children"],
    [false, "result_available"],
  ] as const) {
    assert.equal(
      delegatedTaskProgress({
        ...projection,
        providerThreads: [
          {
            pendingBackgroundTasks: [
              { taskId: "background-audit", kind: "command", ...(awaited ? { awaited } : {}) },
              { taskId: "log-watcher", kind: "monitor" },
            ],
          },
        ],
      }).state,
      state,
    );
  }
  const pending = {
    ...run,
    id: RunId.make("followup"),
    ordinal: 2,
    status: "queued" as const,
    startedAt: null,
  };
  assert.equal(delegatedTaskProgress({ ...projection, runs: [run, pending] }).state, "working");
  const cancelled = { ...run, status: "cancelled" as const };
  const held = delegatedTaskProgress({
    ...projection,
    runs: [cancelled, { ...pending, queueHeld: true }],
  });
  assert.equal(held.state, "result_available");
  assert.equal(held.resultRun?.id, cancelled.id);
  const report = { ...pending, status: "completed" as const, startedAt: parentCreatedAt };
  const monitor = { ...report, id: RunId.make("monitor"), ordinal: 3 };
  const artifacts = makeSubagentConversationArtifacts({
    messageId: MessageId.make("monitor-message"),
    turnItemId: TurnItemId.make("monitor-item"),
    threadId: parentThreadId,
    rootNodeId: NodeId.make("root"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    role: "user",
    text: "Monitor update",
    ordinal: 3,
    now: childCreatedAt,
  });
  const progress = delegatedTaskProgress({
    ...projection,
    runs: [run, report, monitor],
    messages: [
      {
        ...artifacts.message,
        runId: monitor.id,
        notification: {
          source: { kind: "monitor" },
          outcome: "updated",
          summary: "Monitor update",
        },
      },
    ],
  });
  assert.equal(progress.state, "result_available");
  assert.equal(progress.resultRun?.id, report.id);
});

it("exposes the provider failure rather than a progress message from the failed run", () => {
  const { projection, run } = taskFixture();
  const failedRun = { ...run, status: "failed" as const };
  const artifacts = makeSubagentConversationArtifacts({
    messageId: MessageId.make("progress"),
    turnItemId: TurnItemId.make("error"),
    threadId: parentThreadId,
    rootNodeId: NodeId.make("root"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    role: "assistant",
    text: "Starting the audit.",
    ordinal: 1,
    now: childCreatedAt,
  });
  if (artifacts.turnItem.type !== "assistant_message") throw new Error("Expected assistant item");
  const failure = {
    class: "unknown" as const,
    message: "You've hit your usage limit. Try again Sep 14 at 7:20 PM.",
    code: null,
    retryable: false,
  };
  const result = subagentResultForRun(
    {
      ...projection,
      messages: [{ ...artifacts.message, runId: run.id }],
      turnItems: [{ ...artifacts.turnItem, type: "error", runId: run.id, failure }],
    },
    failedRun,
  );
  assert.equal(result.text, failure.message);
  assert.equal(result.turnItemId, artifacts.turnItem.id);
  assert.isNull(result.messageId);
});

it("orders a task's assistant messages by turn item, not by timestamps", () => {
  const { projection, run } = taskFixture();
  const at = DateTime.makeUnsafe("2026-07-24T10:05:00.000Z");
  const message = (id: string, text: string, ordinal: number) => {
    const artifacts = makeSubagentConversationArtifacts({
      messageId: MessageId.make(id),
      turnItemId: TurnItemId.make(id),
      threadId: parentThreadId,
      rootNodeId: NodeId.make("root"),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      role: "assistant",
      text,
      ordinal,
      now: at,
    });
    return {
      message: { ...artifacts.message, runId: run.id },
      turnItem: { ...artifacts.turnItem, runId: run.id },
    };
  };
  const progress = message("progress", "Starting step 0.", 1);
  const report = message("report", "All steps passed.", 2);
  const result = subagentResultForRun(
    {
      ...projection,
      messages: [progress.message, report.message],
      turnItems: [report.turnItem, progress.turnItem],
    },
    run,
  );
  assert.equal(result.text, "All steps passed.");
  assert.equal(result.messageId, report.message.id);
  assert.equal(result.turnItemId, report.turnItem.id);
  const reported = { runAttemptId: run.activeAttemptId, ordinal: 1, model: "gpt-5.4-mini" };
  assert.equal(
    subagentResultForRun(
      { ...projection, messages: [report.message], providerTurns: [reported as never] },
      run,
    ).text,
    "Requested model gpt-5.4; the provider reported running gpt-5.4-mini.\n\nAll steps passed.",
  );
});

it("keeps each follow-up task on its own delegated run", () => {
  const { projection, run } = taskFixture();
  const taskA = NodeId.make("node:task-a");
  const taskB = NodeId.make("node:task-b");
  const runA = { ...run, id: RunId.make("run:task-a"), delegatedTaskId: taskA };
  const runB = {
    ...run,
    id: RunId.make("run:task-b"),
    ordinal: 2,
    delegatedTaskId: taskB,
  };
  const child = {
    ...projection,
    thread: {
      ...projection.thread,
      id: childThreadId,
      forkedFrom: { type: "node" as const, nodeId: taskA },
    },
    runs: [runA, runB],
  };

  const first = resolveDelegatedTaskRunChain(child, {
    id: taskA,
    threadId: parentThreadId,
    childThreadId,
  });
  const second = resolveDelegatedTaskRunChain(child, {
    id: taskB,
    threadId: parentThreadId,
    childThreadId,
  });

  assert.deepEqual(
    first.runs.map((entry) => entry.id),
    [runA.id],
  );
  assert.deepEqual(
    second.runs.map((entry) => entry.id),
    [runB.id],
  );
  assert.equal(second.run?.id, runB.id);
});

it("keeps restart continuations in one task chain", () => {
  const { projection, run } = taskFixture();
  const taskId = NodeId.make("node:task-continuation");
  const first = { ...run, id: RunId.make("run:continuation-1"), delegatedTaskId: taskId };
  const second = {
    ...run,
    id: RunId.make("run:continuation-2"),
    ordinal: 2,
    restartContinuationOfRunId: first.id,
    delegatedTaskId: taskId,
  };
  const resolved = resolveDelegatedTaskRunChain(
    { ...projection, runs: [first, second] },
    { id: taskId, threadId: parentThreadId, childThreadId },
  );

  assert.equal(resolved.association, "run_delegated_task_id");
  assert.deepEqual(
    resolved.runs.map((entry) => entry.id),
    [first.id, second.id],
  );
  assert.equal(resolved.run?.id, second.id);
});

it("accepts only the original task's unique spawn transfer as a legacy anchor", () => {
  const { projection, run } = taskFixture();
  const taskId = NodeId.make("node:task-spawn");
  const spawn = {
    id: "transfer:spawn",
    type: "subagent_spawn",
    sourceThreadId: parentThreadId,
    targetThreadId: childThreadId,
    sourcePoint: { threadId: parentThreadId },
    targetRunId: run.id,
  };
  const child = {
    ...projection,
    thread: {
      ...projection.thread,
      id: childThreadId,
      forkedFrom: { type: "node" as const, nodeId: taskId },
    },
    runs: [run],
    contextTransfers: [spawn],
  } as never;

  const resolved = resolveDelegatedTaskRunChain(child, {
    id: taskId,
    threadId: parentThreadId,
    childThreadId,
  });
  const followUp = resolveDelegatedTaskRunChain(child, {
    id: NodeId.make("node:task-follow-up"),
    threadId: parentThreadId,
    childThreadId,
  });

  assert.equal(resolved.association, "spawn_transfer");
  assert.equal(resolved.run?.id, run.id);
  assert.equal(followUp.association, "unavailable");
  assert.isUndefined(followUp.run);
});

it("returns one task's exact observed result without the agent-facing model note", () => {
  const { projection, run } = taskFixture();
  const taskId = NodeId.make("node:task-result-a");
  const otherTaskId = NodeId.make("node:task-result-b");
  const runA = { ...run, id: RunId.make("run:result-a"), delegatedTaskId: taskId };
  const runB = {
    ...run,
    id: RunId.make("run:result-b"),
    ordinal: 2,
    delegatedTaskId: otherTaskId,
  };
  const artifact = (runId: RunId, id: string, text: string, ordinal: number) => {
    const value = makeSubagentConversationArtifacts({
      messageId: MessageId.make(`message:${id}`),
      turnItemId: TurnItemId.make(`item:${id}`),
      threadId: childThreadId,
      rootNodeId: NodeId.make("root"),
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      role: "assistant",
      text,
      ordinal,
      now: childCreatedAt,
    });
    return {
      message: { ...value.message, runId },
      turnItem: { ...value.turnItem, runId },
    };
  };
  const progress = artifact(runA.id, "progress", "Starting the audit.", 1);
  const report = artifact(runA.id, "report", "Audit complete.", 2);
  const other = artifact(runB.id, "other", "Other task result.", 3);
  const child = {
    ...projection,
    messages: [progress.message, report.message, other.message],
    turnItems: [progress.turnItem, report.turnItem, other.turnItem],
    providerTurns: [
      {
        runAttemptId: runA.activeAttemptId,
        ordinal: 1,
        model: "reported-model",
      },
    ],
  };

  const raw = subagentOriginalResultForRun(child as never, runA);
  const anchored = subagentOriginalResultForRun(child as never, runA, {
    turnItemId: progress.turnItem.id,
  });

  assert.equal(raw?.text, "Audit complete.");
  assert.equal(anchored?.text, "Starting the audit.");
  assert.equal(anchored?.turnItemId, progress.turnItem.id);
  assert.notInclude(raw?.text ?? "", "Requested model");
});

it.effect("ends an orphaned native subagent's node when only its record already ended", () =>
  Effect.gen(function* () {
    const id = NodeId.make("node:orphaned-native-subagent");
    const subagent = { id, origin: "provider_native", status: "running", runId: null };
    const events = yield* endOrphanedNativeSubagent({
      projection: {
        subagents: [subagent],
        nodes: [{ id, status: "running", runId: null }],
        turnItems: [],
      } as never,
      subagentId: id,
      status: "cancelled",
      now: yield* DateTime.now,
      emitted: [
        { type: "subagent.updated", payload: { ...subagent, status: "cancelled" } },
      ] as never,
      allocateEventId: () => Effect.succeed(EventId.make("event:orphaned-native-subagent")),
    });
    assert.deepEqual(
      events.map((event) => [event.type, event.type === "node.updated" && event.payload.status]),
      [["node.updated", "cancelled"]],
    );
  }),
);

it.effect("ends a runless root turn's items when its node already ended", () =>
  Effect.gen(function* () {
    const root = {
      id: NodeId.make("node:runless-root"),
      kind: "root_turn",
      status: "running",
      runId: null,
    };
    const item = (id: string) => ({ id, nodeId: root.id, runId: null, status: "running" });
    const events = yield* endRunlessRootTurns({
      threadId: childThreadId,
      providerInstanceId: parentProviderInstanceId,
      projection: {
        nodes: [root],
        providerTurns: [],
        turnItems: [item("turn-item:command"), item("turn-item:reasoning")],
      } as never,
      status: "cancelled",
      now: yield* DateTime.now,
      emitted: [
        {
          type: "turn-item.updated",
          payload: { ...item("turn-item:command"), status: "cancelled" },
        },
        { type: "node.updated", payload: { ...root, status: "cancelled" } },
      ] as never,
      allocateEventId: () => Effect.succeed(EventId.make("event:runless-root")),
    });
    assert.deepEqual(
      events.map(
        (event) => `${event.type} ${event.type === "turn-item.updated" && event.payload.id}`,
      ),
      ["turn-item.updated turn-item:reasoning"],
    );
  }),
);
