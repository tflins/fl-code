import { assert, describe, it } from "@effect/vitest";

import { macAppBundlePath } from "../app/macAppBundlePath.ts";
import {
  isForkDesktopVersion,
  readExpectedSha256,
  selectNewerForkRelease,
  type GitHubRelease,
} from "./forkRelease.ts";

const release = (version: string, overrides: Partial<GitHubRelease> = {}): GitHubRelease => ({
  tag_name: `tflins-v${version}`,
  draft: false,
  prerelease: true,
  assets: [
    {
      name: `T3-Code-${version}-arm64.zip`,
      browser_download_url: `https://github.com/tflins/fl-code/releases/download/tflins-v${version}/T3-Code-${version}-arm64.zip`,
      size: 1234,
    },
    {
      name: "SHA256SUMS",
      browser_download_url: `https://github.com/tflins/fl-code/releases/download/tflins-v${version}/SHA256SUMS`,
      size: 160,
    },
  ],
  ...overrides,
});

describe("fork desktop releases", () => {
  it("recognizes only the fork version suffix", () => {
    assert.isTrue(isForkDesktopVersion("0.1.8-nightly.20261109.4399-tflins.6"));
    assert.isFalse(isForkDesktopVersion("0.1.8-nightly.20261109.4399"));
    assert.isFalse(isForkDesktopVersion("0.1.8-nightly.20261109.4399-tflins.dev"));
  });

  it("selects the newest newer fork prerelease", () => {
    const selected = selectNewerForkRelease(
      [
        release("0.1.8-nightly.20261109.4399-tflins.7"),
        release("0.1.8-nightly.20261110.4400-tflins.1"),
        release("0.1.8-nightly.20261109.4399-tflins.5"),
      ],
      "0.1.8-nightly.20261109.4399-tflins.6",
    );

    assert.deepEqual(selected, {
      tagName: "tflins-v0.1.8-nightly.20261110.4400-tflins.1",
      version: "0.1.8-nightly.20261110.4400-tflins.1",
      url: "https://github.com/tflins/fl-code/releases/tag/tflins-v0.1.8-nightly.20261110.4400-tflins.1",
      zipUrl:
        "https://github.com/tflins/fl-code/releases/download/tflins-v0.1.8-nightly.20261110.4400-tflins.1/T3-Code-0.1.8-nightly.20261110.4400-tflins.1-arm64.zip",
      checksumUrl:
        "https://github.com/tflins/fl-code/releases/download/tflins-v0.1.8-nightly.20261110.4400-tflins.1/SHA256SUMS",
      zipSize: 1234,
    });
  });

  it("ignores drafts, releases from other trains, and versions that are not newer", () => {
    assert.isNull(
      selectNewerForkRelease(
        [
          release("0.1.8-nightly.20261110.4400-tflins.2", { draft: true }),
          release("0.1.8-nightly.20261110.4400-tflins.2", {
            tag_name: "v0.1.8-nightly.20261110.4400",
          }),
          release("0.1.8-nightly.20261109.4399-tflins.6"),
        ],
        "0.1.8-nightly.20261109.4399-tflins.6",
      ),
    );
  });

  it("skips newer releases without the verified macOS assets", () => {
    const selected = selectNewerForkRelease(
      [
        release("0.1.8-nightly.20261110.4400-tflins.2", { assets: [] }),
        release("0.1.8-nightly.20261109.4399-tflins.7"),
      ],
      "0.1.8-nightly.20261109.4399-tflins.6",
    );

    assert.equal(selected?.version, "0.1.8-nightly.20261109.4399-tflins.7");
  });

  it("requires one checksum for the exact release ZIP", () => {
    const checksum = "a".repeat(64);
    const fileName = "T3-Code-test-arm64.zip";

    assert.equal(
      readExpectedSha256(`${"b".repeat(64)}  other.zip\n${checksum}  ${fileName}\n`, fileName),
      checksum,
    );
    assert.throws(() => readExpectedSha256("", fileName));
    assert.throws(() =>
      readExpectedSha256(`${checksum}  ${fileName}\n${checksum}  ${fileName}\n`, fileName),
    );
  });

  it("resolves the application bundle from the running executable", () => {
    assert.equal(
      macAppBundlePath("/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code"),
      "/Applications/T3 Code (Nightly).app",
    );
    assert.isUndefined(macAppBundlePath("/usr/local/bin/t3"));
  });
});
