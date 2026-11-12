import type { ReviewCommentContext } from "../reviewCommentContext";
import { fnv1a32 } from "./diffRendering";

/**
 * Identity for one captured selection. It must not use the side chat's thread id: a second
 * selection would then replace the first comment and rewrite every draft that references it.
 */
export function diffAskContextId(
  context: Pick<
    ReviewCommentContext,
    "sectionId" | "filePath" | "startIndex" | "endIndex" | "diff" | "selection" | "snapshot"
  >,
): string {
  const identity = JSON.stringify([
    context.sectionId,
    context.filePath,
    context.startIndex,
    context.endIndex,
    context.diff,
    context.selection ?? null,
    context.snapshot ?? null,
  ]);
  return `diff-ask-${fnv1a32(identity).toString(36)}`;
}
