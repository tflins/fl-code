import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderSessionId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { AgentScope } from "@t3tools/shared/AgentScope";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

it("stamps authoritative provenance on commands that create threads or messages", () => {
  const command: OrchestrationV2Command = {
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("command:thread-management:create"),
    threadId: ThreadId.make("thread:thread-management:create"),
    projectId: ProjectId.make("project:thread-management"),
    title: "Thread management",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    // A client cannot claim a linked environment's origin, or a parent there.
    linkOrigin: { sessionId: "forged", label: "Somewhere else" },
    delegatedFrom: {
      environmentId: EnvironmentId.make("environment:elsewhere"),
      threadId: ThreadId.make("thread:elsewhere"),
      title: "Somewhere else",
    },
    decision: {
      sourceThreadId: ThreadId.make("thread:elsewhere"),
      question: "Forged decision",
    },
  };

  const stamped = ThreadManagementService.withCreationProvenance(command, {
    createdBy: "user",
    creationSource: "web",
  });
  expect(stamped).toMatchObject({
    createdBy: "user",
    creationSource: "web",
  });
  expect(stamped).not.toHaveProperty("linkOrigin");
  expect(stamped).not.toHaveProperty("delegatedFrom");
  expect(stamped).not.toHaveProperty("decision");
});

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

const layerDispatchChokepointTest =
  (settingsLayer: ReturnType<typeof ServerSettings.layerTest>) => (dispatched: Array<string>) =>
    ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: ThreadId.make("thread:thread-management:chokepoint"),
                projectId: ProjectId.make("project:thread-management:chokepoint"),
                deletedAt: null,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex_work"),
                  model: "test",
                },
              },
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(settingsLayer),
      Layer.provideMerge(layerReceiptsTest),
    );

it.effect(
  "the dispatch chokepoint refuses a continuation message.dispatch on a project-disabled instance before reaching the orchestrator",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-disabled");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* Effect.flip(
        threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make("message:thread-management:chokepoint-disabled"),
          text: "Background task completed.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      );

      expect(error).toBeInstanceOf(
        ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
      );
      expect(error).toMatchObject({ projectId, instanceId });
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "a replay of an already-accepted command id dispatches despite the instance now being disabled",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-replay");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      yield* receipts.insertIfAbsent({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: yield* DateTime.now,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });

      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId: MessageId.make("message:thread-management:chokepoint-replay"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });

      expect(dispatched).toEqual(["message.dispatch"]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("reuses accepted or uncertain attempts and advances only durable rejections", () => {
  const layer = layerDispatchChokepointTest(ServerSettings.layerTest({}))([]);
  return Effect.gen(function* () {
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const baseId = CommandId.make("decision:start:retry");
    expect(yield* threads.nextCommandAttemptId(baseId)).toEqual(baseId);
    const first = {
      commandId: baseId,
      threadId: ThreadId.make("thread:decision-retry"),
      commandType: "message.dispatch" as const,
      acceptedAt: yield* DateTime.now,
      resultSequence: 0,
      status: "rejected" as const,
      error: "Provider temporarily unavailable",
    };
    yield* receipts.insertIfAbsent(first);
    const retryId = yield* threads.nextCommandAttemptId(baseId);
    expect(retryId).not.toEqual(baseId);
    expect(yield* threads.nextCommandAttemptId(baseId)).toEqual(retryId);
    yield* receipts.insertIfAbsent({
      ...first,
      commandId: retryId,
      status: "accepted",
      resultSequence: 1,
      error: null,
    });
    expect(yield* threads.nextCommandAttemptId(baseId)).toEqual(retryId);
  }).pipe(Effect.provide(layer));
});

it.effect("waitForThread follows a restart continuation instead of the cut run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-restart");
    const threadId = ThreadId.make("thread:thread-management:wait-restart");
    const runId = RunId.make("run:thread-management:wait-restart");
    const continuationId = RunId.make("run:thread-management:wait-restart:2");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let runs: Array<{
      id: RunId;
      status: OrchestrationV2Run["status"];
      restartContinuationOfRunId?: RunId;
    }> = [{ id: runId, status: "cancelled" }];
    let pending = true;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: (run) => Effect.succeed(pending && run.id === runId),
          awaitRestartContinuation: () => Effect.never,
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    const continuation = { id: continuationId, restartContinuationOfRunId: runId };
    runs = [...runs, { ...continuation, status: "running" }];
    pending = false;
    yield* Queue.offer(
      events,
      stored(1, { type: "run.updated", payload: { ...continuation, status: "running" } }),
    );
    runs = [runs[0]!, { ...continuation, status: "completed" }];
    yield* Queue.offer(
      events,
      stored(2, { type: "run.updated", payload: { ...continuation, status: "completed" } }),
    );
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: continuationId, status: "completed" },
    });
  }),
);

it.effect("waitForThread can wait past an ended run for the thread's delegated work", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-delegated");
    const threadId = ThreadId.make("thread:thread-management:wait-delegated");
    const runId = RunId.make("run:thread-management:wait-delegated");
    const wakeRunId = RunId.make("run:thread-management:wait-delegated:wake");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1_000);
    const run = (id: RunId, ordinal: number, status: OrchestrationV2Run["status"], end: number) =>
      ({
        id,
        ordinal,
        status,
        startedAt: at(end - 1),
        completedAt: status === "running" ? null : at(end),
      }) as unknown as OrchestrationV2Run;
    // The run ended, but a task it delegated still runs and will wake the thread.
    let runs = [run(runId, 1, "completed", 1)];
    let subagents = [{ status: "running" }];
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: (input) =>
            input?.eventType === "subagent.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                  messages: [],
                  subagents,
                  providerThreads: [],
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    // Without the option, the ended run is the answer, as before.
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 }),
    ).toMatchObject({ timedOut: false, run: { id: runId } });
    expect(
      yield* service.waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 }),
    ).not.toHaveProperty("resultRun");

    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 60 * 60 * 1_000,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.forkChild);
    // A wait that returns early fails below instead of hanging here.
    yield* Effect.raceFirst(Deferred.await(subscribed), Fiber.await(fiber));
    // The task finishes; its delivery wakes the thread, whose next run answers.
    subagents = [{ status: "completed" }];
    runs = [...runs, run(wakeRunId, 2, "completed", 3)];
    yield* Queue.offer(events, stored(1, { type: "subagent.updated", payload: {} }));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: runId, status: "completed" },
      resultRun: { id: wakeRunId, status: "completed" },
    });
  }),
);

