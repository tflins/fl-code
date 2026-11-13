import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive, latestProviderTurnForAttempt } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { presentLiveWindow, type GenerationSpeedPresentation } from "./generationSpeed.ts";

const LIVE_GENERATION_WINDOW_MS = 2_000;
const LIVE_GENERATION_PUBLISH_INTERVAL_MS = 1_000;
const LIVE_GENERATION_MIN_SPAN_MS = 750;
const LIVE_GENERATION_MIN_SAMPLES = 3;
const LIVE_GENERATION_MAX_SAMPLES = 256;
// A streaming reply normally flushes more often than this. When no sample arrives for
// this long, the observation is too old to describe current output.
export const LIVE_GENERATION_QUIET_EXPIRY_MS = 1_500;

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
  /** Drops the current reading and makes the next streaming batch a fresh baseline. */
  expire(): boolean;
  reset(): void;
}

export interface LiveGenerationBatchResult {
  readonly sawAssistantText: boolean;
  readonly presentation: GenerationSpeedPresentation | null;
  readonly presentationChanged: boolean;
}

interface LiveSample {
  readonly atMs: number;
  readonly tokens: number;
}

interface LiveScope {
  readonly key: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly providerTurnId: string;
  readonly providerThreadId: string;
}

interface CurrentAssistantText {
  readonly id: string;
  readonly ordinal: number;
  text: string;
  tokens: number;
  readonly estimator: IncrementalTokenEstimator;
}

