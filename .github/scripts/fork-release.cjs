const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function upstreamNightlyVersion(upstreamTag) {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-nightly\.\d{8}\.[1-9]\d*)$/.exec(
    upstreamTag,
  );
  if (!match || match[0] !== upstreamTag)
    throw new Error("Expected a published upstream nightly tag");
  return match[1];
}

function releaseVersion(tag, upstreamTag) {
  const match =
    /^tflins-v((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-nightly\.\d{8}\.[1-9]\d*-tflins\.[1-9]\d*)$/.exec(
      tag,
    );
  if (!match || match[0] !== tag)
    throw new Error("Expected tflins-vX.Y.Z-nightly.YYYYMMDD.B-tflins.N with a positive revision");
  const version = match[1];
  if (version.split("-tflins.")[0] !== upstreamNightlyVersion(upstreamTag)) {
    throw new Error("Tag base version differs from the pinned upstream nightly");
  }
  return version;
}

function nextAutomaticReleaseTag(upstreamTag, existingTags) {
  const prefix = `tflins-v${upstreamNightlyVersion(upstreamTag)}-tflins.`;
  let latestRevision = 0;
  for (const tag of existingTags) {
    if (typeof tag !== "string" || !tag.startsWith(prefix)) continue;
    const revision = tag.slice(prefix.length);
    if (!/^[1-9]\d*$/.test(revision)) continue;
    latestRevision = Math.max(latestRevision, Number(revision));
  }
  const tag = `${prefix}${latestRevision + 1}`;
  releaseVersion(tag, upstreamTag);
  return tag;
}

function verificationVersion(upstreamTag, sha) {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error("Invalid source commit");
  return `${upstreamNightlyVersion(upstreamTag)}-tflins.verify.${sha.toLowerCase().slice(0, 12)}`;
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

module.exports = {
  nextAutomaticReleaseTag,
  releaseVersion,
  verificationVersion,
  writeChecksums,
};

if (require.main === module) {
  const [operation, argument, directory] = process.argv.slice(2);
  const { upstreamTag } = JSON.parse(fs.readFileSync(".github/fork-release.json", "utf8"));
  if (operation === "metadata") {
    if (!argument) throw new Error("Release metadata requires an explicit tag");
    const version = releaseVersion(argument, upstreamTag);
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `RELEASE_VERSION=${version}\nRELEASE_TAG=${argument}\nUPSTREAM_NIGHTLY_TAG=${upstreamTag}\n`,
    );
  } else if (operation === "checksums" && directory) {
    if (!argument) throw new Error("Checksums require an explicit version");
    writeChecksums(directory, argument);
  } else if (operation === "next-tag" && argument) {
    const existingTags = fs.readFileSync(argument, "utf8").split(/\r?\n/).filter(Boolean);
    process.stdout.write(`${nextAutomaticReleaseTag(upstreamTag, existingTags)}\n`);
  } else if (operation === "verification-metadata") {
    const version = verificationVersion(upstreamTag, argument || process.env.GITHUB_SHA);
    fs.appendFileSync(
      process.env.GITHUB_ENV,
      `RELEASE_VERSION=${version}\nUPSTREAM_NIGHTLY_TAG=${upstreamTag}\n`,
    );
  } else {
    throw new Error(
      "Usage: fork-release.cjs <metadata|verification-metadata|next-tag|checksums> <argument> [directory]",
    );
  }
}
