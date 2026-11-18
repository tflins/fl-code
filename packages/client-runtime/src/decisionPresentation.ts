import type { OrchestrationV2Decision } from "@t3tools/contracts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export const decisionStatusLabels = {
  discussing: msg("Awaiting you"),
  completed: msg("Returned"),
  cancelled: msg("Cancelled"),
} as const;

export function decisionComposerPlaceholder(
  decision: Pick<OrchestrationV2Decision, "status"> | undefined,
  resolve: MFunctionType = mFallback,
): string | undefined {
  if (!decision) return undefined;
  return decision.status === "discussing"
    ? resolve(msg("Discuss this decision…"))
    : resolve(msg("Continue this discussion; reopen to revise the decision…"));
}
