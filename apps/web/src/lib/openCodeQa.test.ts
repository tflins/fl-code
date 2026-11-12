import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { CODE_QA_CONTEXT_INSTRUCTIONS } from "@t3tools/shared/diffAsk";
import { describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "~/composerDraftStore";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { formatInlineContextReference } from "./composerContextReferences";
import { reviewCommentContextReference } from "./composerContextRecords";
import { diffAskContextId } from "./diffAskContext";
import { appendCodeQaQuestionToDraft, openCodeQaQuestion } from "./openCodeQa";

const parentRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("parent"));
const otherRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("other"));
const sideRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("side"));
const context: ReviewCommentContext = {
  id: "diff-ask-selection",
  sectionId: "unstaged",
  sectionTitle: "Uncommitted",
  filePath: "src/app.ts",
  startIndex: 0,
  endIndex: 0,
  rangeLabel: "+1",
  text: "",
  diff: "@@ -1,1 +1,1 @@\n-old\n+new",
};

describe("code Q&A opening", () => {
  it("writes nothing when the user switches threads while the chat opens", async () => {
    let finish!: (ref: typeof sideRef | null) => void;
    const ensureSideChat = vi.fn(
      () => new Promise<typeof sideRef | null>((resolve) => (finish = resolve)),
    );
    const appendQuestion = vi.fn();
    let currentParent: typeof parentRef | null = parentRef;

    const opening = openCodeQaQuestion({
      parentRef,
      context,
      question: "Why this branch?",
      readCurrentParent: () => currentParent,
      ensureSideChat,
      appendQuestion,
    });
    currentParent = otherRef;
    finish(sideRef);

    await expect(opening).resolves.toBeNull();
    expect(appendQuestion).not.toHaveBeenCalled();
  });

  it("adds the question to the side chat draft when the parent is unchanged", async () => {
    const appendQuestion = vi.fn();
    const opened = await openCodeQaQuestion({
      parentRef,
      context,
      question: "Why this branch?",
      readCurrentParent: () => parentRef,
      ensureSideChat: async () => sideRef,
      appendQuestion,
    });

    expect(opened).toBe(sideRef);
    expect(appendQuestion).toHaveBeenCalledWith(
      sideRef,
      { ...context, text: CODE_QA_CONTEXT_INSTRUCTIONS },
      "Why this branch?",
    );
  });

  it("does not write a draft when no side chat could be created", async () => {
    const appendQuestion = vi.fn();
    const opened = await openCodeQaQuestion({
      parentRef,
      context,
      question: "Why this branch?",
      readCurrentParent: () => parentRef,
      ensureSideChat: async () => null,
      appendQuestion,
    });
    expect(opened).toBeNull();
    expect(appendQuestion).not.toHaveBeenCalled();
  });
});

describe("code Q&A draft writes", () => {
  it("keeps edited text, the chat's model, and each selection's own reference", () => {
    const store = useComposerDraftStore.getState();
    const modelSelection = {
      instanceId: ProviderInstanceId.make("deepseek"),
      model: "deepseek-v4.1-flash",
    };
    const first: ReviewCommentContext = {
      ...context,
      id: "first-selection",
      startIndex: 4,
      endIndex: 4,
      rangeLabel: "+5",
      diff: "@@ -5,1 +5,1 @@\n-old\n+new",
    };
    const second: ReviewCommentContext = {
      ...context,
      id: "second-selection",
      startIndex: 9,
      endIndex: 9,
      rangeLabel: "+10",
      diff: "@@ -10,1 +10,1 @@\n-before\n+after",
    };
    store.clearDraftThread(sideRef);
    store.setModelSelection(sideRef, modelSelection);
    store.setPrompt(sideRef, "Keep my edited question");

    for (const [selection, question] of [
      [first, "Why the first branch?"],
      [second, "Why the second branch?"],
    ] as const) {
      appendCodeQaQuestionToDraft({
        sideRef,
        context: selection,
        question,
        addReviewComment: (ref, comment) =>
          store.addReviewComment(ref, comment, { appendReference: false }),
        getPrompt: (ref) => store.getComposerDraft(ref)?.prompt ?? "",
        setPrompt: (ref, prompt) => store.setPrompt(ref, prompt),
      });
    }

    const draft = store.getComposerDraft(sideRef);
    const firstContext = { ...first, id: diffAskContextId(first) };
    const secondContext = { ...second, id: diffAskContextId(second) };
    expect(draft?.prompt).toContain("Keep my edited question");
    expect(draft?.prompt).toContain(
      formatInlineContextReference(reviewCommentContextReference(firstContext)),
    );
    expect(draft?.prompt).toContain(
      formatInlineContextReference(reviewCommentContextReference(secondContext)),
    );
    expect(draft?.reviewComments.map((comment) => [comment.id, comment.diff])).toEqual([
      [firstContext.id, first.diff],
      [secondContext.id, second.diff],
    ]);
    expect(draft?.modelSelectionByProvider[modelSelection.instanceId]).toEqual(modelSelection);
  });
});
