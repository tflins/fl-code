import {
  EventId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  estimateVisibleTextTokens,
  makeIncrementalTokenEstimator,
  makeLiveGenerationSpeedTracker as makeBaseLiveGenerationSpeedTracker,
} from "./liveGenerationSpeed.ts";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";

const THREAD_ID = ThreadId.make("thread-live");
const RUN_ID = RunId.make("run-live");
const ATTEMPT_ID = RunAttemptId.make("attempt-live");
const PROVIDER_TURN_ID = ProviderTurnId.make("turn-live");
const PROVIDER_THREAD_ID = ProviderThreadId.make("provider-thread-1");
function at(offsetMs: number) {
  return DateTime.add(v2Now, { milliseconds: offsetMs });
}

function liveProjection(
  overrides: {
    readonly runStatus?: "running" | "completed";
    readonly attemptStatus?: "running" | "completed";
    readonly turnStatus?: "running" | "completed";
    readonly driver?: "codex" | "claudeAgent";
    readonly runId?: RunId;
    readonly attemptId?: RunAttemptId;
    readonly providerTurnId?: ProviderTurnId;
  } = {},
): OrchestrationV2ThreadProjection {
  const runId = overrides.runId ?? RUN_ID;
  const attemptId = overrides.attemptId ?? ATTEMPT_ID;
  const providerTurnId = overrides.providerTurnId ?? PROVIDER_TURN_ID;
  return {
    ...v2Projection,
    runs: [
      {
        id: runId,
        threadId: THREAD_ID,
        ordinal: 1,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        providerThreadId: null,
        userMessageId: MessageId.make("user-message"),
        rootNodeId: null,
        activeAttemptId: attemptId,
        status: overrides.runStatus ?? "running",
        requestedAt: at(0),
        startedAt: at(0),
        completedAt: overrides.runStatus === "completed" ? at(1_000) : null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: NodeId.make("node-1"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerThreadId: PROVIDER_THREAD_ID,
        providerTurnId: null,
        reason: "initial",
        status: overrides.attemptStatus ?? "running",
        startedAt: at(0),
        completedAt: overrides.attemptStatus === "completed" ? at(1_000) : null,
      },
    ],
    providerThreads: [
      {
        id: PROVIDER_THREAD_ID,
        driver: ProviderDriverKind.make(overrides.driver ?? "codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: null,
        appThreadId: THREAD_ID,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        nativeMetadata: null,
        goal: null,
        createdAt: at(0),
        updatedAt: at(0),
      },
    ],
    providerTurns: [
      {
        id: providerTurnId,
        providerThreadId: PROVIDER_THREAD_ID,
        nodeId: NodeId.make("node-1"),
        runAttemptId: attemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: overrides.turnStatus ?? "running",
        startedAt: at(0),
        completedAt: overrides.turnStatus === "completed" ? at(1_000) : null,
      },
    ],
  };
}

function makeLiveGenerationSpeedTracker() {
  const tracker = makeBaseLiveGenerationSpeedTracker();
  return {
    ...tracker,
    observeBatch: (
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
      projection: OrchestrationV2ThreadProjection | null = liveProjection(),
    ) => tracker.observeBatch(events, projection),
  };
}

function assistantEvent(input: {
  readonly id: string;
  readonly text: string;
  readonly atMs: number;
  readonly streaming?: boolean;
  readonly status?: "running" | "completed";
  readonly runId?: RunId | null;
  readonly providerTurnId?: ProviderTurnId | null;
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-${input.id}-${input.atMs}`),
    type: "turn-item.updated",
    threadId: THREAD_ID,
    occurredAt: at(input.atMs),
    payload: {
      id: TurnItemId.make(input.id),
      threadId: THREAD_ID,
      runId: input.runId === undefined ? RUN_ID : input.runId,
      nodeId: null,
      providerThreadId: PROVIDER_THREAD_ID,
      providerTurnId: input.providerTurnId === undefined ? PROVIDER_TURN_ID : input.providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: input.status ?? "running",
      title: null,
      startedAt: at(0),
      completedAt: null,
      updatedAt: at(input.atMs),
      type: "assistant_message",
      messageId: MessageId.make(`message-${input.id}`),
      text: input.text,
      streaming: input.streaming ?? true,
    },
  };
}

function providerTurnEvent(input: {
  readonly atMs: number;
  readonly status: "running" | "completed";
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-provider-turn-${input.atMs}-${input.status}`),
    type: "provider-turn.updated",
    threadId: THREAD_ID,
    occurredAt: at(input.atMs),
    payload: {
      id: PROVIDER_TURN_ID,
      providerThreadId: ProviderThreadId.make("provider-thread-1"),
      nodeId: NodeId.make("node-1"),
      runAttemptId: ATTEMPT_ID,
      nativeTurnRef: null,
      ordinal: 1,
      status: input.status,
      startedAt: at(0),
      completedAt: input.status === "completed" ? at(input.atMs) : null,
    },
  };
}

function toolEvent(atMs: number): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-tool-${atMs}`),
    type: "turn-item.updated",
    threadId: THREAD_ID,
    occurredAt: at(atMs),
    payload: {
      id: TurnItemId.make("tool-1"),
      threadId: THREAD_ID,
      runId: RUN_ID,
      nodeId: null,
      providerThreadId: PROVIDER_THREAD_ID,
      providerTurnId: PROVIDER_TURN_ID,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      status: "running",
      title: null,
      startedAt: at(0),
      completedAt: null,
      updatedAt: at(atMs),
      type: "command_execution",
      input: "echo hi",
      output: "hi",
    },
  };
}

function messageEvent(text: string, atMs: number): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-message-${atMs}`),
    type: "message.updated",
    threadId: THREAD_ID,
    occurredAt: at(atMs),
    payload: {
      id: MessageId.make("message-assistant"),
      threadId: THREAD_ID,
      runId: RUN_ID,
      nodeId: null,
      role: "assistant",
      text,
      createdBy: "agent",
      creationSource: "provider",
      attachments: [],
      streaming: true,
      createdAt: at(0),
      updatedAt: at(atMs),
    },
  };
}

