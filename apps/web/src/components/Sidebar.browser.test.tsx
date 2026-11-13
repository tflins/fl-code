import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import {
  readEnvironmentServerConfigLoaded,
  useProjects,
  useQuietThreadShell,
  useQuietThreadShells,
  useThreadShell,
} from "../state/entities";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { useUiStateStore } from "../uiStateStore";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { SidebarSearchResultRow, SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
    });
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      defaultProjectFallbackReady: true,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

function threadShell(projectId: ProjectId, index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Thread ${index}`,
  });
}

it.each([
  { layout: "card", state: "replied" },
  { layout: "compact", state: "replied" },
  { layout: "search", state: "replied" },
  { layout: "card", state: "woke" },
  { layout: "compact", state: "woke" },
] as const)(
  "keeps decision status, runtime feedback and source actions distinct: $layout $state",
  async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.layout === "compact",
    });
    const previousVisits = useUiStateStore.getState().threadLastVisitedAtById;
    stack.defer(() => useUiStateStore.setState({ threadLastVisitedAtById: previousVisits }));
    const activeProject = project("decision-project");
    const source = makeThreadFixture({
      environmentId: activeProject.environmentId,
      projectId: activeProject.id,
      id: ThreadId.make("execution-task"),
      title: "Execution task",
    });
    const now = "2026-11-13T00:00:00.000Z";
    const decision = makeThreadFixture({
      environmentId: source.environmentId,
      projectId: source.projectId,
      id: ThreadId.make("decision-task"),
      title: "Retention policy",
      ...(scenario.state === "woke" ? {} : { lastVisitedAt: "2026-11-12T00:00:00.000Z" }),
      snoozedUntil: scenario.state === "woke" ? now : null,
      runtime: {
        status: "completed",
        activeRunId: null,
        providerInstanceId: source.providerInstanceId,
        providerName: null,
        lastError: null,
        updatedAt: now,
      },
      latestRun: {
        runId: RunId.make("decision-reply"),
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: null,
      },
      decision: {
        sourceThreadId: source.id,
        question: "How long should records be kept?",
        status: "discussing",
        revision: 1,
        createdAt: DateTime.makeUnsafe(now),
        updatedAt: DateTime.makeUnsafe(now),
      },
    });
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue([source, decision]);
    vi.mocked(useQuietThreadShell).mockImplementation((ref) =>
      ref?.threadId === source.id ? source : null,
    );
    vi.mocked(useThreadShell).mockReturnValue(null);
    vi.mocked(readEnvironmentServerConfigLoaded).mockReturnValue(false);
    vi.mocked(useThreadRouteTarget).mockReturnValue(null);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: { environmentId: source.environmentId, projectId: source.projectId },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: null,
    });
    const onSelect = vi.fn();
    await using screen = await render(
      scenario.layout === "search" ? (
        <SidebarSearchResultRow
          isSettled={false}
          thread={decision}
          project={null}
          projectDisplayName={null}
          environmentLabel={null}
          environmentMachine="laptop"
          providerEntryByInstanceId={new Map()}
          isHighlighted={false}
          isRouteActive={false}
          resultId="decision-search-result"
          searchMatch={null}
          searchQuery="Retention"
          onHighlight={() => {}}
          onSelect={onSelect}
          onFileDropThreads={() => {}}
        />
      ) : (
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>
      ),
    );
    await expect.element(screen.getByText("Awaiting you", { exact: true })).toBeVisible();
    if (scenario.state === "woke") {
      const dismiss = screen.getByRole("button", { name: "Dismiss Woke notification" });
      await expect.element(dismiss).toBeVisible();
      await userEvent.click(dismiss);
      await expect.element(dismiss).not.toBeInTheDocument();
      await expect.element(screen.getByText("Awaiting you", { exact: true })).toBeVisible();
    } else {
      await expect.element(screen.getByText("AI replied", { exact: true })).toBeVisible();
    }
    const sourceLink = screen.getByRole(scenario.layout === "search" ? "link" : "button", {
      name: "Open source task: Execution task",
    });
    await expect.element(sourceLink).toBeVisible();
    if (scenario.layout === "search") {
      await userEvent.click(screen.getByRole("option"));
      await userEvent.keyboard("{Enter}");
      expect(onSelect).toHaveBeenCalledTimes(2);
      onSelect.mockClear();
      await userEvent.click(sourceLink);
      await vi.waitFor(() =>
        expect(screen.router?.state.location.pathname).toBe("/local/execution-task"),
      );
      expect(onSelect).not.toHaveBeenCalled();
    }
  },
);

describe("sidebar render isolation", () => {
  // regression: #33100 Cmd+J re-rendered every sidebar row, which took hundreds of ms with many threads
  it("does not re-render thread rows when a quick Mod shortcut opens and focuses the terminal", async () => {
    using stack = new DisposableStack();
    const activeProject = project("active");
    const threads = Array.from({ length: 5 }, (_, index) => threadShell(activeProject.id, index));
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[0]!.id,
    };
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, false));
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();
    const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const beforeShortcut = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, true));
    await act(() => terminalInput.focus());
    await userEvent.keyboard(`{/${modifier}}`);
    await act(() => terminalInput.blur());
    expect(
      rowRenders() - beforeShortcut,
      "thread rows re-rendered while opening the terminal with a quick Mod shortcut",
    ).toBe(0);

    const jumpLabelsSince = (start: number) =>
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(start)
        .map(([props]) => props.jumpLabel)
        .filter((label) => label !== null);
    const beforeHold = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    expect(jumpLabelsSince(beforeHold), "holding Mod showed no jump hints").toHaveLength(2);
    const beforeRelease = rowRenders();
    await userEvent.keyboard(`{/${modifier}}`);
    expect(rowRenders()).toBeGreaterThan(beforeRelease);
    expect(jumpLabelsSince(beforeRelease)).toEqual([]);
  });
});
