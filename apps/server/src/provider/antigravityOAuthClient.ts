import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

export interface AntigravityOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

const ClientFile = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.NonEmptyString,
});
const decodeClientFile = Schema.decodeEffect(Schema.fromJsonString(ClientFile));

// Antigravity's desktop OAuth credentials belong to the installed CLI, not this repository.
export const loadAntigravityOAuthClient = Effect.fn("AntigravityOAuthClient.load")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly configPath: string;
    readonly fs: FileSystem.FileSystem;
  }) {
    const clientId = input.environment["ANTIGRAVITY_OAUTH_CLIENT_ID"]?.trim();
    const clientSecret = input.environment["ANTIGRAVITY_OAUTH_CLIENT_SECRET"]?.trim();
    if (clientId && clientSecret) return { clientId, clientSecret };

    const exists = yield* input.fs.exists(input.configPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return undefined;
    const client = yield* input.fs.readFileString(input.configPath).pipe(
      Effect.flatMap(decodeClientFile),
      Effect.orElseSucceed(() => undefined),
    );
    return client === undefined
      ? undefined
      : { clientId: client.client_id, clientSecret: client.client_secret };
  },
);