function runEvent(input: {
  readonly atMs: number;
  readonly runId?: RunId;
  readonly attemptId?: RunAttemptId | null;
  readonly status?: "running" | "completed" | "cancelled";
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-run-${input.atMs}`),
    type: "run.updated",
    threadId: THREAD_ID,
    occurredAt: at(input.atMs),
    payload: {
      id: input.runId ?? RUN_ID,
      threadId: THREAD_ID,
      ordinal: 1,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      providerThreadId: null,
      userMessageId: MessageId.make("user-message"),
      rootNodeId: null,
      activeAttemptId: input.attemptId === undefined ? ATTEMPT_ID : input.attemptId,
      status: input.status ?? "running",
      requestedAt: at(0),
      startedAt: at(0),
      completedAt: input.status === undefined || input.status === "running" ? null : at(input.atMs),
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

function attemptEvent(input: {
  readonly atMs: number;
  readonly runId?: RunId;
  readonly attemptId?: RunAttemptId;
  readonly status?: "running" | "completed";
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(`event-attempt-${input.atMs}`),
    type: "run-attempt.updated",
    threadId: THREAD_ID,
    occurredAt: at(input.atMs),
    payload: {
      id: input.attemptId ?? ATTEMPT_ID,
      runId: input.runId ?? RUN_ID,
      attemptOrdinal: 1,
      rootNodeId: NodeId.make("node-1"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerThreadId: ProviderThreadId.make("provider-thread-1"),
      providerTurnId: PROVIDER_TURN_ID,
      reason: "initial",
      status: input.status ?? "running",
      startedAt: at(0),
      completedAt: input.status === "completed" ? at(input.atMs) : null,
    },
  };
}

describe("live generation speed token estimate", () => {
  it("is independent of how the same multilingual text is chunked", () => {
    const text = "Hello, world!\n你好，世界。\nconst total = await sum(2, 3);\n🚀👍🏽\nمرحبا";
    const whole = estimateVisibleTextTokens(text);
    expect(whole).toBeGreaterThan(0);

    for (let index = 0; index <= text.length; index += 1) {
      const estimator = makeIncrementalTokenEstimator();
      estimator.append(text.slice(0, index));
      estimator.append(text.slice(index));
      expect(estimator.tokens()).toBe(whole);
    }
  });

  it("weights CJK and code above plain latin text without using a fixed chars/4 rule", () => {
    expect(estimateVisibleTextTokens("abcd")).toBeCloseTo(1, 10);
    expect(estimateVisibleTextTokens("你好世界")).toBeCloseTo(2.8, 10);
    expect(estimateVisibleTextTokens("const x = 1;")).toBeGreaterThan(
      estimateVisibleTextTokens("abcdefgh"),
    );
  });

  it("counts a surrogate pair once when its code units arrive in separate chunks", () => {
    const whole = estimateVisibleTextTokens("🚀");
    const estimator = makeIncrementalTokenEstimator();
    estimator.append("🚀".slice(0, 1));
    estimator.append("🚀".slice(1));
    expect(estimator.tokens()).toBe(whole);
  });
});

describe("live generation speed window", () => {
  it("uses the first batch as a baseline and waits for enough batches and span", () => {
    const tracker = makeLiveGenerationSpeedTracker();

    expect(
      tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]).presentation,
    ).toBeNull();
    expect(
      tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]).presentation,
    ).toBeNull();

    const first = tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 800 })]);
    expect(first.presentation?.kind).toBe("live");
    expect(first.presentation?.label).toBe("Live ≈ 0.9 tok/s");
    expect(first.presentation?.outputTokens).toBeCloseTo(0.75, 10);
    expect(first.presentation?.durationMs).toBe(800);
    expect(first.presentation?.tokensPerSecond).toBeCloseTo(0.9375, 10);
  });

  it("publishes at most once per second", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    const published = tracker.observeBatch([
      assistantEvent({ id: "a", text: "aaaa", atMs: 800 }),
    ]).presentation;
    expect(published).not.toBeNull();

    const throttled = tracker.observeBatch([
      assistantEvent({ id: "a", text: "a".repeat(8), atMs: 1_000 }),
    ]);
    expect(throttled.presentation).toBe(published);

    const next = tracker.observeBatch([
      assistantEvent({ id: "a", text: "a".repeat(10), atMs: 1_900 }),
    ]);
    expect(next.presentation).not.toBe(published);
    expect(next.presentation?.kind).toBe("live");
  });

  it("hides a single burst, duplicate text, tool output, and final message snapshots", () => {
    const burst = makeLiveGenerationSpeedTracker();
    expect(
      burst.observeBatch([
        assistantEvent({ id: "a", text: "a", atMs: 0 }),
        assistantEvent({ id: "a", text: "aaaa", atMs: 0 }),
      ]).presentation,
    ).toBeNull();

    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    const published = tracker.observeBatch([
      assistantEvent({ id: "a", text: "aaaa", atMs: 800 }),
    ]).presentation;

    const duplicate = tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 900 })]);
    expect(duplicate.sawAssistantText).toBe(false);
    expect(duplicate.presentation).toBe(published);

    const tool = tracker.observeBatch([toolEvent(1_000)]);
    expect(tool.sawAssistantText).toBe(false);
    expect(tool.presentation).toBe(published);

    const message = tracker.observeBatch([messageEvent("a".repeat(40), 1_100)]);
    expect(message.sawAssistantText).toBe(false);
    expect(message.presentation).toBe(published);
  });

  it("keeps counting visible text while a background tool updates", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([toolEvent(100)]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 300 })]);
    tracker.observeBatch([toolEvent(500)]);
    const result = tracker.observeBatch([
      assistantEvent({ id: "a", text: "a".repeat(8), atMs: 800 }),
    ]);
    expect(result.presentation?.kind).toBe("live");
  });

  it("hides sampling when the active provider driver has no verified stream contract", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    const claude = liveProjection({ driver: "claudeAgent" });
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })], claude);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })], claude);
    const result = tracker.observeBatch(
      [assistantEvent({ id: "a", text: "aaaa", atMs: 800 })],
      claude,
    );

    expect(result.sawAssistantText).toBe(false);
    expect(result.presentation).toBeNull();
  });

  it("rebaselines when a late event carries an older timestamp", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    const published = tracker.observeBatch([
      assistantEvent({ id: "a", text: "aaaa", atMs: 800 }),
    ]).presentation;
    expect(published).not.toBeNull();

    const late = tracker.observeBatch([assistantEvent({ id: "a", text: "aaaaa", atMs: 700 })]);
    expect(late.sawAssistantText).toBe(false);
    expect(late.presentation).toBeNull();
  });

  it("clears when the run, attempt, model, or thread changes", () => {
    const publish = (tracker: ReturnType<typeof makeLiveGenerationSpeedTracker>) => {
      tracker.observeBatch([runEvent({ atMs: 0 })]);
      tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
      tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
      tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 800 })]);
      return tracker;
    };

    const newRun = publish(makeLiveGenerationSpeedTracker());
    expect(
      newRun.observeBatch(
        [runEvent({ atMs: 1_000, runId: RunId.make("run-next"), attemptId: ATTEMPT_ID })],
        liveProjection({
          runId: RunId.make("run-next"),
          attemptId: ATTEMPT_ID,
          providerTurnId: PROVIDER_TURN_ID,
        }),
      ).presentation,
    ).toBeNull();

    const newAttempt = publish(makeLiveGenerationSpeedTracker());
    const attemptNext = RunAttemptId.make("attempt-next");
    expect(
      newAttempt.observeBatch(
        [runEvent({ atMs: 1_000, attemptId: attemptNext })],
        liveProjection({ attemptId: attemptNext }),
      ).presentation,
    ).toBeNull();

    const newAttemptEvent = publish(makeLiveGenerationSpeedTracker());
    expect(
      newAttemptEvent.observeBatch(
        [attemptEvent({ atMs: 1_000, attemptId: attemptNext })],
        liveProjection({ attemptId: attemptNext }),
      ).presentation,
    ).toBeNull();

    const modelChange = publish(makeLiveGenerationSpeedTracker());
    expect(
      modelChange.observeBatch([
        {
          id: EventId.make("event-model"),
          type: "thread.model-selection-updated",
          threadId: THREAD_ID,
          occurredAt: at(1_000),
          payload: v2Projection.thread,
        },
      ]).presentation,
    ).toBeNull();

    const deleted = publish(makeLiveGenerationSpeedTracker());
    expect(
      deleted.observeBatch([
        {
          id: EventId.make("event-deleted"),
          type: "thread.deleted",
          threadId: THREAD_ID,
          occurredAt: at(1_000),
          payload: { ...v2Projection.thread, deletedAt: at(1_000) },
        },
      ]).presentation,
    ).toBeNull();
  });

  it("stops after completion and ignores late text for the finished run", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    expect(
      tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 800 })]).presentation,
    ).not.toBeNull();

    expect(
      tracker.observeBatch(
        [runEvent({ atMs: 1_000, status: "completed" })],
        liveProjection({ runStatus: "completed" }),
      ).presentation,
    ).toBeNull();

    const late = tracker.observeBatch(
      [assistantEvent({ id: "a", text: "a".repeat(20), atMs: 1_200 })],
      liveProjection({ runStatus: "completed" }),
    );
    expect(late.sawAssistantText).toBe(false);
    expect(late.presentation).toBeNull();
  });

  it("does not count a final non-streaming assistant snapshot as new output", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    expect(
      tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 800 })]).presentation,
    ).not.toBeNull();

    const completed = tracker.observeBatch([
      assistantEvent({
        id: "a",
        text: "a".repeat(40),
        atMs: 1_000,
        streaming: false,
        status: "completed",
      }),
    ]);
    expect(completed.sawAssistantText).toBe(false);
    expect(completed.presentation).toBeNull();
  });

  it("clears immediately when the provider turn becomes terminal", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 800 })]);

    expect(
      tracker.observeBatch([providerTurnEvent({ atMs: 1_000, status: "completed" })]).presentation,
    ).toBeNull();
  });

  it("does not let unrelated run text take over the current window", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([runEvent({ atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    const published = tracker.observeBatch([
      assistantEvent({ id: "a", text: "aaaa", atMs: 800 }),
    ]).presentation;
    expect(published).not.toBeNull();

    const unrelated = tracker.observeBatch([
      assistantEvent({
        id: "old",
        text: "a".repeat(40),
        atMs: 1_000,
        runId: RunId.make("run-old"),
        providerTurnId: ProviderTurnId.make("turn-old"),
      }),
    ]);
    expect(unrelated.sawAssistantText).toBe(false);
    expect(unrelated.presentation).toBe(published);
  });

  it("does not let text from an older provider turn take over the current window", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    const projection = liveProjection();
    const currentTurn = projection.providerTurns[0]!;
    const oldTurnId = ProviderTurnId.make("turn-old");
    const multipleTurns = {
      ...projection,
      providerTurns: [{ ...currentTurn, id: oldTurnId, ordinal: 0 }, currentTurn],
    };
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    const published = tracker.observeBatch([
      assistantEvent({ id: "a", text: "aaaa", atMs: 800 }),
    ]).presentation;

    const oldTurn = tracker.observeBatch(
      [
        assistantEvent({
          id: "old",
          text: "a".repeat(40),
          atMs: 1_000,
          providerTurnId: oldTurnId,
        }),
      ],
      multipleTurns,
    );
    expect(oldTurn.sawAssistantText).toBe(false);
    expect(oldTurn.presentation).toBe(published);

    const completed = tracker.observeBatch([], {
      ...multipleTurns,
      providerTurns: multipleTurns.providerTurns.map((turn) =>
        turn.id === currentTurn.id ? { ...turn, status: "completed" } : turn,
      ),
    });
    expect(completed.presentation).toBeNull();
  });

  it("clears instead of publishing when streaming text is rewritten", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    expect(
      tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 800 })]).presentation,
    ).not.toBeNull();

    const rewritten = tracker.observeBatch([assistantEvent({ id: "a", text: "x", atMs: 1_000 })]);
    expect(rewritten.sawAssistantText).toBe(false);
    expect(rewritten.presentation).toBeNull();
  });

  it("clears the live reading when the run is cancelled", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 800 })]);

    expect(
      tracker.observeBatch([runEvent({ atMs: 1_000, status: "cancelled" })], null).presentation,
    ).toBeNull();
  });

  it("ignores late text from an ended provider turn", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 800 })]);

    expect(
      tracker.observeBatch(
        [attemptEvent({ atMs: 1_000, status: "completed" })],
        liveProjection({ attemptStatus: "completed" }),
      ).presentation,
    ).toBeNull();
    const late = tracker.observeBatch(
      [
        assistantEvent({ id: "a", text: "a".repeat(8), atMs: 1_300 }),
        assistantEvent({ id: "a", text: "a".repeat(10), atMs: 1_600 }),
        assistantEvent({ id: "a", text: "a".repeat(12), atMs: 1_900 }),
      ],
      liveProjection({ attemptStatus: "completed" }),
    );
    expect(late.sawAssistantText).toBe(false);
    expect(late.presentation).toBeNull();
  });

  it("starts a clean window for the next run after the previous run finished", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 800 })]);
    tracker.observeBatch(
      [runEvent({ atMs: 1_000, status: "completed" })],
      liveProjection({ runStatus: "completed" }),
    );

    const nextRun = RunId.make("run-next");
    const nextAttempt = RunAttemptId.make("attempt-next");
    const nextProviderTurn = ProviderTurnId.make("turn-next");
    const nextProjection = liveProjection({
      runId: nextRun,
      attemptId: nextAttempt,
      providerTurnId: nextProviderTurn,
    });
    tracker.observeBatch(
      [runEvent({ atMs: 1_100, runId: nextRun, attemptId: nextAttempt })],
      nextProjection,
    );
    tracker.observeBatch(
      [
        assistantEvent({
          id: "b",
          text: "a",
          atMs: 1_100,
          runId: nextRun,
          providerTurnId: nextProviderTurn,
        }),
      ],
      nextProjection,
    );
    tracker.observeBatch(
      [
        assistantEvent({
          id: "b",
          text: "aa",
          atMs: 1_400,
          runId: nextRun,
          providerTurnId: nextProviderTurn,
        }),
      ],
      nextProjection,
    );
    const live = tracker.observeBatch(
      [
        assistantEvent({
          id: "b",
          text: "aaaa",
          atMs: 1_900,
          runId: nextRun,
          providerTurnId: nextProviderTurn,
        }),
      ],
      nextProjection,
    );
    expect(live.presentation?.kind).toBe("live");

    const oldRunLateText = tracker.observeBatch(
      [assistantEvent({ id: "a", text: "a".repeat(20), atMs: 2_000 })],
      nextProjection,
    );
    expect(oldRunLateText.sawAssistantText).toBe(false);
    expect(oldRunLateText.presentation).toBe(live.presentation);
  });

  it("expires the reading and rebaselines when output resumes", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 800 })]);

    expect(tracker.expire()).toBe(true);
    expect(tracker.observeBatch([]).presentation).toBeNull();
    expect(
      tracker.observeBatch([assistantEvent({ id: "a", text: "a".repeat(20), atMs: 2_400 })])
        .presentation,
    ).toBeNull();
  });
});
