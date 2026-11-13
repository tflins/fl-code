import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive, latestProviderTurnForAttempt } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deriveGenerationSpeed,
  presentLiveWindow,
  presentCompletedTurn,
  presentProviderStep,
  type GenerationSpeedPresentation,
} from "./generationSpeed.ts";

const LIVE_GENERATION_WINDOW_MS = 2_000;
const LIVE_GENERATION_PUBLISH_INTERVAL_MS = 250;
const LIVE_GENERATION_MIN_ESTIMATE_MS = 250;
const LIVE_GENERATION_MAX_SAMPLES = 256;

const GENERATING_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "starting",
  "running",
  "waiting",
]);
const ACTIVE_ATTEMPT_STATUSES = new Set<OrchestrationV2RunAttempt["status"]>([
  "pending",
  "running",
]);

export interface LiveGenerationSpeedTracker {
  observeBatch(
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
    projection: OrchestrationV2ThreadProjection | null,
  ): LiveGenerationBatchResult;
  reset(options?: { readonly preserveReading?: boolean }): void;
}

export interface LiveGenerationBatchResult {
  readonly sawModelOutput: boolean;
  readonly presentation: GenerationSpeedPresentation | null;
  readonly presentationChanged: boolean;
}

interface LiveSample {
  readonly atMs: number;
  readonly tokens: number;
}

interface LiveScope {
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly key: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly providerTurnId: string;
  readonly providerThreadId: string;
}

type StreamedOutputItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "assistant_message" | "reasoning" | "proposed_plan" }
>;

interface CurrentOutputText {
  text: string;
  tokens: number;
  completed: boolean;
  readonly estimator: IncrementalTokenEstimator;
}

