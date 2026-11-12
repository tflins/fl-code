import type { OrchestrationV2ProviderTurnThroughputEstimate } from "@t3tools/contracts";

interface CodexThroughputWait {
  readonly startedAtMs: number;
  completedAtMs?: number;
  overlapsModelOutput: boolean;
}

export interface CodexTurnThroughputTracker {
  readonly waits: Map<string, CodexThroughputWait>;
  readonly runningModelOutputs: Set<string>;
  contaminated: boolean;
}

export function makeCodexTurnThroughputTracker(): CodexTurnThroughputTracker {
  return {
    waits: new Map(),
    runningModelOutputs: new Set(),
    contaminated: false,
  };
}

export function beginCodexThroughputWait(
  tracker: CodexTurnThroughputTracker,
  id: string,
  startedAtMs: number,
): void {
  if (!Number.isFinite(startedAtMs) || tracker.waits.has(id)) {
    tracker.contaminated = true;
    return;
  }
  tracker.waits.set(id, {
    startedAtMs,
    overlapsModelOutput: tracker.runningModelOutputs.size > 0,
  });
}

export function endCodexThroughputWait(
  tracker: CodexTurnThroughputTracker,
  id: string,
  completedAtMs: number,
): void {
  const wait = tracker.waits.get(id);
  if (
    wait === undefined ||
    wait.completedAtMs !== undefined ||
    !Number.isFinite(completedAtMs) ||
    completedAtMs < wait.startedAtMs
  ) {
    tracker.contaminated = true;
    return;
  }
  wait.completedAtMs = completedAtMs;
}

export function beginCodexThroughputModelOutput(
  tracker: CodexTurnThroughputTracker,
  id: string,
): void {
  tracker.runningModelOutputs.add(id);
  for (const wait of tracker.waits.values()) {
    if (wait.completedAtMs === undefined) wait.overlapsModelOutput = true;
  }
}

export function endCodexThroughputModelOutput(
  tracker: CodexTurnThroughputTracker,
  id: string,
): void {
  tracker.runningModelOutputs.delete(id);
}

export function completeCodexThroughputEstimate(
  tracker: CodexTurnThroughputTracker,
  input: {
    readonly outputTokens: number;
    readonly turnDurationMs: number;
  },
): OrchestrationV2ProviderTurnThroughputEstimate | undefined {
  if (
    tracker.contaminated ||
    [...tracker.waits.values()].some((wait) => wait.completedAtMs === undefined) ||
    !Number.isSafeInteger(input.outputTokens) ||
    input.outputTokens <= 0 ||
    !Number.isSafeInteger(input.turnDurationMs) ||
    input.turnDurationMs <= 0
  ) {
    return undefined;
  }

  const excludedWaitMs = Math.min(
    input.turnDurationMs,
    confirmedWaitDurationMs(
      [...tracker.waits.values()].flatMap((wait) =>
        wait.completedAtMs === undefined || wait.overlapsModelOutput
          ? []
          : [{ startedAtMs: wait.startedAtMs, completedAtMs: wait.completedAtMs }],
      ),
    ),
  );
  const durationMs = input.turnDurationMs - excludedWaitMs;
  return durationMs <= 0
    ? undefined
    : {
        basis: "turn_wall_minus_known_waits",
        outputTokens: input.outputTokens,
        durationMs,
      };
}

function confirmedWaitDurationMs(
  intervals: ReadonlyArray<{ readonly startedAtMs: number; readonly completedAtMs: number }>,
): number {
  const ordered = intervals
    .filter((interval) => interval.completedAtMs > interval.startedAtMs)
    .sort((left, right) => left.startedAtMs - right.startedAtMs);
  let total = 0;
  let currentStart: number | null = null;
  let currentEnd = 0;
  for (const interval of ordered) {
    if (currentStart === null) {
      currentStart = interval.startedAtMs;
      currentEnd = interval.completedAtMs;
      continue;
    }
    if (interval.startedAtMs <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.completedAtMs);
      continue;
    }
    total += currentEnd - currentStart;
    currentStart = interval.startedAtMs;
    currentEnd = interval.completedAtMs;
  }
  return currentStart === null ? 0 : total + currentEnd - currentStart;
}