it.effect("waitForThread settles delegated work on a thread rolled back past its only run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-rolled-back");
    const threadId = ThreadId.make("thread:thread-management:wait-rolled-back");
    const runId = RunId.make("run:thread-management:wait-rolled-back");
    const rolledBack = {
      id: runId,
      ordinal: 1,
      status: "rolled_back",
      startedAt: DateTime.makeUnsafe(0),
      completedAt: DateTime.makeUnsafe(1_000),
    } as unknown as OrchestrationV2Run;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          delegatedTaskResultPending: () => Effect.succeed(false),
          streamStoredEventsFrom: () => Stream.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [rolledBack],
              messages: [],
              subagents: [],
              providerThreads: [],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 60_000,
        untilDelegatedWorkSettled: true,
      })
      .pipe(Effect.forkChild);
    // Nothing will ever run there again, so a wait still open runs out here.
    yield* TestClock.adjust(Duration.millis(60_000));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: runId, status: "rolled_back" },
      resultRun: { id: runId, status: "rolled_back" },
    });
  }),
);

it.effect("waitForThread returns the cut run once its continuation is declined", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-declined");
    const threadId = ThreadId.make("thread:thread-management:wait-declined");
    const runId = RunId.make("run:thread-management:wait-declined");
    const subscribed = yield* Deferred.make<void>();
    const declined = yield* Deferred.make<void>();
    let pending = true;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(pending),
          awaitRestartContinuation: () => Deferred.await(declined),
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.never),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status: "cancelled" }],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    pending = false;
    yield* Deferred.succeed(declined, undefined);
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "cancelled" } });
  }),
);

it.effect.each(["live", "no-session", "unsupported-runtime"] as const)(
  "marks background work awaited on the thread's active provider thread with state %s",
  (state) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:background-wait");
      const providerThreadId = ProviderThreadId.make("provider-thread:background-wait");
      const providerSessionId = ProviderSessionId.make("provider-session:background-wait");
      const driver = ProviderDriverKind.make("claudeAgent");
      const now = yield* DateTime.now;
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [{ taskId: "tests", kind: "command" }],
        contextUsage: null,
        nativeMetadata: null,
        createdAt: now,
        updatedAt: now,
      };
      const calls: Array<{ providerThreadId: ProviderThreadId; awaited: boolean }> = [];
      const runtime = {
        driver,
        providerSessionId,
        ...(state === "unsupported-runtime"
          ? {}
          : {
              awaitBackgroundTasks: (input: {
                readonly providerThread: OrchestrationV2ProviderThread;
                readonly taskIds: ReadonlyArray<string>;
                readonly awaited: boolean;
              }) =>
                Effect.sync(() => {
                  calls.push({
                    providerThreadId: input.providerThread.id,
                    awaited: input.awaited,
                  });
                  return { matched: input.taskIds.filter((taskId) => taskId === "tests") };
                }),
            }),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: threadId,
                    deletedAt: null,
                    activeProviderThreadId: providerThreadId,
                  },
                  providerThreads: [providerThread],
                } as unknown as OrchestrationV2ThreadProjection),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                Effect.succeed(state === "no-session" ? Option.none() : Option.some(runtime)),
            }),
          ),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const result = yield* Effect.gen(function* () {
        const service = yield* ThreadManagementService.ThreadManagementService;
        return yield* service
          .awaitBackgroundTasks({ threadId, taskIds: ["tests", "finished"], awaited: true })
          .pipe(Effect.result);
      }).pipe(Effect.provide(Layer.merge(layerTest, ThreadCommandExecutor.layer)));

      if (state === "live") {
        expect(result).toMatchObject({
          success: { matched: ["tests"], unmatched: ["finished"] },
        });
        expect(calls).toEqual([{ providerThreadId, awaited: true }]);
      } else {
        expect(result).toMatchObject({
          failure: {
            _tag: "ThreadManagementBackgroundWaitError",
            reason: state === "no-session" ? "unavailable" : "unsupported",
          },
        });
        expect(calls).toEqual([]);
      }
    }),
);

