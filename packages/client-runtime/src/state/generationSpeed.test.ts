import { RunAttemptId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveGenerationSpeed,
  presentCompletedTurn,
  presentLiveWindow,
} from "./generationSpeed.ts";

const attempt = RunAttemptId.make("attempt-1");

function completedTurn(overrides: {
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly hasSubagents?: boolean;
  readonly models?: ReadonlyArray<string>;
  readonly estimateOutputTokens?: number;
  readonly estimateDurationMs?: number;
}) {
  const outputTokens = overrides.outputTokens ?? 150;
  return {
    runAttemptId: attempt,
    ordinal: 1,
    status: "completed" as const,
    throughputEstimate: {
      basis: "turn_wall_minus_known_waits" as const,
      outputTokens: overrides.estimateOutputTokens ?? outputTokens,
      durationMs: overrides.estimateDurationMs ?? 11_000,
    },
    turnTokenUsage: {
      usageStatus: "complete" as const,
      usageScope: "main_agent" as const,
      inputTokens: 2_000,
      outputTokens,
      reasoningTokens: overrides.reasoningTokens ?? 80,
      hasSubagents: overrides.hasSubagents ?? false,
      ...(overrides.models === undefined ? {} : { models: overrides.models }),
    },
  };
}

describe("generation speed presentation", () => {
  it("uses the canonical output total without adding reasoning again", () => {
    const presentation = presentCompletedTurn(
      completedTurn({ outputTokens: 100, reasoningTokens: 80, estimateDurationMs: 10_000 }),
    );

    expect(presentation?.tokensPerSecond).toBe(10);
    expect(presentation?.label).toBe("≈ 10 tok/s");
    expect(presentation?.kind).toBe("average");
    expect(presentation?.outputTokens).toBe(100);
    expect(presentation?.details).toContain("100 output tokens over 10.0 seconds");
    expect(presentation?.details).toContain("not pure decode speed");
  });

  it("shows only the latest completed provider turn for the current attempt", () => {
    const presentation = deriveGenerationSpeed({
      runs: [
        { activeAttemptId: RunAttemptId.make("attempt-old"), ordinal: 1 },
        { activeAttemptId: attempt, ordinal: 2 },
      ],
      providerTurns: [
        { ...completedTurn({}), runAttemptId: RunAttemptId.make("attempt-old"), ordinal: 8 },
        completedTurn({}),
        {
          ...completedTurn({ outputTokens: 20, estimateDurationMs: 2_000 }),
          ordinal: 2,
          status: "running" as const,
          throughputEstimate: undefined,
          turnTokenUsage: undefined,
        },
      ],
    });

    expect(presentation).toBeNull();
  });

  it("keeps the current attempt estimate after its latest turn completes", () => {
    const presentation = deriveGenerationSpeed({
      runs: [{ activeAttemptId: attempt, ordinal: 2 }],
      providerTurns: [completedTurn({})],
    });

    expect(presentation?.label).toBe("≈ 14 tok/s");
  });

  it("hides scopes that the server cannot attribute to one main-agent model", () => {
    expect(presentCompletedTurn(completedTurn({ hasSubagents: true }))).toBeNull();
    expect(presentCompletedTurn(completedTurn({ models: ["codex-a", "codex-b"] }))).toBeNull();
    expect(presentCompletedTurn(completedTurn({ models: [] }))).toBeNull();
  });

  it("hides incomplete usage and mismatched numerator or denominator data", () => {
    expect(
      presentCompletedTurn({
        ...completedTurn({}),
        turnTokenUsage: {
          ...completedTurn({}).turnTokenUsage,
          usageStatus: "partial" as const,
        },
      }),
    ).toBeNull();
    expect(presentCompletedTurn(completedTurn({ estimateOutputTokens: 149 }))).toBeNull();
    expect(presentCompletedTurn(completedTurn({ estimateDurationMs: 0 }))).toBeNull();
    expect(presentCompletedTurn(completedTurn({ outputTokens: 0 }))).toBeNull();
  });

  it("does not render a positive rate as zero", () => {
    const presentation = presentCompletedTurn(
      completedTurn({ outputTokens: 1, estimateDurationMs: 60_000 }),
    );

    expect(presentation?.label).toBe("≈ <0.1 tok/s");
  });

  it("distinguishes the live visible-text estimate from the completed provider average", () => {
    const presentation = presentLiveWindow(84, 2_000);

    expect(presentation).toMatchObject({
      kind: "live",
      label: "≈ 42 tok/s",
      outputTokens: 84,
      durationMs: 2_000,
    });
    expect(presentation?.details).toContain("visible reasoning, and plans");
    expect(presentation?.details).toContain("multilingual character heuristic");
    expect(presentation?.details).toContain("hidden reasoning are excluded");
    expect(presentation?.details).toContain("completed-turn average instead uses");
  });
});
