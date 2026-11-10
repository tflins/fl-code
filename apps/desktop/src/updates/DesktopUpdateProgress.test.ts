import { assert, it } from "@effect/vitest";

import { downloadProgressPercent } from "./DesktopUpdateProgress.ts";

it("reports bounded whole-number download progress", () => {
  assert.equal(downloadProgressPercent(0, 1_000), 0);
  assert.equal(downloadProgressPercent(499, 1_000), 49);
  assert.equal(downloadProgressPercent(1_000, 1_000), 100);
  assert.equal(downloadProgressPercent(1_500, 1_000), 100);
  assert.equal(downloadProgressPercent(500, 0), 0);
});
