// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- The detached updater coordinates macOS processes, files, and wall-clock cleanup directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const FORK_BUNDLE_IDENTIFIER = "com.t3tools.t3code";
const UPDATE_DIRECTORY_PREFIX = ".t3code-update-";
const STALE_UPDATE_AGE_MS = 24 * 60 * 60 * 1000;

export interface PreparedMacUpdate {
  readonly appBundlePath: string;
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
  await removeStaleUpdateDirectories(parentDirectory);

  const workDirectory = await NodeFSP.mkdtemp(
    NodePath.join(parentDirectory, UPDATE_DIRECTORY_PREFIX),
  );
  try {
    const zipPath = NodePath.join(workDirectory, "update.zip");
    await NodeFSP.writeFile(zipPath, input.zipBytes);

    const actualSha256 = NodeCrypto.createHash("sha256").update(input.zipBytes).digest("hex");
    if (actualSha256 !== input.expectedSha256.toLowerCase()) {
      throw new Error("The downloaded update failed SHA256 verification.");
    }

    const extractedDirectory = NodePath.join(workDirectory, "extracted");
    await runFile("/usr/bin/ditto", ["-x", "-k", zipPath, extractedDirectory]);

    const appName = NodePath.basename(input.appBundlePath);
    const stagedAppPath = NodePath.join(extractedDirectory, appName);
    const infoPlistPath = NodePath.join(stagedAppPath, "Contents", "Info.plist");
    const version = await readPlistValue(infoPlistPath, "CFBundleShortVersionString");
    const identifier = await readPlistValue(infoPlistPath, "CFBundleIdentifier");
    if (version !== input.expectedVersion || identifier !== FORK_BUNDLE_IDENTIFIER) {
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

async function removeStaleUpdateDirectories(parentDirectory: string): Promise<void> {
  const now = Date.now();
  const entries = await NodeFSP.readdir(parentDirectory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith(UPDATE_DIRECTORY_PREFIX)) return;
      const candidate = NodePath.join(parentDirectory, entry.name);
      const modifiedAt = await NodeFSP.stat(candidate)
        .then((value) => value.mtimeMs)
        .catch(() => now);
      if (now - modifiedAt >= STALE_UPDATE_AGE_MS) {
        await NodeFSP.rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      }
    }),
  );
}

const MAC_UPDATE_SCRIPT = `#!/bin/sh
set -u

pid="$1"
target="$2"
staged="$3"
work="$4"
backup="$work/previous.app"
log="$work/install.log"

exec >>"$log" 2>&1

fail() {
  if [ -e "$backup" ]; then
    if [ -e "$target" ]; then
      /bin/mv "$target" "$work/failed.app" || true
    fi
    /bin/mv "$backup" "$target" || true
  fi
  /usr/bin/open "$target" >/dev/null 2>&1 || true
  /usr/bin/osascript -e 'display notification "The previous version was restored." with title "T3 Code update failed"' >/dev/null 2>&1 || true
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

/bin/mv "$target" "$backup" || fail
/bin/mv "$staged" "$target" || fail
/usr/bin/open "$target" >/dev/null 2>&1 || fail
`;
