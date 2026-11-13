import type {
  AnnotationSide,
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import type { CodeViewHandle, CodeViewProps } from "@pierre/diffs/react";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { MessageCircle } from "lucide-react";
import { lazy, Suspense, useState, type ReactNode, type Ref } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import {
  buildFileDiffSnapshot,
  fnv1a32,
  resolveFileDiffPath,
  resolveFileDiffPreviousPath,
} from "~/lib/diffRendering";
import { diffAskContextId } from "~/lib/diffAskContext";
import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
} from "~/reviewCommentContext";

import { nextFileCommentId } from "../files/fileCommentAnnotations";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { DiffCommentAnnotation } from "./DiffCommentAnnotation";
import { StyledDiffCodeView, type StyledDiffCodeViewOptions } from "./StyledDiffCodeView";

const DiffAskPanel = lazy(() =>
  import("./DiffAskPanel").then((module) => ({ default: module.DiffAskPanel })),
);

interface DiffCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment" | "ask";
  range: SelectedLineRange;
  rangeLabel: string;
  text: string;
  sideChatRef?: ScopedThreadRef | undefined;
}

interface DiffCommentAnnotationGroup {
  entries: DiffCommentAnnotationEntry[];
}

type DiffCommentLineAnnotation = DiffLineAnnotation<DiffCommentAnnotationGroup>;
export type AnnotatableCodeViewHandle = CodeViewHandle<DiffCommentAnnotationGroup, undefined>;
const EMPTY_REVIEW_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];

function annotationSide(range: SelectedLineRange): AnnotationSide {
  return (range.endSide ?? range.side) === "deletions" ? "deletions" : "additions";
}

function appendAnnotationEntry(
  annotations: ReadonlyArray<DiffCommentLineAnnotation>,
  range: SelectedLineRange,
  entry: DiffCommentAnnotationEntry,
): DiffCommentLineAnnotation[] {
  const side = annotationSide(range);
  const annotationIndex = annotations.findIndex(
    (annotation) => annotation.side === side && annotation.lineNumber === range.end,
  );
  if (annotationIndex < 0) {
    return [
      ...annotations,
      {
        side,
        lineNumber: range.end,
        metadata: { entries: [entry] },
      },
    ];
  }
  return annotations.map((annotation, index) =>
    index === annotationIndex
      ? {
          ...annotation,
          metadata: { entries: [...annotation.metadata.entries, entry] },
        }
      : annotation,
  );
}

interface AnnotatableCodeViewProps {
  environmentId?: EnvironmentId | undefined;
  projectId?: ProjectId | null | undefined;
  codeViewKey: string;
  files: ReadonlyArray<{
    fileDiff: FileDiffMetadata;
    filePath: string;
    fileKey: string;
    fileVersion: number;
    collapsed: boolean;
  }>;
  pendingFiles: ReadonlyArray<FileDiffMetadata>;
  sectionId: string;
  sectionTitle: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  options: StyledDiffCodeViewOptions<DiffCommentAnnotationGroup>;
  viewerRef?: Ref<AnnotatableCodeViewHandle>;
  onScroll?: CodeViewProps<DiffCommentAnnotationGroup, undefined>["onScroll"];
  className?: string;
  renderCodeViewFooter?: () => ReactNode;
  unsafeCSSExtra?: string;
  renderHeaderMetadata?: (fileDiff: FileDiffMetadata) => ReactNode;
  renderHeaderFilenameSuffix: (fileDiff: FileDiffMetadata) => ReactNode;
  renderHeaderPrefix: (
    fileDiff: FileDiffMetadata,
    fileKey: string,
    collapsed: boolean,
  ) => ReactNode;
  onRevealSearchMatch: (fileKey: string) => void;
  onAskAboutSelection?: (
    context: ReviewCommentContext,
    question: string,
  ) => Promise<ScopedThreadRef | null>;
  askParentPanel?: SideChatParentPanel | undefined;
}

interface DiffSelectionContext {
  item: CodeViewItem<DiffCommentAnnotationGroup>;
}

