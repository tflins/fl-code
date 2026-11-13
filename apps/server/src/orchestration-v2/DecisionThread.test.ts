// @effect-diagnostics nodeBuiltinImport:off -- The test places an isolated SQLite file beside its workspace.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodePath from "node:path";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection: ModelSelection = { instanceId, model: "test-model" };

type HarnessOptions = {
  readonly supportsActiveSteering?: boolean;
  readonly activeSteeringInterruptsTools?: boolean;
  readonly supportsQueuedMessages?: boolean;
};

function makeHarness(name: string, options: HarnessOptions = {}) {
  return Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
    const steered: string[] = [];
    const capabilities = {
      ...CodexProviderCapabilitiesV2,
      turns: {
        ...CodexProviderCapabilitiesV2.turns,
        supportsActiveSteering: options.supportsActiveSteering ?? true,
        ...(options.activeSteeringInterruptsTools === undefined
          ? {}
          : { activeSteeringInterruptsTools: options.activeSteeringInterruptsTools }),
        supportsQueuedMessages: options.supportsQueuedMessages ?? true,
      },
    };
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(capabilities),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          return {
            instanceId,
            driver,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd,
              model: modelSelection.model,
              capabilities,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events),
            ensureThread: ({ threadId }) =>
              Effect.succeed({
                id: ProviderThreadId.make(`provider-thread:${threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }),
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: (turn) =>
              Effect.gen(function* () {
                started.push(turn);
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native:${turn.attemptId}`,
                      strength: "strong",
                    },
                    ordinal: turn.providerTurnOrdinal,
                    status: "running",
                    startedAt: now,
                    completedAt: null,
                  },
                });
              }),
            steerTurn: (turn) =>
              Effect.sync(() => {
                steered.push(turn.message.text);
              }),
            interruptTurn: () => Effect.void,
            respondToRuntimeRequest: () => Effect.void,
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: () => Effect.die("unused"),
            forkThread: () => Effect.die("unused"),
          };
        }),
    };
    const registryLayer = ProviderAdapterRegistry.layerSingle(adapter);
    const layer = ProviderReplayHarness.layerWithRegistry({ name }, registryLayer, {
      runEffectWorker: false,
    });
    return { cwd, started, steered, layer, registryLayer } as const;
  });
}

