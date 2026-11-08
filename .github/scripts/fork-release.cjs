const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function releaseVersion(tag, baseVersion) {
  const match = /^tflins-v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-tflins\.[1-9]\d*)$/.exec(tag);
  if (!match || match[0] !== tag)
    throw new Error("Expected tflins-vX.Y.Z-tflins.N with a positive revision");
  const version = match[1];
  if (version.split("-")[0] !== baseVersion.split("-")[0]) {
    throw new Error("Tag base version differs from apps/desktop/package.json");
  }
  return version;
}

function automaticReleaseTag(baseVersion, runNumber) {
  if (!/^[1-9]\d*$/.test(String(runNumber))) throw new Error("Invalid workflow run number");
  const tag = `tflins-v${baseVersion.split("-")[0]}-tflins.${runNumber}`;
  releaseVersion(tag, baseVersion);
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
  const manifest = JSON.parse(fs.readFileSync("apps/desktop/package.json", "utf8"));
  const tag = requestedTag || automaticReleaseTag(manifest.version, process.env.GITHUB_RUN_NUMBER);
  const version = releaseVersion(tag, manifest.version);
  if (operation === "metadata") {
    fs.appendFileSync(process.env.GITHUB_ENV, `RELEASE_VERSION=${version}\nRELEASE_TAG=${tag}\n`);
  } else if (operation === "checksums" && directory) {
    writeChecksums(directory, version);
  } else {
    throw new Error("Usage: fork-release.cjs <metadata|checksums> <tag> [directory]");
  }
}
