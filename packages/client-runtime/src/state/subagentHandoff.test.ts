import {
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2SubagentHandoff,
  type OrchestrationV2SubagentHandoffBody,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  formatSubagentDelivery,
  formatSubagentExecutedModel,
  formatSubagentRequestedModel,
  mergeSubagentHandoffPage,
  resolveSubagentHandoffRefreshAction,
  resolveSubagentHandoffNavigationTarget,
  subagentHandoffTargetIsAvailable,
} from "./subagentHandoff.ts";

const parentEnvironmentId = EnvironmentId.make("environment:parent");
const parentThreadId = ThreadId.make("thread:parent");
const childThreadId = ThreadId.make("thread:child");
const messageId = MessageId.make("message:result");

function body(
  text: string,
  overrides: Partial<OrchestrationV2SubagentHandoffBody> = {},
): OrchestrationV2SubagentHandoffBody {
  return {
    availability: "available",
    revision: "revision-1",
    text,
    truncated: false,
    nextOffset: null,
    ...overrides,
  };
}

function handoff(
  overrides: Partial<OrchestrationV2SubagentHandoff> = {},
): OrchestrationV2SubagentHandoff {
  return {
    parentThreadId,
    subagentId: NodeId.make("node:task-a"),
    parentRunId: RunId.make("run:parent"),
    executionStatus: "completed",
    completionDelivery: { state: "delivered", observedByRunId: null },
    requestedModel: {
      model: "requested-model",
      selection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "requested-model",
      },
    },
    executedModel: "executed-model",
    prompt: body("prompt"),
    result: {
      body: body("result"),
      source: "child_run",
      messageId,
      turnItemId: null,
    },
    deliveryResult: body("delivered result"),
    childRunId: RunId.make("run:child"),
    roundAssociation: "run_delegated_task_id",
    target: { kind: "local", threadId: childThreadId },
    navigation: { kind: "result", messageId },
    childThreadState: "available",
    updatedAt: DateTime.makeUnsafe("2026-11-11T00:00:00.000Z"),
    ...overrides,
  };
}

describe("subagent handoff presentation", () => {
  it("keeps requested and executed model facts separate", () => {
    const value = handoff({ executedModel: null });

    expect(formatSubagentRequestedModel(value.requestedModel)).toBe("requested-model");
    expect(formatSubagentExecutedModel(value.executedModel)).toBe("Unknown");
  });

  it("does not describe delivery acknowledgement as understanding or adoption", () => {
    for (const state of ["claimed", "acknowledged", "delivered", "disposed"] as const) {
      const label = formatSubagentDelivery({ state, observedByRunId: null }).label;
      expect(label.toLowerCase()).not.toContain("understood");
      expect(label.toLowerCase()).not.toContain("adopted");
    }
    expect(
      formatSubagentDelivery({ state: "acknowledged", observedByRunId: null }).detail,
    ).toContain("does not mean understanding");
    expect(formatSubagentDelivery({ state: "delivered", observedByRunId: null }).detail).toContain(
      "not that it was adopted",
    );
    expect(formatSubagentDelivery(null).label).toBe("Delivery unknown");
  });
});

