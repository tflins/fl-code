// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Electron from "electron";
import { vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as MacAppBundlePath from "../app/macAppBundlePath.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopReleaseUpdates from "./DesktopReleaseUpdates.ts";
import * as DesktopUpdateProgress from "./DesktopUpdateProgress.ts";
import * as MacUpdater from "./forkMacUpdater.ts";

vi.mock("electron", () => ({ net: { fetch: vi.fn() } }));
vi.mock(import("./DesktopUpdateProgress.ts"), { spy: true });
vi.mock(import("./forkMacUpdater.ts"), { spy: true });
vi.mock(import("../app/macAppBundlePath.ts"), { spy: true });

it.effect(
  "waits for renderer readiness before cleaning update files without blocking readiness",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const checked = yield* Deferred.make<void>();
        const cleaning = Promise.withResolvers<void>();
        const releaseCleanup = Promise.withResolvers<void>();
        let cleanupFinished = false;
        using cleanup = vi.spyOn(MacUpdater, "cleanupMacUpdates").mockImplementation(() => {
          cleaning.resolve();
          return releaseCleanup.promise.then(() => {
            cleanupFinished = true;
          });
        });
        using _bundle = vi
          .spyOn(MacAppBundlePath, "macAppBundlePath")
          .mockReturnValue("/fixture/FL Code.app");
        const services = Layer.mergeAll(
          DesktopEnvironment.layer({
            dirname: "/fixture/dist-electron",
            homeDirectory: "/fixture/home",
            platform: "darwin",
            processArch: "arm64",
            isPackaged: true,
            appVersion: "1.2.3-tflins.7",
            appPath: "/fixture/FL Code.app",
            resourcesPath: "/fixture/resources",
            runningUnderArm64Translation: false,
          }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({})))),
          Layer.mock(ElectronApp.ElectronApp, {}),
          Layer.mock(ElectronDialog.ElectronDialog, {}),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Deferred.succeed(checked, undefined).pipe(
                Effect.as(HttpClientResponse.fromWeb(request, Response.json([]))),
              ),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const updates = yield* DesktopReleaseUpdates.DesktopReleaseUpdates;
          const listener = yield* updates.listen.pipe(Effect.forkChild({ startImmediately: true }));
          yield* TestClock.adjust("15 seconds");
          yield* Deferred.await(checked);
          assert.equal(cleanup.mock.calls.length, 0);
          yield* updates.confirmStartup;
          yield* Effect.promise(() => cleaning.promise);
          assert.isFalse(cleanupFinished);
          yield* updates.confirmStartup;
          assert.equal(cleanup.mock.calls.length, 1);
          releaseCleanup.resolve();
          yield* Fiber.interrupt(listener);
        }).pipe(Effect.provide(DesktopReleaseUpdates.layer.pipe(Layer.provide(services))));
      }),
    ),
);

it.effect("follows GitHub release asset redirects", () =>
  Effect.gen(function* () {
    const sourceUrl =
      "https://github.com/tflins/fl-code/releases/download/tflins-v0.1.8/SHA256SUMS";
    const redirectUrl = "https://release-assets.githubusercontent.com/SHA256SUMS";
    const requestedUrls: string[] = [];
    const client = DesktopReleaseUpdates.followReleaseRedirects(
      HttpClient.make((request) =>
        Effect.sync(() => {
          requestedUrls.push(request.url);
          return request.url === sourceUrl
            ? HttpClientResponse.fromWeb(
                request,
                new Response(null, {
                  status: 302,
                  headers: { location: redirectUrl },
                }),
              )
            : HttpClientResponse.fromWeb(request, new Response("checksum  archive.zip"));
        }),
      ),
    );
    const response = yield* client.get(sourceUrl);
    assert.equal(yield* response.text, "checksum  archive.zip");
    assert.deepEqual(requestedUrls, [sourceUrl, redirectUrl]);
  }),
);

