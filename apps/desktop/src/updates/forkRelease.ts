import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

export const FORK_RELEASE_REPOSITORY = "tflins/fl-code";
const FORK_RELEASE_TAG_PREFIX = "tflins-v";

export const GitHubReleaseAsset = Schema.Struct({
  name: Schema.String,
  browser_download_url: Schema.String,
  size: Schema.Number,
});
export type GitHubReleaseAsset = typeof GitHubReleaseAsset.Type;

export const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  assets: Schema.Array(GitHubReleaseAsset),
});

export const GitHubReleases = Schema.Array(GitHubRelease);
export type GitHubRelease = typeof GitHubRelease.Type;

export interface ForkRelease {
  readonly tagName: string;
  readonly version: string;
  readonly url: string;
  readonly zipUrl: string;
  readonly checksumUrl: string;
  readonly zipSize: number;
}

export function isForkDesktopVersion(version: string): boolean {
  return /-tflins\.\d+$/u.test(version);
}

export function selectNewerForkRelease(
  releases: ReadonlyArray<GitHubRelease>,
  currentVersion: string,
): ForkRelease | null {
  const current = currentVersion.trim();
  let latest: ForkRelease | null = null;

  for (const release of releases) {
    if (
      release.draft ||
      !release.tag_name.startsWith(FORK_RELEASE_TAG_PREFIX) ||
      !release.prerelease
    ) {
      continue;
    }

    const version = release.tag_name.slice(FORK_RELEASE_TAG_PREFIX.length);
    if (!isForkDesktopVersion(version)) continue;

    try {
      if (compareSemverVersions(version, current) <= 0) continue;
      if (latest !== null && compareSemverVersions(version, latest.version) <= 0) continue;
    } catch {
      continue;
    }

    const zipName = `T3-Code-${version}-arm64.zip`;
    const zip = release.assets.find((asset) => asset.name === zipName);
    const checksum = release.assets.find((asset) => asset.name === "SHA256SUMS");
    if (!zip || !checksum || !isDownloadUrl(zip) || !isDownloadUrl(checksum)) continue;

    latest = {
      tagName: release.tag_name,
      version,
      url: `https://github.com/${FORK_RELEASE_REPOSITORY}/releases/tag/${encodeURIComponent(release.tag_name)}`,
      zipUrl: zip.browser_download_url,
      checksumUrl: checksum.browser_download_url,
      zipSize: zip.size,
    };
  }

  return latest;
}

export function readExpectedSha256(checksumManifest: string, fileName: string): string {
  const expected = checksumManifest
    .split(/\r?\n/u)
    .map((line) => /^([a-f\d]{64})\s+\*?(.+)$/iu.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match?.[2] === fileName)
    .map((match) => match[1]!.toLowerCase());

  if (expected.length !== 1) {
    throw new Error(`Expected exactly one SHA256 checksum for ${fileName}.`);
  }
  return expected[0]!;
}

function isDownloadUrl(asset: GitHubReleaseAsset): boolean {
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) return false;
  try {
    return new URL(asset.browser_download_url).protocol === "https:";
  } catch {
    return false;
  }
}
