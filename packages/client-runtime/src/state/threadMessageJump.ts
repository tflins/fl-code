// @effect-diagnostics globalTimers:off - Cross-shell navigation owns a short request deadline outside an Effect runtime.
import type { MessageId } from "@t3tools/contracts";

// A message result opens its thread at that message. The thread screen reads
// the request while it shows that thread, and finishes it once the feed is
// there or the message cannot be found. A request whose thread never showed
// lapses, so a later plain open does not jump.
const PENDING_JUMP_MS = 30_000;
let pending: {
  readonly threadKey: string;
  readonly messageId: MessageId;
} | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function requestThreadMessageJump(threadKey: string, messageId: MessageId): void {
  if (expiry !== null) clearTimeout(expiry);
  pending = { threadKey, messageId };
  expiry = setTimeout(() => {
    pending = null;
    expiry = null;
    notify();
  }, PENDING_JUMP_MS);
  notify();
}

/** The message this thread should open at, if a result asked for one. */
export function pendingThreadMessageJump(threadKey: string): MessageId | null {
  return pending?.threadKey === threadKey ? pending.messageId : null;
}

export function finishThreadMessageJump(threadKey: string): void {
  if (pending?.threadKey !== threadKey) return;
  pending = null;
  if (expiry !== null) {
    clearTimeout(expiry);
    expiry = null;
  }
  notify();
}

export function subscribeThreadMessageJump(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
