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

it.effect("prepares a verified macOS application bundle in a same-volume staging directory", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "darwin") return;

    yield* Effect.promise(async () => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-updater-test-"));
      try {
        const appPath = NodePath.join(root, "T3 Code (Nightly).app");
        const contentsPath = NodePath.join(appPath, "Contents");
        const executablePath = NodePath.join(contentsPath, "MacOS", "T3 Code");
        await NodeFSP.mkdir(NodePath.dirname(executablePath), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(contentsPath, "Info.plist"),
          `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.t3tools.t3code</string>
<key>CFBundleShortVersionString</key><string>1.2.3-tflins.7</string>
<key>CFBundleExecutable</key><string>T3 Code</string>
</dict></plist>
`,
        );
        await NodeFSP.writeFile(executablePath, "#!/bin/sh\nexit 0\n");
        await NodeFSP.chmod(executablePath, 0o755);

        const zipPath = NodePath.join(root, "update.zip");
        await execFilePromise("/usr/bin/ditto", ["-c", "-k", "--keepParent", appPath, zipPath]);
        const zipBytes = await NodeFSP.readFile(zipPath);
        const expectedSha256 = NodeCrypto.createHash("sha256").update(zipBytes).digest("hex");

        const prepared = await prepareMacUpdate({
          appBundlePath: appPath,
          expectedSha256,
          expectedVersion: "1.2.3-tflins.7",
          zipBytes,
        });

        assert.equal(NodePath.dirname(prepared.workDirectory), root);
        await NodeFSP.access(NodePath.join(prepared.stagedAppPath, "Contents", "MacOS", "T3 Code"));
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    });
  }),
);
