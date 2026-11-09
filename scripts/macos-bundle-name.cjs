const fs = require("node:fs");
const path = require("node:path");

const HELPER_BUNDLES = [
  { directory: "Frameworks", suffix: " Helper" },
  { directory: "Frameworks", suffix: " Helper (GPU)" },
  { directory: "Frameworks", suffix: " Helper (Plugin)" },
  { directory: "Frameworks", suffix: " Helper (Renderer)" },
  { directory: "Library/LoginItems", suffix: " Login Helper" },
];

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function setPlistString(plistPath, key, value) {
  const source = fs.readFileSync(plistPath, "utf8");
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`, "u");
  if (!pattern.test(source)) {
    throw new Error(`Missing ${key} in ${plistPath}`);
  }
  fs.writeFileSync(plistPath, source.replace(pattern, `$1${escapeXml(value)}$2`));
}

function renameBundle(sourceBundle, targetBundle, sourceName, targetName) {
  if (!fs.existsSync(targetBundle)) {
    if (!fs.existsSync(sourceBundle)) {
      return;
    }
    fs.renameSync(sourceBundle, targetBundle);
  }

  const sourceExecutable = path.join(targetBundle, "Contents", "MacOS", sourceName);
  const targetExecutable = path.join(targetBundle, "Contents", "MacOS", targetName);
  if (sourceExecutable !== targetExecutable) {
    if (!fs.existsSync(sourceExecutable)) {
      throw new Error(`Missing macOS bundle executable ${sourceExecutable}`);
    }
    fs.renameSync(sourceExecutable, targetExecutable);
  } else if (!fs.existsSync(targetExecutable)) {
    throw new Error(`Missing macOS bundle executable ${targetExecutable}`);
  }

  const infoPlistPath = path.join(targetBundle, "Contents", "Info.plist");
  setPlistString(infoPlistPath, "CFBundleExecutable", targetName);
  setPlistString(infoPlistPath, "CFBundleName", targetName);
  setPlistString(infoPlistPath, "CFBundleDisplayName", targetName);
}

/**
 * Electron resolves helper bundles from the main bundle's CFBundleName. Keep the
 * stable installed bundle and executable names while aligning helpers with the
 * user-visible application name.
 */
function alignMacHelperBundleNames({ appOutDir, productName, bundleName }) {
  if (productName === bundleName) {
    return;
  }

  const appBundle = path.join(appOutDir, `${productName}.app`);
  const contents = path.join(appBundle, "Contents");
  for (const { directory, suffix } of HELPER_BUNDLES) {
    const parent = path.join(contents, ...directory.split("/"));
    renameBundle(
      path.join(parent, `${productName}${suffix}.app`),
      path.join(parent, `${bundleName}${suffix}.app`),
      `${productName}${suffix}`,
      `${bundleName}${suffix}`,
    );
  }
}

module.exports = { alignMacHelperBundleNames };