it.effect.each([
  { status: "completed" as const, followUp: "none", settles: true },
  { status: "failed" as const, followUp: "none", settles: false },
  { status: "interrupted" as const, followUp: "none", settles: false },
  { status: "completed" as const, followUp: "notification", settles: true },
  { status: "completed" as const, followUp: "replayed-notification", settles: true },
  { status: "completed" as const, followUp: "delegated", settles: true },
  { status: "completed" as const, followUp: "failed-notification", settles: false },
  { status: "completed" as const, followUp: "held-notification", settles: true },
  { status: "completed" as const, followUp: "user", settles: false },
  { status: "completed" as const, followUp: "steered-notification", settles: false },
])("settleAfterRun handles $status with $followUp follow-up", ({ status, followUp, settles }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const followUpId = RunId.make(`${runId}:follow-up`);
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const replayRejected = yield* Deferred.make<void>();
    let sequence = 0;
    let sequenceReads = 0;
    let rejectedCommandId: CommandId | undefined;
    const runs = [{ id: runId, ordinal: 1, status, userMessageId: MessageId.make("original") }];
    const nextRun = {
      id: followUpId,
      ordinal: 2,
      status: "running" as OrchestrationV2Run["status"],
      userMessageId: MessageId.make("follow-up"),
    };
    const dispatched: Array<string> = [];
    // The notification starts after the completed run was observed, before settlement commits.
    let raced = false;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () =>
            Effect.sync(() => {
              if (followUp === "replayed-notification" && sequenceReads++ === 2) sequence = 1;
              return sequence;
            }),
          restartContinuationPending: () => Effect.succeed(false),
          streamStoredEventsFrom: () =>
            Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.fromQueue(events)),
            ),
          getThreadRecords: (_threadId, _fields, filter) =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs: raced ? [...runs, nextRun] : runs,
                  messages: [
                    { id: MessageId.make("original"), runId, role: "user" as const },
                    {
                      id: nextRun.userMessageId,
                      runId: followUpId,
                      role: "user" as const,
                      ...(followUp.endsWith("notification") ? { notification: {} } : {}),
                      ...(followUp === "delegated" ? { delegatedCompletion: {} } : {}),
                    },
                    { id: MessageId.make("reply"), runId: followUpId, role: "assistant" as const },
                    ...(followUp === "steered-notification"
                      ? [
                          {
                            id: MessageId.make("user-steer"),
                            runId: followUpId,
                            role: "user" as const,
                          },
                        ]
                      : []),
                  ].filter(
                    (message) =>
                      (filter?.messageIds === undefined ||
                        filter.messageIds.includes(message.id)) &&
                      (filter?.messageRunIds === undefined ||
                        filter.messageRunIds.includes(message.runId)) &&
                      (filter?.messageRoles === undefined ||
                        filter.messageRoles.includes(message.role)),
                  ),
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
          dispatch: (command) =>
            Effect.gen(function* () {
              if (followUp !== "none" && !raced) {
                raced = true;
                rejectedCommandId = command.commandId;
                return yield* new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "Thread is still running",
                });
              }
              if (followUp === "replayed-notification" && command.commandId === rejectedCommandId) {
                yield* Deferred.succeed(replayRejected, undefined);
                return yield* new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
                  commandId: command.commandId,
                  commandType: command.type,
                  detail: "Thread is still running",
                });
              }
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .settleAfterRun({ projectId, threadId, runId })
      .pipe(Effect.forkChild);
    if (followUp !== "none") {
      yield* Deferred.await(subscribed);
      expect(dispatched).toEqual([]);
      nextRun.status =
        followUp === "failed-notification"
          ? "failed"
          : followUp === "held-notification"
            ? "queued"
            : "completed";
      yield* Queue.offer(events, {
        sequence: 1,
        event: { type: "run.updated", threadId, payload: nextRun },
      } as unknown as OrchestrationV2StoredEvent);
    }
    if (followUp === "replayed-notification") {
      yield* Deferred.await(replayRejected);
      expect(dispatched).toEqual([]);
      sequence = 2;
      yield* Queue.offer(events, {
        sequence,
        event: { type: "run.updated", threadId, payload: nextRun },
      } as unknown as OrchestrationV2StoredEvent);
    }
    yield* Fiber.join(fiber);
    expect(dispatched).toEqual(settles ? ["thread.settle"] : []);
  }),
);

it.effect.each([
  {
    name: "kills the thread's own agent and ends its turn",
    others: [] as ReadonlyArray<string>,
    killed: true,
    expected: { outcome: "killed", sharedWithThreadIds: [] },
    teardown: ["release"],
  },
  {
    name: "keeps a process another working thread shares and only ends this turn",
    others: ["thread:thread-management:force-stop:other"],
    killed: false,
    expected: {
      outcome: "shared",
      sharedWithThreadIds: ["thread:thread-management:force-stop:other"],
    },
    teardown: ["detach"],
  },
  {
    name: "still settles a finished run's background work in a shared process",
    others: ["thread:thread-management:force-stop:other"],
    killed: false,
    settledRun: true,
    expected: {
      outcome: "shared",
      sharedWithThreadIds: ["thread:thread-management:force-stop:other"],
    },
    teardown: ["detach"],
  },
  {
    name: "detaches when a sibling starts a turn just before the session is released",
    others: [] as ReadonlyArray<string>,
    killed: false,
    siblingBusy: true,
    expected: { outcome: "shared", sharedWithThreadIds: [] },
    teardown: ["release", "detach"],
  },
  {
    name: "reports a teardown that has not finished in time as still releasing",
    others: [] as ReadonlyArray<string>,
    killed: false,
    releaseHangs: true,
    expected: { outcome: "releasing", sharedWithThreadIds: [] },
    teardown: ["release"],
  },
])("Force stop $name", ({ others, killed, expected, teardown, ...row }) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:thread-management:force-stop");
    const providerSessionId = ProviderSessionId.make("provider-session:force-stop");
    const providerThreadId = ProviderThreadId.make("provider-thread:force-stop");
    const runId = RunId.make("run:thread-management:force-stop");
    const dispatched: Array<OrchestrationV2Command | { readonly type: string }> = [];
    const teardowns: Array<string> = [];
    const tornDown = yield* Deferred.make<void>();
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          isLive: () => Effect.succeed(true),
          otherWorkingThreads: () => Effect.succeed(others.map((id) => ThreadId.make(id))),
          releaseUnlessBusy: () =>
            Effect.sync(() => teardowns.push("release")).pipe(
              Effect.andThen(
                "releaseHangs" in row ? Effect.never : Effect.succeed(!("siblingBusy" in row)),
              ),
            ),
          detach: () =>
            Effect.sync(() => teardowns.push("detach")).pipe(
              Effect.andThen(Deferred.succeed(tornDown, undefined)),
              Effect.asVoid,
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, deletedAt: null },
              runs: [
                {
                  id: runId,
                  ordinal: 1,
                  status: "settledRun" in row ? "completed" : "running",
                  activeAttemptId: "attempt",
                },
                // A queued follow-up neither supersedes the request nor becomes the target.
                { id: RunId.make("run:queued-follow-up"), ordinal: 2, status: "queued" },
              ],
              providerThreads: [{ id: providerThreadId, appThreadId: threadId, providerSessionId }],
              providerTurns: [
                {
                  id: "provider-turn:force-stop",
                  providerThreadId,
                  runAttemptId: "attempt",
                  status: "settledRun" in row ? "completed" : "running",
                },
              ],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(
        Layer.succeed(AgentScope, {
          ...AgentScope.defaultValue(),
          kill: () => Effect.succeed(killed),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      const stopping = yield* service.forceStopThread({ threadId, runId }).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(stopping)).toEqual(expected);
      expect(dispatched).toMatchObject([
        {
          type: "thread.background-work.settle",
          providerThreadId,
          reason: "Force stopped by user",
        },
      ]);
      if (teardown.at(-1) === "detach") yield* Deferred.await(tornDown);
      expect(teardowns).toEqual(teardown);
    }).pipe(Effect.provide(layerTest));
  }),
);