export function makeLiveGenerationSpeedTracker(): LiveGenerationSpeedTracker {
  let scopeKey: string | null = null;
  const outputItems = new Map<string, CurrentOutputText>();
  let totalTokens = 0;
  let samples: LiveSample[] = [];
  let published: GenerationSpeedPresentation | null = null;
  let publishedAtMs: number | null = null;
  let publishedScopeKey: string | null = null;
  let providerSampleKey: string | null = null;
  let lastEventAtMs: number | null = null;

  const clearWindow = () => {
    outputItems.clear();
    totalTokens = 0;
    samples = [];
    lastEventAtMs = null;
  };

  const reset: LiveGenerationSpeedTracker["reset"] = (options) => {
    scopeKey = null;
    if (options?.preserveReading !== true) {
      published = null;
      publishedAtMs = null;
      publishedScopeKey = null;
      providerSampleKey = null;
    }
    clearWindow();
  };

  const observeOutput = (eventTimeMs: number, item: StreamedOutputItem): boolean => {
    if (!Number.isFinite(eventTimeMs)) return false;
    if (lastEventAtMs !== null && eventTimeMs < lastEventAtMs) return false;

    const text = outputText(item);
    const existing = outputItems.get(item.id);
    if (existing === undefined) {
      const estimator = makeIncrementalTokenEstimator();
      const tokens = estimator.append(text);
      outputItems.set(item.id, { text, tokens, estimator, completed: false });
      const previousTokens = totalTokens;
      totalTokens += tokens;
      if (samples.length === 0) {
        const startedAtMs =
          item.startedAt === null ? eventTimeMs : DateTime.toEpochMillis(item.startedAt);
        samples =
          (published === null ||
            publishedScopeKey !== scopeKey ||
            (publishedAtMs !== null && startedAtMs > publishedAtMs)) &&
          eventTimeMs - startedAtMs >= LIVE_GENERATION_MIN_ESTIMATE_MS
            ? [{ atMs: startedAtMs, tokens: previousTokens }]
            : [{ atMs: eventTimeMs, tokens: totalTokens }];
      }
      recordSample(eventTimeMs);
      return tokens > 0;
    }
    if (existing.completed || text === existing.text) return false;
    if (!text.startsWith(existing.text)) {
      existing.estimator.reset();
      const tokens = existing.estimator.append(text);
      totalTokens += tokens - existing.tokens;
      existing.tokens = tokens;
      existing.text = text;
      samples = [{ atMs: eventTimeMs, tokens: totalTokens }];
      lastEventAtMs = eventTimeMs;
      return false;
    }

    const tokens = existing.estimator.append(text.slice(existing.text.length));
    const addedTokens = tokens - existing.tokens;
    totalTokens += addedTokens;
    existing.tokens = tokens;
    existing.text = text;
    recordSample(eventTimeMs);
    return addedTokens > 0;
  };

  const recordSample = (atMs: number) => {
    const last = samples.at(-1);
    if (last !== undefined && last.atMs === atMs) {
      samples[samples.length - 1] = { atMs, tokens: totalTokens };
    } else {
      samples.push({ atMs, tokens: totalTokens });
    }
    const cutoff = atMs - LIVE_GENERATION_WINDOW_MS;
    // Keep the left boundary so a sparse stream can still form a measured interval.
    while (samples.length > 2 && samples[1]!.atMs <= cutoff) samples.shift();
    while (samples.length > LIVE_GENERATION_MAX_SAMPLES) samples.shift();
    publishIfDue(atMs);
    lastEventAtMs = atMs;
  };

  const publishIfDue = (atMs: number) => {
    const first = samples[0];
    if (first === undefined || samples.length < 2) return;
    const span = atMs - first.atMs;
    const tokens = totalTokens - first.tokens;
    if (span < LIVE_GENERATION_MIN_ESTIMATE_MS || tokens <= 0) return;
    if (publishedAtMs !== null && atMs - publishedAtMs < LIVE_GENERATION_PUBLISH_INTERVAL_MS)
      return;
    const presentation = presentLiveWindow(tokens, span);
    if (presentation === null) return;
    published = presentation;
    publishedAtMs = atMs;
    publishedScopeKey = scopeKey;
  };

  const observeBatch = (
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
    projection: OrchestrationV2ThreadProjection | null,
  ) => {
    const before = published;
    let sawModelOutput = false;
    let terminal = false;
    if (published === null && projection !== null) {
      published = restoreLatestReading(projection);
    }
    const completed = projection === null ? null : deriveGenerationSpeed(projection);
    if (
      completed !== null &&
      (published?.kind !== "average" ||
        published.outputTokens !== completed.outputTokens ||
        published.durationMs !== completed.durationMs)
    ) {
      published = completed;
    }
    const scope = liveScope(projection);
    if (scope === null) {
      clearWindow();
      return {
        sawModelOutput,
        presentation: published,
        presentationChanged: published !== before,
      } satisfies LiveGenerationBatchResult;
    }
    if (scope.key !== scopeKey) {
      scopeKey = scope.key;
      clearWindow();
    }
    const usage = scope.providerTurn.tokenUsage;
    const sampleKey = `${scope.providerTurnId}:${usage?.updatedAt}:${usage?.outputTokens}:${usage?.outputDurationMs}`;
    if (sampleKey !== providerSampleKey) {
      const reading = presentProviderStep(scope.providerTurn);
      if (reading !== null) {
        published = reading;
        publishedScopeKey = scope.key;
        const atMs = Date.parse(usage!.updatedAt);
        publishedAtMs = Number.isFinite(atMs) ? atMs : null;
        providerSampleKey = sampleKey;
      }
    }
    for (const event of events) {
      switch (event.type) {
        case "thread.deleted":
        case "thread.model-selection-updated":
        case "thread.provider-switched":
          terminal = true;
          break;
        case "provider-turn.updated":
          if (
            event.payload.id === scope.providerTurnId &&
            event.payload.status !== "pending" &&
            event.payload.status !== "running"
          ) {
            terminal = true;
          }
          break;
        case "turn-item.updated": {
          const payload = event.payload;
          const item =
            payload.type === "assistant_message" && payload.textOmitted === true
              ? projection?.turnItems.findLast((candidate) => candidate.id === payload.id)
              : payload;
          if (item === undefined || !isStreamedOutputItem(item)) break;
          if (item.type === "assistant_message" && item.textOmitted === true) break;
          if (
            item.runId !== scope.runId ||
            item.providerTurnId !== scope.providerTurnId ||
            item.providerThreadId !== scope.providerThreadId
          ) {
            break;
          }
          if (item.streaming !== true || !isOrchestrationV2WorkActive(item.status)) {
            const existing = outputItems.get(item.id);
            if (existing !== undefined) {
              existing.completed = true;
              existing.text = "";
              existing.estimator.reset();
            }
            if (published === null || existing === undefined) {
              const reading = presentCompletedOutput(item);
              if (reading !== null) {
                published = reading;
                publishedScopeKey = scope.key;
                publishedAtMs = DateTime.toEpochMillis(event.occurredAt);
              }
            }
            break;
          }
          sawModelOutput =
            observeOutput(DateTime.toEpochMillis(event.occurredAt), item) || sawModelOutput;
          break;
        }
      }
    }
    if (terminal) {
      clearWindow();
      scopeKey = scope.key;
    }
    return {
      sawModelOutput,
      presentation: published,
      presentationChanged: published !== before,
    } satisfies LiveGenerationBatchResult;
  };

  return {
    observeBatch,
    reset,
  };
}

