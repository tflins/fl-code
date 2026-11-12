import {
  codeQaSideChatThreadId,
  type ModelSelection,
  type RuntimeMode,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useInsertionEffect, useRef } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import { appendCodeQaQuestionToDraft, openCodeQaQuestion } from "../../lib/openCodeQa";
import { useRightPanelStore } from "../../rightPanelStore";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import {
  readThreadShell,
  readThreadShells,
  waitForCodeQaSideChat,
  waitForThreadShell,
} from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

/** `open` sends with the parent composer's settings; `openAsk` reuses one side chat for diff questions. */
export function useSideChat(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly readSettings: () => {
    readonly runtimeMode: RuntimeMode;
    readonly modelSelection: ModelSelection | undefined;
  };
  readonly onError: (message: string) => void;
}) {
  const pendingRef = useRef(false);
  const askPendingRef = useRef(false);
  const latestThreadRef = useRef(input.threadRef);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- lets an in-flight ask notice a thread switch
  useInsertionEffect(() => {
    latestThreadRef.current = input.threadRef;
  });
  const forkSideChat = useAtomCommand(threadEnvironment.forkSideChat, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const setThreadRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode, {
    reportFailure: false,
  });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const reportFailure = (
    failure: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>,
    fallback: string,
  ) => {
    if (isAtomCommandInterrupted(failure)) return;
    const error = squashAtomCommandFailure(failure);
    input.onError(error instanceof Error ? error.message : fallback);
  };

  const isCodeQaSideChatOf = (
    sideChat: NonNullable<ReturnType<typeof readThreadShell>>,
    parentRef: ScopedThreadRef,
  ) =>
    sideChat.lineage.sideChat === true &&
    sideChat.lineage.codeQa === true &&
    sideChat.lineage.parentThreadId === parentRef.threadId &&
    sideChat.deletedAt === null;

  const codeQaTargetRef = (parentRef: ScopedThreadRef) =>
    scopeThreadRef(parentRef.environmentId, codeQaSideChatThreadId(parentRef.threadId));

  const findAskSideChat = (parentRef: ScopedThreadRef) => {
    const targetRef = codeQaTargetRef(parentRef);
    const target = readThreadShell(targetRef);
    if (target !== null && isCodeQaSideChatOf(target, parentRef)) return targetRef;
    const listed = readThreadShells().find(
      (shell) =>
        shell.environmentId === parentRef.environmentId &&
        shell.lineage.parentThreadId === parentRef.threadId &&
        shell.lineage.sideChat === true &&
        shell.lineage.codeQa === true &&
        shell.deletedAt === null,
    );
    return listed === undefined ? null : scopeThreadRef(parentRef.environmentId, listed.id);
  };

  const createSideChat = async (
    threadRef: ScopedThreadRef,
    title: string,
    runtimeMode: RuntimeMode,
    modelSelection: ModelSelection | undefined,
    prompt: string | undefined,
  ) => {
    const targetThreadId = newThreadId();
    const fork = await forkSideChat({
      environmentId: threadRef.environmentId,
      input: { sourceThreadId: threadRef.threadId, targetThreadId, title },
    });
    if (fork._tag === "Failure") {
      reportFailure(fork, "Could not start a side chat.");
      return null;
    }
    // Drops the empty side chat a failed start leaves behind; one that got its message stays.
    const discard = () =>
      void deleteThread({
        environmentId: threadRef.environmentId,
        input: { threadId: targetThreadId, onlyIfUnused: true },
      });
    const targetRef = scopeThreadRef(threadRef.environmentId, targetThreadId);
    if (!(await waitForThreadShell(targetRef))) {
      input.onError("The side chat was created, but it did not reach this client.");
      discard();
      return null;
    }
    const sideChat = readThreadShell(targetRef);
    if (sideChat === null) {
      input.onError("The side chat is no longer available.");
      discard();
      return null;
    }
    if (runtimeMode !== sideChat.runtimeMode) {
      const mode = await setThreadRuntimeMode({
        environmentId: threadRef.environmentId,
        input: { threadId: targetThreadId, runtimeMode, createdAt: new Date().toISOString() },
      });
      if (mode._tag === "Failure") {
        reportFailure(mode, "Could not set the side chat's permission mode.");
        discard();
        return null;
      }
    }
    const text = prompt?.trim();
    // Send before showing the tab: closing a tab whose side chat has no run deletes it.
    if (text) {
      const turn = await startThreadTurn({
        environmentId: threadRef.environmentId,
        input: {
          threadId: targetThreadId,
          message: { messageId: newMessageId(), role: "user", text, attachments: [] },
          ...(modelSelection === undefined ? {} : { modelSelection }),
          titleSeed: deriveThreadTitleSeed({ text, attachments: [] }),
          runtimeMode,
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        },
      });
      if (turn._tag === "Failure") {
        reportFailure(turn, "Could not send the side chat message.");
        discard();
        return null;
      }
    } else if (modelSelection !== undefined) {
      useComposerDraftStore.getState().setModelSelection(targetRef, modelSelection);
    }
    return { ref: targetRef };
  };

  const ensureCodeQaSideChat = async (
    parentRef: ScopedThreadRef,
    modelSelection: ModelSelection | undefined,
  ) => {
    const existing = findAskSideChat(parentRef);
    if (existing !== null) return existing;
    const targetRef = codeQaTargetRef(parentRef);
    const fork = await forkSideChat({
      environmentId: parentRef.environmentId,
      input: {
        sourceThreadId: parentRef.threadId,
        targetThreadId: targetRef.threadId,
        title: "Side chat",
        codeQa: true,
      },
    });
    if (fork._tag === "Failure") {
      const concurrent = findAskSideChat(parentRef);
      if (concurrent !== null) return concurrent;
      reportFailure(fork, "Could not start the code Q&A side chat.");
      return null;
    }
    // The server advances the generation after a deleted chat, so wait for the live child.
    const liveRef = await waitForCodeQaSideChat(parentRef);
    if (liveRef === null) {
      input.onError("The code Q&A side chat was created, but it did not reach this client.");
      return null;
    }
    const sideChat = readThreadShell(liveRef);
    if (sideChat === null || !isCodeQaSideChatOf(sideChat, parentRef)) {
      input.onError("The code Q&A side chat is not available for this thread.");
      return null;
    }
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(liveRef);
    // A reopened chat keeps its own model and an edited prompt; only an untouched draft gets
    // the parent composer's first model.
    if (
      modelSelection !== undefined &&
      (draft === null || Object.keys(draft.modelSelectionByProvider).length === 0)
    ) {
      store.setModelSelection(liveRef, modelSelection);
    }
    return liveRef;
  };

  const start = async (threadRef: ScopedThreadRef, prompt: string | undefined) => {
    const { runtimeMode, modelSelection } = input.readSettings();
    const created = await createSideChat(
      threadRef,
      "Side chat",
      runtimeMode,
      modelSelection,
      prompt,
    );
    if (created === null) return false;
    useRightPanelStore.getState().openSideChat(threadRef, created.ref.threadId);
    return true;
  };

  const openAsk = async (request: {
    readonly context: ReviewCommentContext;
    readonly question: string;
  }): Promise<ScopedThreadRef | null> => {
    const parentRef = input.threadRef;
    if (!parentRef || askPendingRef.current) return null;
    askPendingRef.current = true;
    let sideRef: ScopedThreadRef | null;
    try {
      const { modelSelection } = input.readSettings();
      sideRef = await openCodeQaQuestion({
        parentRef,
        context: request.context,
        question: request.question,
        readCurrentParent: () => latestThreadRef.current,
        ensureSideChat: (ref) => ensureCodeQaSideChat(ref, modelSelection),
        appendQuestion: (sideRef, context, question) => {
          const store = useComposerDraftStore.getState();
          appendCodeQaQuestionToDraft({
            sideRef,
            context,
            question,
            addReviewComment: (ref, comment) =>
              store.addReviewComment(ref, comment, { appendReference: false }),
            getPrompt: (ref) => store.getComposerDraft(ref)?.prompt ?? "",
            setPrompt: (ref, prompt) => store.setPrompt(ref, prompt),
          });
        },
      });
    } catch (error) {
      askPendingRef.current = false;
      throw error;
    }
    askPendingRef.current = false;
    return sideRef;
  };

  const open = async (prompt?: string) => {
    const { threadRef } = input;
    if (!threadRef || pendingRef.current) return false;
    pendingRef.current = true;
    return start(threadRef, prompt).finally(() => {
      pendingRef.current = false;
    });
  };
  return {
    available: input.threadRef !== null,
    open: useStableCallback(open),
    openAsk: useStableCallback(openAsk),
  };
}
