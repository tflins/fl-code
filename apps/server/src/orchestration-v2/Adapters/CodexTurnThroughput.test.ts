import { describe, expect, it } from "vite-plus/test";

import {
  beginCodexThroughputModelOutput,
  beginCodexThroughputWait,
  completeCodexThroughputEstimate,
  endCodexThroughputModelOutput,
  endCodexThroughputWait,
  makeCodexTurnThroughputTracker,
} from "./CodexTurnThroughput.ts";

describe("Codex turn throughput estimate", () => {
  it("excludes a confirmed tool wait without growing as both spans grow", () => {
    const shortTool = makeCodexTurnThroughputTracker();
    beginCodexThroughputWait(shortTool, "tool:command", 1_000);
    endCodexThroughputWait(shortTool, "tool:command", 4_000);

    const longTool = makeCodexTurnThroughputTracker();
    beginCodexThroughputWait(longTool, "tool:command", 1_000);
    endCodexThroughputWait(longTool, "tool:command", 14_000);

    expect(
      completeCodexThroughputEstimate(shortTool, { outputTokens: 120, turnDurationMs: 15_000 }),
    ).toEqual({
      basis: "turn_wall_minus_known_waits",
      outputTokens: 120,
      durationMs: 12_000,
    });
    expect(
      completeCodexThroughputEstimate(longTool, { outputTokens: 120, turnDurationMs: 25_000 }),
    ).toEqual({
      basis: "turn_wall_minus_known_waits",
      outputTokens: 120,
      durationMs: 12_000,
    });
  });

  it("counts overlapping tool and approval waits once", () => {
    const tracker = makeCodexTurnThroughputTracker();
    beginCodexThroughputWait(tracker, "tool:command", 1_000);
    beginCodexThroughputWait(tracker, "request:approval", 3_000);
    endCodexThroughputWait(tracker, "request:approval", 7_000);
    endCodexThroughputWait(tracker, "tool:command", 5_000);

    expect(
      completeCodexThroughputEstimate(tracker, {
        outputTokens: 200,
        turnDurationMs: 20_000,
      }),
    ).toEqual({
      basis: "turn_wall_minus_known_waits",
      outputTokens: 200,
      durationMs: 14_000,
    });
  });

  it("keeps an interval that overlaps model output instead of over-deducting it", () => {
    const tracker = makeCodexTurnThroughputTracker();
    beginCodexThroughputWait(tracker, "tool:background", 1_000);
    beginCodexThroughputModelOutput(tracker, "message:1");
    endCodexThroughputModelOutput(tracker, "message:1");
    endCodexThroughputWait(tracker, "tool:background", 5_000);

    expect(
      completeCodexThroughputEstimate(tracker, {
        outputTokens: 50,
        turnDurationMs: 10_000,
      }),
    ).toEqual({
      basis: "turn_wall_minus_known_waits",
      outputTokens: 50,
      durationMs: 10_000,
    });
  });

  it("hides malformed, open, or zero-duration scopes", () => {
    const duplicate = makeCodexTurnThroughputTracker();
    beginCodexThroughputWait(duplicate, "tool:command", 1_000);
    beginCodexThroughputWait(duplicate, "tool:command", 2_000);
    endCodexThroughputWait(duplicate, "tool:command", 4_000);
    expect(
      completeCodexThroughputEstimate(duplicate, { outputTokens: 10, turnDurationMs: 5_000 }),
    ).toBeUndefined();

    const open = makeCodexTurnThroughputTracker();
    beginCodexThroughputWait(open, "request:input", 1_000);
    expect(
      completeCodexThroughputEstimate(open, { outputTokens: 10, turnDurationMs: 5_000 }),
    ).toBeUndefined();

    const empty = makeCodexTurnThroughputTracker();
    expect(
      completeCodexThroughputEstimate(empty, { outputTokens: 10, turnDurationMs: 0 }),
    ).toBeUndefined();
    expect(
      completeCodexThroughputEstimate(empty, { outputTokens: 0, turnDurationMs: 5_000 }),
    ).toBeUndefined();
  });
});
