import type { OrchestrationV2Decision } from "@t3tools/contracts";

export const decisionStatusLabels = {
  discussing: "Awaiting you",
  completed: "Returned",
  cancelled: "Cancelled",
} as const;

export function decisionComposerPlaceholder(
  decision: Pick<OrchestrationV2Decision, "status"> | undefined,
): string | undefined {
  if (!decision) return undefined;
  return decision.status === "discussing"
    ? "Discuss this decision…"
    : "Continue this discussion; reopen to revise the decision…";
}
