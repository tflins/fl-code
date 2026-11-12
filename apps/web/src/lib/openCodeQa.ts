import type { ScopedThreadRef } from "@t3tools/contracts";
import { CODE_QA_CONTEXT_INSTRUCTIONS } from "@t3tools/shared/diffAsk";

import type { ReviewCommentContext } from "../reviewCommentContext";
import { formatInlineContextReference } from "./composerContextReferences";
import { reviewCommentContextReference } from "./composerContextRecords";
import { diffAskContextId } from "./diffAskContext";

function sameThreadRef(left: ScopedThreadRef | null, right: ScopedThreadRef | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId
  );
}

/**
 * Opens the parent's code Q&A chat, then writes the question only if the user is still on that
 * parent. An open that finishes after a thread switch must not target the new thread's panel or draft.
 */
export async function openCodeQaQuestion(input: {
  readonly parentRef: ScopedThreadRef;
  readonly context: ReviewCommentContext;
  readonly question: string;
  readonly readCurrentParent: () => ScopedThreadRef | null;
  readonly ensureSideChat: (parentRef: ScopedThreadRef) => Promise<ScopedThreadRef | null>;
  readonly appendQuestion: (
    sideRef: ScopedThreadRef,
    context: ReviewCommentContext,
    question: string,
  ) => void;
}): Promise<ScopedThreadRef | null> {
  const sideRef = await input.ensureSideChat(input.parentRef);
  if (sideRef === null) return null;
  if (!sameThreadRef(input.readCurrentParent(), input.parentRef)) return null;
  input.appendQuestion(
    sideRef,
    { ...input.context, text: CODE_QA_CONTEXT_INSTRUCTIONS },
    input.question,
  );
  return sideRef;
}

/** Adds one captured selection to an Ask draft without replacing earlier selections or edits. */
export function appendCodeQaQuestionToDraft(input: {
  readonly sideRef: ScopedThreadRef;
  readonly context: ReviewCommentContext;
  readonly question: string;
  readonly addReviewComment: (sideRef: ScopedThreadRef, context: ReviewCommentContext) => void;
  readonly getPrompt: (sideRef: ScopedThreadRef) => string;
  readonly setPrompt: (sideRef: ScopedThreadRef, prompt: string) => void;
}): void {
  const identifiedContext = { ...input.context, id: diffAskContextId(input.context) };
  input.addReviewComment(input.sideRef, identifiedContext);
  const prompt = input.getPrompt(input.sideRef);
  const reference = formatInlineContextReference(reviewCommentContextReference(identifiedContext));
  const referenceAndQuestion =
    input.question.length === 0 ? reference : `${reference} ${input.question}`;
  input.setPrompt(
    input.sideRef,
    prompt.trimEnd().length === 0
      ? referenceAndQuestion
      : `${prompt.trimEnd()}\n${referenceAndQuestion}`,
  );
}
