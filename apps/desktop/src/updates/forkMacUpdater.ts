// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The detached updater coordinates macOS processes, files, and wall-clock cleanup directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { compareSemverVersions } from "@t3tools/shared/semver";

const FORK_BUNDLE_IDENTIFIER = "com.t3tools.t3code";
const UPDATE_DIRECTORY_PREFIX = ".t3code-update-";
const CLEANUP_DIRECTORY_PREFIX = ".t3code-update-cleanup-";
const STALE_UPDATE_AGE_MS = 24 * 60 * 60 * 1000;

export interface PreparedMacUpdate {
  readonly appBundlePath: string;
  readonly destinationAppPath: string;
  readonly scriptPath: string;
  readonly stagedAppPath: string;
  readonly workDirectory: string;
}

interface PrepareMacUpdateInput {
  readonly appBundlePath: string;
  readonly expectedSha256: string;
  readonly expectedVersion: string;
  readonly zipBytes: Uint8Array;
}

export async function prepareMacUpdate(input: PrepareMacUpdateInput): Promise<PreparedMacUpdate> {
  const parentDirectory = NodePath.dirname(input.appBundlePath);
  await NodeFSP.access(parentDirectory, NodeFS.constants.W_OK);

  const workDirectory = await NodeFSP.mkdtemp(
    NodePath.join(parentDirectory, UPDATE_DIRECTORY_PREFIX),
  );
  try {
    await NodeFSP.writeFile(NodePath.join(workDirectory, "pending"), String(process.pid));
    const zipPath = NodePath.join(workDirectory, "update.zip");
    await NodeFSP.writeFile(zipPath, input.zipBytes);

    const actualSha256 = NodeCrypto.createHash("sha256").update(input.zipBytes).digest("hex");
    if (actualSha256 !== input.expectedSha256.toLowerCase()) {
      throw new Error("The downloaded update failed SHA256 verification.");
    }

    const extractedDirectory = NodePath.join(workDirectory, "extracted");
    await runFile("/usr/bin/ditto", ["-x", "-k", zipPath, extractedDirectory]);

    const stagedAppPath = await findExtractedAppBundle(extractedDirectory);
    const infoPlistPath = NodePath.join(stagedAppPath, "Contents", "Info.plist");
    const version = await readPlistValue(infoPlistPath, "CFBundleShortVersionString");
    if (version !== input.expectedVersion) {
      throw new Error("The downloaded application identity does not match this fork release.");
    }

    const executableName = await readPlistValue(infoPlistPath, "CFBundleExecutable");
    if (
      executableName.length === 0 ||
      executableName === "." ||
      executableName === ".." ||
      executableName.includes("/")
    ) {
      throw new Error("The downloaded application has an invalid executable name.");
    }
    await NodeFSP.access(
      NodePath.join(stagedAppPath, "Contents", "MacOS", executableName),
      NodeFS.constants.X_OK,
    );
    await runFile("/usr/bin/xattr", ["-rd", "com.apple.quarantine", stagedAppPath]);
    await NodeFSP.rm(zipPath, { force: true });

    const scriptPath = NodePath.join(workDirectory, "install.sh");
    await NodeFSP.writeFile(scriptPath, MAC_UPDATE_SCRIPT, { mode: 0o700 });
    await NodeFSP.chmod(scriptPath, 0o700);

    return {
      appBundlePath: input.appBundlePath,
      destinationAppPath: NodePath.join(parentDirectory, NodePath.basename(stagedAppPath)),
      scriptPath,
      stagedAppPath,
      workDirectory,
    };
  } catch (error) {
    await NodeFSP.rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function launchMacUpdate(update: PreparedMacUpdate): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "/bin/sh",
      [
        update.scriptPath,
        String(process.pid),
        update.appBundlePath,
        update.destinationAppPath,
        update.stagedAppPath,
        update.workDirectory,
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function cleanupMacUpdates(input: {
  readonly appBundlePath: string;
  readonly currentVersion: string;
}): Promise<void> {
  if ((await readUpdateBundleVersion(input.appBundlePath)) !== input.currentVersion) return;
  const parentDirectory = NodePath.dirname(input.appBundlePath);
  const entries = await NodeFSP.readdir(parentDirectory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith(UPDATE_DIRECTORY_PREFIX)) return;
      const directory = NodePath.join(parentDirectory, entry.name);
      if (entry.name.startsWith(CLEANUP_DIRECTORY_PREFIX)) {
        await NodeFSP.rm(directory, { recursive: true, force: true });
        return;
      }
      if (await canRemoveUpdateDirectory(directory, input.currentVersion)) {
        // Preserve cleanup ownership if deleting a large backup is interrupted.
        const discarded = NodePath.join(
          parentDirectory,
          `${CLEANUP_DIRECTORY_PREFIX}${NodeCrypto.randomUUID()}`,
        );
        await NodeFSP.rename(directory, discarded);
        await NodeFSP.rm(discarded, { recursive: true, force: true });
      }
    }),
  );
}

