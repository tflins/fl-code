import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { loadAntigravityOAuthClient } from "./antigravityOAuthClient.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  return { fs, configPath: path.join(directory, "antigravity-oauth-client.json") };
});

describe("Antigravity OAuth client", () => {
  it.effect("prefers environment variables", () =>
    Effect.gen(function* () {
      const { fs, configPath } = yield* fixture;
      yield* fs.writeFileString(
        configPath,
        JSON.stringify({ client_id: "file-id", client_secret: "file-secret" }),
      );
      const client = yield* loadAntigravityOAuthClient({
        environment: {
          ANTIGRAVITY_OAUTH_CLIENT_ID: "env-id",
          ANTIGRAVITY_OAUTH_CLIENT_SECRET: "env-secret",
        },
        configPath,
        fs,
      });
      expect(client).toEqual({ clientId: "env-id", clientSecret: "env-secret" });
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("reads the local config file", () =>
    Effect.gen(function* () {
      const { fs, configPath } = yield* fixture;
      yield* fs.writeFileString(
        configPath,
        JSON.stringify({ client_id: "file-id", client_secret: "file-secret" }),
      );
      const client = yield* loadAntigravityOAuthClient({
        environment: {},
        configPath,
        fs,
      });
      expect(client).toEqual({ clientId: "file-id", clientSecret: "file-secret" });
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("ignores missing or invalid files", () =>
    Effect.gen(function* () {
      const { fs, configPath } = yield* fixture;
      expect(
        yield* loadAntigravityOAuthClient({ environment: {}, configPath, fs }),
      ).toBeUndefined();
      yield* fs.writeFileString(configPath, "{}");
      expect(
        yield* loadAntigravityOAuthClient({ environment: {}, configPath, fs }),
      ).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
