import { createMemoryHistory } from "@tanstack/react-router";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  finishThreadMessageJump,
  pendingThreadMessageJump,
  requestThreadMessageJump,
} from "@t3tools/client-runtime/state/thread-message-jump";
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { Activity, StrictMode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { ThreadTimeline } from "./chat/ThreadTimeline";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  assistantItem,
  emitThreadEvent,
  installFakeEnvironment,
  isThreadSubscribed,
  runningRun,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

vi.mock(import("./chat/ThreadTimeline"), { spy: true });

const historyThreadKey = (threadId: ThreadId) =>
  scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, threadId));

interface StrictHistoryScenario {
  readonly router: ReturnType<typeof getRouter>;
  readonly replay: (beforeReplay?: () => void) => Promise<void>;
}

async function withStrictHistoryScenario(
  threads: ReadonlyArray<FakeThread>,
  initialPath: string,
  run: (scenario: StrictHistoryScenario) => Promise<void>,
): Promise<void> {
  using _environment = installFakeEnvironment(threads);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({
      initialEntries: [initialPath],
    }),
  );
  await router.load();
  const renderApp = (mode: "visible" | "hidden" = "visible") => (
    <StrictMode>
      <Activity mode={mode}>
        <AppRoot router={router} />
      </Activity>
    </StrictMode>
  );
  await using app = await render(renderApp(), {
    // AppRoot brings its own router.
    router: false,
  });
  await run({
    router,
    replay: async (beforeReplay) => {
      beforeReplay?.();
      await app.rerender(renderApp("hidden"));
      await app.rerender(renderApp());
    },
  });
}

async function expectTimelineJump(threadKey: string, messageId: MessageId) {
  await vi.waitFor(() => {
    expect(
      vi
        .mocked(ThreadTimeline)
        .mock.calls.some(
          ([props]) => props.routeThreadKey === threadKey && props.jumpToMessageId === messageId,
        ),
    ).toBe(true);
  });
}

async function expectTimelineRowInViewport(messageId: MessageId) {
  await vi.waitFor(() => {
    const row = document.querySelector<HTMLElement>(`[data-timeline-row-id="${messageId}"]`);
    expect(row).not.toBeNull();
    const viewport = document.querySelector<HTMLElement>(
      '[data-assistant-citation-viewport="true"]',
    );
    expect(viewport).not.toBeNull();
    const rowBounds = row!.getBoundingClientRect();
    const viewportBounds = viewport!.getBoundingClientRect();
    expect(rowBounds.top).toBeGreaterThanOrEqual(viewportBounds.top - 1);
    expect(rowBounds.top).toBeLessThan(viewportBounds.bottom);
  });
}

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

