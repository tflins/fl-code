import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  INITIAL_SUBAGENT_HANDOFF_OFFSETS,
  formatSubagentChildThreadState,
  formatSubagentDelivery,
  formatSubagentExecutedModel,
  formatSubagentExecutionStatus,
  formatSubagentRequestedModel,
  formatSubagentResultSource,
  formatSubagentRoundAssociation,
  mergeSubagentHandoffPage,
  resolveSubagentHandoffRefreshAction,
  resolveSubagentHandoffNavigationTarget,
  subagentHandoffTargetIsAvailable,
  type SubagentHandoffBodyKey,
  type SubagentHandoffBodyView,
  type SubagentHandoffNavigationTarget,
  type SubagentHandoffOffsets,
  type SubagentHandoffView,
} from "@t3tools/client-runtime/state/subagent-handoff";
import { requestThreadMessageJump } from "@t3tools/client-runtime/state/thread-message-jump";
import type { EnvironmentId, NodeId, ThreadId } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";

const ALL_SECTIONS: ReadonlyArray<SubagentHandoffBodyKey> = ["prompt", "result", "delivery"];

export function SubagentHandoffDetails(props: {
  readonly parentEnvironmentId: EnvironmentId;
  readonly parentThreadId: ThreadId;
  readonly subagentId: NodeId;
  readonly canOpenTarget: (target: SubagentHandoffNavigationTarget) => boolean;
  readonly onOpenTarget: (target: SubagentHandoffNavigationTarget) => void;
}) {
  const [offsets, setOffsets] = useState<SubagentHandoffOffsets>(INITIAL_SUBAGENT_HANDOFF_OFFSETS);
  const [mergeKeys, setMergeKeys] = useState<ReadonlyArray<SubagentHandoffBodyKey>>(ALL_SECTIONS);
  const [baseView, setBaseView] = useState<SubagentHandoffView | null>(null);
  const query = useEnvironmentQuery(
    orchestrationEnvironment.subagentHandoff({
      environmentId: props.parentEnvironmentId,
      input: {
        parentThreadId: props.parentThreadId,
        subagentId: props.subagentId,
        promptOffset: offsets.prompt,
        resultOffset: offsets.result,
        deliveryOffset: offsets.delivery,
        ...(baseView === null
          ? {}
          : {
              revisions: {
                prompt: baseView.prompt.revision,
                result: baseView.result.revision,
                delivery: baseView.delivery.revision,
              },
            }),
      },
    }),
  );

  const view = query.isPending
    ? baseView
    : query.data === null
      ? null
      : mergeSubagentHandoffPage(baseView, query.data, offsets, mergeKeys);

  const loadMore = (key: SubagentHandoffBodyKey, nextOffset: number) => {
    setBaseView(view);
    setMergeKeys([key]);
    setOffsets({
      ...INITIAL_SUBAGENT_HANDOFF_OFFSETS,
      [key]: nextOffset,
    });
  };
  const refresh = () => {
    if (resolveSubagentHandoffRefreshAction(offsets, baseView) === "refresh") {
      query.refresh();
      return;
    }
    setMergeKeys(ALL_SECTIONS);
    setBaseView(null);
    setOffsets(INITIAL_SUBAGENT_HANDOFF_OFFSETS);
  };

  if (query.error !== null) {
    return (
      <div className="mt-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
        <p className="text-destructive-foreground">{query.error}</p>
        <Button className="mt-2" size="xs" variant="outline" onClick={query.refresh}>
          Retry
        </Button>
      </div>
    );
  }
  if (view === null) {
    return (
      <p className="mt-1 rounded-lg border border-border/60 px-3 py-2 text-xs text-muted-foreground">
        {query.isPending || query.data !== null
          ? "Loading handoff…"
          : "Handoff record unavailable."}
      </p>
    );
  }

  const handoff = view.handoff;
  const delivery = formatSubagentDelivery(handoff.completionDelivery);
  const target = resolveSubagentHandoffNavigationTarget(handoff, props.parentEnvironmentId);
  const canOpen =
    target !== null && subagentHandoffTargetIsAvailable(handoff) && props.canOpenTarget(target);
  const openTarget = () => {
    if (target === null || !canOpen) return;
    if (target.messageId !== null) {
      requestThreadMessageJump(
        scopedThreadKey(scopeThreadRef(target.environmentId, target.threadId)),
        target.messageId,
      );
    }
    props.onOpenTarget(target);
  };

  return (
    <section
      aria-label="Subagent handoff"
      className="mt-1 flex min-w-0 flex-col gap-3 rounded-lg border border-border/70 bg-muted/20 p-3 text-xs"
    >
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <Metadata label="Execution">
          {formatSubagentExecutionStatus(handoff.executionStatus)}
        </Metadata>
        <Metadata label="Delivery">
          {delivery.label}
          <span className="block text-muted-foreground">{delivery.detail}</span>
        </Metadata>
        <Metadata label="Requested model">
          {formatSubagentRequestedModel(handoff.requestedModel)}
        </Metadata>
        <Metadata label="Executed model">
          {formatSubagentExecutedModel(handoff.executedModel)}
        </Metadata>
        <Metadata label="Round">
          {formatSubagentRoundAssociation(handoff.roundAssociation)}
        </Metadata>
        <Metadata label="Child">
          {formatSubagentChildThreadState(handoff.childThreadState)}
        </Metadata>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="outline" disabled={!canOpen} onClick={openTarget}>
          Open thread
        </Button>
        {target === null ? (
          <span className="text-muted-foreground">No child thread is recorded.</span>
        ) : !subagentHandoffTargetIsAvailable(handoff) ? (
          <span className="text-muted-foreground">
            {formatSubagentChildThreadState(handoff.childThreadState)}.
          </span>
        ) : !canOpen ? (
          <span className="text-muted-foreground">The child environment is unavailable.</span>
        ) : target.messageId === null ? (
          <span className="text-muted-foreground">Exact round location is unavailable.</span>
        ) : (
          <span className="text-muted-foreground">Opens at the recorded round.</span>
        )}
        <Button
          className="ms-auto"
          size="xs"
          variant="ghost"
          disabled={query.isPending}
          onClick={refresh}
        >
          Refresh
        </Button>
      </div>

      <HandoffText
        label="Task prompt"
        value={view.prompt}
        unavailable="The original task prompt is unavailable."
        loading={query.isPending}
        onLoadMore={(offset) => loadMore("prompt", offset)}
      />
      <HandoffText
        label={formatSubagentResultSource(handoff.result.source)}
        value={view.result}
        unavailable={
          handoff.result.source === null
            ? "No final result has been recorded for this round."
            : "The result text is unavailable."
        }
        loading={query.isPending}
        onLoadMore={(offset) => loadMore("result", offset)}
      />
      <HandoffText
        label="Parent task result record"
        value={view.delivery}
        unavailable="No result text was saved on the parent task."
        loading={query.isPending}
        onLoadMore={(offset) => loadMore("delivery", offset)}
      />
    </section>
  );
}

function Metadata(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0">{props.children}</dd>
    </>
  );
}

function HandoffText(props: {
  readonly label: string;
  readonly value: SubagentHandoffBodyView;
  readonly unavailable: string;
  readonly loading: boolean;
  readonly onLoadMore: (offset: number) => void;
}) {
  return (
    <section aria-label={props.label} className="flex min-w-0 flex-col gap-1.5">
      <h4 className="font-medium text-foreground">{props.label}</h4>
      {props.value.availability === "unavailable" ? (
        <p className="text-muted-foreground">{props.unavailable}</p>
      ) : (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/70 p-2 font-sans text-xs text-foreground">
          {props.value.text}
        </pre>
      )}
      {props.value.nextOffset === null ? null : (
        <Button
          className="self-start"
          size="xs"
          variant="outline"
          disabled={props.loading}
          onClick={() => props.onLoadMore(props.value.nextOffset!)}
        >
          Load more
        </Button>
      )}
    </section>
  );
}