describe("subagent handoff paging", () => {
  it("refreshes the mounted first page directly and remounts a paged query once", () => {
    expect(resolveSubagentHandoffRefreshAction({ prompt: 0, result: 0, delivery: 0 }, null)).toBe(
      "refresh",
    );
    expect(resolveSubagentHandoffRefreshAction({ prompt: 10, result: 0, delivery: 0 }, null)).toBe(
      "reset",
    );
    expect(
      resolveSubagentHandoffRefreshAction(
        { prompt: 0, result: 0, delivery: 0 },
        mergeSubagentHandoffPage(null, handoff(), { prompt: 0, result: 0, delivery: 0 }),
      ),
    ).toBe("reset");
  });

  it("appends the next page only when revision and source still match", () => {
    const first = handoff({
      prompt: body("abc", { truncated: true, nextOffset: 3 }),
    });
    const previous = mergeSubagentHandoffPage(null, first, {
      prompt: 0,
      result: 0,
      delivery: 0,
    });
    const next = handoff({
      prompt: body("def", { revision: "revision-1", nextOffset: null }),
    });
    const merged = mergeSubagentHandoffPage(previous, next, { prompt: 3, result: 0, delivery: 0 }, [
      "prompt",
    ]);

    expect(merged.prompt.text).toBe("abcdef");
  });

  it("replaces instead of joining a changed revision or result source", () => {
    const previous = mergeSubagentHandoffPage(
      null,
      handoff({
        prompt: body("old prompt", { truncated: true, nextOffset: 10 }),
        result: {
          body: body("old result", { truncated: true, nextOffset: 10 }),
          source: "child_run",
          messageId,
          turnItemId: null,
        },
      }),
      { prompt: 0, result: 0, delivery: 0 },
    );
    const changedRevision = mergeSubagentHandoffPage(
      previous,
      handoff({
        prompt: body("new prompt", { revision: "revision-2" }),
        result: {
          body: body("new result", { revision: "revision-2" }),
          source: "child_run",
          messageId,
          turnItemId: null,
        },
      }),
      { prompt: 10, result: 10, delivery: 0 },
      ["prompt", "result"],
    );
    const changedSource = mergeSubagentHandoffPage(
      previous,
      handoff({
        result: {
          body: body("parent snapshot"),
          source: "parent_record",
          messageId: null,
          turnItemId: null,
        },
      }),
      { prompt: 0, result: 10, delivery: 0 },
      ["result"],
    );

    expect(changedRevision.prompt.text).toBe("new prompt");
    expect(changedRevision.result.text).toBe("new result");
    expect(changedSource.result.text).toBe("parent snapshot");
    expect(changedSource.result.source).toBe("parent_record");
  });

  it("replaces a non-target result when its source changes while loading the prompt", () => {
    const previous = mergeSubagentHandoffPage(
      null,
      handoff({
        prompt: body("old prompt", { truncated: true, nextOffset: 10 }),
        result: {
          body: body("old parent result", { revision: "parent-1" }),
          source: "parent_record",
          messageId: null,
          turnItemId: null,
        },
        navigation: null,
      }),
      { prompt: 0, result: 0, delivery: 0 },
    );
    const childMessageId = MessageId.make("message:child-result");
    const merged = mergeSubagentHandoffPage(
      previous,
      handoff({
        prompt: body(" more prompt"),
        result: {
          body: body("new child result", { revision: "child-2" }),
          source: "child_run",
          messageId: childMessageId,
          turnItemId: null,
        },
        navigation: { kind: "result", messageId: childMessageId },
      }),
      { prompt: 10, result: 0, delivery: 0 },
      ["prompt"],
    );

    expect(merged.prompt.text).toBe("old prompt more prompt");
    expect(merged.result.text).toBe("new child result");
    expect(merged.result.source).toBe("child_run");
    expect(merged.handoff.result.source).toBe("child_run");
    expect(
      resolveSubagentHandoffNavigationTarget(merged.handoff, parentEnvironmentId),
    ).toMatchObject({ messageId: childMessageId });
  });

  it("replaces a non-target result when a missing result becomes available", () => {
    const previous = mergeSubagentHandoffPage(
      null,
      handoff({
        prompt: body("old prompt", { truncated: true, nextOffset: 10 }),
        result: {
          body: body("", { availability: "unavailable" }),
          source: null,
          messageId: null,
          turnItemId: null,
        },
        navigation: null,
      }),
      { prompt: 0, result: 0, delivery: 0 },
    );
    const childMessageId = MessageId.make("message:new-child-result");
    const merged = mergeSubagentHandoffPage(
      previous,
      handoff({
        prompt: body(" more prompt"),
        result: {
          body: body("new child result", { revision: "child-1" }),
          source: "child_run",
          messageId: childMessageId,
          turnItemId: null,
        },
        navigation: { kind: "result", messageId: childMessageId },
      }),
      { prompt: 10, result: 0, delivery: 0 },
      ["prompt"],
    );

    expect(merged.result.availability).toBe("available");
    expect(merged.result.text).toBe("new child result");
    expect(merged.result.source).toBe("child_run");
  });

  it("replaces a changed non-target revision and keeps unchanged loaded sections", () => {
    const previous = mergeSubagentHandoffPage(
      null,
      handoff({
        prompt: body("old prompt", { truncated: true, nextOffset: 10 }),
        result: {
          body: body("loaded result", { truncated: true, nextOffset: 6 }),
          source: "child_run",
          messageId,
          turnItemId: null,
        },
      }),
      { prompt: 0, result: 0, delivery: 0 },
    );
    const merged = mergeSubagentHandoffPage(
      previous,
      handoff({
        prompt: body(" more prompt"),
        result: {
          body: body("replacement result", { revision: "revision-2" }),
          source: "child_run",
          messageId,
          turnItemId: null,
        },
      }),
      { prompt: 10, result: 0, delivery: 0 },
      ["prompt"],
    );

    expect(merged.prompt.text).toBe("old prompt more prompt");
    expect(merged.result.text).toBe("replacement result");
    expect(merged.result.revision).toBe("revision-2");
  });

  it("keeps unchanged loaded result and delivery pages while loading the prompt", () => {
    const first = mergeSubagentHandoffPage(
      null,
      handoff({
        prompt: body("prompt", { truncated: true, nextOffset: 6 }),
        result: {
          body: body("result one", {
            revision: "result-revision",
            truncated: true,
            nextOffset: 10,
          }),
          source: "child_run",
          messageId,
          turnItemId: null,
        },
        deliveryResult: body("delivery one", {
          revision: "delivery-revision",
          truncated: true,
          nextOffset: 12,
        }),
      }),
      { prompt: 0, result: 0, delivery: 0 },
    );
    const loaded = mergeSubagentHandoffPage(
      first,
      handoff({
        result: {
          body: body(" two", { revision: "result-revision" }),
          source: "child_run",
          messageId,
          turnItemId: null,
        },
        deliveryResult: body(" two", { revision: "delivery-revision" }),
      }),
      { prompt: 0, result: 10, delivery: 12 },
      ["result", "delivery"],
    );
    const merged = mergeSubagentHandoffPage(
      loaded,
      handoff({
        prompt: body(" more"),
        result: {
          body: body("result one", {
            revision: "result-revision",
            truncated: true,
            nextOffset: 10,
          }),
          source: "child_run",
          messageId,
          turnItemId: null,
        },
        deliveryResult: body("delivery one", {
          revision: "delivery-revision",
          truncated: true,
          nextOffset: 12,
        }),
      }),
      { prompt: 6, result: 0, delivery: 0 },
      ["prompt"],
    );

    expect(merged.prompt.text).toBe("prompt more");
    expect(merged.result.text).toBe("result one two");
    expect(merged.delivery.text).toBe("delivery one two");
  });
});

