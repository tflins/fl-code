// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { followReleaseRedirects } from "./DesktopReleaseUpdates.ts";

it.effect("follows GitHub release asset redirects", () =>
  Effect.gen(function* () {
    const sourceUrl = "https://github.com/tflins/t3code/releases/download/tflins-v0.1.8/SHA256SUMS";
    const redirectUrl = "https://release-assets.githubusercontent.com/SHA256SUMS";
    const requestedUrls: string[] = [];
    const client = followReleaseRedirects(
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
