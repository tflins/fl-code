const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function nightlyPrefix(upstreamTag) {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-nightly\.\d{8})\.[1-9]\d*$/.exec(
    upstreamTag,
  );
  if (!match || match[0] !== upstreamTag)
    throw new Error("Expected a published upstream nightly tag");
  return match[1];
}

function releaseVersion(tag, upstreamTag) {
  const match =
    /^tflins-v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.\d{8}\.[1-9]\d*)$/.exec(tag);
  if (!match || match[0] !== tag)
    throw new Error("Expected tflins-vX.Y.Z-nightly.YYYYMMDD.N with a positive revision");
  const version = match[1];
  if (version.slice(0, version.lastIndexOf(".")) !== nightlyPrefix(upstreamTag)) {
    throw new Error("Tag base version differs from the pinned upstream nightly");
  }
  return version;
}

function automaticReleaseTag(upstreamTag, runNumber) {
  if (!/^[1-9]\d*$/.test(String(runNumber))) throw new Error("Invalid workflow run number");
  const tag = `tflins-v${nightlyPrefix(upstreamTag)}.${runNumber}`;
  releaseVersion(tag, upstreamTag);
  return tag;
}

function writeChecksums(directory, version) {
  const files = ["dmg", "zip"].map((extension) => `T3-Code-${version}-arm64.${extension}`);
  const lines = files.map((name) => {
    const data = fs.readFileSync(path.join(directory, name));
    if (data.length === 0) throw new Error(`Empty artifact: ${name}`);
    return `${crypto.createHash("sha256").update(data).digest("hex")}  ${name}`;
  });
  fs.writeFileSync(path.join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

module.exports = { releaseVersion, automaticReleaseTag, writeChecksums };

if (require.main === module) {
  const [operation, requestedTag, directory] = process.argv.slice(2);
  const { upstreamTag } = JSON.parse(fs.readFileSync(".github/fork-release.json", "utf8"));
  const tag = requestedTag || automaticReleaseTag(upstreamTag, process.env.GITHUB_RUN_NUMBER);
  const version = releaseVersion(tag, upstreamTag);
  if (operation === "metadata") {
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `RELEASE_VERSION=${version}\nRELEASE_TAG=${tag}\nUPSTREAM_NIGHTLY_TAG=${upstreamTag}\n`,
    );
  } else if (operation === "checksums" && directory) {
    writeChecksums(directory, version);
  } else {
    throw new Error("Usage: fork-release.cjs <metadata|checksums> <tag> [directory]");
  }
}
