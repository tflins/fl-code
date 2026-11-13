export const MOBILE_APP_BASE_NAME = "FL Code";

export type MobileStageLabel = "Dev" | "Nightly";

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  return "Nightly";
}
