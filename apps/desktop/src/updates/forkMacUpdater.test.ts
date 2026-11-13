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

import { cleanupMacUpdates, prepareMacUpdate } from "./forkMacUpdater.ts";

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

        await cleanupMacUpdates({
          appBundlePath: prepared.destinationAppPath,
          currentVersion: "1.2.3-tflins.7",
        });
        await assertRejects(NodeFSP.access(prepared.workDirectory));
        await NodeFSP.access(prepared.destinationAppPath);
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });
  }),
);

it.effect("cleans completed legacy updates while retaining active and recoverable backups", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "darwin") return;
    yield* Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-updater-test-"));
      try {
        const appBundlePath = NodePath.join(root, "FL Code (Nightly).app");
        await writeTestAppBundle(appBundlePath, "FL Code (Nightly)", "1.2.3-tflins.7");
        const legacy = NodePath.join(root, ".t3code-update-legacy");
        const active = NodePath.join(root, ".t3code-update-active");
        const recoverable = NodePath.join(root, ".t3code-update-recoverable");
        const stale = NodePath.join(root, ".t3code-update-stale");
        const unrelated = NodePath.join(root, ".t3code-update-unrelated");
        const newer = NodePath.join(root, ".t3code-update-newer");
        const invalid = NodePath.join(root, ".t3code-update-invalid");
        const linked = NodePath.join(root, ".t3code-update-linked");
        const download = NodePath.join(root, ".t3code-update-download");
        const abandoned = NodePath.join(root, ".t3code-update-abandoned");
        const discarded = NodePath.join(root, ".t3code-update-cleanup-interrupted");
        await NodeFSP.mkdir(discarded);
        await NodeFSP.writeFile(NodePath.join(discarded, "remaining.bin"), "interrupted cleanup");
        for (const directory of [legacy, active, recoverable]) {
          await writeTestAppBundle(
            NodePath.join(directory, "previous.app"),
            "FL Code",
            "1.2.2-tflins.6",
          );
        }
        await NodeFSP.writeFile(NodePath.join(active, "pending"), String(process.pid));
        await writeTestAppBundle(NodePath.join(newer, "previous.app"), "FL Code", "1.2.4-tflins.8");
        await NodeFSP.mkdir(NodePath.join(invalid, "previous.app"), { recursive: true });
        await NodeFSP.symlink(legacy, linked);
        for (const [directory, pid] of [
          [download, String(process.pid)],
          [abandoned, EXITED_PID],
        ] as const) {
          await NodeFSP.mkdir(directory);
          await NodeFSP.writeFile(NodePath.join(directory, "update.zip"), "partial download");
          await NodeFSP.writeFile(NodePath.join(directory, "pending"), pid);
          await NodeFSP.utimes(directory, 0, 0);
        }
        await writeTestAppBundle(
          NodePath.join(recoverable, "extracted", "FL Code.app"),
          "FL Code",
          "1.2.4-tflins.8",
        );
        await NodeFSP.mkdir(stale);
        await NodeFSP.writeFile(NodePath.join(stale, "update.zip"), "partial download");
        await NodeFSP.mkdir(unrelated);
        await NodeFSP.writeFile(NodePath.join(unrelated, "keep.txt"), "unrelated content");
        for (const directory of [active, recoverable, stale, unrelated, newer, invalid]) {
          await NodeFSP.utimes(directory, 0, 0);
        }

        await cleanupMacUpdates({ appBundlePath, currentVersion: "1.2.4-tflins.8" });
        await NodeFSP.access(legacy);
        await NodeFSP.access(stale);
        await cleanupMacUpdates({ appBundlePath, currentVersion: "1.2.3-tflins.7" });

        await assertRejects(NodeFSP.access(legacy));
        await assertRejects(NodeFSP.access(stale));
        await assertRejects(NodeFSP.access(abandoned));
        await assertRejects(NodeFSP.access(discarded));
        for (const directory of [active, recoverable, unrelated, newer, invalid, download])
          await NodeFSP.access(directory);
        assert.isTrue((await NodeFSP.lstat(linked)).isSymbolicLink());
        await NodeFSP.access(appBundlePath);
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
        await cleanupMacUpdates({
          appBundlePath: installedAppPath,
          currentVersion: "1.2.2-tflins.6",
        });
        await NodeFSP.access(prepared.workDirectory);
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });
  }),
);