it("keeps a first historical jump through StrictMode and cancels it on leave", async () => {
  await page.viewport(1440, 1000);
  const assistantThread = {
    ...threadWithHistory("strict-history-assistant", 40),
    hasMoreHistory: true,
  };
  const assistantThreadKey = historyThreadKey(assistantThread.id);
  using _jumpCleanup = {
    [Symbol.dispose]: () => {
      finishThreadMessageJump(assistantThreadKey);
    },
  };

  const pendingTarget = MessageId.make("strict-history-assistant-assistant-6");
  const cancelledTarget = MessageId.make("strict-history-assistant-cancelled");

  await withStrictHistoryScenario(
    [assistantThread],
    `/${ENVIRONMENT_ID}/${assistantThread.id}`,
    async ({ router, replay }) => {
      await expect.element(page.getByText("Answer 39 for strict-history-assistant.")).toBeVisible();

      await replay(() => requestThreadMessageJump(assistantThreadKey, pendingTarget));
      await expectTimelineJump(assistantThreadKey, pendingTarget);
      await vi.waitFor(() => expect(pendingThreadMessageJump(assistantThreadKey)).toBeNull());
      await expectTimelineRowInViewport(pendingTarget);

      requestThreadMessageJump(assistantThreadKey, cancelledTarget);
      expect(pendingThreadMessageJump(assistantThreadKey)).toBe(cancelledTarget);
      await router.navigate({ href: "/new" });
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/new"));
      await vi.waitFor(() => expect(pendingThreadMessageJump(assistantThreadKey)).toBeNull());

      const callsBeforeReturn = vi.mocked(ThreadTimeline).mock.calls.length;
      await router.navigate({ href: `/${ENVIRONMENT_ID}/${assistantThread.id}` });
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${assistantThread.id}`),
      );
      const returnedJumpTargets = vi
        .mocked(ThreadTimeline)
        .mock.calls.slice(callsBeforeReturn)
        .filter(([props]) => props.routeThreadKey === assistantThreadKey)
        .map(([props]) => props.jumpToMessageId);
      expect(returnedJumpTargets).not.toContain(cancelledTarget);
    },
  );
});

it("opens historical user and missing targets under StrictMode", async () => {
  await page.viewport(1440, 1000);
  const userThread = threadWithHistory("strict-history-user-target", 40);
  const missingThread = threadWithHistory("strict-history-missing", 40);
  const userThreadKey = historyThreadKey(userThread.id);
  const missingThreadKey = historyThreadKey(missingThread.id);
  using _jumpCleanup = {
    [Symbol.dispose]: () => {
      finishThreadMessageJump(userThreadKey);
      finishThreadMessageJump(missingThreadKey);
    },
  };

  const userTarget = MessageId.make("strict-history-user-target-user-8");
  const missingLatest = MessageId.make("strict-history-missing-assistant-39");

  await withStrictHistoryScenario(
    [userThread, missingThread],
    `/${ENVIRONMENT_ID}/${userThread.id}`,
    async ({ router }) => {
      await expect
        .element(page.getByText("Answer 39 for strict-history-user-target."))
        .toBeVisible();
      await router.navigate({ href: "/new" });
      await vi.waitFor(() => expect(router.state.location.pathname).toBe("/new"));

      requestThreadMessageJump(userThreadKey, userTarget);
      await router.navigate({ href: `/${ENVIRONMENT_ID}/${userThread.id}` });
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${userThread.id}`),
      );
      await expectTimelineJump(userThreadKey, userTarget);
      await vi.waitFor(() => expect(pendingThreadMessageJump(userThreadKey)).toBeNull());
      await expectTimelineRowInViewport(userTarget);

      const callsBeforeMissing = vi.mocked(ThreadTimeline).mock.calls.length;
      requestThreadMessageJump(missingThreadKey, MessageId.make("message-does-not-exist"));
      await router.navigate({ href: `/${ENVIRONMENT_ID}/${missingThread.id}` });
      await vi.waitFor(() =>
        expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${missingThread.id}`),
      );
      await expect
        .element(page.getByText("Answer 39 for strict-history-missing."))
        .toBeInViewport();
      await vi.waitFor(() => expect(pendingThreadMessageJump(missingThreadKey)).toBeNull());
      const missingJumpTargets = vi
        .mocked(ThreadTimeline)
        .mock.calls.slice(callsBeforeMissing)
        .filter(([props]) => props.routeThreadKey === missingThreadKey)
        .map(([props]) => props.jumpToMessageId)
        .filter((messageId) => messageId !== null && messageId !== undefined);
      expect(missingJumpTargets).not.toContain(missingLatest);
      expect(missingJumpTargets).toEqual([]);
    },
  );
});

it("opens the thread actions menu for an older settled thread the shell leaves out", async () => {
  const thread = { ...threadWithHistory("older-settled", 1), olderSettled: true as const };
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("older-settled: question 0")).toBeVisible();

  await page.getByRole("button", { name: `Thread actions for ${thread.title}` }).click();
  // Without a bound the poll runs to the test deadline and reports a bare timeout.
  await expect
    .element(page.getByRole("menuitem", { name: "Rename thread" }), { timeout: 5_000 })
    .toBeVisible();
});

it("retains each thread's diff selection when returning from another thread or Settings", async () => {
  const a = threadWithHistory("diff-selection-a", 1);
  const b = threadWithHistory("diff-selection-b", 1);
  using _environment = installFakeEnvironment([a, b]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const aRef = scopeThreadRef(ENVIRONMENT_ID, a.id);
  const bRef = scopeThreadRef(ENVIRONMENT_ID, b.id);
  useRightPanelStore.getState().open(aRef, "diff");
  useRightPanelStore.getState().open(bRef, "diff");
  useDiffPanelStore.getState().selectBranchBaseRef(bRef, "origin/release");
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${a.id}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  await act(() => useDiffPanelStore.getState().selectGitScope(aRef, "unstaged"));

  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: b.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${b.id}.`)).toBeVisible();
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, bRef)).toEqual({
    kind: "branch",
    baseRef: "origin/release",
  });
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: a.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, aRef)).toEqual({
    kind: "unstaged",
  });

  await act(() => useDiffPanelStore.getState().selectTurn(aRef, a.runs[0]!.id));
  await act(() => router.navigate({ to: "/settings/general" }));
  await expect
    .element(page.getByRole("heading", { name: "Time format", exact: true }))
    .toBeVisible();
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: a.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  expect(
    selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, aRef),
  ).toMatchObject({
    kind: "turn",
    turnId: a.runs[0]!.id,
  });
});