it.effect("Force stop refuses once a newer run has started, before killing anything", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:thread-management:force-stop-superseded");
    let killed = false;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, deletedAt: null },
              runs: [
                { id: RunId.make("run:stopped"), ordinal: 1, status: "running" },
                { id: RunId.make("run:newer"), ordinal: 2, status: "running" },
              ],
              providerThreads: [],
              providerTurns: [],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(
        Layer.succeed(AgentScope, {
          ...AgentScope.defaultValue(),
          kill: () => Effect.sync(() => (killed = true)),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const error = yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      return yield* Effect.flip(
        service.forceStopThread({ threadId, runId: RunId.make("run:stopped") }),
      );
    }).pipe(Effect.provide(layerTest));
    expect(error.reason).toBe("superseded");
    expect(killed).toBe(false);
  }),
);

function subagentHandoffLayer(input: {
  readonly getThreadRecords: (
    threadId: ThreadId,
    fields: ReadonlyArray<string>,
    filter?: unknown,
  ) => unknown;
  readonly getThreadShell: (threadId: ThreadId) => unknown;
  readonly dispatched: Array<string>;
}) {
  return ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadRecords: ((threadId: ThreadId, fields: ReadonlyArray<string>, filter: unknown) =>
          Effect.succeed(input.getThreadRecords(threadId, fields, filter) as never)) as never,
        getThreadShell: ((threadId: ThreadId) =>
          Effect.succeed(input.getThreadShell(threadId) as never)) as never,
        dispatch: ((command: { readonly type: string }) =>
          Effect.sync(() => {
            input.dispatched.push(command.type);
            return { sequence: 1, storedEvents: [] } as never;
          })) as never,
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );
}