function restoreLatestReading(projection: OrchestrationV2ThreadProjection) {
  let latestAt = -Infinity;
  let reading: GenerationSpeedPresentation | null = null;
  for (const turn of projection.providerTurns) {
    if (turn.completedAt === null) continue;
    const atMs = DateTime.toEpochMillis(turn.completedAt);
    if (atMs <= latestAt) continue;
    const candidate = presentCompletedTurn(turn);
    if (candidate !== null) {
      latestAt = atMs;
      reading = candidate;
    }
  }
  for (const item of projection.turnItems) {
    if (!isStreamedOutputItem(item) || item.completedAt === null) continue;
    const atMs = DateTime.toEpochMillis(item.completedAt);
    if (atMs <= latestAt) continue;
    const providerThread = projection.providerThreads.find(
      (thread) => thread.id === item.providerThreadId,
    );
    if (providerThread?.driver !== "codex") continue;
    const candidate = presentCompletedOutput(item);
    if (candidate !== null) {
      latestAt = atMs;
      reading = candidate;
    }
  }
  return reading;
}

function presentCompletedOutput(item: StreamedOutputItem) {
  if (
    item.status !== "completed" ||
    item.streaming ||
    (item.type === "assistant_message" && item.textOmitted === true) ||
    item.startedAt === null ||
    item.completedAt === null
  )
    return null;
  const durationMs =
    DateTime.toEpochMillis(item.completedAt) - DateTime.toEpochMillis(item.startedAt);
  return durationMs < LIVE_GENERATION_MIN_ESTIMATE_MS
    ? null
    : presentLiveWindow(estimateVisibleTextTokens(outputText(item)), durationMs);
}

function isStreamedOutputItem(item: OrchestrationV2TurnItem): item is StreamedOutputItem {
  return (
    item.type === "assistant_message" || item.type === "reasoning" || item.type === "proposed_plan"
  );
}

function outputText(item: StreamedOutputItem): string {
  return item.type === "proposed_plan" ? item.markdown : item.text;
}

function liveScope(projection: OrchestrationV2ThreadProjection | null): LiveScope | null {
  if (projection === null) return null;
  let run: OrchestrationV2Run | null = null;
  for (const candidate of projection.runs) {
    if (!GENERATING_RUN_STATUSES.has(candidate.status)) continue;
    if (run === null || candidate.ordinal > run.ordinal) run = candidate;
  }
  if (run === null || run.activeAttemptId === null) return null;

  const attempt = projection.attempts.find(
    (candidate) =>
      candidate.id === run.activeAttemptId &&
      candidate.runId === run.id &&
      ACTIVE_ATTEMPT_STATUSES.has(candidate.status),
  );
  if (attempt === undefined) return null;

  const providerTurn = latestProviderTurnForAttempt(projection.providerTurns, attempt.id);
  if (providerTurn?.status !== "running") return null;

  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === providerTurn.providerThreadId,
  );
  if (providerThread?.driver !== "codex") return null;

  return {
    providerTurn,
    key: `${run.id}\u0000${attempt.id}\u0000${providerTurn.id}`,
    runId: run.id,
    attemptId: attempt.id,
    providerTurnId: providerTurn.id,
    providerThreadId: providerThread.id,
  };
}

export interface IncrementalTokenEstimator {
  append(delta: string): number;
  tokens(): number;
  reset(): void;
}

export function makeIncrementalTokenEstimator(): IncrementalTokenEstimator {
  let tokens = 0;
  let pendingHighSurrogate = "";
  return {
    append: (delta) => {
      let text = pendingHighSurrogate + delta;
      pendingHighSurrogate = "";
      if (text.length === 0) return tokens;
      const lastCodeUnit = text.charCodeAt(text.length - 1);
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
        // Hold a split surrogate pair until the next delta so chunking cannot change the count.
        pendingHighSurrogate = text.slice(-1);
        text = text.slice(0, -1);
      }
      for (const character of text) {
        tokens += codePointTokenWeight(character.codePointAt(0) ?? 0);
      }
      return tokens;
    },
    tokens: () => tokens,
    reset: () => {
      tokens = 0;
      pendingHighSurrogate = "";
    },
  };
}

export function estimateVisibleTextTokens(text: string): number {
  const estimator = makeIncrementalTokenEstimator();
  estimator.append(text);
  return estimator.tokens();
}

function codePointTokenWeight(codePoint: number): number {
  if (codePoint === 0x20 || codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) {
    return 0.1;
  }
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }
  if (isCjkCodePoint(codePoint)) return 0.7;
  if (
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a)
  ) {
    return 0.25;
  }
  if (codePoint < 0x80) return 0.5;
  if (codePoint <= 0xffff) return 0.35;
  return 1;
}

function isCjkCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0x2fdf) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3100 && codePoint <= 0x31ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fa1f)
  );
}
