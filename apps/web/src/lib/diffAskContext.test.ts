import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildDiffReviewComment } from "~/reviewCommentContext";
import { diffAskContextId } from "./diffAskContext";

const fileDiff = parsePatchFiles(
  [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
  ].join("\n"),
  { cacheKeyPrefix: "diff-ask-context-test" },
)[0]!.files[0]!;

const commentFor = (input: {
  readonly start: number;
  readonly fileVersion: number;
  readonly snapshotId: string;
}) => {
  const captured = buildDiffReviewComment({
    id: "pending",
    sectionId: "unstaged",
    sectionTitle: "Uncommitted",
    filePath: "src/app.ts",
    fileDiff,
    range: { start: input.start, end: input.start, side: "additions" },
    text: "",
    snapshot: { kind: "git-object", id: input.snapshotId, fileVersion: input.fileVersion },
  });
  if (captured === null) throw new Error("Expected a diff comment.");
  return { ...captured, id: diffAskContextId(captured) };
};

describe("diff Q&A context identity", () => {
  it("keeps one id per captured selection instead of replacing the previous reference", () => {
    const target = DraftId.make("diff-ask-accumulation");
    const first = commentFor({ start: 1, fileVersion: 1, snapshotId: "first" });
    const second = commentFor({ start: 3, fileVersion: 1, snapshotId: "first" });
    expect(first.id).not.toBe(second.id);

    const store = useComposerDraftStore.getState();
    store.setReviewComments(target, []);
    store.addReviewComment(target, first, { appendReference: false });
    store.addReviewComment(target, second, { appendReference: false });

    const comments = useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments;
    expect(comments?.map((comment) => comment.id)).toEqual([first.id, second.id]);
    expect(comments?.find((comment) => comment.id === first.id)?.diff).toBe(first.diff);
  });

  it("mints a new id when the captured content changes under the same lines", () => {
    const before = commentFor({ start: 3, fileVersion: 1, snapshotId: "before" });
    const after = commentFor({ start: 3, fileVersion: 2, snapshotId: "after" });
    expect(before.id).not.toBe(after.id);
  });
});