function handoffFixture() {
  const parentThreadId = ThreadId.make("thread:handoff:parent");
  const childThreadId = ThreadId.make("thread:handoff:child");
  const parentRunId = RunId.make("run:handoff:parent");
  const taskAId = NodeId.make("node:handoff:task-a");
  const taskBId = NodeId.make("node:handoff:task-b");
  const childProviderThreadId = ProviderThreadId.make("provider-thread:handoff:child");
  const attemptA = "attempt:handoff:a";
  const attemptB = "attempt:handoff:b";
  const at = DateTime.makeUnsafe("2026-11-11T01:00:00.000Z");
  const later = DateTime.makeUnsafe("2026-11-11T01:05:00.000Z");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "requested-model",
  };
  const run = (
    id: RunId,
    ordinal: number,
    delegatedTaskId: NodeId,
    activeAttemptId: string,
  ): OrchestrationV2Run => ({
    id,
    threadId: childThreadId,
    ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: childProviderThreadId,
    userMessageId: MessageId.make(`message:${id}:user`),
    rootNodeId: NodeId.make("node:handoff:child-root"),
    activeAttemptId: activeAttemptId as never,
    status: "completed",
    requestedAt: at,
    startedAt: at,
    completedAt: later,
    checkpointId: null,
    contextHandoffId: null,
    delegatedTaskId,
  });
  const runA = run(RunId.make("run:handoff:a"), 1, taskAId, attemptA);
  const runB = run(RunId.make("run:handoff:b"), 2, taskBId, attemptB);
  const task = (
    id: NodeId,
    result: string | null,
    status: "running" | "completed",
  ): OrchestrationV2ThreadProjection["subagents"][number] =>
    ({
      id,
      threadId: parentThreadId,
      runId: parentRunId,
      parentNodeId: NodeId.make("node:handoff:parent-root"),
      origin: "app_owned",
      createdBy: "agent",
      driver: "codex",
      providerInstanceId: modelSelection.instanceId,
      providerThreadId: null,
      childThreadId,
      nativeTaskRef: null,
      prompt: `Prompt ${id}`,
      title: null,
      model: "requested-model",
      modelSelection,
      completionWake: "always",
      status,
      result,
      startedAt: at,
      completedAt: status === "completed" ? later : null,
      updatedAt: later,
    }) as never;
  const taskA = task(taskAId, "Parent delivery A", "completed");
  const taskB = task(taskBId, "Parent delivery B", "completed");
  const artifact = (
    runId: RunId,
    id: string,
    text: string,
    ordinal: number,
  ): {
    readonly message: OrchestrationV2ThreadProjection["messages"][number];
    readonly turnItem: OrchestrationV2ThreadProjection["turnItems"][number];
  } => ({
    message: {
      createdBy: "agent",
      creationSource: "provider",
      id: MessageId.make(`message:${id}`),
      threadId: childThreadId,
      runId,
      nodeId: NodeId.make("node:handoff:child-root"),
      role: "assistant",
      text,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: later,
    } as never,
    turnItem: {
      id: TurnItemId.make(`item:${id}`),
      threadId: childThreadId,
      runId,
      nodeId: NodeId.make("node:handoff:child-root"),
      providerThreadId: childProviderThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed",
      type: "assistant_message",
      title: null,
      startedAt: at,
      completedAt: later,
      updatedAt: later,
      messageId: MessageId.make(`message:${id}`),
      text,
      streaming: false,
    } as never,
  });
  const final = artifact(runA.id, "handoff-final", "Final result A", 2);
  const laterCommentary = artifact(runA.id, "handoff-later", "Later commentary", 3);
  const other = artifact(runB.id, "handoff-other", "Result B", 4);
  const providerThread = {
    id: childProviderThreadId,
    nativeThreadRef: { driver: "codex", nativeId: "native-thread", strength: "strong" },
  };
  const providerTurn = {
    id: "provider-turn:handoff:a",
    providerThreadId: childProviderThreadId,
    runAttemptId: attemptA,
    nativeTurnRef: { driver: "codex", nativeId: "native-turn", strength: "strong" },
    ordinal: 1,
    model: "executed-model-a",
  };
  const transfer = (id: string, sourceRun: OrchestrationV2Run, turnItemId: string) =>
    ({
      id,
      type: "subagent_result",
      sourceThreadId: childThreadId,
      targetThreadId: parentThreadId,
      sourcePoint: {
        threadId: childThreadId,
        runId: sourceRun.id,
        turnItemId,
        providerThreadRef: providerThread.nativeThreadRef,
        providerTurnRef: providerTurn.nativeTurnRef,
      },
      basePoint: null,
      sourceProviderInstanceId: modelSelection.instanceId,
      targetProviderInstanceId: modelSelection.instanceId,
      targetRunId: parentRunId,
      status: "consumed",
      resolution: null,
      createdBy: "system",
      error: null,
      createdAt: later,
      updatedAt: later,
      consumedAt: later,
    }) as never;
  const transfers = [
    transfer("transfer:a", runA, final.turnItem.id),
    transfer("transfer:b", runB, other.turnItem.id),
  ];
  return {
    parentThreadId,
    childThreadId,
    parentRunId,
    runA,
    runB,
    taskA,
    taskB,
    final,
    laterCommentary,
    other,
    providerThread,
    providerTurn,
    transfers,
  };
}

it.effect("reads one round's exact child result and model without side effects", () =>
  Effect.gen(function* () {
    const fixture = handoffFixture();
    const dispatched: Array<string> = [];
    const reads: Array<{
      readonly threadId: ThreadId;
      readonly fields: ReadonlyArray<string>;
      readonly filter: unknown;
    }> = [];
    const layerTest = subagentHandoffLayer({
      dispatched,
      getThreadShell: () => ({
        id: fixture.childThreadId,
        lineage: {
          parentThreadId: fixture.parentThreadId,
          relationshipToParent: "subagent",
          rootThreadId: fixture.parentThreadId,
        },
        deletedAt: null,
      }),
      getThreadRecords: (threadId, fields, filter) => {
        reads.push({ threadId, fields, filter });
        if (threadId === fixture.parentThreadId) {
          return {
            thread: { id: fixture.parentThreadId },
            subagents: [fixture.taskA, fixture.taskB],
            contextTransfers: fixture.transfers,
          };
        }
        return {
          thread: { id: fixture.childThreadId },
          runs: [fixture.runA, fixture.runB],
          contextTransfers: [],
          providerThreads: [fixture.providerThread],
          providerTurns: [fixture.providerTurn],
          messages: [fixture.final.message, fixture.laterCommentary.message, fixture.other.message],
          turnItems: [
            fixture.final.turnItem,
            fixture.laterCommentary.turnItem,
            fixture.other.turnItem,
          ],
        };
      },
    });
    const handoff = yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      return yield* service.getSubagentHandoff({
        parentThreadId: fixture.parentThreadId,
        subagentId: fixture.taskA.id,
      });
    }).pipe(Effect.provide(layerTest));

    expect(handoff).toMatchObject({
      subagentId: fixture.taskA.id,
      childRunId: fixture.runA.id,
      completionDelivery: null,
      requestedModel: {
        model: "requested-model",
        selection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "requested-model",
        },
      },
      executedModel: "executed-model-a",
      roundAssociation: "run_delegated_task_id",
      target: { kind: "local", threadId: fixture.childThreadId },
      childThreadState: "available",
      result: {
        source: "child_run",
        messageId: fixture.final.message.id,
        turnItemId: fixture.final.turnItem.id,
      },
      navigation: { kind: "result", messageId: fixture.final.message.id },
    });
    expect(handoff?.result.body.text).toBe("Final result A");
    expect(dispatched).toEqual([]);
    expect(
      reads.find(
        (read) =>
          read.threadId === fixture.childThreadId && read.fields.join() === "messages,turnItems",
      )?.filter,
    ).toMatchObject({ messageRunIds: [fixture.runA.id], turnItemRunId: fixture.runA.id });
    expect(
      reads.find(
        (read) =>
          read.threadId === fixture.parentThreadId && read.fields.join() === "contextTransfers",
      )?.filter,
    ).toMatchObject({
      contextTransferTypes: ["subagent_result"],
      contextTransferSourceThreadIds: [fixture.childThreadId],
      contextTransferTargetThreadIds: [fixture.parentThreadId],
      contextTransferTargetRunIds: [fixture.parentRunId],
    });
  }),
);

