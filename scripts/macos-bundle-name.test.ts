// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

interface MacBundleName {
  readonly alignMacHelperBundleNames: (input: {
    readonly appOutDir: string;
    readonly productName: string;
    readonly bundleName: string;
  }) => void;
}

const require = NodeModule.createRequire(import.meta.url);
const { alignMacHelperBundleNames } = require("./macos-bundle-name.cjs") as MacBundleName;

const infoPlist = (executableName: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${executableName}</string>
  <key>CFBundleExecutable</key>
  <string>${executableName}</string>
  <key>CFBundleName</key>
  <string>${executableName}</string>
</dict>
</plist>
`;

it("aligns Electron helpers with the visible macOS bundle name", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-macos-bundle-name-"));
  const productName = "T3 Code (Nightly)";
  const bundleName = "FL Code (Nightly)";
  const appBundle = NodePath.join(root, `${productName}.app`);
  const helpers = [
    { directory: "Frameworks", suffix: " Helper" },
    { directory: "Frameworks", suffix: " Helper (GPU)" },
    { directory: "Frameworks", suffix: " Helper (Plugin)" },
    { directory: "Frameworks", suffix: " Helper (Renderer)" },
    { directory: "Library/LoginItems", suffix: " Login Helper" },
  ] as const;

  try {
    for (const { directory, suffix } of helpers) {
      const executableName = `${productName}${suffix}`;
      const helperBundle = NodePath.join(
        appBundle,
        "Contents",
        ...directory.split("/"),
        `${executableName}.app`,
      );
      const executableDir = NodePath.join(helperBundle, "Contents", "MacOS");
      NodeFS.mkdirSync(executableDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(executableDir, executableName), "");
      NodeFS.writeFileSync(
        NodePath.join(helperBundle, "Contents", "Info.plist"),
        infoPlist(executableName),
      );
    }

    alignMacHelperBundleNames({ appOutDir: root, productName, bundleName });

    for (const { directory, suffix } of helpers) {
      const executableName = `${bundleName}${suffix}`;
      const helperBundle = NodePath.join(
        appBundle,
        "Contents",
        ...directory.split("/"),
        `${executableName}.app`,
      );
      expect(
        NodeFS.existsSync(NodePath.join(helperBundle, "Contents", "MacOS", executableName)),
      ).toBe(true);
      expect(
        NodeFS.readFileSync(NodePath.join(helperBundle, "Contents", "Info.plist"), "utf8"),
      ).not.toContain(productName);
    }
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
