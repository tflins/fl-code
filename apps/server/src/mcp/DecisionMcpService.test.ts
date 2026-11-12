import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const now = DateTime.makeUnsafe("2026-11-12T00:00:00.000Z");
const sourceThreadId = ThreadId.make("thread:mcp-decision-source");
const projectId = ProjectId.make("project:mcp-decision");
const providerInstanceId = ProviderInstanceId.make("codex");

const sourceScope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "provider:source",
  thread: {
    threadId: sourceThreadId,
    providerSessionId: "provider:source",
    providerInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const sourceRun = {
  id: RunId.make("run:mcp-decision-source"),
  threadId: sourceThreadId,
  ordinal: 1,
  providerInstanceId,
  rootNodeId: NodeId.make("node:mcp-decision-source"),
  status: "running",
} as OrchestrationV2ThreadProjection["runs"][number];

const sourceShell: OrchestrationV2ThreadShell = {
  ...liveThreadShell(sourceThreadId),
  projectId,
  title: "Execution thread",
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
  branch: "main",
  worktreePath: "/workspace",
};

const decisionShellFrom = (
  command: Extract<OrchestrationV2ServerCommand, { readonly type: "thread.create" }>,
): OrchestrationV2ThreadShell => {
  const decision = command.decision;
  if (decision === undefined) throw new Error("expected decision metadata");
  return {
    ...liveThreadShell(command.threadId, {
      activeRunId: null,
      runtimeMode: command.runtimeMode,
      interactionMode: command.interactionMode,
    }),
    projectId: command.projectId,
    title: command.title,
    providerInstanceId: command.modelSelection.instanceId,
    modelSelection: command.modelSelection,
    branch: command.branch,
    worktreePath: command.worktreePath,
    createdBy: command.createdBy,
    creationSource: command.creationSource,
    status: "idle",
    decision: {
      ...decision,
      status: "discussing",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
  };
};

describe("OrchestratorMcpService decisions", () => {
  it.effect("creates one fresh decision thread per source issue and reads it back", () => {
    let decisionShell: OrchestrationV2ThreadShell | null = null;
    let prompt: string | null = null;
    let sourceDeleted = false;
    const commands: Array<OrchestrationV2ServerCommand> = [];
    let rejectNext: "thread.create" | "message.dispatch" | undefined;
    const rejected = new Set<string>();

    const projectionFor = (shell: OrchestrationV2ThreadShell) =>
      ({
        thread: { ...shell, lastVisitedAt: null },
        runs: shell.id === sourceThreadId ? [sourceRun] : [],
        messages:
          shell.id === sourceThreadId
            ? [
                {
                  id: "message:source-transcript",
                  threadId: sourceThreadId,
                  runId: sourceRun.id,
                  nodeId: null,
                  createdBy: "user",
                  creationSource: "web",
                  role: "user",
                  text: "Internal source transcript must not move.",
                  attachments: [],
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              ]
            : shell.id === decisionShell?.id && prompt !== null
              ? [
                  {
                    id: `${shell.id}:initial`,
                    threadId: shell.id,
                    runId: RunId.make("run:mcp-decision-initial"),
                    nodeId: null,
                    createdBy: "agent",
                    creationSource: "mcp",
                    role: "user",
                    text: prompt,
                    attachments: [],
                    streaming: false,
                    createdAt: now,
                    updatedAt: now,
                  },
                ]
              : [],
      }) as unknown as OrchestrationV2ThreadProjection;

    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      nextCommandAttemptId: (id) =>
        Effect.succeed(rejected.has(id) ? (`${id}:attempt:1` as typeof id) : id),
      getThreadShell: (threadId) =>
        Effect.sync(() => {
          if (threadId === sourceThreadId) {
            return sourceDeleted ? { ...sourceShell, deletedAt: now } : sourceShell;
          }
          return decisionShell?.id === threadId ? decisionShell : null;
        }),
      getThreadRecords: (threadId) =>
        Effect.sync(() => {
          const shell =
            threadId === sourceThreadId
              ? sourceDeleted
                ? { ...sourceShell, deletedAt: now }
                : sourceShell
              : decisionShell?.id === threadId
                ? decisionShell
                : null;
          if (shell === null) throw new Error(`unknown thread ${threadId}`);
          return projectionFor(shell);
        }),
      getProjectThreadRecords: (input) =>
        Effect.sync(() => {
          const shell =
            input.threadId === sourceThreadId
              ? sourceDeleted
                ? { ...sourceShell, deletedAt: now }
                : sourceShell
              : decisionShell?.id === input.threadId
                ? decisionShell
                : null;
          if (shell === null) throw new Error(`unknown thread ${input.threadId}`);
          return projectionFor(shell);
        }),
      dispatch: (command) =>
        Effect.gen(function* () {
          commands.push(command);
          if (command.type === rejectNext) {
            rejectNext = undefined;
            rejected.add(command.commandId);
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "Provider temporarily unavailable",
            });
          }
          if (command.type === "thread.create") {
            decisionShell = decisionShellFrom(command);
          } else if (command.type === "message.dispatch") {
            prompt = command.text;
          }
          return { sequence: commands.length, storedEvents: [] };
        }),
    });

    const layer = OrchestratorMcpService.layer.pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(threads),
      Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(Layer.mock(ServerSettings.ServerSettingsService)({})),
      Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
    );

    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const input = {
        action: "create" as const,
        clientRequestId: "retention-policy",
        question: "Should deleted-file usage stay cached?",
        context: "Only the reader and retention job depend on it.",
      };
      const created = yield* service.createDecision(sourceScope, input);
      assert.isTrue(created.created);
      assert.isTrue(created.sourceAvailable);
      assert.equal(created.sourceThreadId, sourceThreadId);
      assert.equal(created.decision.status, "discussing");
      assert.equal(created.decision.revision, 1);
      assert.match(created.threadId, /^thread:decision:/);
      assert.equal(commands.length, 2);

      const create = commands[0];
      assert.equal(create?.type, "thread.create");
      if (create?.type !== "thread.create") return yield* Effect.die("unreachable");
      assert.equal(create.decision?.sourceThreadId, sourceThreadId);
      assert.equal(create.decision?.question, input.question);
      assert.equal(create.decision?.context, input.context);
      assert.equal(create.modelSelection.instanceId, providerInstanceId);
      assert.equal(create.worktreePath, sourceShell.worktreePath);
      assert.equal(create.createdBy, "agent");
      assert.equal(create.creationSource, "mcp");

      const initial = commands[1];
      assert.equal(initial?.type, "message.dispatch");
      if (initial?.type !== "message.dispatch") return yield* Effect.die("unreachable");
      assert.equal(initial.messageId, `${created.threadId}:initial`);
      assert.include(initial.text, input.question);
      assert.include(initial.text, input.context);
      assert.include(initial.text, "Do not edit or write files");
      assert.notInclude(initial.text, "Execution thread");
      assert.notInclude(initial.text, "Internal source transcript");

      const repeated = yield* service.createDecision(sourceScope, input);
      assert.isFalse(repeated.created);
      assert.equal(repeated.threadId, created.threadId);
      assert.equal(commands.length, 2);

      const withMoreContext = yield* service.createDecision(sourceScope, {
        ...input,
        context: "The reader also needs cold-storage retention.",
      });
      assert.equal(withMoreContext.threadId, created.threadId);
      assert.equal(commands.length, 2);

      const read = yield* service.readDecision(sourceScope, {
        action: "read",
        threadId: created.threadId,
      });
      assert.isFalse(read.created);
      assert.isTrue(read.sourceAvailable);
      assert.equal(read.decision.finalAnswer, null);

      sourceDeleted = true;
      const readGone = yield* service.readDecision(sourceScope, {
        action: "read",
        threadId: created.threadId,
      });
      assert.isFalse(readGone.sourceAvailable);

      sourceDeleted = false;
      decisionShell = null;
      prompt = null;
      commands.length = 0;
      const retryInput = { ...input, clientRequestId: "retry-after-rejection" };
      rejectNext = "thread.create";
      const rejectedCreate = yield* service
        .createDecision(sourceScope, retryInput)
        .pipe(Effect.flip);
      assert.equal(rejectedCreate._tag, "OrchestratorMcpFailure");
      rejectNext = "message.dispatch";
      const rejectedStart = yield* service
        .createDecision(sourceScope, retryInput)
        .pipe(Effect.flip);
      assert.equal(rejectedStart._tag, "OrchestratorMcpFailure");
      const recovered = yield* service.createDecision(sourceScope, retryInput);
      assert.isFalse(recovered.created);
      assert.equal(commands.length, 4);
      assert.notEqual(commands[0]!.commandId, commands[1]!.commandId);
      assert.notEqual(commands[2]!.commandId, commands[3]!.commandId);
      const replayed = yield* service.createDecision(sourceScope, retryInput);
      assert.equal(replayed.threadId, recovered.threadId);
      assert.equal(commands.length, 4);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a decision thread as a source and a foreign source id", () => {
    const decisionShell: OrchestrationV2ThreadShell = {
      ...liveThreadShell(ThreadId.make("thread:mcp-decision-existing"), {
        activeRunId: null,
      }),
      decision: {
        sourceThreadId,
        question: "Existing",
        status: "discussing",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
    };
    const decisionScope: McpInvocationScope = {
      ...sourceScope,
      requestNamespace: "provider:decision",
      thread: {
        threadId: decisionShell.id,
        providerSessionId: "provider:decision",
        providerInstanceId,
        decision: true,
      },
    };
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: (threadId) =>
        Effect.succeed(
          projectionForShell(
            threadId === sourceThreadId
              ? sourceShell
              : threadId === decisionShell.id
                ? decisionShell
                : null,
            [sourceRun],
          ),
        ),
      getThreadShell: (threadId) =>
        Effect.succeed(
          threadId === sourceThreadId
            ? sourceShell
            : threadId === decisionShell.id
              ? decisionShell
              : null,
        ),
    });
    const layer = OrchestratorMcpService.layer.pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.provide(threads),
      Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(Layer.mock(ServerSettings.ServerSettingsService)({})),
      Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
    );

    return Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const fromDecision = yield* service
        .createDecision(decisionScope, { action: "create", question: "Another" })
        .pipe(Effect.flip);
      assert.equal(fromDecision.code, "invalid_request");

      const foreign = yield* service
        .createDecision(sourceScope, {
          action: "create",
          sourceThreadId: ThreadId.make("thread:elsewhere"),
          question: "Another",
        })
        .pipe(Effect.flip);
      assert.equal(foreign.code, "invalid_request");
    }).pipe(Effect.provide(layer));
  });
});

function projectionForShell(
  shell: OrchestrationV2ThreadShell | null,
  runs: ReadonlyArray<OrchestrationV2ThreadProjection["runs"][number]>,
) {
  if (shell === null) throw new Error("unknown thread");
  return {
    thread: { ...shell, lastVisitedAt: null },
    runs: shell.id === sourceThreadId ? runs : [],
    messages: [],
  } as unknown as OrchestrationV2ThreadProjection;
}