it.effect("resolves a spawn task through unbound restart continuations", () =>
  Effect.gen(function* () {
    const fixture = handoffFixture();
    const spawnRun = {
      ...fixture.runA,
      id: RunId.make("run:handoff:spawn"),
      ordinal: 1,
      delegatedTaskId: undefined,
      activeAttemptId: "attempt:handoff:spawn" as never,
      userMessageId: MessageId.make("message:handoff:spawn:user"),
    };
    const continuation1 = {
      ...spawnRun,
      id: RunId.make("run:handoff:continuation-1"),
      ordinal: 2,
      restartContinuationOfRunId: spawnRun.id,
      activeAttemptId: "attempt:handoff:continuation-1" as never,
      userMessageId: MessageId.make("message:handoff:continuation-1:user"),
    };
    const continuation2 = {
      ...spawnRun,
      id: RunId.make("run:handoff:continuation-2"),
      ordinal: 3,
      restartContinuationOfRunId: continuation1.id,
      activeAttemptId: "attempt:handoff:continuation-2" as never,
      userMessageId: MessageId.make("message:handoff:continuation-2:user"),
    };
    const unrelated = {
      ...spawnRun,
      id: RunId.make("run:handoff:unrelated"),
      ordinal: 4,
      activeAttemptId: "attempt:handoff:unrelated" as never,
      userMessageId: MessageId.make("message:handoff:unrelated:user"),
    };
    const resultMessageId = MessageId.make("message:handoff:continuation-2:result");
    const continuationResult = {
      message: {
        ...fixture.final.message,
        id: resultMessageId,
        runId: continuation2.id,
        text: "Continuation two result",
      },
      turnItem: {
        ...fixture.final.turnItem,
        id: TurnItemId.make("item:handoff:continuation-2:result"),
        runId: continuation2.id,
        messageId: resultMessageId,
        text: "Continuation two result",
      },
    };
    const unrelatedResult = {
      message: {
        ...fixture.other.message,
        id: MessageId.make("message:handoff:unrelated:result"),
        runId: unrelated.id,
        text: "Unrelated later result",
      },
      turnItem: {
        ...fixture.other.turnItem,
        id: TurnItemId.make("item:handoff:unrelated:result"),
        runId: unrelated.id,
        messageId: MessageId.make("message:handoff:unrelated:result"),
        text: "Unrelated later result",
      },
    };
    const providerTurns = [spawnRun, continuation1, continuation2, unrelated].map((run, index) => ({
      ...fixture.providerTurn,
      id: `provider-turn:handoff:${run.id}`,
      runAttemptId: run.activeAttemptId,
      ordinal: index + 1,
      model: `executed-model-${index + 1}`,
    }));
    const resultTransfer = {
      ...(fixture.transfers[0] as unknown as OrchestrationV2ContextTransfer),
      id: "transfer:handoff:continuation-2" as OrchestrationV2ContextTransfer["id"],
      sourcePoint: {
        threadId: fixture.childThreadId,
        runId: continuation2.id,
        turnItemId: continuationResult.turnItem.id,
      },
    } satisfies OrchestrationV2ContextTransfer;
    const spawnTransfer = {
      ...(fixture.transfers[0] as unknown as OrchestrationV2ContextTransfer),
      id: "transfer:handoff:spawn" as OrchestrationV2ContextTransfer["id"],
      type: "subagent_spawn",
      sourceThreadId: fixture.parentThreadId,
      targetThreadId: fixture.childThreadId,
      sourcePoint: { threadId: fixture.parentThreadId },
      targetRunId: spawnRun.id,
    } satisfies OrchestrationV2ContextTransfer;
    const layerTest = subagentHandoffLayer({
      dispatched: [],
      getThreadShell: () => ({
        id: fixture.childThreadId,
        lineage: {
          parentThreadId: fixture.parentThreadId,
          relationshipToParent: "subagent",
          rootThreadId: fixture.parentThreadId,
        },
        deletedAt: null,
      }),
      getThreadRecords: (threadId, fields) => {
        if (threadId === fixture.parentThreadId) {
          return {
            thread: { id: threadId },
            subagents: [fixture.taskA],
            ...(fields.includes("contextTransfers") ? { contextTransfers: [resultTransfer] } : {}),
          };
        }
        return {
          thread: {
            id: threadId,
            forkedFrom: { type: "node", nodeId: fixture.taskA.id },
          },
          runs: [spawnRun, continuation1, continuation2, unrelated],
          contextTransfers: [spawnTransfer],
          providerThreads: [fixture.providerThread],
          providerTurns,
          messages: [continuationResult.message, unrelatedResult.message],
          turnItems: [continuationResult.turnItem, unrelatedResult.turnItem],
        };
      },
    });
    const handoff = yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      return yield* service.getSubagentHandoff({
        parentThreadId: fixture.parentThreadId,
        subagentId: fixture.taskA.id,
      });
    }).pipe(Effect.provide(layerTest));

    expect(handoff).toMatchObject({
      childRunId: continuation2.id,
      executedModel: "executed-model-3",
      roundAssociation: "spawn_transfer",
      result: {
        source: "child_run",
        messageId: continuationResult.message.id,
        turnItemId: continuationResult.turnItem.id,
      },
      navigation: { kind: "result", messageId: continuationResult.message.id },
    });
    expect(handoff?.result.body.text).toBe("Continuation two result");
  }),
);