it("shows fresh streaming throughput in the composer and replaces it with the completed average", async () => {
  await page.viewport(1440, 900);
  const thread = threadWithHistory("composer-throughput", 1);
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(app.getByTestId("composer-editor")).toBeVisible();
  await vi.waitFor(() => expect(isThreadSubscribed(thread.id)).toBe(true));

  const at = (milliseconds: number) =>
    DateTime.add(DateTime.makeUnsafe("2026-03-17T19:12:28.000Z"), { milliseconds });
  const attemptId = RunAttemptId.make("throughput-attempt");
  const providerThreadId = ProviderThreadId.make("throughput-provider-thread");
  const providerTurnId = ProviderTurnId.make("throughput-provider-turn");
  const nodeId = NodeId.make("throughput-node");
  const run = {
    ...runningRun(thread.id, "throughput-run", 2, "throughput-user"),
    activeAttemptId: attemptId,
  };
  const providerTurn = {
    id: providerTurnId,
    providerThreadId,
    nodeId,
    runAttemptId: attemptId,
    nativeTurnRef: null,
    ordinal: 1,
    status: "running" as const,
    startedAt: at(0),
    completedAt: null,
  };
  await act(async () => {
    await emitThreadEvent(thread.id, { type: "run.created", payload: run });
    await emitThreadEvent(thread.id, {
      type: "provider-thread.updated",
      payload: {
        id: providerThreadId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: null,
        appThreadId: thread.id,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 2,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        nativeMetadata: null,
        goal: null,
        createdAt: at(0),
        updatedAt: at(0),
      },
    });
    await emitThreadEvent(thread.id, {
      type: "run-attempt.created",
      payload: {
        id: attemptId,
        runId: run.id,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId: run.providerInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "running",
        startedAt: at(0),
        completedAt: null,
      },
    });
    await emitThreadEvent(thread.id, { type: "provider-turn.updated", payload: providerTurn });
  });
  await expect.element(app.getByText("≈ … tok/s", { exact: true })).toBeVisible();
  const item = {
    ...assistantItem(thread.id, run.id, "throughput-answer", 3, ""),
    providerThreadId,
    providerTurnId,
    status: "running" as const,
    streaming: true,
    startedAt: at(0),
    completedAt: null,
  };
  await act(async () => {
    for (const [milliseconds, text] of [
      [0, "Streaming"],
      [400, "Streaming an answer"],
      [800, "Streaming an answer with more text"],
    ] as const) {
      await emitThreadEvent(thread.id, {
        type: "message.updated",
        occurredAt: at(milliseconds),
        payload: {
          id: item.messageId,
          threadId: thread.id,
          runId: run.id,
          nodeId: null,
          role: "assistant",
          text,
          createdBy: "agent",
          creationSource: "provider",
          attachments: [],
          streaming: true,
          createdAt: at(0),
          updatedAt: at(milliseconds),
        },
      });
      await emitThreadEvent(thread.id, {
        type: "turn-item.updated",
        occurredAt: at(milliseconds),
        payload: { ...item, text: "", textOmitted: true, updatedAt: at(milliseconds) },
      });
    }
  });
  await expect.element(app.getByText(/^≈ [\d.]+ tok\/s$/)).toBeVisible();
  await act(async () => {
    await emitThreadEvent(thread.id, {
      type: "turn-item.updated",
      occurredAt: at(900),
      payload: {
        ...item,
        text: "Streaming an answer with more text",
        streaming: false,
        status: "completed",
        completedAt: at(900),
        updatedAt: at(900),
      },
    });
  });
  await expect.element(app.getByText(/^≈ [\d.]+ tok\/s$/)).toBeVisible();
  await act(async () => {
    await emitThreadEvent(thread.id, {
      type: "provider-turn.updated",
      occurredAt: at(1_000),
      payload: {
        ...providerTurn,
        status: "completed",
        completedAt: at(1_000),
        throughputEstimate: {
          basis: "turn_wall_minus_known_waits",
          outputTokens: 120,
          durationMs: 1_000,
        },
        turnTokenUsage: {
          usageScope: "main_agent",
          inputTokens: 50,
          outputTokens: 120,
          usageStatus: "complete",
          hasSubagents: false,
        },
      },
    });
  });
  await expect.element(app.getByText("≈ 120 tok/s", { exact: true })).toBeVisible();
  await act(async () => {
    await emitThreadEvent(thread.id, {
      type: "run.created",
      payload: {
        ...runningRun(thread.id, "throughput-next", 3, "throughput-next-user"),
        activeAttemptId: RunAttemptId.make("throughput-next-attempt"),
      },
    });
  });
  await expect.element(app.getByText("≈ 120 tok/s", { exact: true })).toBeVisible();
});
