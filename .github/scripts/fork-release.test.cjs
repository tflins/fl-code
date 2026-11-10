const assert = require("node:assert/strict");
const test = require("node:test");
const {
  nextAutomaticReleaseTag,
  releaseVersion,
  verificationVersion,
} = require("./fork-release.cjs");

test("accepts a fork revision based on the pinned upstream nightly", () => {
  assert.equal(
    releaseVersion("tflins-v0.1.8-nightly.20261108.4367-tflins.1", "v0.1.8-nightly.20261108.4367"),
    "0.1.8-nightly.20261108.4367-tflins.1",
  );
  assert.equal(
    releaseVersion("tflins-v0.1.8-nightly.20261108.4367-tflins.12", "v0.1.8-nightly.20261108.4367"),
    "0.1.8-nightly.20261108.4367-tflins.12",
  );
});

test("rejects official tags, malformed revisions and mismatched nightly bases", () => {
  for (const tag of [
    "v0.1.7",
    "main",
    "tflins-v0.1.7",
    "tflins-v0.1.8-nightly.20261108.4366-tflins.1",
    "tflins-v0.1.8-nightly.20261108.4367",
    "tflins-v0.1.8-nightly.20261108.4367-tflins.0",
    "tflins-v0.1.8-nightly.20261108.4367-tflins.01",
    "tflins-v0.1.8-nightly.20261108.4367-tflins.1\n",
    "tflins-v0.1.9-nightly.20261108.4367-tflins.1",
    "tflins-v0.1.8-nightly.20261107.4367-tflins.1",
  ]) {
    assert.throws(() => releaseVersion(tag, "v0.1.8-nightly.20261108.4367"), undefined, tag);
  }
});

test("increments from published releases for the pinned upstream nightly", () => {
  const upstreamTag = "v0.1.8-nightly.20261108.4367";
  assert.equal(
    nextAutomaticReleaseTag(upstreamTag, [
      "tflins-v0.1.8-nightly.20261108.4367-tflins.4",
      "tflins-v0.1.8-nightly.20261108.4367-tflins.12",
      "tflins-v0.1.9-nightly.20261108.4368-tflins.99",
      "v0.1.8-nightly.20261108.4367",
    ]),
    "tflins-v0.1.8-nightly.20261108.4367-tflins.13",
  );
  assert.equal(
    nextAutomaticReleaseTag("v0.1.9-nightly.20261108.4368", [
      "tflins-v0.1.8-nightly.20261108.4367-tflins.12",
    ]),
    "tflins-v0.1.9-nightly.20261108.4368-tflins.1",
  );
  for (const upstream of ["main", "v0.1.7", "v0.1.8-nightly.20261108.4367\n"]) {
    assert.throws(() => nextAutomaticReleaseTag(upstream, []));
  }
});

test("uses a source-bound version for build-only verification", () => {
  assert.equal(
    verificationVersion("v0.1.8-nightly.20261108.4367", "0123456789abcdef0123456789abcdef01234567"),
    "0.1.8-nightly.20261108.4367-tflins.verify.0123456789ab",
  );
  for (const sha of [undefined, "", "main", "0123456\n"]) {
    assert.throws(() => verificationVersion("v0.1.8-nightly.20261108.4367", sha));
  }
});