it.effect("does not use an invalid transfer anchor or fall back to child latest", () =>
  Effect.gen(function* () {
    const fixture = handoffFixture();
    const transfers = fixture.transfers.map((transfer, index) => {
      if (index !== 0) return transfer;
      const typed = transfer as unknown as OrchestrationV2ContextTransfer;
      return {
        ...typed,
        sourcePoint: {
          ...typed.sourcePoint,
          providerTurnRef: {
            driver: ProviderDriverKind.make("codex"),
            nativeId: "other-turn",
            strength: "strong",
          },
        },
      } satisfies OrchestrationV2ContextTransfer;
    });
    const layerTest = subagentHandoffLayer({
      dispatched: [],
      getThreadShell: () => ({
        id: fixture.childThreadId,
        lineage: {
          parentThreadId: fixture.parentThreadId,
          relationshipToParent: "subagent",
          rootThreadId: fixture.parentThreadId,
        },
        deletedAt: null,
      }),
      getThreadRecords: (threadId, fields) => {
        if (threadId === fixture.parentThreadId) {
          return {
            thread: { id: threadId },
            subagents: [fixture.taskA, fixture.taskB],
            ...(fields.includes("contextTransfers") ? { contextTransfers: transfers } : {}),
          };
        }
        return {
          thread: { id: threadId },
          runs: [fixture.runA, fixture.runB],
          contextTransfers: [],
          providerThreads: [fixture.providerThread],
          providerTurns: [fixture.providerTurn],
          messages: [fixture.final.message, fixture.laterCommentary.message, fixture.other.message],
          turnItems: [
            fixture.final.turnItem,
            fixture.laterCommentary.turnItem,
            fixture.other.turnItem,
          ],
        };
      },
    });
    const handoff = yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      return yield* service.getSubagentHandoff({
        parentThreadId: fixture.parentThreadId,
        subagentId: fixture.taskA.id,
      });
    }).pipe(Effect.provide(layerTest));

    expect(handoff).toMatchObject({
      childRunId: null,
      executedModel: null,
      roundAssociation: "unavailable",
      navigation: null,
      result: {
        source: "parent_record",
        messageId: null,
        turnItemId: null,
      },
    });
    expect(handoff?.result.body.text).toBe("Parent delivery A");
  }),
);

it.effect("keeps a remote task bound to its recorded environment without remote reads", () =>
  Effect.gen(function* () {
    const fixture = handoffFixture();
    const remoteEnvironmentId = EnvironmentId.make("environment:handoff:remote");
    const remoteThreadId = ThreadId.make("thread:handoff:remote-child");
    const remoteRunId = RunId.make("run:handoff:remote-child");
    const task = {
      ...fixture.taskA,
      childThreadId: null,
      remoteChild: {
        environmentId: remoteEnvironmentId,
        threadId: remoteThreadId,
        label: "Remote machine",
        runId: remoteRunId,
      },
    };
    const reads: ThreadId[] = [];
    const layerTest = subagentHandoffLayer({
      dispatched: [],
      getThreadShell: () => {
        throw new Error("remote handoff must not read a local child shell");
      },
      getThreadRecords: (threadId) => {
        reads.push(threadId);
        return {
          thread: { id: threadId },
          subagents: [task],
        };
      },
    });
    const handoff = yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      return yield* service.getSubagentHandoff({
        parentThreadId: fixture.parentThreadId,
        subagentId: task.id,
      });
    }).pipe(Effect.provide(layerTest));

    expect(reads).toEqual([fixture.parentThreadId]);
    expect(handoff).toMatchObject({
      childRunId: null,
      executedModel: null,
      roundAssociation: "unavailable",
      navigation: null,
      result: { source: "parent_record" },
      target: {
        kind: "remote",
        environmentId: remoteEnvironmentId,
        threadId: remoteThreadId,
        runId: remoteRunId,
      },
      childThreadState: "unknown",
    });
  }),
);

it.effect("does not expose T3 handoff semantics for a provider-native subagent", () =>
  Effect.gen(function* () {
    const fixture = handoffFixture();
    const task = { ...fixture.taskA, origin: "provider_native" as const };
    const layerTest = subagentHandoffLayer({
      dispatched: [],
      getThreadShell: () => {
        throw new Error("provider-native handoff must not read a child shell");
      },
      getThreadRecords: (threadId) => ({
        thread: { id: threadId },
        subagents: [task],
      }),
    });
    const handoff = yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      return yield* service.getSubagentHandoff({
        parentThreadId: fixture.parentThreadId,
        subagentId: task.id,
      });
    }).pipe(Effect.provide(layerTest));

    expect(handoff).toBeNull();
  }),
);

it.effect("falls back to the parent record when the child thread was deleted", () =>
  Effect.gen(function* () {
    const fixture = handoffFixture();
    const dispatched: Array<string> = [];
    const reads: Array<{ readonly threadId: ThreadId; readonly fields: ReadonlyArray<string> }> =
      [];
    const layerTest = subagentHandoffLayer({
      dispatched,
      getThreadShell: () => ({
        id: fixture.childThreadId,
        lineage: {
          parentThreadId: fixture.parentThreadId,
          relationshipToParent: "subagent",
          rootThreadId: fixture.parentThreadId,
        },
        deletedAt: DateTime.makeUnsafe("2026-11-11T02:00:00.000Z"),
      }),
      getThreadRecords: (threadId, fields) => {
        reads.push({ threadId, fields });
        return {
          thread: { id: threadId },
          subagents: [fixture.taskA],
          contextTransfers: fixture.transfers,
        };
      },
    });
    const handoff = yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      return yield* service.getSubagentHandoff({
        parentThreadId: fixture.parentThreadId,
        subagentId: fixture.taskA.id,
      });
    }).pipe(Effect.provide(layerTest));

    expect(handoff).toMatchObject({
      childThreadState: "deleted",
      childRunId: null,
      roundAssociation: "unavailable",
      executedModel: null,
      result: { source: "parent_record", messageId: null, turnItemId: null },
    });
    expect(handoff?.result.body.text).toBe("Parent delivery A");
    expect(reads.every((read) => read.threadId === fixture.parentThreadId)).toBe(true);
    expect(dispatched).toEqual([]);
  }),
);

