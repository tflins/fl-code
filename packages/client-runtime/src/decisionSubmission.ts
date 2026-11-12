import { CommandId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const DecisionDraft = Schema.Struct({
  commandId: CommandId,
  answer: Schema.String,
  cancelCommandId: Schema.optional(CommandId),
  reopenCommandId: Schema.optional(CommandId),
});
export type DecisionDraft = typeof DecisionDraft.Type;
export type DecisionAction = "confirm" | "cancel" | "reopen";

const commandKeys = {
  confirm: "commandId",
  cancel: "cancelCommandId",
  reopen: "reopenCommandId",
} as const;

export function prepareDecisionSubmission(input: {
  readonly draft: DecisionDraft | null | undefined;
  readonly action: DecisionAction;
  readonly answer?: string | undefined;
  readonly newCommandId: CommandId;
}) {
  const previous = input.draft ?? { commandId: input.newCommandId, answer: "" };
  const draft =
    input.answer === undefined || input.answer === previous.answer
      ? previous
      : { ...previous, commandId: input.newCommandId, answer: input.answer };
  const key = commandKeys[input.action];
  const commandId = draft[key] ?? input.newCommandId;
  return { commandId, draft: { ...draft, [key]: commandId } };
}

export function replaceRejectedDecisionAttempt(input: {
  readonly draft: DecisionDraft;
  readonly action: DecisionAction;
  readonly commandId: CommandId;
}): DecisionDraft {
  return { ...input.draft, [commandKeys[input.action]]: input.commandId };
}
