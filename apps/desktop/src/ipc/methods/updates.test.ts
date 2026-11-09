import type { DesktopUpdateState } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopReleaseUpdates from "../../updates/DesktopReleaseUpdates.ts";
import * as DesktopUpdates from "../../updates/DesktopUpdates.ts";
import { checkForUpdate, getUpdateState } from "./updates.ts";

const disabledState: DesktopUpdateState = {
  enabled: false,
  status: "disabled",
  channel: "nightly",
  currentVersion: "0.1.8-nightly.20261109.4399-tflins.7",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: "Automatic updates are not available because no update feed is configured.",
  errorContext: null,
  canRetry: false,
};

it.effect("routes fork builds through their GitHub release updater", () =>
  Effect.gen(function* () {
    let forkCheckCount = 0;
    const layer = Layer.mergeAll(
      Layer.mock(DesktopUpdates.DesktopUpdates, {
        getState: Effect.succeed(disabledState),
        check: () => Effect.die("generic update feed must not run"),
      }),
      Layer.mock(DesktopReleaseUpdates.DesktopReleaseUpdates, {
        supported: true,
        checkAndPrompt: Effect.sync(() => {
          forkCheckCount += 1;
        }),
        listen: Effect.void,
      }),
    );

    const state = yield* getUpdateState.handler(undefined).pipe(Effect.provide(layer));
    assertForkState(state);

    const result = yield* checkForUpdate.handler(undefined).pipe(Effect.provide(layer));
    assert.deepEqual(result, {
      checked: true,
      state: { ...disabledState, enabled: true, status: "idle", message: null },
    });
    assert.strictEqual(forkCheckCount, 1);
  }),
);

function assertForkState(state: unknown): void {
  assert.deepEqual(state, {
    ...disabledState,
    enabled: true,
    status: "idle",
    message: null,
  });
}
