import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";

// Preview builds share nightly branding but ship without an update feed.
export function isNightlyDesktopVersion(version: string): boolean {
  return cliReleaseChannelOf(version) !== "stable";
}
