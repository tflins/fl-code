// @effect-diagnostics nodeBuiltinImport:off -- This test builds a disposable macOS app bundle with the same OS tools as the updater.
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { prepareMacUpdate } from "./forkMacUpdater.ts";

const execFilePromise = NodeUtil.promisify(NodeChildProcess.execFile);
const EXITED_PID = "99999999";

async function writeTestAppBundle(
  appPath: string,
  executableName: string,
  version: string,
): Promise<void> {
  const contentsPath = NodePath.join(appPath, "Contents");
  const executablePath = NodePath.join(contentsPath, "MacOS", executableName);
  await NodeFSP.mkdir(NodePath.dirname(executablePath), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(contentsPath, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.t3tools.t3code</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>${executableName}</string>
</dict></plist>
`,
  );
  await NodeFSP.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
  await NodeFSP.chmod(executablePath, 0o755);
}

async function createPreparedMigrationFixture(root: string, currentVersion: string) {
  const installedAppPath = NodePath.join(root, "T3 Code (Nightly).app");
  const downloadedAppPath = NodePath.join(root, "download", "FL Code (Nightly).app");
  await writeTestAppBundle(installedAppPath, "T3 Code (Nightly)", currentVersion);
  await writeTestAppBundle(downloadedAppPath, "FL Code (Nightly)", "1.2.3-tflins.7");

  const zipPath = NodePath.join(root, "update.zip");
  await execFilePromise("/usr/bin/ditto", ["-c", "-k", "--keepParent", downloadedAppPath, zipPath]);
  const zipBytes = await NodeFSP.readFile(zipPath);
  const expectedSha256 = NodeCrypto.createHash("sha256").update(zipBytes).digest("hex");
  const prepared = await prepareMacUpdate({
    appBundlePath: installedAppPath,
    expectedSha256,
    expectedVersion: "1.2.3-tflins.7",
    zipBytes,
  });
  return { installedAppPath, prepared };
}

async function runMacUpdateScript(
  prepared: Awaited<ReturnType<typeof prepareMacUpdate>>,
  openCommand: string,
): Promise<void> {
  await execFilePromise(
    "/bin/sh",
    [
      prepared.scriptPath,
      EXITED_PID,
      prepared.appBundlePath,
      prepared.destinationAppPath,
      prepared.stagedAppPath,
      prepared.workDirectory,
    ],
    {
      env: {
        ...process.env,
        T3CODE_UPDATE_OPEN: openCommand,
        T3CODE_UPDATE_SKIP_NOTIFICATION: "1",
      },
    },
  );
}

async function assertRejects(promise: Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await promise;
  } catch {
    rejected = true;
  }
  assert.isTrue(rejected);
}

it.effect("migrates a verified macOS update from the legacy app bundle name", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "darwin") return;

    yield* Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-updater-test-"));
      try {
        const { installedAppPath, prepared } = await createPreparedMigrationFixture(
          root,
          "1.2.2-tflins.6",
        );

        assert.equal(NodePath.dirname(prepared.workDirectory), root);
        assert.equal(prepared.destinationAppPath, NodePath.join(root, "FL Code (Nightly).app"));
        await NodeFSP.access(
          NodePath.join(prepared.stagedAppPath, "Contents", "MacOS", "FL Code (Nightly)"),
        );

        await runMacUpdateScript(prepared, "/usr/bin/true");

        await NodeFSP.access(prepared.destinationAppPath);
        await assertRejects(NodeFSP.access(installedAppPath));
        await NodeFSP.access(NodePath.join(prepared.workDirectory, "previous.app"));
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });
  }),
);

it.effect("restores the legacy app bundle when launch after migration fails", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "darwin") return;

    yield* Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-updater-test-"));
      try {
        const { installedAppPath, prepared } = await createPreparedMigrationFixture(
          root,
          "1.2.2-tflins.6",
        );

        await assertRejects(runMacUpdateScript(prepared, "/usr/bin/false"));

        await NodeFSP.access(installedAppPath);
        await assertRejects(NodeFSP.access(prepared.destinationAppPath));
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });
  }),
);
