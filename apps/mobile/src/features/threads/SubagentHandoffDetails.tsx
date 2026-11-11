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
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

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
      <View className="mt-1 gap-2 rounded-lg border border-destructive/30 bg-card p-3">
        <Text className="text-xs text-destructive">{query.error}</Text>
        <Action label="Retry" onPress={query.refresh} />
      </View>
    );
  }
  if (view === null) {
    return (
      <View className="mt-1 rounded-lg border border-border px-3 py-2">
        <Text className="text-xs text-foreground-muted">
          {query.isPending || query.data !== null
            ? "Loading handoff…"
            : "Handoff record unavailable."}
        </Text>
      </View>
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
    <View
      accessibilityLabel="Subagent handoff"
      className="mt-1 gap-3 rounded-lg border border-border bg-card/40 p-3"
    >
      <Metadata label="Execution" value={formatSubagentExecutionStatus(handoff.executionStatus)} />
      <Metadata label="Delivery" value={delivery.label} detail={delivery.detail} />
      <Metadata
        label="Requested model"
        value={formatSubagentRequestedModel(handoff.requestedModel)}
      />
      <Metadata label="Executed model" value={formatSubagentExecutedModel(handoff.executedModel)} />
      <Metadata label="Round" value={formatSubagentRoundAssociation(handoff.roundAssociation)} />
      <Metadata label="Child" value={formatSubagentChildThreadState(handoff.childThreadState)} />

      <View className="flex-row flex-wrap items-center gap-2">
        <Action label="Open thread" disabled={!canOpen} onPress={openTarget} />
        <Text className="text-2xs text-foreground-muted">
          {target === null
            ? "No child thread is recorded."
            : !subagentHandoffTargetIsAvailable(handoff)
              ? `${formatSubagentChildThreadState(handoff.childThreadState)}.`
              : !canOpen
                ? "The child environment is unavailable."
                : target.messageId === null
                  ? "Exact round location is unavailable."
                  : "Opens at the recorded round."}
        </Text>
        <View className="ms-auto">
          <Action label="Refresh" disabled={query.isPending} onPress={refresh} />
        </View>
      </View>

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
    </View>
  );
}

function Metadata(props: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
}) {
  return (
    <View className="flex-row gap-3">
      <Text className="w-28 shrink-0 text-xs text-foreground-muted">{props.label}</Text>
      <View className="min-w-0 flex-1">
        <Text className="text-xs text-foreground">{props.value}</Text>
        {props.detail === undefined ? null : (
          <Text className="mt-0.5 text-2xs text-foreground-muted">{props.detail}</Text>
        )}
      </View>
    </View>
  );
}

function Action(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.disabled
          ? "rounded-md border border-border px-2.5 py-1.5 opacity-50"
          : "rounded-md border border-border px-2.5 py-1.5 active:bg-subtle"
      }
    >
      <Text className="text-xs font-t3-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function HandoffText(props: {
  readonly label: string;
  readonly value: SubagentHandoffBodyView;
  readonly unavailable: string;
  readonly loading: boolean;
  readonly onLoadMore: (offset: number) => void;
}) {
  const nextOffset = props.value.nextOffset;
  return (
    <View className="gap-1.5">
      <Text className="font-t3-medium text-xs text-foreground">{props.label}</Text>
      {props.value.availability === "unavailable" ? (
        <Text className="text-xs text-foreground-muted">{props.unavailable}</Text>
      ) : (
        <ScrollView
          style={{ maxHeight: 256 }}
          nestedScrollEnabled
          className="rounded-md border border-border bg-background p-2"
        >
          <Text selectable className="text-xs text-foreground">
            {props.value.text}
          </Text>
        </ScrollView>
      )}
      {nextOffset === null ? null : (
        <View className="self-start">
          <Action
            label="Load more"
            disabled={props.loading}
            onPress={() => props.onLoadMore(nextOffset)}
          />
        </View>
      )}
    </View>
  );
}
