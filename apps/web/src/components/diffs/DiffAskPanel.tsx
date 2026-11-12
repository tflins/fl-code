import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessageCircle, XIcon } from "lucide-react";
import { useEffect } from "react";

import { ComposerHandleContext } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { hostRightPanel } from "../../rightPanelStore";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { Button } from "../ui/button";

/** A diff question's side chat, kept beside the selected lines instead of replacing the panel. */
export function DiffAskPanel(props: {
  readonly parentRef: ScopedThreadRef;
  readonly sideChatRef: ScopedThreadRef;
  readonly filePath: string;
  readonly rangeLabel: string;
  readonly parentPanel: SideChatParentPanel;
  readonly onClose: () => void;
}) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the parent as this embedded chat's panel host
  useEffect(
    () => hostRightPanel(props.sideChatRef, props.parentRef),
    [props.parentRef, props.sideChatRef],
  );

  return (
    <div
      data-side-chat-pane
      data-diff-ask-panel
      className="flex max-h-[70vh] min-h-[320px] flex-col border-y border-border/40 bg-background font-sans text-foreground"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 px-3">
        <MessageCircle className="size-3.5 shrink-0 text-primary/70" aria-hidden="true" />
        <span className="shrink-0 text-xs font-medium">Ask about this diff</span>
        <span className="min-w-0 flex-1 truncate font-mono text-3xs text-muted-foreground">
          {props.filePath} · {props.rangeLabel}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close diff question"
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <BackgroundThreadContext value>
          <ComposerHandleContext value={null}>
            <ChatView
              environmentId={props.sideChatRef.environmentId}
              threadId={props.sideChatRef.threadId}
              routeKind="server"
              embedded={props.parentPanel}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      </div>
      <p className="shrink-0 border-t border-border/40 px-3 py-1.5 text-3xs text-muted-foreground">
        Read-only Q&A: the server blocks file changes, side-effecting tools, and cross-thread
        actions. Codex and Claude sessions can enforce this; other providers are refused.
      </p>
    </div>
  );
}