describe("subagent handoff navigation", () => {
  it("keeps the parent environment for local targets", () => {
    expect(resolveSubagentHandoffNavigationTarget(handoff(), parentEnvironmentId)).toEqual({
      environmentId: parentEnvironmentId,
      threadId: childThreadId,
      runId: RunId.make("run:child"),
      messageId,
    });
  });

  it("keeps the recorded environment for remote targets", () => {
    const remoteEnvironmentId = EnvironmentId.make("environment:remote");
    const remote = handoff({
      target: {
        kind: "remote",
        environmentId: remoteEnvironmentId,
        threadId: childThreadId,
        runId: RunId.make("run:remote"),
      },
      navigation: null,
    });

    expect(resolveSubagentHandoffNavigationTarget(remote, parentEnvironmentId)).toEqual({
      environmentId: remoteEnvironmentId,
      threadId: childThreadId,
      runId: RunId.make("run:remote"),
      messageId: null,
    });
    expect(subagentHandoffTargetIsAvailable(remote)).toBe(true);
  });

  it("does not offer a local child that is deleted or belongs to another parent", () => {
    expect(subagentHandoffTargetIsAvailable(handoff({ childThreadState: "deleted" }))).toBe(false);
    expect(subagentHandoffTargetIsAvailable(handoff({ childThreadState: "unknown" }))).toBe(false);
  });
});
