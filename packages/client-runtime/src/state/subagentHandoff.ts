import type {
  EnvironmentId,
  MessageId,
  OrchestrationV2SubagentHandoff,
  OrchestrationV2SubagentHandoffBody,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

export type SubagentHandoffBodyKey = "prompt" | "result" | "delivery";
export type SubagentHandoffOffsets = Readonly<Record<SubagentHandoffBodyKey, number>>;

export interface SubagentHandoffBodyView {
  readonly availability: OrchestrationV2SubagentHandoffBody["availability"];
  readonly revision: string;
  readonly source: OrchestrationV2SubagentHandoff["result"]["source"];
  readonly text: string;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
}

export interface SubagentHandoffView {
  readonly handoff: OrchestrationV2SubagentHandoff;
  readonly prompt: SubagentHandoffBodyView;
  readonly result: SubagentHandoffBodyView;
  readonly delivery: SubagentHandoffBodyView;
}

export const INITIAL_SUBAGENT_HANDOFF_OFFSETS: SubagentHandoffOffsets = {
  prompt: 0,
  result: 0,
  delivery: 0,
};

export type SubagentHandoffRefreshAction = "refresh" | "reset";

/**
 * A paged query's key includes offsets and revisions. Resetting it mounts the
 * zero-offset query, which revalidates on mount; also refreshing the old page
 * would issue two requests for one user action.
 */
export function resolveSubagentHandoffRefreshAction(
  offsets: SubagentHandoffOffsets,
  view: SubagentHandoffView | null,
): SubagentHandoffRefreshAction {
  return view !== null || offsets.prompt !== 0 || offsets.result !== 0 || offsets.delivery !== 0
    ? "reset"
    : "refresh";
}

function bodyView(
  body: OrchestrationV2SubagentHandoffBody,
  source: OrchestrationV2SubagentHandoff["result"]["source"],
): SubagentHandoffBodyView {
  return {
    availability: body.availability,
    revision: body.revision,
    source,
    text: body.text,
    truncated: body.truncated,
    nextOffset: body.nextOffset,
  };
}

function mergeBody(
  previous: SubagentHandoffBodyView | undefined,
  body: OrchestrationV2SubagentHandoffBody,
  source: OrchestrationV2SubagentHandoff["result"]["source"],
  requestedOffset: number,
): SubagentHandoffBodyView {
  const next = bodyView(body, source);
  if (
    previous === undefined ||
    requestedOffset === 0 ||
    requestedOffset !== previous.nextOffset ||
    previous.revision !== next.revision ||
    previous.source !== next.source ||
    previous.availability !== "available" ||
    next.availability !== "available"
  ) {
    return next;
  }
  return {
    ...next,
    text: previous.text + next.text,
  };
}

function mergeSection(
  previous: SubagentHandoffBodyView | undefined,
  body: OrchestrationV2SubagentHandoffBody,
  source: OrchestrationV2SubagentHandoff["result"]["source"],
  requestedOffset: number,
  requested: boolean,
): SubagentHandoffBodyView {
  if (
    !requested &&
    previous !== undefined &&
    previous.revision === body.revision &&
    previous.source === source &&
    previous.availability === body.availability
  ) {
    return previous;
  }
  return mergeBody(previous, body, source, requestedOffset);
}

/**
 * Merges one RPC page into manually loaded text. A changed section replaces its visible body even
 * when another section supplied the page, so labels and navigation cannot lead their text.
 */
export function mergeSubagentHandoffPage(
  previous: SubagentHandoffView | null,
  handoff: OrchestrationV2SubagentHandoff,
  offsets: SubagentHandoffOffsets,
  mergeKeys: ReadonlyArray<SubagentHandoffBodyKey> = ["prompt", "result", "delivery"],
): SubagentHandoffView {
  const keys = new Set(mergeKeys);
  return {
    handoff,
    prompt: mergeSection(
      previous?.prompt,
      handoff.prompt,
      null,
      offsets.prompt,
      keys.has("prompt"),
    ),
    result: mergeSection(
      previous?.result,
      handoff.result.body,
      handoff.result.source,
      offsets.result,
      keys.has("result"),
    ),
    delivery: mergeSection(
      previous?.delivery,
      handoff.deliveryResult,
      "parent_record",
      offsets.delivery,
      keys.has("delivery"),
    ),
  };
}

export function formatSubagentExecutionStatus(
  status: OrchestrationV2SubagentHandoff["executionStatus"],
): string {
  switch (status) {
    case "pending":
      return "Queued";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
  }
}

export function formatSubagentDelivery(
  delivery: OrchestrationV2SubagentHandoff["completionDelivery"],
): { readonly label: string; readonly detail: string } {
  if (delivery === null) {
    return {
      label: "Delivery unknown",
      detail: "No completion delivery record was saved for this task.",
    };
  }
  switch (delivery.state) {
    case "pending":
      return {
        label: "Not delivered yet",
        detail: "The parent turn has not claimed this result.",
      };
    case "claimed":
      return {
        label: "Claimed by parent",
        detail: "The parent run claimed this result; it has not been recorded as delivered.",
      };
    case "acknowledged":
      return {
        label: "Acknowledged by parent",
        detail: "The parent turn confirmed receipt; acknowledgement does not mean understanding.",
      };
    case "delivered":
      return {
        label: "Recorded as delivered",
        detail: "The server recorded delivery through the parent turn, not that it was adopted.",
      };
    case "disposed":
      return {
        label: "Not sent to parent",
        detail: "The server recorded that this result was not included in the parent turn.",
      };
  }
}

export function formatSubagentRequestedModel(
  requested: OrchestrationV2SubagentHandoff["requestedModel"],
): string {
  if (requested === null) return "Not recorded";
  if (requested.selection !== null) return requested.selection.model;
  if (requested.model === null) return "Not recorded";
  return `${requested.model} (selection details unavailable)`;
}

export function formatSubagentExecutedModel(
  executed: OrchestrationV2SubagentHandoff["executedModel"],
): string {
  return executed ?? "Unknown";
}

export function formatSubagentResultSource(
  source: OrchestrationV2SubagentHandoff["result"]["source"],
): string {
  switch (source) {
    case "child_run":
      return "Original child result";
    case "parent_record":
      return "Saved parent result record";
    case null:
      return "No final result recorded";
  }
}

export function formatSubagentChildThreadState(
  state: OrchestrationV2SubagentHandoff["childThreadState"],
): string {
  switch (state) {
    case "available":
      return "Child thread available";
    case "deleted":
      return "Child thread deleted; its original result is unavailable";
    case "missing":
      return "Child thread missing; its original result is unavailable";
    case "unknown":
      return "Child thread ownership could not be verified";
  }
}

export function formatSubagentRoundAssociation(
  association: OrchestrationV2SubagentHandoff["roundAssociation"],
): string {
  switch (association) {
    case "run_delegated_task_id":
      return "Round linked by delegated task id";
    case "spawn_transfer":
      return "Round linked by the task's spawn transfer";
    case "unavailable":
      return "Round location unavailable";
  }
}

export interface SubagentHandoffNavigationTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly messageId: MessageId | null;
}

export function subagentHandoffTargetIsAvailable(handoff: OrchestrationV2SubagentHandoff): boolean {
  return (
    handoff.target !== null &&
    (handoff.target.kind === "remote" || handoff.childThreadState === "available")
  );
}

export function resolveSubagentHandoffNavigationTarget(
  handoff: OrchestrationV2SubagentHandoff,
  parentEnvironmentId: EnvironmentId,
): SubagentHandoffNavigationTarget | null {
  if (handoff.target === null) return null;
  return handoff.target.kind === "local"
    ? {
        environmentId: parentEnvironmentId,
        threadId: handoff.target.threadId,
        runId: handoff.childRunId,
        messageId: handoff.navigation?.messageId ?? null,
      }
    : {
        environmentId: handoff.target.environmentId,
        threadId: handoff.target.threadId,
        runId: handoff.target.runId,
        messageId: handoff.navigation?.messageId ?? null,
      };
}
