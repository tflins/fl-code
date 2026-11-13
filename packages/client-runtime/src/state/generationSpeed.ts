import {
  latestProviderTurnForAttempt,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";

export const GENERATION_SPEED_PLACEHOLDER = "≈ … tok/s";

export interface GenerationSpeedPresentation {
  readonly kind: "live" | "average";
  readonly label: string;
  readonly details: string;
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly tokensPerSecond: number;
}

type GenerationSpeedProjection = {
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "activeAttemptId" | "ordinal">>;
  readonly providerTurns: ReadonlyArray<
    Pick<
      OrchestrationV2ProviderTurn,
      "runAttemptId" | "ordinal" | "status" | "throughputEstimate" | "turnTokenUsage"
    >
  >;
};

export function deriveGenerationSpeed(
  projection: GenerationSpeedProjection,
): GenerationSpeedPresentation | null {
  const run = projection.runs.reduce<GenerationSpeedProjection["runs"][number] | null>(
    (latest, candidate) =>
      latest === null || candidate.ordinal > latest.ordinal ? candidate : latest,
    null,
  );
  if (run?.activeAttemptId == null) return null;

  const turn = latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId);
  return turn === undefined ? null : presentCompletedTurn(turn);
}

export function presentCompletedTurn(
  turn: Pick<OrchestrationV2ProviderTurn, "status" | "throughputEstimate" | "turnTokenUsage">,
): GenerationSpeedPresentation | null {
  const estimate = turn.throughputEstimate;
  const usage = turn.turnTokenUsage;
  if (
    turn.status !== "completed" ||
    estimate === undefined ||
    estimate.basis !== "turn_wall_minus_known_waits" ||
    usage?.usageStatus !== "complete" ||
    usage.hasSubagents ||
    (usage.models !== undefined && usage.models.length !== 1) ||
    estimate.outputTokens !== usage.outputTokens ||
    !Number.isFinite(estimate.outputTokens) ||
    estimate.outputTokens <= 0 ||
    !Number.isFinite(estimate.durationMs) ||
    estimate.durationMs <= 0
  ) {
    return null;
  }

  const tokensPerSecond = estimate.outputTokens / (estimate.durationMs / 1000);
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null;
  const rate = formatRate(tokensPerSecond);
  const durationSeconds = (estimate.durationMs / 1000).toFixed(1);
  const outputTokens = estimate.outputTokens.toLocaleString("en-US");
  return {
    kind: "average",
    label: `≈ ${rate} tok/s`,
    details:
      `Average estimated output throughput: ${rate} tokens per second. ` +
      `${outputTokens} output tokens over ${durationSeconds} seconds of effective turn time. ` +
      "This excludes confirmed tool, approval, and input waits, while network, prefill, and scheduling remain included. " +
      "Output tokens include reasoning and tool-call arguments when the provider reports them once. This is not pure decode speed.",
    outputTokens: estimate.outputTokens,
    durationMs: estimate.durationMs,
    tokensPerSecond,
  };
}

export function presentProviderStep(
  turn: Pick<OrchestrationV2ProviderTurn, "status" | "tokenUsage">,
): GenerationSpeedPresentation | null {
  const usage = turn.tokenUsage;
  if (
    turn.status !== "running" ||
    usage?.outputTokens === undefined ||
    usage.outputDurationMs === undefined ||
    usage.outputDurationMs < 250
  )
    return null;
  const reading = presentLiveWindow(usage.outputTokens, usage.outputDurationMs);
  if (reading === null) return null;
  return {
    ...reading,
    details:
      `Most recent provider-reported output throughput: ${formatRate(reading.tokensPerSecond)} tokens per second. ` +
      `${usage.outputTokens.toLocaleString("en-US")} output tokens over ${(usage.outputDurationMs / 1000).toFixed(1)} seconds of the same response's observed output interval. ` +
      "Uses reported output tokens once, including reported reasoning and tool arguments. Confirmed tool waits are excluded; buffered output updates when the response reports its usage. This is not pure decode speed.",
  };
}

export function presentLiveWindow(
  estimatedTokens: number,
  durationMs: number,
): GenerationSpeedPresentation | null {
  if (
    !Number.isFinite(estimatedTokens) ||
    estimatedTokens <= 0 ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return null;
  }
  const tokensPerSecond = estimatedTokens / (durationMs / 1000);
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null;
  const rate = formatRate(tokensPerSecond);
  const durationSeconds = (durationMs / 1000).toFixed(1);
  const outputTokens =
    estimatedTokens < 10
      ? estimatedTokens.toFixed(1)
      : Math.round(estimatedTokens).toLocaleString("en-US");
  return {
    kind: "live",
    label: `≈ ${rate} tok/s`,
    details:
      `Most recent estimated output throughput: ${rate} tokens per second over ${durationSeconds} seconds. ` +
      `Counts streamed assistant text, visible reasoning, and plans, estimated as ${outputTokens} tokens with a multilingual character heuristic rather than the provider tokenizer. ` +
      "Tool execution output, unstreamed tool arguments, and hidden reasoning are excluded. Observed stream gaps remain included. The completed-turn average instead uses the provider's reported output tokens and effective turn time.",
    outputTokens: estimatedTokens,
    durationMs,
    tokensPerSecond,
  };
}

function formatRate(tokensPerSecond: number): string {
  if (tokensPerSecond < 0.05) return "<0.1";
  if (tokensPerSecond < 10) return tokensPerSecond.toFixed(1);
  return String(Math.round(tokensPerSecond));
}
