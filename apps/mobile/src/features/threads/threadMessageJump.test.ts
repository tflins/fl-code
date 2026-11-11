import { MessageId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  finishThreadMessageJump,
  pendingThreadMessageJump,
  requestThreadMessageJump,
} from "./threadMessageJump";

describe("threadMessageJump", () => {
  it("lets a jump lapse when its thread never showed", () => {
    vi.useFakeTimers();
    try {
      requestThreadMessageJump("thread-a", MessageId.make("message-1"));
      expect(pendingThreadMessageJump("thread-a")).toBe("message-1");
      expect(pendingThreadMessageJump("thread-b")).toBeNull();
      vi.advanceTimersByTime(29_999);
      expect(pendingThreadMessageJump("thread-a")).toBe("message-1");
      vi.advanceTimersByTime(1);
      expect(pendingThreadMessageJump("thread-a")).toBeNull();
    } finally {
      finishThreadMessageJump("thread-a");
      vi.useRealTimers();
    }
  });
});
