const assert = require("node:assert/strict");
const test = require("node:test");
const { releaseVersion, automaticReleaseTag } = require("./fork-release.cjs");

test("accepts a fork revision based on the checked-out desktop version", () => {
  assert.equal(releaseVersion("tflins-v0.1.7-tflins.1", "0.1.7"), "0.1.7-tflins.1");
  assert.equal(releaseVersion("tflins-v0.1.7-tflins.12", "0.1.7-tflins.1"), "0.1.7-tflins.12");
});

test("rejects official tags, malformed revisions and mismatched source versions", () => {
  for (const tag of [
    "v0.1.7",
    "main",
    "tflins-v0.1.7",
    "tflins-v0.1.7-tflins.0",
    "tflins-v0.1.7-tflins.01",
    "tflins-v0.1.7-tflins.1\n",
    "tflins-v0.1.8-tflins.1",
  ]) {
    assert.throws(() => releaseVersion(tag, "0.1.7"), undefined, tag);
  }
});

test("assigns a distinct fork version to each workflow run", () => {
  assert.equal(automaticReleaseTag("0.1.7", "12"), "tflins-v0.1.7-tflins.12");
  assert.equal(automaticReleaseTag("0.1.8", "13"), "tflins-v0.1.8-tflins.13");
  for (const invalid of [undefined, "0", "1\n", "abc"]) {
    assert.throws(() => automaticReleaseTag("0.1.7", invalid));
  }
});
