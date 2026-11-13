import { decisionStatusLabels } from "@t3tools/client-runtime/decision-presentation";
import {
  DecisionDraft,
  prepareDecisionSubmission,
  replaceRejectedDecisionAttempt,
  type DecisionAction,
} from "@t3tools/client-runtime/decision-submission";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommandId, type OrchestrationV2Decision, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { MessagesSquareIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { randomUUID } from "../../lib/utils";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const NullableDecisionDraft = Schema.NullOr(DecisionDraft);

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
  const [draft, setDraft] = useLocalStorage(
    `t3:decision:${JSON.stringify([threadRef.environmentId, threadRef.threadId, decision.revision])}`,
    null,
    NullableDecisionDraft,
  );
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const sourceDeleted = source?.deletedAt != null;
  const handled = decision.status !== "discussing";
  const showDetails = !handled || expanded;

  async function submit(action: DecisionAction, selectedAnswer?: string) {
    if (inFlight.current) return;
    const { commandId, draft: submission } = prepareDecisionSubmission({
      draft,
      action,
      answer: selectedAnswer,
      newCommandId: CommandId.make(randomUUID()),
    });
    if (action === "confirm" && (!canConfirm || !submission.answer.trim())) return;
    if (action === "cancel" && !canCancel) return;
    if (action === "reopen" && !canReopen) return;
    setDraft(submission);
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
        setDraft(
          replaceRejectedDecisionAttempt({
            draft: submission,
            action,
            commandId: CommandId.make(randomUUID()),
          }),
        );
      }
    } else {
      setDraft(null);
      if (action === "cancel" && "sourceNotified" in result.value && !result.value.sourceNotified) {
        setError("Decision cancelled. The source task could not be notified.");
      }
    }
    inFlight.current = false;
    setPending(false);
  }

  return (
    <section aria-label="Decision" className="chat-content-lane my-3">
      <div
        className={`rounded-lg border p-2.5 ${handled ? "border-border bg-muted/20" : "border-warning-foreground/25 bg-warning-foreground/5"}`}
      >
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <MessagesSquareIcon aria-hidden className="size-4 shrink-0 text-warning-foreground" />
          <span className="font-medium text-warning-foreground">Decision</span>
          <span className="shrink-0 font-medium text-foreground">
            {decisionStatusLabels[decision.status]}
          </span>
          <span className="min-w-0 flex-1 truncate">{!showDetails ? decision.question : null}</span>
          {handled ? (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={showDetails}
              onClick={() => setExpanded(!expanded)}
            >
              {showDetails ? "Hide details" : "Details"}
            </Button>
          ) : null}
        </div>
        {showDetails ? (
          <>
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(sourceRef)}
              className="mt-2 block truncate text-xs underline underline-offset-2"
            >
              Source: {source?.title ?? "Open source task"}
            </Link>
            <p className="my-2 text-sm whitespace-pre-wrap">{decision.question}</p>
            {decision.finalAnswer && decision.status !== "completed" ? (
              <p className="mb-2 text-sm text-muted-foreground">
                Previously confirmed: {decision.finalAnswer}
              </p>
            ) : null}
            {decision.status === "discussing" ? (
              <>
                <p className="mb-2 text-xs text-muted-foreground">
                  Continue discussing in chat. Only the conclusion you confirm below is returned to
                  the source task.
                </p>
                {decision.options?.length ? (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {decision.options.map((option) => (
                      <Button
                        key={option}
                        size="sm"
                        variant="outline"
                        disabled={pending || !canConfirm || sourceDeleted}
                        onClick={() => void submit("confirm", option)}
                      >
                        {option}
                      </Button>
                    ))}
                  </div>
                ) : null}
                <Textarea
                  aria-label="Final decision"
                  placeholder="Write the conclusion to return…"
                  rows={3}
                  value={draft?.answer ?? ""}
                  disabled={pending || !canConfirm}
                  onChange={(event) =>
                    setDraft({
                      commandId: CommandId.make(randomUUID()),
                      answer: event.target.value,
                    })
                  }
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={pending || !canConfirm || !draft?.answer.trim() || sourceDeleted}
                    onClick={() => void submit("confirm")}
                  >
                    {pending ? "Saving…" : "Confirm and return"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending || !canCancel}
                    onClick={() => void submit("cancel")}
                  >
                    Cancel decision
                  </Button>
                </div>
              </>
            ) : (
              <>
                {decision.finalAnswer && decision.status === "completed" ? (
                  <p className="mb-2 text-sm whitespace-pre-wrap">{decision.finalAnswer}</p>
                ) : null}
                <p className="my-2 text-xs text-muted-foreground">
                  This decision is closed. Reopen to revise it with the existing discussion. For a
                  different issue, ask the source task to open a new decision.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || !canReopen}
                  onClick={() => void submit("reopen")}
                >
                  Reopen discussion
                </Button>
              </>
            )}
          </>
        ) : null}
        {sourceDeleted ? (
          <p role="alert" className="my-2 text-sm text-destructive">
            The source task was deleted. Your discussion is still available.
          </p>
        ) : null}
        {decision.status === "cancelled" && decision.cancellationNotified === false ? (
          <p role="alert" className="my-2 text-sm text-destructive">
            The source task could not be notified of this cancellation.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
