import {
  prepareDecisionSubmission,
  replaceRejectedDecisionAttempt,
  type DecisionAction,
} from "@t3tools/client-runtime/decision-submission";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, type OrchestrationV2Decision, type ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SymbolView } from "../../components/ui/AppSymbol";
import { uuidv4 } from "../../lib/uuid";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenLinkedThread } from "./useOpenLinkedThread";

export function DecisionThreadPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly decision: OrchestrationV2Decision;
}) {
  const { threadRef, decision } = props;
  const sourceRef = { environmentId: threadRef.environmentId, threadId: decision.sourceThreadId };
  const source = useAtomValue(environmentThreadShells.threadShellAtom(sourceRef));
  const canConfirm = useAtomValue(
    threadEnvironment.confirmDecision.permissionAtom(threadRef.environmentId),
  );
  const canCancel = useAtomValue(
    threadEnvironment.cancelDecision.permissionAtom(threadRef.environmentId),
  );
  const canReopen = useAtomValue(
    threadEnvironment.reopenDecision.permissionAtom(threadRef.environmentId),
  );
  const confirm = useAtomCommand(threadEnvironment.confirmDecision, { reportFailure: false });
  const cancel = useAtomCommand(threadEnvironment.cancelDecision, { reportFailure: false });
  const reopen = useAtomCommand(threadEnvironment.reopenDecision, { reportFailure: false });
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const openSource = useOpenLinkedThread();
  const draftKey = JSON.stringify([threadRef.environmentId, threadRef.threadId, decision.revision]);
  const draft = AsyncResult.isSuccess(preferences)
    ? preferences.value.decisionDrafts?.[draftKey]
    : undefined;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const sourceDeleted = source?.deletedAt != null;

  function saveDraft(value: typeof draft) {
    savePreferences({
      transform: (current) => {
        const drafts = { ...current.decisionDrafts };
        if (value) drafts[draftKey] = value;
        else delete drafts[draftKey];
        return { decisionDrafts: drafts };
      },
    });
  }

  async function submit(action: DecisionAction, selectedAnswer?: string) {
    if (inFlight.current) return;
    const { commandId, draft: submission } = prepareDecisionSubmission({
      draft,
      action,
      answer: selectedAnswer,
      newCommandId: CommandId.make(uuidv4()),
    });
    if (action === "confirm" && (!canConfirm || !submission.answer.trim())) return;
    if (action === "cancel" && !canCancel) return;
    if (action === "reopen" && !canReopen) return;
    saveDraft(submission);
    inFlight.current = true;
    setPending(true);
    setError(null);
    const attempted = await settlePromise(async () =>
      action === "confirm"
        ? await confirm({
            environmentId: threadRef.environmentId,
            input: {
              commandId,
              threadId: threadRef.threadId,
              expectedRevision: decision.revision,
              answer: submission.answer.trim(),
            },
          })
        : action === "cancel"
          ? await cancel({
              environmentId: threadRef.environmentId,
              input: {
                commandId,
                threadId: threadRef.threadId,
                expectedRevision: decision.revision,
              },
            })
          : await reopen({
              environmentId: threadRef.environmentId,
              input: {
                commandId,
                threadId: threadRef.threadId,
                expectedRevision: decision.revision,
              },
            }),
    );
    const result = attempted._tag === "Success" ? attempted.value : attempted;
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update the decision. Your answer is kept here.",
      );
      if (
        typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        cause._tag === "OrchestrationV2DispatchCommandError"
      ) {
        saveDraft(
          replaceRejectedDecisionAttempt({
            draft: submission,
            action,
            commandId: CommandId.make(uuidv4()),
          }),
        );
      }
    } else {
      saveDraft(undefined);
      if (action === "cancel" && "sourceNotified" in result.value && !result.value.sourceNotified) {
        setError("Decision cancelled. The source task could not be notified.");
      }
    }
    inFlight.current = false;
    setPending(false);
  }

  return (
    <View
      accessibilityLabel="Decision"
      className="mx-3 mb-2 gap-2 rounded-xl border border-input-border bg-screen p-3"
    >
      <View className="flex-row items-center gap-2">
        <SymbolView
          name="bubble.left.and.bubble.right"
          size={14}
          tintColorClassName="accent-foreground-muted"
        />
        <Text className="text-sm font-t3-medium">Decision</Text>
        <Text className="flex-1 text-xs text-foreground-muted">
          {decision.status === "discussing"
            ? "Awaiting your decision"
            : decision.status === "completed"
              ? "Returned to source task"
              : "Cancelled without an answer"}
        </Text>
      </View>
      <Button
        label={source?.title ?? "Open source task"}
        tone="text"
        size="compact"
        onPress={() => openSource(sourceRef)}
      />
      <Text className="text-sm">{decision.question}</Text>
      {sourceDeleted ? (
        <Text accessibilityRole="alert" className="text-sm text-danger">
          The source task was deleted. Your discussion is still available.
        </Text>
      ) : null}
      {decision.status === "cancelled" && decision.cancellationNotified === false ? (
        <Text accessibilityRole="alert" className="text-sm text-danger">
          The source task could not be notified of this cancellation.
        </Text>
      ) : null}
      {decision.finalAnswer && decision.status !== "completed" ? (
        <Text className="text-sm text-foreground-muted">
          Previously confirmed: {decision.finalAnswer}
        </Text>
      ) : null}
      {decision.status === "discussing" ? (
        <>
          <Text className="text-xs text-foreground-muted">
            Continue discussing in chat. Only the conclusion you confirm below is returned to the
            source task.
          </Text>
          {decision.options?.length ? (
            <View className="flex-row flex-wrap gap-2">
              {decision.options.map((option) => (
                <Button
                  key={option}
                  label={option}
                  size="compact"
                  disabled={pending || !canConfirm || sourceDeleted}
                  onPress={() => void submit("confirm", option)}
                />
              ))}
            </View>
          ) : null}
          <TextInput
            accessibilityLabel="Final decision"
            placeholder="Write the conclusion to return…"
            multiline
            numberOfLines={3}
            value={draft?.answer ?? ""}
            editable={!pending && canConfirm}
            onChangeText={(answer) => saveDraft({ commandId: CommandId.make(uuidv4()), answer })}
          />
          <View className="flex-row flex-wrap gap-2">
            <Button
              label="Confirm and return"
              size="compact"
              tone="primary"
              loading={pending}
              disabled={!canConfirm || !draft?.answer.trim() || sourceDeleted}
              onPress={() => void submit("confirm")}
            />
            <Button
              label="Cancel decision"
              size="compact"
              tone="text"
              disabled={pending || !canCancel}
              onPress={() => void submit("cancel")}
            />
          </View>
        </>
      ) : (
        <>
          {decision.finalAnswer ? <Text className="text-sm">{decision.finalAnswer}</Text> : null}
          <Button
            label="Reopen discussion"
            size="compact"
            disabled={pending || !canReopen}
            onPress={() => void submit("reopen")}
          />
        </>
      )}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
