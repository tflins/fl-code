import { describe, expect, it } from "@effect/vitest";
import { CommandId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  DecisionDraft,
  prepareDecisionSubmission,
  replaceRejectedDecisionAttempt,
} from "./decisionSubmission.ts";

const decodeDraft = Schema.decodeSync(Schema.fromJsonString(DecisionDraft));

describe("decision submissions", () => {
  it.each(["confirm", "cancel", "reopen"] as const)(
    "keeps an uncertain %s attempt across persistence and renews a rejected attempt",
    (action) => {
      const first = prepareDecisionSubmission({
        action,
        draft: null,
        answer: "Keep for 30 days.",
        newCommandId: CommandId.make("attempt:first"),
      });
      const persisted = decodeDraft(JSON.stringify(first.draft));
      const uncertainRetry = prepareDecisionSubmission({
        action,
        draft: persisted,
        answer: first.draft.answer,
        newCommandId: CommandId.make("attempt:unused"),
      });
      expect(uncertainRetry.commandId).toEqual(first.commandId);
      const rejected = replaceRejectedDecisionAttempt({
        action,
        draft: persisted,
        commandId: CommandId.make("attempt:retry"),
      });
      const recovered = prepareDecisionSubmission({
        action,
        draft: rejected,
        newCommandId: CommandId.make("attempt:also-unused"),
      });
      expect(recovered.commandId).toEqual("attempt:retry");
      expect(recovered.draft.answer).toEqual(first.draft.answer);
    },
  );

  it("gives a changed answer a new confirmation identity", () => {
    const submission = prepareDecisionSubmission({
      action: "confirm",
      draft: { commandId: CommandId.make("answer:old"), answer: "Keep." },
      answer: "Delete.",
      newCommandId: CommandId.make("answer:new"),
    });
    expect(submission.commandId).toEqual("answer:new");
    expect(submission.draft.answer).toEqual("Delete.");
  });
});