it.effect.each(["success", "checksum HTTP failure", "checksum body failure"] as const)(
  "downloads through Electron when direct asset access fails: %s",
  (outcome) =>
    Effect.gen(function* () {
      const version = "0.1.9-nightly.20261110.4452-tflins.4";
      const releaseUrl = `https://github.com/tflins/fl-code/releases/download/tflins-v${version}`;
      const checksumUrl = `${releaseUrl}/SHA256SUMS`;
      const zipName = `T3-Code-${version}-arm64.zip`;
      const zipUrl = `${releaseUrl}/${zipName}`;
      const archive = new Uint8Array([1, 2, 3, 4]);
      const checksum = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
      const releases = [
        {
          tag_name: `tflins-v${version}`,
          draft: false,
          prerelease: true,
          assets: [
            { name: zipName, browser_download_url: zipUrl, size: archive.length },
            { name: "SHA256SUMS", browser_download_url: checksumUrl, size: 100 },
          ],
        },
      ];
      const requestedUrls: string[] = [];
      using _fetch = vi.spyOn(Electron.net, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.startsWith("https://api.github.com/")) return Response.json(releases);
        if (url === checksumUrl) {
          if (outcome === "checksum HTTP failure")
            return new Response("Unavailable", { status: 503 });
          if (outcome === "checksum body failure") {
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.error(new Error("Checksum connection interrupted"));
                },
              }),
            );
          }
          return new Response(`${checksum}  ${zipName}`);
        }
        if (url === zipUrl) return new Response(archive);
        throw new Error(`Unexpected URL: ${url}`);
      });
      const failure = vi.fn(async (_message: string) => true);
      using _progress = vi.spyOn(DesktopUpdateProgress, "openUpdateProgress").mockResolvedValue({
        update: async () => true,
        fail: failure,
      });
      using _appBundle = vi
        .spyOn(MacAppBundlePath, "macAppBundlePath")
        .mockReturnValue("/fixture/FL Code.app");
      using prepare = vi.spyOn(MacUpdater, "prepareMacUpdate").mockResolvedValue({
        appBundlePath: "/fixture/FL Code.app",
        destinationAppPath: "/fixture/FL Code.app",
        scriptPath: "/fixture/install.sh",
        stagedAppPath: "/fixture/staged/FL Code.app",
        workDirectory: "/fixture/staged",
      });
      using launch = vi.spyOn(MacUpdater, "launchMacUpdate").mockResolvedValue(undefined);
      let quit = false;
      const services = Layer.mergeAll(
        DesktopEnvironment.layer({
          dirname: "/fixture/dist-electron",
          homeDirectory: "/fixture/home",
          platform: "darwin",
          processArch: "arm64",
          isPackaged: true,
          appVersion: "0.1.9-nightly.20261110.4452-tflins.3",
          appPath: "/fixture/FL Code.app",
          resourcesPath: "/fixture/resources",
          runningUnderArm64Translation: false,
        }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({})))),
        Layer.mock(ElectronApp.ElectronApp, {
          quit: Effect.sync(() => {
            quit = true;
          }),
        }),
        Layer.mock(ElectronDialog.ElectronDialog, {
          showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            request.url.startsWith("https://api.github.com/")
              ? Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(releases)))
              : Effect.die(new Error("Direct asset access cannot use the system proxy")),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const updater = yield* DesktopReleaseUpdates.DesktopReleaseUpdates;
        yield* updater.checkAndPrompt;
      }).pipe(Effect.provide(DesktopReleaseUpdates.layer.pipe(Layer.provide(services))));

      assert.ok(requestedUrls.includes(checksumUrl), "Checksum must use Electron's network stack");
      if (outcome === "success") {
        assert.deepEqual(prepare.mock.calls[0]?.[0], {
          appBundlePath: "/fixture/FL Code.app",
          expectedSha256: checksum,
          expectedVersion: version,
          zipBytes: archive,
        });
        assert.ok(quit);
        assert.equal(failure.mock.calls.length, 0);
      } else {
        assert.ok(!requestedUrls.includes(zipUrl));
        assert.equal(prepare.mock.calls.length, 0);
        assert.equal(launch.mock.calls.length, 0);
        assert.ok(!quit);
        assert.equal(failure.mock.calls.length, 1);
        assert.ok(
          failure.mock.calls[0]![0].includes(
            outcome === "checksum HTTP failure" ? "503" : "Checksum connection interrupted",
          ),
        );
      }
    }),
);
