import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { macAppBundlePath } from "../app/macAppBundlePath.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import {
  downloadProgressPercent,
  openUpdateProgress,
  type DesktopUpdateProgress,
} from "./DesktopUpdateProgress.ts";
import { launchMacUpdate, prepareMacUpdate } from "./forkMacUpdater.ts";
import {
  FORK_RELEASE_REPOSITORY,
  GitHubReleases,
  isForkDesktopVersion,
  readExpectedSha256,
  selectNewerForkRelease,
  type ForkRelease,
} from "./forkRelease.ts";

const STARTUP_DELAY = Duration.seconds(15);
const POLL_INTERVAL = Duration.hours(6);
const API_REQUEST_TIMEOUT = Duration.seconds(15);
const FILE_REQUEST_TIMEOUT = Duration.minutes(5);
const ARCHIVE_REQUEST_TIMEOUT = Duration.minutes(30);
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

type DesktopReleaseUpdateCheckResult =
  | { readonly status: "unsupported" }
  | {
      readonly status: "up-to-date";
      readonly currentVersion: string;
    }
  | {
      readonly status: "available";
      readonly currentVersion: string;
      readonly release: ForkRelease;
    }
  | {
      readonly status: "error";
      readonly currentVersion: string;
      readonly message: string;
    };

class ForkReleaseInstallError extends Schema.TaggedError<ForkReleaseInstallError>()(
  "ForkReleaseInstallError",
  {
    stage: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Fork release update failed during ${this.stage}.`;
  }
}

const isForkReleaseInstallError = Schema.is(ForkReleaseInstallError);

export class DesktopReleaseUpdates extends Context.Service<
  DesktopReleaseUpdates,
  {
    readonly supported: boolean;
    readonly checkAndPrompt: Effect.Effect<void>;
    readonly listen: Effect.Effect<void>;
  }
>()("@t3tools/desktop/updates/DesktopReleaseUpdates") {}

type DesktopReleaseUpdatesRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
  | HttpClient.HttpClient;

const { logInfo, logWarning } = makeComponentLogger("desktop-release-updates");

export const followReleaseRedirects = HttpClient.followRedirects();

const describeCause = (cause: unknown): string => {
  if (Cause.isCause(cause)) {
    return cause.reasons
      .map((reason) => {
        if (reason._tag === "Fail") return describeCause(reason.error);
        if (reason._tag === "Die") return describeCause(reason.defect);
        return "Interrupted";
      })
      .join("; ");
  }
  if (isForkReleaseInstallError(cause)) {
    return `${cause.message} ${describeCause(cause.cause)}`;
  }
  if (cause instanceof Error) return cause.message;
  return String(cause);
};

const formatMegabytes = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`;

async function downloadReleaseArchive(
  release: ForkRelease,
  progress: DesktopUpdateProgress,
): Promise<Uint8Array> {
  const response = await fetchReleaseResponse(
    release.zipUrl,
    "application/octet-stream",
    ARCHIVE_REQUEST_TIMEOUT,
  );
  if (response.body === null) {
    throw new Error("Release archive download returned an empty response body.");
  }

  const bytes = new Uint8Array(release.zipSize);
  const reader = response.body.getReader();
  let receivedBytes = 0;
  let lastReportedPercent = -1;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (receivedBytes + chunk.value.byteLength > bytes.byteLength) {
        throw new Error("The downloaded update is larger than its release metadata.");
      }
      bytes.set(chunk.value, receivedBytes);
      receivedBytes += chunk.value.byteLength;

      const percent = downloadProgressPercent(receivedBytes, bytes.byteLength);
      if (percent !== lastReportedPercent) {
        lastReportedPercent = percent;
        await progress.update({
          phase: "downloading",
          percent: Math.floor(percent * 0.9),
          detail: `${formatMegabytes(receivedBytes)} of ${formatMegabytes(bytes.byteLength)} (${percent}%)`,
        });
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (receivedBytes !== bytes.byteLength) {
    throw new Error("The downloaded update size does not match the release metadata.");
  }
  return bytes;
}

const readReleaseText = Effect.fn("DesktopReleaseUpdates.readReleaseText")(
  (url: string, accept: string, timeout: Duration.Duration) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetchReleaseResponse(url, accept, timeout);
        return response.text();
      },
      catch: (cause) => new ForkReleaseInstallError({ stage: "release metadata download", cause }),
    }),
);