export function AnnotatableCodeView({
  environmentId,
  projectId,
  codeViewKey,
  files,
  pendingFiles,
  sectionId,
  sectionTitle,
  composerDraftTarget,
  options,
  viewerRef,
  onScroll,
  className,
  renderCodeViewFooter,
  unsafeCSSExtra,
  renderHeaderMetadata,
  renderHeaderFilenameSuffix,
  renderHeaderPrefix,
  onRevealSearchMatch,
  onAskAboutSelection,
  askParentPanel,
}: AnnotatableCodeViewProps) {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const reviewComments = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.reviewComments ?? EMPTY_REVIEW_COMMENTS,
  );
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  const [draft, setDraft] = useState<{
    fileKey: string;
    filePath: string;
    previousFilePath: string;
    annotation: DiffCommentLineAnnotation;
  } | null>(null);
  const [draftText, setDraftText] = useState("");
  const [ask, setAsk] = useState<{
    fileKey: string;
    filePath: string;
    previousFilePath: string;
    annotation: DiffCommentLineAnnotation;
  } | null>(null);
  const [askPending, setAskPending] = useState(false);
  const parentThreadRef = typeof composerDraftTarget === "string" ? null : composerDraftTarget;

  const filesByKey = new Map(files.map((file) => [file.fileKey, file]));
  if (
    draft !== null &&
    !filesByKey.has(draft.fileKey) &&
    // Lazy placeholders have provisional change types, so match both paths instead.
    !pendingFiles.some(
      (file) =>
        resolveFileDiffPath(file) === draft.filePath &&
        resolveFileDiffPreviousPath(file) === draft.previousFilePath,
    )
  ) {
    setDraft(null);
    setDraftText("");
    setSelectedLines(null);
  }
  if (
    ask !== null &&
    !filesByKey.has(ask.fileKey) &&
    !pendingFiles.some(
      (file) =>
        resolveFileDiffPath(file) === ask.filePath &&
        resolveFileDiffPreviousPath(file) === ask.previousFilePath,
    )
  ) {
    setAsk(null);
  }
  const items: CodeViewDiffItem<DiffCommentAnnotationGroup>[] = files.map(
    ({ fileDiff, filePath, fileKey, fileVersion, collapsed }) => {
      const persisted = reviewComments
        .filter(
          (comment) =>
            comment.sectionId === sectionId &&
            comment.filePath === filePath &&
            (comment.fenceLanguage ?? "diff") === "diff",
        )
        .reduce<DiffCommentLineAnnotation[]>((annotations, comment) => {
          const range = restoreDiffReviewCommentRange(fileDiff, comment);
          if (!range) return annotations;
          return appendAnnotationEntry(annotations, range, {
            id: comment.id,
            kind: "comment",
            range,
            rangeLabel: comment.rangeLabel,
            text: comment.text,
          });
        }, []);
      const annotations = [
        ...(ask?.fileKey === fileKey ? [ask.annotation] : []),
        ...(draft?.fileKey === fileKey ? [draft.annotation] : []),
        ...persisted,
      ];
      return {
        id: fileKey,
        type: "diff",
        fileDiff,
        annotations,
        collapsed,
        version: fnv1a32(
          `${fileVersion}:${collapsed ? "1" : "0"}:${annotations
            .flatMap((annotation) =>
              annotation.metadata.entries.map(
                (entry) =>
                  `${entry.id}:${entry.kind}:${entry.rangeLabel}:${entry.text}:${entry.sideChatRef?.threadId ?? ""}`,
              ),
            )
            .join(":")}`,
        ),
      };
    },
  );

  const removeEntry = (entryId: string) => {
    setSelectedLines(null);
    if (ask?.annotation.metadata.entries.some((entry) => entry.id === entryId)) {
      setAsk(null);
      return;
    }
    if (draft?.annotation.metadata.entries.some((entry) => entry.id === entryId)) {
      setDraft(null);
      setDraftText("");
    } else {
      removeReviewComment(composerDraftTarget, entryId);
    }
  };

  const submitEntry = (entryId: string, text: string) => {
    const entry = draft?.annotation.metadata.entries.find((candidate) => candidate.id === entryId);
    const file = draft ? filesByKey.get(draft.fileKey) : undefined;
    if (!entry || !file) return;
    const comment = buildDiffReviewComment({
      id: entry.id,
      sectionId,
      sectionTitle,
      filePath: file.filePath,
      fileDiff: file.fileDiff,
      range: entry.range,
      text,
    });
    if (comment) addReviewComment(composerDraftTarget, comment);
    setSelectedLines(null);
    setDraft(null);
    setDraftText("");
  };

  const beginComment = (range: SelectedLineRange | null, context: DiffSelectionContext) => {
    if (!range) return;
    const item = context.item;
    if (item.type !== "diff") return;
    setAsk(null);
    const id = nextFileCommentId();
    const filePath = resolveFileDiffPath(item.fileDiff);
    const comment = buildDiffReviewComment({
      id,
      sectionId,
      sectionTitle,
      filePath,
      fileDiff: item.fileDiff,
      range,
      text: "",
    });
    if (!comment) return;
    setDraftText("");
    setDraft({
      fileKey: item.id,
      filePath,
      previousFilePath: resolveFileDiffPreviousPath(item.fileDiff),
      annotation: {
        side: annotationSide(range),
        lineNumber: range.end,
        metadata: {
          entries: [{ id, kind: "draft", range, rangeLabel: comment.rangeLabel, text: "" }],
        },
      },
    });
  };

  const beginAsk = async (
    range: SelectedLineRange | null,
    context: DiffSelectionContext,
    question: string,
  ) => {
    if (!range || !onAskAboutSelection || !askParentPanel || askPending) return;
    const item = context.item;
    if (item.type !== "diff") return;
    const file = filesByKey.get(item.id);
    if (!file) return;
    const captured = buildDiffReviewComment({
      id: "pending-diff-ask",
      sectionId,
      sectionTitle,
      filePath: file.filePath,
      fileDiff: item.fileDiff,
      range,
      text: "",
      snapshot: buildFileDiffSnapshot(item.fileDiff, file.fileVersion),
    });
    if (!captured) return;
    const comment = { ...captured, id: diffAskContextId(captured) };
    setAskPending(true);
    let sideChatRef: ScopedThreadRef | null;
    try {
      sideChatRef = await onAskAboutSelection(comment, question);
    } catch (error) {
      setAskPending(false);
      throw error;
    }
    setAskPending(false);
    if (sideChatRef === null) return;
    setDraft(null);
    setDraftText("");
    setSelectedLines(null);
    setAsk({
      fileKey: item.id,
      filePath: file.filePath,
      previousFilePath: resolveFileDiffPreviousPath(item.fileDiff),
      annotation: {
        side: annotationSide(range),
        lineNumber: range.end,
        metadata: {
          entries: [
            {
              id: comment.id,
              kind: "ask",
              range,
              rangeLabel: comment.rangeLabel,
              text: "",
              sideChatRef,
            },
          ],
        },
      },
    });
  };

  return (
    <StyledDiffCodeView<DiffCommentAnnotationGroup>
      key={codeViewKey}
      {...(viewerRef ? { viewerRef } : {})}
      {...(onScroll ? { onScroll } : {})}
      {...(className ? { className } : {})}
      {...(unsafeCSSExtra ? { unsafeCSSExtra } : {})}
      {...(renderHeaderMetadata
        ? {
            renderHeaderMetadata: (item: CodeViewItem<DiffCommentAnnotationGroup>) =>
              item.type === "diff" ? renderHeaderMetadata(item.fileDiff) : null,
          }
        : {})}
      {...(renderCodeViewFooter ? { renderCodeViewFooter } : {})}
      items={items}
      selectedLines={selectedLines}
      onSelectedLinesChange={setSelectedLines}
      options={{
        ...options,
        enableGutterUtility: draft === null,
        enableLineSelection: draft === null,
        onGutterUtilityClick: beginComment,
        onRevealSearchMatch: (item) => onRevealSearchMatch(item.id),
      }}
      renderHeaderFilenameSuffix={(item) =>
        item.type === "diff" ? renderHeaderFilenameSuffix(item.fileDiff) : null
      }
      renderHeaderPrefix={(item) =>
        item.type === "diff"
          ? renderHeaderPrefix(item.fileDiff, item.id, item.collapsed === true)
          : null
      }
      renderAnnotation={(...[annotation, , item]) => {
        const hasDraft = annotation.metadata.entries.some((entry) => entry.kind === "draft");
        return (
          <div
            className={hasDraft ? "py-1" : "divide-y divide-border/30 border-y border-border/30"}
          >
            {annotation.metadata.entries.map((entry) =>
              entry.kind === "ask" ? (
                entry.sideChatRef !== undefined && askParentPanel && parentThreadRef ? (
                  <Suspense key={entry.id} fallback={null}>
                    <DiffAskPanel
                      parentRef={parentThreadRef}
                      sideChatRef={entry.sideChatRef}
                      filePath={ask?.filePath ?? ""}
                      rangeLabel={entry.rangeLabel}
                      parentPanel={askParentPanel}
                      onClose={() => removeEntry(entry.id)}
                    />
                  </Suspense>
                ) : null
              ) : (
                <DiffCommentAnnotation
                  key={entry.id}
                  environmentId={environmentId}
                  projectId={projectId}
                  ownerKey={JSON.stringify([
                    environmentId,
                    composerDraftTarget,
                    codeViewKey,
                    entry.id,
                  ])}
                  kind={entry.kind}
                  rangeLabel={entry.rangeLabel}
                  text={entry.kind === "draft" ? draftText : entry.text}
                  onTextChange={setDraftText}
                  onCancel={() => removeEntry(entry.id)}
                  onComment={(text) => submitEntry(entry.id, text)}
                  onDelete={() => removeEntry(entry.id)}
                  pending={entry.kind === "draft" && askPending}
                  {...(entry.kind === "draft" && onAskAboutSelection && askParentPanel
                    ? {
                        secondaryAction: {
                          label: "Ask",
                          icon: <MessageCircle className="size-3" />,
                          allowEmpty: true,
                          onAction: (text: string) => {
                            if (item.type === "diff") void beginAsk(entry.range, { item }, text);
                          },
                        },
                      }
                    : {})}
                />
              ),
            )}
          </div>
        );
      }}
    />
  );
}