async function findExtractedAppBundle(extractedDirectory: string): Promise<string> {
  const entries = await NodeFSP.readdir(extractedDirectory, { withFileTypes: true });
  const matches: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;

    const candidate = NodePath.join(extractedDirectory, entry.name);
    const identifier = await readPlistValue(
      NodePath.join(candidate, "Contents", "Info.plist"),
      "CFBundleIdentifier",
    ).catch(() => undefined);
    if (identifier === FORK_BUNDLE_IDENTIFIER) {
      matches.push(candidate);
    }
  }

  if (matches.length !== 1) {
    throw new Error("The downloaded archive must contain exactly one FL Code application.");
  }
  return matches[0]!;
}

async function readPlistValue(infoPlistPath: string, key: string): Promise<string> {
  const output = await runFile("/usr/libexec/PlistBuddy", ["-c", `Print ${key}`, infoPlistPath]);
  return output.trim();
}

async function runFile(file: string, args: ReadonlyArray<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      file,
      args,
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim();
          reject(
            new Error(
              detail.length > 0
                ? `${NodePath.basename(file)} failed: ${detail}`
                : `${file} failed.`,
              { cause: error },
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function canRemoveUpdateDirectory(
  directory: string,
  currentVersion: string,
): Promise<boolean> {
  const entries = await NodeFSP.readdir(directory);
  const pending = entries.includes("pending") && !entries.includes("completed");
  if (entries.includes("previous.app")) {
    if (pending) return false;
    const previousVersion = await readUpdateBundleVersion(NodePath.join(directory, "previous.app"));
    if (previousVersion === undefined) return false;
    try {
      if (compareSemverVersions(previousVersion, currentVersion) >= 0) return false;
    } catch {
      return false;
    }
    const staged = await NodeFSP.readdir(NodePath.join(directory, "extracted")).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      },
    );
    return !staged.some((name) => name.endsWith(".app"));
  }
  if (
    !entries.some((name) => name === "update.zip" || name === "extracted" || name === "install.sh")
  ) {
    return false;
  }
  const modifiedAt = (await NodeFSP.stat(directory)).mtimeMs;
  if (Date.now() - modifiedAt < STALE_UPDATE_AGE_MS) return false;
  if (!pending) return true;
  const ownerPid = Number(await NodeFSP.readFile(NodePath.join(directory, "pending"), "utf8"));
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
  try {
    process.kill(ownerPid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function readUpdateBundleVersion(appPath: string): Promise<string | undefined> {
  const infoPath = NodePath.join(appPath, "Contents", "Info.plist");
  if (!(await NodeFSP.lstat(appPath).catch(() => undefined))?.isDirectory()) return undefined;
  const identifier = await readPlistValue(infoPath, "CFBundleIdentifier").catch(() => undefined);
  if (identifier !== FORK_BUNDLE_IDENTIFIER) return undefined;
  return readPlistValue(infoPath, "CFBundleShortVersionString").catch(() => undefined);
}

const MAC_UPDATE_SCRIPT = `#!/bin/sh
set -u

pid="$1"
target="$2"
destination="$3"
staged="$4"
work="$5"
backup="$work/previous.app"
failed="$work/failed.app"
log="$work/install.log"

exec >>"$log" 2>&1

open_app() {
  "\${T3CODE_UPDATE_OPEN:-/usr/bin/open}" "$1" >/dev/null 2>&1
}

notify_failure() {
  if [ "\${T3CODE_UPDATE_SKIP_NOTIFICATION:-}" = "1" ]; then
    return
  fi
  /usr/bin/osascript -e 'display notification "The previous version was restored." with title "FL Code update failed"' >/dev/null 2>&1 || true
}

fail() {
  if [ -e "$backup" ]; then
    if [ -e "$destination" ]; then
      /bin/rm -rf "$failed"
      /bin/mv "$destination" "$failed" || true
    fi
    /bin/mv "$backup" "$target" || true
  fi
  open_app "$target" || true
  notify_failure
  exit 1
}

waited=0
while /bin/kill -0 "$pid" 2>/dev/null; do
  if [ "$waited" -ge 600 ]; then
    fail
  fi
  /bin/sleep 0.1
  waited=$((waited + 1))
done

if [ "$destination" != "$target" ] && [ -e "$destination" ]; then
  fail
fi
/bin/mv "$target" "$backup" || fail
/bin/mv "$staged" "$destination" || fail
open_app "$destination" || fail
: > "$work/completed"
`;
