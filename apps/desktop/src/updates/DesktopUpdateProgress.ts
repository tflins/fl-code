import * as Electron from "electron";

export type UpdateProgressPhase = "downloading" | "verifying" | "restarting" | "failed";

export interface UpdateProgressState {
  readonly phase: UpdateProgressPhase;
  readonly percent: number;
  readonly detail: string;
}

export interface DesktopUpdateProgress {
  readonly update: (state: UpdateProgressState) => Promise<void>;
  readonly close: () => void;
}

const NOOP_PROGRESS: DesktopUpdateProgress = {
  update: async () => undefined,
  close: () => undefined,
};

export function downloadProgressPercent(receivedBytes: number, totalBytes: number): number {
  if (!Number.isFinite(receivedBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.floor((receivedBytes / totalBytes) * 100)));
}

export async function openUpdateProgress(version: string): Promise<DesktopUpdateProgress> {
  let window: Electron.BrowserWindow | undefined;
  try {
    window = new Electron.BrowserWindow({
      width: 480,
      height: 220,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: `Updating FL Code to ${version}`,
      backgroundColor: "#111111",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const progressWindow = window;
    progressWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    progressWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    await progressWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(updateProgressHtml(version))}`,
    );
    if (progressWindow.isDestroyed()) return NOOP_PROGRESS;
    progressWindow.show();

    return {
      update: async (state) => {
        if (progressWindow.isDestroyed()) return;
        try {
          await progressWindow.webContents.executeJavaScript(
            `window.updateUpdateProgress(${JSON.stringify(state)})`,
          );
        } catch {
          // Progress reporting must never interrupt the update.
        }
      },
      close: () => {
        if (!progressWindow.isDestroyed()) progressWindow.destroy();
      },
    };
  } catch {
    if (window !== undefined && !window.isDestroyed()) window.destroy();
    return NOOP_PROGRESS;
  }
}

function updateProgressHtml(version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Updating FL Code</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #f5f5f5; background: #171717; }
    main { padding: 28px 30px; }
    h1 { margin: 0 0 8px; font-size: 18px; line-height: 1.3; }
    p { margin: 0; color: #b8b8b8; font-size: 13px; line-height: 1.5; }
    progress { width: 100%; height: 10px; margin: 22px 0 10px; accent-color: #3b82f6; }
    .meta { display: flex; justify-content: space-between; gap: 16px; }
    #percent { color: #f5f5f5; font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <main>
    <h1>Updating FL Code</h1>
    <p>${escapeHtml(version)}</p>
    <progress id="bar" max="100" value="0"></progress>
    <div class="meta">
      <p id="detail">Preparing download…</p>
      <p id="percent">0%</p>
    </div>
  </main>
  <script>
    window.updateUpdateProgress = (state) => {
      const percent = Math.min(100, Math.max(0, Math.round(state.percent)));
      document.getElementById("bar").value = percent;
      document.getElementById("percent").textContent = percent + "%";
      document.getElementById("detail").textContent = state.detail;
    };
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
