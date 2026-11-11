import { useReducer } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "~/index.css";

const harness = vi.hoisted(() => {
  interface PageInput {
    readonly promptOffset?: number;
    readonly resultOffset?: number;
  }

  const body = (
    text: string,
    revision: string,
    options: { readonly truncated?: boolean; readonly nextOffset?: number | null } = {},
  ) => ({
    availability: "available",
    revision,
    text,
    truncated: options.truncated ?? false,
    nextOffset: options.nextOffset ?? null,
  });

  const state = {
    requests: 0,
    version: 1,
    paged: false,
    lastKey: null as string | null,
    reset() {
      state.requests = 0;
      state.version = 1;
      state.paged = false;
      state.lastKey = null;
    },
    beginRequest(input: PageInput) {
      const paged = (input.promptOffset ?? 0) !== 0 || (input.resultOffset ?? 0) !== 0;
      if (paged) {
        state.paged = true;
        return;
      }
      if (state.paged) {
        state.paged = false;
        state.version += 1;
      }
    },
    page(input: PageInput) {
      const promptFirst = `prompt-first-v${state.version}`;
      const resultFirst = `result-first-v${state.version}`;
      return {
        parentThreadId: "thread-parent",
        subagentId: "node:task",
        parentRunId: null,
        executionStatus: "completed",
        completionDelivery: null,
        requestedModel: null,
        executedModel: null,
        prompt: body(
          input.promptOffset === 0 ? promptFirst : "prompt-second",
          "prompt",
          input.promptOffset === 0
            ? { truncated: true, nextOffset: promptFirst.length }
            : { nextOffset: null },
        ),
        result: {
          body: body(
            input.resultOffset === 0 ? resultFirst : "result-second",
            "result",
            input.resultOffset === 0
              ? { truncated: true, nextOffset: resultFirst.length }
              : { nextOffset: null },
          ),
          source: "child_run" as const,
          messageId: "message-result",
          turnItemId: null,
        },
        deliveryResult: body("", "delivery", { truncated: false }),
        childRunId: "run-child",
        roundAssociation: "run_delegated_task_id" as const,
        target: { kind: "local" as const, threadId: "thread-child" },
        navigation: { kind: "result" as const, messageId: "message-result" },
        childThreadState: "available" as const,
        updatedAt: "2026-11-11T00:00:00.000Z",
      };
    },
    refreshCurrentPage() {
      state.requests += 1;
      state.version += 1;
    },
  };
  return state;
});

vi.mock(import("../../state/orchestration"), (() => ({
  orchestrationEnvironment: {
    subagentHandoff: (target: unknown) => target,
  },
})) as never);

vi.mock(import("../../state/query"), (() => ({
  useEnvironmentQuery: (target: { readonly input: Parameters<typeof harness.page>[0] }) => {
    const [, rerender] = useReducer((count: number) => count + 1, 0);
    const key = JSON.stringify(target.input);
    if (key !== harness.lastKey) {
      harness.lastKey = key;
      harness.requests += 1;
      harness.beginRequest(target.input);
    }
    return {
      data: harness.page(target.input) as never,
      dataUpdatedAt: 0,
      error: null,
      failure: null,
      isPending: false,
      isSuccess: true,
      refresh: () => {
        harness.refreshCurrentPage();
        rerender();
      },
    };
  },
})) as never);

import { SubagentHandoffDetails } from "./SubagentHandoffDetails";

function details() {
  return (
    <SubagentHandoffDetails
      parentEnvironmentId={"environment-local" as never}
      parentThreadId={"thread-parent" as never}
      subagentId={"node:task" as never}
      canOpenTarget={() => true}
      onOpenTarget={() => {}}
    />
  );
}

function sectionText(container: HTMLElement, label: string) {
  return container.querySelector(`section[aria-label="${label}"] pre`)?.textContent ?? null;
}

function loadMoreButton(container: HTMLElement, label: string) {
  return container.querySelector<HTMLButtonElement>(`section[aria-label="${label}"] button`);
}

it("refreshes a paginated handoff with one request and shows its first page", async () => {
  harness.reset();
  await using screen = await render(details());
  await vi.waitFor(() => expect(harness.requests).toBe(1));
  await vi.waitFor(() =>
    expect(sectionText(screen.container, "Task prompt")).toBe("prompt-first-v1"),
  );

  await userEvent.click(loadMoreButton(screen.container, "Task prompt")!);
  await vi.waitFor(() => expect(harness.requests).toBe(2));
  await vi.waitFor(() =>
    expect(sectionText(screen.container, "Task prompt")).toBe("prompt-first-v1prompt-second"),
  );

  await userEvent.click(loadMoreButton(screen.container, "Original child result")!);
  await vi.waitFor(() => expect(harness.requests).toBe(3));
  await vi.waitFor(() =>
    expect(sectionText(screen.container, "Original child result")).toBe(
      "result-first-v1result-second",
    ),
  );

  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await vi.waitFor(() => expect(harness.requests).toBe(4));
  await vi.waitFor(() =>
    expect(sectionText(screen.container, "Task prompt")).toBe("prompt-first-v2"),
  );
  expect(sectionText(screen.container, "Original child result")).toBe("result-first-v2");
});

it("refreshes an unpaginated handoff with one request", async () => {
  harness.reset();
  await using screen = await render(details());
  await vi.waitFor(() => expect(harness.requests).toBe(1));

  await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await vi.waitFor(() => expect(harness.requests).toBe(2));
  await vi.waitFor(() =>
    expect(sectionText(screen.container, "Task prompt")).toBe("prompt-first-v2"),
  );
});