export function makeLiveGenerationSpeedTracker(): LiveGenerationSpeedTracker {
  let scopeKey: string | null = null;
  let currentText: CurrentAssistantText | null = null;
  let totalTokens = 0;
  let samples: LiveSample[] = [];
  let published: GenerationSpeedPresentation | null = null;
  let publishedAtMs = 0;
  let lastEventAtMs: number | null = null;

  const clearWindow = () => {
    currentText = null;
    totalTokens = 0;
    samples = [];
    published = null;
    publishedAtMs = 0;
    lastEventAtMs = null;
  };

  const reset = () => {
    scopeKey = null;
    clearWindow();
  };

  const observeAssistantText = (
    eventTimeMs: number,
    item: OrchestrationV2TurnItem & { readonly type: "assistant_message" },
    scope: LiveScope,
  ): boolean => {
    if (
      item.runId !== scope.runId ||
      item.providerTurnId !== scope.providerTurnId ||
      item.providerThreadId !== scope.providerThreadId ||
      item.streaming !== true ||
      !isOrchestrationV2WorkActive(item.status)
    ) {
      return false;
    }
    if (!Number.isFinite(eventTimeMs)) return false;
    if (lastEventAtMs !== null && eventTimeMs < lastEventAtMs) {
      // Replaying an old timestamp is not evidence of output arriving now. Drop the
      // window and let a later event establish a fresh baseline.
      clearWindow();
      lastEventAtMs = eventTimeMs;
      return false;
    }

    const existing = currentText;
    if (existing === null || item.ordinal > existing.ordinal) {
      const estimator = makeIncrementalTokenEstimator();
      estimator.append(item.text);
      const tokens = estimator.tokens();
      totalTokens += tokens;
      currentText = {
        id: item.id,
        ordinal: item.ordinal,
        text: item.text,
        tokens,
        estimator,
      };
      rebaseline(eventTimeMs);
      return false;
    }
    if (item.id !== existing.id || item.ordinal < existing.ordinal) return false;
    if (item.text === existing.text) return false;
    if (item.text.length <= existing.text.length) {
      // Streaming text is append-only for the supported Codex driver. Anything else
      // is a rewrite, so its text becomes a new baseline rather than new output.
      installRewriteBaseline(eventTimeMs, item.text, existing);
      return false;
    }

    const delta = item.text.slice(existing.text.length);
    const tokens = existing.estimator.append(delta);
    totalTokens += tokens - existing.tokens;
    existing.tokens = tokens;
    existing.text = item.text;
    recordSample(eventTimeMs);
    return true;
  };

  const installRewriteBaseline = (
    eventTimeMs: number,
    text: string,
    existing: CurrentAssistantText,
  ) => {
    const estimator = makeIncrementalTokenEstimator();
    estimator.append(text);
    const tokens = estimator.tokens();
    totalTokens += tokens - existing.tokens;
    existing.text = text;
    existing.tokens = tokens;
    existing.estimator.reset();
    existing.estimator.append(text);
    rebaseline(eventTimeMs);
  };

  const rebaseline = (eventTimeMs: number) => {
    samples = [{ atMs: eventTimeMs, tokens: totalTokens }];
    published = null;
    publishedAtMs = 0;
    lastEventAtMs = eventTimeMs;
  };

  const recordSample = (eventTimeMs: number) => {
    if (!Number.isFinite(eventTimeMs)) return;
    const atMs = eventTimeMs;
    if (lastEventAtMs !== null && atMs - lastEventAtMs > LIVE_GENERATION_WINDOW_MS) {
      // A long gap is a fresh baseline; the old burst cannot describe current output.
      samples = [];
      published = null;
      publishedAtMs = 0;
    }
    const last = samples.at(-1);
    if (last !== undefined && last.atMs === atMs) {
      samples[samples.length - 1] = { atMs, tokens: totalTokens };
    } else {
      samples.push({ atMs, tokens: totalTokens });
    }
    const cutoff = atMs - LIVE_GENERATION_WINDOW_MS;
    while (samples.length > 0 && samples[0]!.atMs < cutoff) samples.shift();
    while (samples.length > LIVE_GENERATION_MAX_SAMPLES) samples.shift();
    publishIfDue(atMs);
    lastEventAtMs = atMs;
  };

  const publishIfDue = (atMs: number) => {
    const first = samples[0];
    if (first === undefined || samples.length < LIVE_GENERATION_MIN_SAMPLES) return;
    const span = atMs - first.atMs;
    const tokens = totalTokens - first.tokens;
    if (span < LIVE_GENERATION_MIN_SPAN_MS || tokens <= 0) return;
    if (published !== null && atMs - publishedAtMs < LIVE_GENERATION_PUBLISH_INTERVAL_MS) return;
    const presentation = presentLiveWindow(tokens, span);
    if (presentation === null) return;
    published = presentation;
    publishedAtMs = atMs;
  };

  const observeBatch = (
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
    projection: OrchestrationV2ThreadProjection | null,
  ) => {
    const before = published;
    let sawAssistantText = false;
    let terminal = false;
    const scope = liveScope(projection);
    if (scope === null) {
      reset();
      return {
        sawAssistantText,
        presentation: published,
        presentationChanged: false,
      } satisfies LiveGenerationBatchResult;
    }
    if (scope.key !== scopeKey) {
      scopeKey = scope.key;
      clearWindow();
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
          const item = event.payload;
          if (item.type !== "assistant_message" || item.textOmitted !== undefined) break;
          if (
            item.runId !== scope.runId ||
            item.providerTurnId !== scope.providerTurnId ||
            item.providerThreadId !== scope.providerThreadId
          ) {
            break;
          }
          if (item.streaming !== true || !isOrchestrationV2WorkActive(item.status)) {
            if (currentText === null || item.ordinal >= currentText.ordinal) terminal = true;
            break;
          }
          sawAssistantText =
            observeAssistantText(DateTime.toEpochMillis(event.occurredAt), item, scope) ||
            sawAssistantText;
          break;
        }
      }
    }
    if (terminal) {
      clearWindow();
      scopeKey = scope.key;
    }
    return {
      sawAssistantText,
      presentation: published,
      presentationChanged: published !== before,
    } satisfies LiveGenerationBatchResult;
  };

  return {
    observeBatch,
    expire: () => {
      const changed = published !== null;
      published = null;
      publishedAtMs = 0;
      samples = [];
      return changed;
    },
    reset,
  };
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
