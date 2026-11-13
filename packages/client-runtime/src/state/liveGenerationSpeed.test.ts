import {
  EventId,
  MessageId,
  NodeId,
  PlanId,
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
  readonly ordinal?: number;
  readonly startedAtMs?: number;
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
      ordinal: input.ordinal ?? 1,
      status: input.status ?? "running",
      title: null,
      startedAt: at(input.startedAtMs ?? 0),
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
  it("shows a number after 250 ms of measured output without waiting for a long paragraph", () => {
    const tracker = makeLiveGenerationSpeedTracker();

    expect(
      tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]).presentation,
    ).toBeNull();
    expect(
      tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]).presentation,
    ).toMatchObject({ label: "≈ 0.8 tok/s", durationMs: 300 });

    const first = tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 800 })]);
    expect(first.presentation?.kind).toBe("live");
    expect(first.presentation?.label).toBe("≈ 0.9 tok/s");
    expect(first.presentation?.outputTokens).toBeCloseTo(0.75, 10);
    expect(first.presentation?.durationMs).toBe(800);
    expect(first.presentation?.tokensPerSecond).toBeCloseTo(0.9375, 10);
  });

  it("measures a short reply delivered as a single completed item and restores it on reconnect", () => {
    const event = assistantEvent({
      id: "short",
      text: "你好世界".repeat(10),
      atMs: 974,
      streaming: false,
      status: "completed",
    });
    if (event.type !== "turn-item.updated") throw new Error("Expected a turn item");
    const item = { ...event.payload, completedAt: at(974) };
    const projection = { ...liveProjection(), turnItems: [item] };
    const tracker = makeLiveGenerationSpeedTracker();
    const result = tracker.observeBatch([{ ...event, payload: item }], projection);
    expect(result.presentation?.tokensPerSecond).toBeCloseTo(28 / 0.974, 10);
    expect(result.presentation?.label).toBe("≈ 29 tok/s");
    expect(tracker.observeBatch([toolEvent(2_000)], projection).presentation).toBe(
      result.presentation,
    );

    const reconnected = makeLiveGenerationSpeedTracker().observeBatch([], projection);
    expect(reconnected.presentation).toEqual(result.presentation);
  });

  it("measures the first streaming update using the message start time", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    const result = tracker.observeBatch([
      assistantEvent({ id: "short", text: "你好世界".repeat(10), atMs: 700 }),
    ]);
    expect(result.presentation?.label).toBe("≈ 40 tok/s");

    const restored = liveProjection();
    const previous = assistantEvent({ id: "previous", text: "a".repeat(192), atMs: -1_000 });
    if (previous.type !== "turn-item.updated" || previous.payload.type !== "assistant_message") {
      throw new Error("Expected an assistant item");
    }
    const history = {
      ...restored,
      turnItems: [
        {
          ...previous.payload,
          status: "completed" as const,
          streaming: false,
          startedAt: at(-5_000),
          completedAt: at(-1_000),
        },
      ],
    };
    const resumed = makeLiveGenerationSpeedTracker();
    expect(resumed.observeBatch([], history).presentation?.label).toBe("≈ 12 tok/s");
    expect(
      resumed.observeBatch(
        [assistantEvent({ id: "current", text: "你好世界".repeat(10), atMs: 700 })],
        history,
      ).presentation?.label,
    ).toBe("≈ 40 tok/s");
  });

  it("replaces retained text estimates with aligned provider usage for a buffered response", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "a".repeat(100), atMs: 1_000 })]);
    const projection = liveProjection();
    const providerTurn = {
      ...projection.providerTurns[0]!,
      tokenUsage: {
        usedTokens: 1_200,
        outputTokens: 200,
        reasoningOutputTokens: 150,
        outputDurationMs: 2_000,
        updatedAt: DateTime.formatIso(at(3_000)),
      },
    };
    const event: OrchestrationV2DomainEvent = {
      id: EventId.make("provider-usage"),
      type: "provider-turn.updated",
      threadId: THREAD_ID,
      occurredAt: at(3_000),
      payload: providerTurn,
    };
    const measured = tracker.observeBatch([event], {
      ...projection,
      providerTurns: [providerTurn],
    });
    expect(measured.presentation?.label).toBe("≈ 100 tok/s");
    expect(measured.presentation?.outputTokens).toBe(200);
    expect(measured.presentation?.details).toContain("provider-reported");
    const cold = makeLiveGenerationSpeedTracker().observeBatch([], {
      ...projection,
      providerTurns: [providerTurn],
    });
    expect(cold.presentation).toEqual(measured.presentation);
    for (const outputDurationMs of [undefined, 0, 1, Number.NaN]) {
      const unmeasured = {
        ...providerTurn,
        tokenUsage: { ...providerTurn.tokenUsage, outputDurationMs },
      };
      expect(
        makeLiveGenerationSpeedTracker().observeBatch([], {
          ...projection,
          providerTurns: [unmeasured],
        }).presentation,
      ).toBeNull();
    }
    const active = { ...projection, providerTurns: [providerTurn] };
    const fresh = tracker.observeBatch(
      [
        assistantEvent({
          id: "next-body",
          ordinal: 2,
          text: "a".repeat(400),
          atMs: 4_000,
          startedAtMs: 3_500,
        }),
      ],
      active,
    ).presentation;
    expect(fresh).not.toBe(measured.presentation);
    expect(tracker.observeBatch([toolEvent(4_100)], active).presentation).toBe(fresh);
  });

  it("restores the previous completed throughput while a new turn is running", () => {
    const projection = liveProjection();
    const previous = {
      ...projection.providerTurns[0]!,
      id: ProviderTurnId.make("previous-turn"),
      runAttemptId: RunAttemptId.make("previous-attempt"),
      ordinal: 0,
      status: "completed" as const,
      completedAt: at(1_000),
      throughputEstimate: {
        basis: "turn_wall_minus_known_waits" as const,
        outputTokens: 100,
        durationMs: 2_000,
      },
      turnTokenUsage: {
        usageStatus: "complete" as const,
        usageScope: "main_agent" as const,
        inputTokens: 100,
        outputTokens: 100,
        hasSubagents: false,
      },
    };
    const result = makeLiveGenerationSpeedTracker().observeBatch([], {
      ...projection,
      providerTurns: [previous, ...projection.providerTurns],
    });
    expect(result.presentation?.label).toBe("≈ 50 tok/s");
  });

  it("updates a sparse stream even when samples are more than two seconds apart", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    const rates = (
      [
        [100, 4],
        [1_300, 400],
        [2_500, 800],
        [3_700, 1_200],
        [4_900, 1_600],
      ] as const
    ).map(
      ([atMs, length]) =>
        tracker.observeBatch([assistantEvent({ id: "sparse", text: "a".repeat(length), atMs })])
          .presentation?.tokensPerSecond,
    );
    expect(rates[0]).toBeUndefined();
    expect(rates[1]).toBeCloseTo(82.5, 10);
    expect(rates[2]).toBeCloseTo(199 / 2.4, 10);
    expect(rates.slice(3)).toEqual([200 / 2.4, 200 / 2.4]);

    const sparse = makeLiveGenerationSpeedTracker();
    sparse.observeBatch([assistantEvent({ id: "slow", text: "a".repeat(4), atMs: 0 })]);
    for (const [atMs, length] of [
      [2_600, 404],
      [5_200, 804],
      [7_800, 1_204],
    ] as const) {
      const reading = sparse.observeBatch([
        assistantEvent({ id: "slow", text: "a".repeat(length), atMs }),
      ]).presentation;
      expect(reading?.tokensPerSecond).toBeCloseTo(100 / 2.6, 10);
    }
  });

  it("measures successive short paragraphs without resetting their shared window", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    for (let index = 0; index < 5; index++) {
      const atMs = index * 300;
      const event = assistantEvent({
        id: `paragraph-${index}`,
        ordinal: index + 1,
        text: "a".repeat(80),
        atMs,
        startedAtMs: atMs,
      });
      const reading = tracker.observeBatch([event]).presentation;
      if (index > 0) expect(reading?.tokensPerSecond).toBeCloseTo(20 / 0.3, 10);
      if (event.type !== "turn-item.updated" || event.payload.type !== "assistant_message") {
        throw new Error("Expected an assistant item");
      }
      tracker.observeBatch([
        {
          ...event,
          payload: {
            ...event.payload,
            status: "completed",
            streaming: false,
            completedAt: at(atMs + 100),
          },
          occurredAt: at(atMs + 100),
        },
      ]);
    }
  });

  it.each(["reasoning", "proposed_plan"] as const)(
    "counts %s across interleaved assistant paragraphs",
    (type) => {
      const tracker = makeLiveGenerationSpeedTracker();
      const reasoning = (text: string, atMs: number): OrchestrationV2DomainEvent => {
        const event = assistantEvent({ id: "reasoning", text, atMs });
        if (event.type !== "turn-item.updated" || event.payload.type !== "assistant_message") {
          throw new Error("Expected an assistant item");
        }
        const { messageId: _messageId, ...item } = event.payload;
        return {
          ...event,
          payload:
            type === "reasoning"
              ? { ...item, type }
              : { ...item, type, planId: PlanId.make("live-plan"), markdown: text },
        };
      };
      tracker.observeBatch([reasoning("a".repeat(4), 0)]);
      expect(
        tracker.observeBatch([reasoning("a".repeat(404), 1_000)]).presentation?.outputTokens,
      ).toBe(100);
      tracker.observeBatch([
        assistantEvent({ id: "body", ordinal: 2, text: "a".repeat(40), atMs: 1_300 }),
      ]);
      const interleaved = tracker.observeBatch([reasoning("a".repeat(804), 1_600)]).presentation;
      expect(interleaved?.outputTokens).toBe(210);
      expect(interleaved?.durationMs).toBe(1_600);
      const final = reasoning("a".repeat(804), 1_700);
      if (
        final.type !== "turn-item.updated" ||
        (final.payload.type !== "reasoning" && final.payload.type !== "proposed_plan")
      ) {
        throw new Error("Expected a streamed output item");
      }
      expect(
        tracker.observeBatch([
          {
            ...final,
            payload: {
              ...final.payload,
              streaming: false,
              status: "completed",
              completedAt: at(1_700),
            },
          },
        ]).presentation,
      ).toBe(interleaved);
    },
  );

  it("rejects a millisecond message estimate in streaming and completed snapshots", () => {
    for (const completed of [false, true]) {
      const tracker = makeLiveGenerationSpeedTracker();
      const event = assistantEvent({
        id: "burst",
        text: "a".repeat(1_000),
        atMs: 1,
        streaming: !completed,
        status: completed ? "completed" : "running",
      });
      if (event.type !== "turn-item.updated") throw new Error("Expected a turn item");
      const item = { ...event.payload, completedAt: completed ? at(1) : null };
      const projection = { ...liveProjection(), turnItems: [item] };
      expect(
        tracker.observeBatch([{ ...event, payload: item }], projection).presentation,
      ).toBeNull();
      expect(makeLiveGenerationSpeedTracker().observeBatch([], projection).presentation).toBeNull();
    }
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "burst", text: "a".repeat(1_000), atMs: 1 })]);
    const valid = tracker.observeBatch([
      assistantEvent({ id: "burst", text: "a".repeat(1_400), atMs: 1_001 }),
    ]).presentation;
    expect(valid?.label).toBe("≈ 100 tok/s");
  });

  it("limits streaming updates to four per second", () => {
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
    expect(duplicate.sawModelOutput).toBe(false);
    expect(duplicate.presentation).toBe(published);

    const tool = tracker.observeBatch([toolEvent(1_000)]);
    expect(tool.sawModelOutput).toBe(false);
    expect(tool.presentation).toBe(published);

    const message = tracker.observeBatch([messageEvent("a".repeat(40), 1_100)]);
    expect(message.sawModelOutput).toBe(false);
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

    expect(result.sawModelOutput).toBe(false);
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
    expect(late.sawModelOutput).toBe(false);
    expect(late.presentation).toMatchObject({ kind: "live", durationMs: 800 });
  });

  it("retains the last estimate while resetting the window across scope changes", () => {
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
    ).toMatchObject({ kind: "live", durationMs: 800 });

    const newAttempt = publish(makeLiveGenerationSpeedTracker());
    const attemptNext = RunAttemptId.make("attempt-next");
    expect(
      newAttempt.observeBatch(
        [runEvent({ atMs: 1_000, attemptId: attemptNext })],
        liveProjection({ attemptId: attemptNext }),
      ).presentation,
    ).toMatchObject({ kind: "live", durationMs: 800 });

    const newAttemptEvent = publish(makeLiveGenerationSpeedTracker());
    expect(
      newAttemptEvent.observeBatch(
        [attemptEvent({ atMs: 1_000, attemptId: attemptNext })],
        liveProjection({ attemptId: attemptNext }),
      ).presentation,
    ).toMatchObject({ kind: "live", durationMs: 800 });

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
    ).toMatchObject({ kind: "live", durationMs: 800 });

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
    ).toMatchObject({ kind: "live", durationMs: 800 });
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
    ).toMatchObject({ kind: "live", durationMs: 800 });

    const late = tracker.observeBatch(
      [assistantEvent({ id: "a", text: "a".repeat(20), atMs: 1_200 })],
      liveProjection({ runStatus: "completed" }),
    );
    expect(late.sawModelOutput).toBe(false);
    expect(late.presentation).toMatchObject({ kind: "live", durationMs: 800 });
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
    expect(completed.sawModelOutput).toBe(false);
    expect(completed.presentation).toMatchObject({ kind: "live", durationMs: 800 });
  });

  it("retains the last estimate when the provider turn becomes terminal", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 800 })]);

    expect(
      tracker.observeBatch([providerTurnEvent({ atMs: 1_000, status: "completed" })]).presentation,
    ).toMatchObject({ kind: "live", durationMs: 800 });
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
    expect(unrelated.sawModelOutput).toBe(false);
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
    expect(oldTurn.sawModelOutput).toBe(false);
    expect(oldTurn.presentation).toBe(published);

    const completed = tracker.observeBatch([], {
      ...multipleTurns,
      providerTurns: multipleTurns.providerTurns.map((turn) =>
        turn.id === currentTurn.id ? { ...turn, status: "completed" } : turn,
      ),
    });
    expect(completed.presentation).toMatchObject({ kind: "live", durationMs: 800 });
  });

  it("retains the last estimate without counting rewritten text", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    expect(
      tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 800 })]).presentation,
    ).not.toBeNull();

    const rewritten = tracker.observeBatch([
      assistantEvent({ id: "a", text: "x".repeat(100), atMs: 1_000 }),
    ]);
    expect(rewritten.sawModelOutput).toBe(false);
    expect(rewritten.presentation).toMatchObject({ kind: "live", durationMs: 800 });
  });

  it("retains the last estimate when the run is cancelled", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aaaa", atMs: 800 })]);

    expect(
      tracker.observeBatch([runEvent({ atMs: 1_000, status: "cancelled" })], null).presentation,
    ).toMatchObject({ kind: "live", durationMs: 800 });
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
    ).toMatchObject({ kind: "live", durationMs: 800 });
    const late = tracker.observeBatch(
      [
        assistantEvent({ id: "a", text: "a".repeat(8), atMs: 1_300 }),
        assistantEvent({ id: "a", text: "a".repeat(10), atMs: 1_600 }),
        assistantEvent({ id: "a", text: "a".repeat(12), atMs: 1_900 }),
      ],
      liveProjection({ attemptStatus: "completed" }),
    );
    expect(late.sawModelOutput).toBe(false);
    expect(late.presentation).toMatchObject({ kind: "live", durationMs: 800 });
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
    expect(oldRunLateText.sawModelOutput).toBe(false);
    expect(oldRunLateText.presentation).toBe(live.presentation);
  });

  it("retains the last reading while idle and measures sparse output when it resumes", () => {
    const tracker = makeLiveGenerationSpeedTracker();
    tracker.observeBatch([assistantEvent({ id: "a", text: "a", atMs: 0 })]);
    tracker.observeBatch([assistantEvent({ id: "a", text: "aa", atMs: 300 })]);
    const published = tracker.observeBatch([
      assistantEvent({ id: "a", text: "aaaa", atMs: 800 }),
    ]).presentation;

    expect(tracker.observeBatch([]).presentation).toBe(published);
    expect(
      tracker.observeBatch([assistantEvent({ id: "a", text: "a".repeat(20), atMs: 3_400 })])
        .presentation,
    ).toMatchObject({ durationMs: 2_600, outputTokens: 4 });
    tracker.observeBatch([assistantEvent({ id: "a", text: "a".repeat(24), atMs: 3_700 })]);
    const resumed = tracker.observeBatch([
      assistantEvent({ id: "a", text: "a".repeat(28), atMs: 4_200 }),
    ]).presentation;
    expect(resumed).toMatchObject({ durationMs: 3_400, outputTokens: 6 });

    tracker.reset({ preserveReading: true });
    expect(tracker.observeBatch([]).presentation).toBe(resumed);
    tracker.observeBatch([assistantEvent({ id: "a", text: "a".repeat(100), atMs: 9_000 })]);
    expect(tracker.observeBatch([]).presentation).toBe(resumed);

    tracker.reset();
    expect(tracker.observeBatch([]).presentation).toBeNull();
  });
});