const createSourceThread = Effect.fn("DecisionThreadTest.createSourceThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly modelSelection?: ModelSelection;
}) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${input.threadId}`),
    threadId: input.threadId,
    projectId: input.projectId,
    title: "Execution thread",
    modelSelection: input.modelSelection ?? modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.cwd,
    createdBy: "user",
    creationSource: "web",
  });
});

const createDecisionThread = Effect.fn("DecisionThreadTest.createDecisionThread")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly cwd: string;
    readonly sourceThreadId: ThreadId;
    readonly question?: string;
    readonly context?: string;
  }) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: "Decision",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      branch: null,
      worktreePath: input.cwd,
      createdBy: "agent",
      creationSource: "mcp",
      decision: {
        sourceThreadId: input.sourceThreadId,
        question: input.question ?? "Which cache policy should we use?",
        ...(input.context === undefined ? {} : { context: input.context }),
      },
    });
  },
);

const startSourceRun = Effect.fn("DecisionThreadTest.startSourceRun")(function* (input: {
  readonly threadId: ThreadId;
  readonly messageId: string;
}) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  const running = yield* orchestrator.streamDomainEvents.pipe(
    Stream.filter(
      (event) =>
        event.type === "provider-turn.updated" &&
        event.threadId === input.threadId &&
        event.payload.status === "running",
    ),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped,
  );
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`start:${input.threadId}`),
    threadId: input.threadId,
    messageId: MessageId.make(input.messageId),
    text: "Keep the source work moving.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  yield* worker.drain();
  yield* Fiber.join(running);
});

const confirmDecision = Effect.fn("DecisionThreadTest.confirmDecision")(function* (input: {
  readonly threadId: ThreadId;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly answer: string;
}) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const result = yield* orchestrator.dispatch({
    type: "decision.confirm",
    commandId: CommandId.make(input.commandId),
    threadId: input.threadId,
    expectedRevision: input.expectedRevision,
    answer: input.answer,
  });
  if (result.decisionResult?.type !== "confirm") {
    return yield* Effect.die("decision.confirm did not produce a decision result");
  }
  return result.decisionResult;
});

it.effect("keeps the discussion out of the source and returns the confirmed answer once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer, started } = yield* makeHarness("decision-idle-confirm");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sourceThreadId = ThreadId.make("thread:decision-idle-source");
        const decisionThreadId = ThreadId.make("thread:decision-idle");
        const projectId = ProjectId.make("project:decision-idle");
        yield* createSourceThread({ threadId: sourceThreadId, projectId, cwd });
        yield* createDecisionThread({
          threadId: decisionThreadId,
          projectId,
          cwd,
          sourceThreadId,
          context: "Only the cache reader and retention job matter.",
        });
        const shell = yield* orchestrator.getThreadShell(decisionThreadId);
        assert.equal(shell?.decision?.sourceThreadId, sourceThreadId);
        assert.equal(shell?.decision?.question, "Which cache policy should we use?");
        assert.equal(shell?.lineage.parentThreadId, null);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("discussion"),
          threadId: decisionThreadId,
          messageId: MessageId.make("message:discussion"),
          text: "Let's compare keeping deleted-file usage with dropping it.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();

        const sourceBefore = yield* orchestrator.getThreadProjection(sourceThreadId);
        assert.equal(sourceBefore.messages.length, 0);

        const confirmed = yield* confirmDecision({
          threadId: decisionThreadId,
          commandId: "confirm:idle",
          expectedRevision: 1,
          answer: "Keep deleted-file usage for 30 days.",
        });
        assert.equal(confirmed.delivery, "queued");
        assert.equal(confirmed.decision.status, "completed");
        assert.equal(confirmed.decision.revision, 2);

        yield* worker.drain();
        const sourceAfter = yield* orchestrator.getThreadProjection(sourceThreadId);
        const decisionAfter = yield* orchestrator.getThreadProjection(decisionThreadId);
        assert.equal(sourceAfter.messages.length, 1);
        assert.include(sourceAfter.messages[0]!.text, "Keep deleted-file usage for 30 days.");
        assert.equal(sourceAfter.messages[0]!.id, confirmed.sourceMessageId);
        assert.equal(decisionAfter.thread.decision?.status, "completed");
        assert.equal(
          decisionAfter.thread.decision?.finalAnswer,
          "Keep deleted-file usage for 30 days.",
        );
        assert.equal(started.length, 2);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect.each([
  { name: "steering", supportsActiveSteering: true, delivery: "steered" as const },
  { name: "unsupported", supportsActiveSteering: false, delivery: "queued" as const },
  {
    name: "interrupting-tools",
    supportsActiveSteering: true,
    activeSteeringInterruptsTools: true,
    delivery: "queued" as const,
  },
])(
  "confirms into an active source as $delivery ($name)",
  ({ name, supportsActiveSteering, activeSteeringInterruptsTools, delivery }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { cwd, layer, steered } = yield* makeHarness(`decision-active-${name}`, {
          supportsActiveSteering,
          ...(activeSteeringInterruptsTools === undefined ? {} : { activeSteeringInterruptsTools }),
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sourceThreadId = ThreadId.make(`thread:decision-active-source:${name}`);
          const decisionThreadId = ThreadId.make(`thread:decision-active:${name}`);
          const projectId = ProjectId.make(`project:decision-active:${name}`);
          yield* createSourceThread({ threadId: sourceThreadId, projectId, cwd });
          yield* createDecisionThread({
            threadId: decisionThreadId,
            projectId,
            cwd,
            sourceThreadId,
          });
          yield* startSourceRun({
            threadId: sourceThreadId,
            messageId: `message:active-source:${name}`,
          });

          const confirmed = yield* confirmDecision({
            threadId: decisionThreadId,
            commandId: `confirm:active:${name}`,
            expectedRevision: 1,
            answer: "Use the bounded cache.",
          });
          assert.equal(confirmed.delivery, delivery);
          const replay = yield* confirmDecision({
            threadId: decisionThreadId,
            commandId: `confirm:active:${name}`,
            expectedRevision: 1,
            answer: "Use the bounded cache.",
          });
          assert.equal(replay.sourceMessageId, confirmed.sourceMessageId);
          assert.equal(replay.delivery, delivery);

          yield* worker.drain();
          assert.equal(steered.length, delivery === "steered" ? 1 : 0);
          const source = yield* orchestrator.getThreadProjection(sourceThreadId);
          assert.equal(
            source.messages.filter((message) => message.id === confirmed.sourceMessageId).length,
            1,
          );
          if (delivery === "queued") {
            assert.isTrue(
              source.runs.some(
                (run) => run.userMessageId === confirmed.sourceMessageId && run.status === "queued",
              ),
            );
          }
        }).pipe(Effect.provide(layer));
      }),
    ),
);

it.effect("replays a confirmation without duplicating the answer and rejects stale submits", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer } = yield* makeHarness("decision-replay");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sourceThreadId = ThreadId.make("thread:decision-replay-source");
        const decisionThreadId = ThreadId.make("thread:decision-replay");
        const projectId = ProjectId.make("project:decision-replay");
        yield* createSourceThread({ threadId: sourceThreadId, projectId, cwd });
        yield* createDecisionThread({
          threadId: decisionThreadId,
          projectId,
          cwd,
          sourceThreadId,
        });

        const attempts = yield* Effect.forEach(
          ["a", "b"],
          (client) =>
            confirmDecision({
              threadId: decisionThreadId,
              commandId: `confirm:client-${client}`,
              expectedRevision: 1,
              answer: client === "a" ? "Keep the cache." : "Drop the cache.",
            }).pipe(Effect.exit),
          { concurrency: "unbounded" },
        );
        assert.equal(attempts.filter(Exit.isSuccess).length, 1);
        assert.equal(attempts.filter(Exit.isFailure).length, 1);
        const winner = Exit.isSuccess(attempts[0]!) ? 0 : 1;
        const accepted = attempts[winner]!;
        if (Exit.isFailure(accepted)) return yield* Effect.die("unreachable");
        const first = accepted.value;
        const replay = yield* confirmDecision({
          threadId: decisionThreadId,
          commandId: winner === 0 ? "confirm:client-a" : "confirm:client-b",
          expectedRevision: 1,
          answer: winner === 0 ? "Keep the cache." : "Drop the cache.",
        });
        assert.equal(replay.sourceMessageId, first.sourceMessageId);

        const stale = yield* confirmDecision({
          threadId: decisionThreadId,
          commandId: "confirm:stale",
          expectedRevision: 1,
          answer: "Drop the cache.",
        }).pipe(Effect.flip);
        assert.equal(stale._tag, "OrchestratorDispatchError");

        yield* worker.drain();
        const source = yield* orchestrator.getThreadProjection(sourceThreadId);
        assert.equal(source.messages.length, 1);
        assert.equal(source.messages[0]!.id, first.sourceMessageId);
        const decision = yield* orchestrator.getThreadProjection(decisionThreadId);
        assert.equal(decision.thread.decision?.revision, 2);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("cancels without an answer and leaves the active source running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer } = yield* makeHarness("decision-cancel");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sourceThreadId = ThreadId.make("thread:decision-cancel-source");
        const decisionThreadId = ThreadId.make("thread:decision-cancel");
        const projectId = ProjectId.make("project:decision-cancel");
        yield* createSourceThread({ threadId: sourceThreadId, projectId, cwd });
        yield* createDecisionThread({
          threadId: decisionThreadId,
          projectId,
          cwd,
          sourceThreadId,
        });
        yield* startSourceRun({
          threadId: sourceThreadId,
          messageId: "message:cancel-source",
        });

        const result = yield* orchestrator.dispatch({
          type: "decision.cancel",
          commandId: CommandId.make("cancel:decision"),
          threadId: decisionThreadId,
          expectedRevision: 1,
        });
        assert.equal(result.decisionResult?.type, "cancel");
        if (result.decisionResult?.type !== "cancel") return yield* Effect.die("unreachable");
        assert.isTrue(result.decisionResult.sourceNotified);
        assert.equal(result.decisionResult.decision.status, "cancelled");

        yield* worker.drain();
        const source = yield* orchestrator.getThreadProjection(sourceThreadId);
        const decision = yield* orchestrator.getThreadProjection(decisionThreadId);
        assert.equal(source.runs.filter((run) => run.status === "running").length, 1);
        assert.isTrue(
          source.messages.some((message) => message.text.includes("cancelled without an answer")),
        );
        assert.equal(decision.thread.decision?.status, "cancelled");
        assert.equal(decision.thread.settledOverride, "settled");
        yield* orchestrator.dispatch({
          type: "decision.cancel",
          commandId: CommandId.make("cancel:decision"),
          threadId: decisionThreadId,
          expectedRevision: 1,
        });
        const stale = yield* orchestrator
          .dispatch({
            type: "decision.cancel",
            commandId: CommandId.make("cancel:another-client"),
            threadId: decisionThreadId,
            expectedRevision: 1,
          })
          .pipe(Effect.flip);
        assert.equal(stale._tag, "OrchestratorDispatchError");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("cancel:follow-up"),
          threadId: decisionThreadId,
          messageId: MessageId.make("message:cancel-follow-up"),
          text: "Thanks for the explanation.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const afterChat = yield* orchestrator.getThreadProjection(decisionThreadId);
        assert.equal(afterChat.thread.decision?.status, "cancelled");
        assert.equal(afterChat.thread.decision?.revision, 2);
        assert.equal(afterChat.thread.settledOverride, "settled");
        const cancellationMessages = (yield* orchestrator.getThreadProjection(
          sourceThreadId,
        )).messages.filter((message) =>
          message.id.startsWith(`decision-cancel:${decisionThreadId}:`),
        );
        assert.equal(cancellationMessages.length, 1);
        yield* orchestrator.dispatch({
          type: "decision.reopen",
          commandId: CommandId.make("cancel:reopen"),
          threadId: decisionThreadId,
          expectedRevision: 2,
        });
        yield* orchestrator.dispatch({
          type: "decision.cancel",
          commandId: CommandId.make("cancel:new-cycle"),
          threadId: decisionThreadId,
          expectedRevision: 3,
        });
        yield* worker.drain();
        const laterMessages = (yield* orchestrator.getThreadProjection(
          sourceThreadId,
        )).messages.filter((message) =>
          message.id.startsWith(`decision-cancel:${decisionThreadId}:`),
        );
        assert.equal(laterMessages.length, 2);
        assert.notEqual(laterMessages[0]!.id, laterMessages[1]!.id);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("rejects confirmation from a deleted source and keeps the decision open", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer } = yield* makeHarness("decision-source-gone");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sourceThreadId = ThreadId.make("thread:decision-gone-source");
        const decisionThreadId = ThreadId.make("thread:decision-gone");
        const projectId = ProjectId.make("project:decision-gone");
        yield* createSourceThread({ threadId: sourceThreadId, projectId, cwd });
        yield* createDecisionThread({
          threadId: decisionThreadId,
          projectId,
          cwd,
          sourceThreadId,
        });
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete:source"),
          threadId: sourceThreadId,
        });

        const failed = yield* confirmDecision({
          threadId: decisionThreadId,
          commandId: "confirm:source-gone",
          expectedRevision: 1,
          answer: "This cannot be delivered.",
        }).pipe(Effect.flip);
        assert.equal(failed._tag, "OrchestratorDispatchError");
        const decision = yield* orchestrator.getThreadProjection(decisionThreadId);
        assert.equal(decision.thread.decision?.status, "discussing");
        assert.equal(decision.thread.decision?.revision, 1);

        const cancelled = yield* orchestrator.dispatch({
          type: "decision.cancel",
          commandId: CommandId.make("cancel:source-gone"),
          threadId: decisionThreadId,
          expectedRevision: 1,
        });
        assert.equal(cancelled.decisionResult?.type, "cancel");
        if (cancelled.decisionResult?.type !== "cancel") return yield* Effect.die("unreachable");
        assert.isFalse(cancelled.decisionResult.sourceNotified);
        assert.isFalse(
          (yield* orchestrator.getThreadProjection(decisionThreadId)).thread.decision
            ?.cancellationNotified,
        );
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("keeps a confirmation open when the source cannot accept the message", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer } = yield* makeHarness("decision-source-dispatch-failure");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sourceThreadId = ThreadId.make("thread:decision-failed-dispatch-source");
        const decisionThreadId = ThreadId.make("thread:decision-failed-dispatch");
        const projectId = ProjectId.make("project:decision-failed-dispatch");
        yield* createSourceThread({
          threadId: sourceThreadId,
          projectId,
          cwd,
          modelSelection: {
            instanceId: ProviderInstanceId.make("not-registered"),
            model: "missing",
          },
        });
        yield* createDecisionThread({
          threadId: decisionThreadId,
          projectId,
          cwd,
          sourceThreadId,
        });

        const failed = yield* confirmDecision({
          threadId: decisionThreadId,
          commandId: "confirm:source-dispatch-failure",
          expectedRevision: 1,
          answer: "This must not settle.",
        }).pipe(Effect.flip);
        assert.match(failed._tag, /^Orchestrator/);

        const decision = yield* orchestrator.getThreadProjection(decisionThreadId);
        assert.equal(decision.thread.decision?.status, "discussing");
        assert.equal(decision.thread.decision?.revision, 1);
        assert.isNull(decision.thread.decision?.finalAnswer ?? null);
        const failedCancel = yield* orchestrator
          .dispatch({
            type: "decision.cancel",
            commandId: CommandId.make("cancel:source-dispatch-failure"),
            threadId: decisionThreadId,
            expectedRevision: 1,
          })
          .pipe(Effect.flip);
        assert.match(failedCancel._tag, /^Orchestrator/);
        assert.equal(
          (yield* orchestrator.getThreadProjection(decisionThreadId)).thread.decision?.status,
          "discussing",
        );
        const source = yield* orchestrator.getThreadProjection(sourceThreadId);
        assert.equal(source.messages.length, 0);
        yield* orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make("restore:source-provider"),
          threadId: sourceThreadId,
          modelSelection,
        });
        const oldAttempt = yield* orchestrator
          .dispatch({
            type: "decision.cancel",
            commandId: CommandId.make("cancel:source-dispatch-failure"),
            threadId: decisionThreadId,
            expectedRevision: 1,
          })
          .pipe(Effect.flip);
        assert.equal(oldAttempt._tag, "OrchestratorCommandPreviouslyRejectedError");
        const retry = {
          type: "decision.cancel" as const,
          commandId: CommandId.make("cancel:source-dispatch-retry"),
          threadId: decisionThreadId,
          expectedRevision: 1,
        };
        const cancelled = yield* orchestrator.dispatch(retry);
        assert.equal(cancelled.decisionResult?.decision.status, "cancelled");
        yield* orchestrator.dispatch(retry);
        assert.equal((yield* orchestrator.getThreadProjection(sourceThreadId)).messages.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("reopens for a correction and an old revision cannot overwrite it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer } = yield* makeHarness("decision-reopen");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sourceThreadId = ThreadId.make("thread:decision-reopen-source");
        const decisionThreadId = ThreadId.make("thread:decision-reopen");
        const projectId = ProjectId.make("project:decision-reopen");
        yield* createSourceThread({ threadId: sourceThreadId, projectId, cwd });
        yield* createDecisionThread({
          threadId: decisionThreadId,
          projectId,
          cwd,
          sourceThreadId,
        });
        yield* confirmDecision({
          threadId: decisionThreadId,
          commandId: "confirm:first",
          expectedRevision: 1,
          answer: "Keep the cache.",
        });
        const reopened = yield* orchestrator.dispatch({
          type: "decision.reopen",
          commandId: CommandId.make("reopen:decision"),
          threadId: decisionThreadId,
          expectedRevision: 2,
        });
        assert.equal(reopened.decisionResult?.type, "reopen");
        if (reopened.decisionResult?.type !== "reopen") return yield* Effect.die("unreachable");
        assert.equal(reopened.decisionResult.decision.status, "discussing");
        assert.equal(reopened.decisionResult.decision.revision, 3);
        assert.equal(reopened.decisionResult.decision.finalAnswer, "Keep the cache.");

        const corrected = yield* confirmDecision({
          threadId: decisionThreadId,
          commandId: "confirm:corrected",
          expectedRevision: 3,
          answer: "Drop the cache after 30 days.",
        });
        assert.equal(corrected.decision.revision, 4);
        assert.equal(corrected.decision.finalAnswer, "Drop the cache after 30 days.");

        const staleReopen = yield* orchestrator
          .dispatch({
            type: "decision.reopen",
            commandId: CommandId.make("reopen:stale"),
            threadId: decisionThreadId,
            expectedRevision: 2,
          })
          .pipe(Effect.flip);
        assert.equal(staleReopen._tag, "OrchestratorDispatchError");

        const stale = yield* confirmDecision({
          threadId: decisionThreadId,
          commandId: "confirm:old",
          expectedRevision: 1,
          answer: "Old answer.",
        }).pipe(Effect.flip);
        assert.equal(stale._tag, "OrchestratorDispatchError");

        yield* worker.drain();
        const source = yield* orchestrator.getThreadProjection(sourceThreadId);
        assert.equal(source.messages.length, 2);
        assert.include(source.messages[1]!.text, "Drop the cache after 30 days.");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("keeps handled decisions closed until explicitly reopened and exposes failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, layer } = yield* makeHarness("decision-late-notice");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sourceThreadId = ThreadId.make("thread:decision-notice-source");
        const decisionThreadId = ThreadId.make("thread:decision-notice");
        const projectId = ProjectId.make("project:decision-notice");
        yield* createSourceThread({ threadId: sourceThreadId, projectId, cwd });
        yield* createDecisionThread({
          threadId: decisionThreadId,
          projectId,
          cwd,
          sourceThreadId,
        });
        yield* confirmDecision({
          threadId: decisionThreadId,
          commandId: "confirm:notice",
          expectedRevision: 1,
          answer: "Use the bounded cache.",
        });
        yield* worker.drain();

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("late-notice"),
          threadId: decisionThreadId,
          messageId: MessageId.make("message:late-notice"),
          text: "The old run finished after the decision.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          notification: {
            source: { kind: "system" },
            outcome: "completed",
            summary: "Late completion",
          },
          createdBy: "agent",
          creationSource: "server",
        });
        yield* worker.drain();
        const afterNotice = yield* orchestrator.getThreadProjection(decisionThreadId);
        assert.equal(afterNotice.thread.decision?.status, "completed");
        assert.equal(afterNotice.thread.settledOverride, "settled");

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("actionable-failure"),
          threadId: decisionThreadId,
          messageId: MessageId.make("message:actionable-failure"),
          text: "The background operation failed and needs attention.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          notification: {
            source: { kind: "system" },
            outcome: "failed",
            summary: "Background operation failed",
          },
          createdBy: "agent",
          creationSource: "server",
        });
        yield* worker.drain();
        const afterFailure = yield* orchestrator.getThreadProjection(decisionThreadId);
        assert.equal(afterFailure.thread.decision?.status, "completed");
        assert.isNull(afterFailure.thread.settledOverride);

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("user-reopen"),
          threadId: decisionThreadId,
          messageId: MessageId.make("message:user-reopen"),
          text: "Actually, reconsider the retention window.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        const afterUser = yield* orchestrator.getThreadProjection(decisionThreadId);
        assert.equal(afterUser.thread.decision?.status, "completed");
        assert.equal(afterUser.thread.decision?.revision, 2);
        assert.equal(afterUser.thread.decision?.finalAnswer, "Use the bounded cache.");
        yield* orchestrator.dispatch({
          type: "decision.reopen",
          commandId: CommandId.make("explicit-reopen"),
          threadId: decisionThreadId,
          expectedRevision: 2,
        });
        const reopened = yield* orchestrator.getThreadProjection(decisionThreadId);
        assert.equal(reopened.thread.decision?.status, "discussing");
        assert.equal(reopened.thread.decision?.revision, 3);
        assert.isNull(reopened.thread.settledOverride);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("reads a confirmed decision back from a new persistence layer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { cwd, registryLayer } = yield* makeHarness("decision-durable-adapter");
      const dbPath = NodePath.join(cwd, "..", "decision-durable.sqlite");
      const sourceThreadId = ThreadId.make("thread:decision-durable-source");
      const decisionThreadId = ThreadId.make("thread:decision-durable");
      const projectId = ProjectId.make("project:decision-durable");
      const databaseLayer = SqlitePersistence.layerFromPath(dbPath).pipe(
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        yield* createSourceThread({ threadId: sourceThreadId, projectId, cwd });
        yield* createDecisionThread({
          threadId: decisionThreadId,
          projectId,
          cwd,
          sourceThreadId,
        });
        yield* confirmDecision({
          threadId: decisionThreadId,
          commandId: "confirm:durable",
          expectedRevision: 1,
          answer: "Keep the durable answer.",
        });
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "decision-durable-first" },
            registryLayer,
            { databaseLayer, runEffectWorker: false },
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const thread = yield* orchestrator.getThreadProjection(decisionThreadId);
        assert.equal(thread.thread.decision?.status, "completed");
        assert.equal(thread.thread.decision?.finalAnswer, "Keep the durable answer.");
        assert.equal(thread.thread.decision?.revision, 2);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "decision-durable-second" },
            registryLayer,
            { databaseLayer, runEffectWorker: false },
          ),
        ),
      );
    }),
  ),
);
