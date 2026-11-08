const assert = require("node:assert/strict");
const test = require("node:test");
const { releaseVersion, automaticReleaseTag } = require("./fork-release.cjs");

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

test("assigns a distinct fork version to each workflow run", () => {
  assert.equal(
    automaticReleaseTag("v0.1.8-nightly.20261108.4367", "12"),
    "tflins-v0.1.8-nightly.20261108.4367-tflins.12",
  );
  assert.equal(
    automaticReleaseTag("v0.1.9-nightly.20261108.4368", "13"),
    "tflins-v0.1.9-nightly.20261108.4368-tflins.13",
  );
  for (const invalid of [undefined, "0", "1\n", "abc"]) {
    assert.throws(() => automaticReleaseTag("v0.1.8-nightly.20261108.4367", invalid));
  }
  for (const upstream of ["main", "v0.1.7", "v0.1.8-nightly.20261108.4367\n"]) {
    assert.throws(() => automaticReleaseTag(upstream, "12"));
  }
});