it.effect("does not present commentary as a final result for an active round", () =>
  Effect.gen(function* () {
    const fixture = handoffFixture();
    const activeTask = {
      ...fixture.taskA,
      result: null,
      status: "running" as const,
      completedAt: null,
    };
    const layerTest = subagentHandoffLayer({
      dispatched: [],
      getThreadShell: () => ({
        id: fixture.childThreadId,
        lineage: {
          parentThreadId: fixture.parentThreadId,
          relationshipToParent: "subagent",
          rootThreadId: fixture.parentThreadId,
        },
        deletedAt: null,
      }),
      getThreadRecords: (threadId) => ({
        thread: { id: threadId },
        subagents: [activeTask],
        contextTransfers: fixture.transfers,
        runs: [fixture.runA, fixture.runB],
        providerThreads: [fixture.providerThread],
        providerTurns: [fixture.providerTurn],
        messages: [fixture.final.message, fixture.laterCommentary.message],
        turnItems: [fixture.final.turnItem, fixture.laterCommentary.turnItem],
      }),
    });
    const handoff = yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      return yield* service.getSubagentHandoff({
        parentThreadId: fixture.parentThreadId,
        subagentId: fixture.taskA.id,
      });
    }).pipe(Effect.provide(layerTest));

    expect(handoff).toMatchObject({
      executionStatus: "running",
      result: {
        source: null,
        body: { availability: "unavailable", text: "" },
      },
      navigation: { kind: "round", messageId: fixture.runA.userMessageId },
    });
  }),
);

it.effect("pages a handoff body, restarts a changed revision, and reports a stale offset", () =>
  Effect.gen(function* () {
    const fixture = handoffFixture();
    const task = {
      ...fixture.taskA,
      prompt: "0123456789",
      result: "abcdefghij",
      status: "running" as const,
      completedAt: null,
    };
    const deliveryRevision = `parent:${task.id}:none:${DateTime.formatIso(task.updatedAt)}`;
    const layerTest = subagentHandoffLayer({
      dispatched: [],
      getThreadShell: () => ({
        id: fixture.childThreadId,
        lineage: {
          parentThreadId: fixture.parentThreadId,
          relationshipToParent: "subagent",
          rootThreadId: fixture.parentThreadId,
        },
        deletedAt: DateTime.makeUnsafe("2026-11-11T02:00:00.000Z"),
      }),
      getThreadRecords: (threadId) => ({
        thread: { id: threadId },
        subagents: [task],
      }),
    });
    const handoffs = yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      return yield* Effect.all([
        service.getSubagentHandoff({
          parentThreadId: fixture.parentThreadId,
          subagentId: task.id,
          maxChars: 4,
        }),
        service.getSubagentHandoff({
          parentThreadId: fixture.parentThreadId,
          subagentId: task.id,
          promptOffset: 4,
          maxChars: 4,
        }),
        service.getSubagentHandoff({
          parentThreadId: fixture.parentThreadId,
          subagentId: task.id,
          promptOffset: 20,
          maxChars: 4,
        }),
        service.getSubagentHandoff({
          parentThreadId: fixture.parentThreadId,
          subagentId: task.id,
          deliveryOffset: 4,
          revisions: {
            prompt: `prompt:${task.id}`,
            result: "result:unchanged",
            delivery: "parent:stale",
          },
          maxChars: 4,
        }),
        service.getSubagentHandoff({
          parentThreadId: fixture.parentThreadId,
          subagentId: task.id,
          deliveryOffset: 4,
          revisions: {
            prompt: `prompt:${task.id}`,
            result: "result:unchanged",
            delivery: deliveryRevision,
          },
          maxChars: 4,
        }),
        service.getSubagentHandoff({
          parentThreadId: fixture.parentThreadId,
          subagentId: task.id,
          resultOffset: 4,
          revisions: {
            prompt: `prompt:${task.id}`,
            result: deliveryRevision,
            delivery: deliveryRevision,
          },
          maxChars: 4,
        }),
      ]);
    }).pipe(Effect.provide(layerTest));

    expect(handoffs[0]?.prompt).toMatchObject({
      availability: "available",
      text: "0123",
      nextOffset: 4,
    });
    expect(handoffs[0]?.result.body).toMatchObject({
      availability: "available",
      text: "abcd",
      nextOffset: 4,
    });
    expect(handoffs[1]?.prompt).toMatchObject({
      availability: "available",
      text: "4567",
      nextOffset: 8,
    });
    expect(handoffs[2]?.prompt).toMatchObject({
      availability: "unavailable",
      text: "",
      nextOffset: null,
    });
    expect(handoffs[3]?.deliveryResult).toMatchObject({
      availability: "available",
      revision: deliveryRevision,
      text: "abcd",
      nextOffset: 4,
    });
    expect(handoffs[4]?.deliveryResult).toMatchObject({
      availability: "available",
      text: "efgh",
      nextOffset: 8,
    });
    expect(handoffs[5]?.result.body).toMatchObject({
      availability: "available",
      revision: deliveryRevision,
      text: "efgh",
      nextOffset: 8,
    });
  }),
);