async function fetchReleaseResponse(
  url: string,
  accept: string,
  timeout: Duration.Duration,
): Promise<Response> {
  // Release assets must honor Chromium's system proxy, including the checksum manifest.
  const response = await Electron.net.fetch(url, {
    headers: { accept, "user-agent": "t3code-fork-release-updater" },
    redirect: "follow",
    signal: AbortSignal.timeout(Duration.toMillis(timeout)),
  });
  if (!response.ok) {
    throw new Error(`Update request to ${url} returned HTTP ${response.status}.`);
  }
  return response;
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const httpClient = followReleaseRedirects(yield* HttpClient.HttpClient);
  const lastNotifiedVersion = yield* Ref.make(Option.none<string>());
  const actionSemaphore = yield* Semaphore.make(1);
  const runtimeContext = yield* Effect.context<DesktopReleaseUpdatesRuntimeServices>();
  const runPromise = Effect.runPromiseWith(runtimeContext);
  const supported =
    environment.platform === "darwin" &&
    environment.processArch === "arm64" &&
    environment.isPackaged &&
    isForkDesktopVersion(environment.appVersion);

  const executeRequest = (url: string, accept: string, timeout: Duration.Duration) =>
    HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders({ accept, "user-agent": "t3code-fork-release-updater" }),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout(timeout),
    );

  const check: Effect.Effect<DesktopReleaseUpdateCheckResult> = supported
    ? executeRequest(
        `https://api.github.com/repos/${FORK_RELEASE_REPOSITORY}/releases?per_page=30`,
        "application/vnd.github+json",
        API_REQUEST_TIMEOUT,
      ).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(GitHubReleases)),
        Effect.map((releases) => {
          const release = selectNewerForkRelease(releases, environment.appVersion);
          return release === null
            ? {
                status: "up-to-date" as const,
                currentVersion: environment.appVersion,
              }
            : {
                status: "available" as const,
                currentVersion: environment.appVersion,
                release,
              };
        }),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const message = describeCause(cause);
            yield* logWarning("failed to check the fork release feed", { message });
            return {
              status: "error" as const,
              currentVersion: environment.appVersion,
              message,
            };
          }),
        ),
      )
    : Effect.succeed({ status: "unsupported" as const });

  const installRelease = Effect.fn("DesktopReleaseUpdates.installRelease")(function* (
    release: ForkRelease,
    progress: DesktopUpdateProgress,
  ) {
    return yield* Effect.gen(function* () {
      if (release.zipSize > MAX_ARCHIVE_BYTES) {
        return yield* new ForkReleaseInstallError({
          stage: "archive-size validation",
          cause: new Error("The release archive is larger than the updater allows."),
        });
      }

      yield* Effect.promise(() =>
        progress.update({
          phase: "downloading",
          percent: 0,
          detail: "Downloading verification data…",
        }),
      );
      const checksumManifest = yield* readReleaseText(
        release.checksumUrl,
        "text/plain",
        FILE_REQUEST_TIMEOUT,
      );
      const fileName = `T3-Code-${release.version}-arm64.zip`;
      const expectedSha256 = yield* Effect.try({
        try: () => readExpectedSha256(checksumManifest, fileName),
        catch: (cause) =>
          new ForkReleaseInstallError({
            stage: "checksum manifest validation",
            cause,
          }),
      });
      yield* Effect.promise(() =>
        progress.update({
          phase: "downloading",
          percent: 0,
          detail: "Connecting to GitHub…",
        }),
      );
      const zipBytes = yield* Effect.tryPromise({
        try: () => downloadReleaseArchive(release, progress),
        catch: (cause) =>
          new ForkReleaseInstallError({
            stage: "release archive download",
            cause,
          }),
      });
      yield* Effect.promise(() =>
        progress.update({
          phase: "verifying",
          percent: 95,
          detail: "Verifying SHA256 and preparing installation…",
        }),
      );

      const appBundlePath = macAppBundlePath(process.execPath);
      if (appBundlePath === undefined) {
        return yield* new ForkReleaseInstallError({
          stage: "application discovery",
          cause: new Error("Could not locate the running macOS application bundle."),
        });
      }
      const prepared = yield* Effect.promise(() =>
        prepareMacUpdate({
          appBundlePath,
          expectedSha256,
          expectedVersion: release.version,
          zipBytes,
        }),
      );
      yield* Effect.promise(() =>
        progress.update({
          phase: "restarting",
          percent: 99,
          detail: "Restarting FL Code…",
        }),
      );
      yield* logInfo("prepared fork release update", {
        currentVersion: environment.appVersion,
        latestVersion: release.version,
      });
      yield* Effect.promise(() => launchMacUpdate(prepared));
      yield* electronApp.quit;
      return { status: "installing" as const };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const message = describeCause(cause);
          yield* logWarning("failed to prepare fork release update", { message });
          return { status: "error" as const, message };
        }),
      ),
    );
  });

  const promptAndInstall = Effect.gen(function* () {
    const result = yield* check;
    if (result.status === "unsupported") return;

    if (result.status === "up-to-date") {
      yield* electronDialog.showMessageBox({
        type: "info",
        title: "You're up to date!",
        message: `${environment.displayName} ${result.currentVersion} is currently the newest fork release available.`,
        buttons: ["OK"],
      });
      return;
    }

    if (result.status === "error") {
      yield* electronDialog.showMessageBox({
        type: "warning",
        title: "Update check failed",
        message: "Could not check the fork release feed.",
        detail: result.message,
        buttons: ["OK"],
      });
      return;
    }

    const { response } = yield* electronDialog.showMessageBox({
      type: "info",
      title: "Update available",
      message: `${environment.displayName} ${result.release.version} is available.`,
      detail: `You are running ${result.currentVersion}. The app will download the release, verify its SHA256 checksum, replace this application, and reopen it.`,
      buttons: ["Download and Restart", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return;

    yield* logInfo("downloading fork release update", {
      currentVersion: result.currentVersion,
      latestVersion: result.release.version,
    });
    const progress = yield* Effect.promise(() => openUpdateProgress(result.release.version));
    yield* Effect.promise(() =>
      progress.update({
        phase: "downloading",
        percent: 0,
        detail: "Preparing download…",
      }),
    );
    const installResult = yield* installRelease(result.release, progress);
    if (installResult.status === "error") {
      const failureShown = yield* Effect.promise(() => progress.fail(installResult.message));
      if (!failureShown) {
        yield* electronDialog.showMessageBox({
          type: "error",
          title: "Update failed",
          message: `${environment.displayName} could not install the downloaded update.`,
          detail: installResult.message,
          buttons: ["OK"],
        });
      }
    }
  }).pipe(Effect.catchCause((cause) => logWarning("fork updater UI failed", { cause })));

  const checkAndPrompt = actionSemaphore.withPermits(1)(promptAndInstall);

  const notify = (result: DesktopReleaseUpdateCheckResult) =>
    result.status === "available"
      ? Ref.get(lastNotifiedVersion).pipe(
          Effect.flatMap((notified) => {
            if (Option.isSome(notified) && notified.value === result.release.version) {
              return Effect.void;
            }
            return Effect.sync(() => {
              if (!Electron.Notification.isSupported()) return;
              const notification = new Electron.Notification({
                title: `${environment.displayName} update available`,
                body: `Version ${result.release.version} is ready. Click to download and restart.`,
              });
              notification.once("click", () => {
                void runPromise(checkAndPrompt);
              });
              notification.show();
            }).pipe(
              Effect.andThen(Ref.set(lastNotifiedVersion, Option.some(result.release.version))),
            );
          }),
        )
      : Effect.void;

  const checkAndNotify = check.pipe(
    Effect.tap(notify),
    Effect.tap((result) =>
      result.status === "available"
        ? logInfo("fork release update available", {
            currentVersion: result.currentVersion,
            latestVersion: result.release.version,
          })
        : Effect.void,
    ),
  );

  const listen = supported
    ? Effect.sleep(STARTUP_DELAY).pipe(
        Effect.andThen(checkAndNotify),
        Effect.andThen(Effect.sleep(POLL_INTERVAL)),
        Effect.forever,
      )
    : Effect.void;

  return DesktopReleaseUpdates.of({ supported, checkAndPrompt, listen });
});

export const layer = Layer.effect(DesktopReleaseUpdates, make);
