import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2Decision,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { DecisionThreadPanel } from "./DecisionThreadPanel";

vi.mock("../../state/threads", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const source = Atom.make(null);
  const deletedSource = Atom.make({ title: "Deleted source", deletedAt: "2026-11-13T00:00:00Z" });
  const command = { permissionAtom: () => allowed };
  return {
    environmentThreadShells: {
      threadShellAtom: (ref: ScopedThreadRef) =>
        ref.threadId === "thread-source-deleted" ? deletedSource : source,
    },
    threadEnvironment: {
      confirmDecision: command,
      cancelDecision: command,
      reopenDecision: command,
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success", value: {} }),
}));

const threadRef = {
  environmentId: EnvironmentId.make("environment-decision-panel"),
  threadId: ThreadId.make("thread-decision-panel"),
};
const now = DateTime.makeUnsafe("2026-11-13T00:00:00Z");

function panel(
  status: OrchestrationV2Decision["status"],
  cancellationNotified = true,
  sourceDeleted = false,
) {
  return (
    <AppAtomRegistryProvider>
      <DecisionThreadPanel
        threadRef={threadRef}
        decision={{
          sourceThreadId: ThreadId.make(sourceDeleted ? "thread-source-deleted" : "thread-source"),
          question: "How long should usage records be retained?",
          status,
          revision: 2,
          createdAt: now,
          updatedAt: now,
          finalAnswer: "Keep records for 30 days.",
          cancellationNotified,
        }}
      />
    </AppAtomRegistryProvider>
  );
}

it.each(["completed", "cancelled"] as const)(
  "collapses a %s decision while keeping history and explicit reopening accessible",
  async (status) => {
    await using screen = await render(panel(status));
    await expect
      .element(screen.getByRole("button", { name: "Details", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Reopen discussion" }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Details", exact: true }));
    await expect
      .element(screen.getByText("Keep records for 30 days.", { exact: false }))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Reopen discussion" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Hide details" }));
    await expect
      .element(screen.getByRole("button", { name: "Reopen discussion" }))
      .not.toBeInTheDocument();
  },
);

it.each([
  { status: "cancelled", cancellationNotified: false, sourceDeleted: false },
  { status: "completed", cancellationNotified: true, sourceDeleted: true },
] as const)(
  "keeps actionable alerts visible when history is collapsed: $status",
  async (scenario) => {
    await using screen = await render(
      panel(scenario.status, scenario.cancellationNotified, scenario.sourceDeleted),
    );
    await expect.element(screen.getByRole("alert")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Details", exact: true }));
    await userEvent.click(screen.getByRole("button", { name: "Hide details" }));
    await expect.element(screen.getByRole("alert")).toBeVisible();
  },
);
