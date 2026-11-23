// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- The installer takes paths and prints the prepared bundle for the caller.
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { prepareLocalMacInstall } from "./forkMacUpdater.ts";

const [sourceAppPath, signingFingerprint, outputDirectory = "."] = process.argv.slice(2);
if (
  HostProcess.Platform.defaultValue() !== "darwin" ||
  sourceAppPath === undefined ||
  signingFingerprint === undefined
) {
  throw new Error(
    "Usage on macOS: vp run dist:desktop:local-install <source.app> <signing fingerprint> [output directory]",
  );
}

console.log(
  await prepareLocalMacInstall({
    sourceAppPath: NodePath.resolve(sourceAppPath),
    outputDirectory: NodePath.resolve(outputDirectory),
    signingFingerprint,
  }),
);
