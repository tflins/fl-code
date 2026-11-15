import { describe, expect, it } from "vite-plus/test";
import { NodeId, RunId } from "@t3tools/contracts";

import { scopeDelegatedTask, subagentThreadTitle } from "./subagentProjection.ts";

it("keeps nested completion wakes in their delegated task scope", () => {
  const taskId = NodeId.make("task:scoped");
  const first = RunId.make("run:scoped");
  const wake = RunId.make("run:wake");
  const nestedWake = RunId.make("run:nested-wake");
  const unrelated = RunId.make("run:unrelated");
  const projection = {
    thread: { forkedFrom: null },
    runs: [
      { id: first, delegatedTaskId: taskId },
      { id: wake },
      { id: nestedWake },
      { id: unrelated, delegatedTaskId: NodeId.make("task:unrelated") },
      { id: RunId.make("run:unrelated-wake") },
    ],
    messages: [
      { runId: nestedWake, delegatedCompletion: { parentRunId: wake, generation: 1, taskIds: [] } },
      { runId: wake, delegatedCompletion: { parentRunId: first, generation: 1, taskIds: [] } },
    ],
    subagents: [{ runId: first }, { runId: wake }, { runId: unrelated }],
  };

  const scoped = scopeDelegatedTask(projection, taskId);
  expect(scoped.runs.map((run) => run.id)).toEqual([first, wake, nestedWake]);
  expect(scoped.subagents.map((task) => task.runId)).toEqual([first, wake]);
});

it("excludes follow-up completion wakes from the original task scope", () => {
  const taskId = NodeId.make("task:original");
  const original = RunId.make("run:original");
  const followup = RunId.make("run:followup");
  const wake = RunId.make("run:followup-wake");
  const scoped = scopeDelegatedTask(
    {
      thread: { forkedFrom: { type: "node", nodeId: taskId } },
      runs: [
        { id: original },
        { id: followup, delegatedTaskId: NodeId.make("task:followup") },
        { id: wake },
      ],
      messages: [
        {
          runId: wake,
          delegatedCompletion: { parentRunId: followup, generation: 1, taskIds: [] },
        },
      ],
      subagents: [{ runId: original }, { runId: wake }],
    },
    taskId,
  );
  expect(scoped.runs.map((run) => run.id)).toEqual([original]);
  expect(scoped.subagents.map((task) => task.runId)).toEqual([original]);
});

describe("subagentThreadTitle", () => {
  it("clips a long prompt without splitting a surrogate pair", () => {
    const title = (prompt: string) =>
      subagentThreadTitle({ parentTitle: "Parent", prompt, ordinal: 1 });

    expect(title(`${"a".repeat(68)}😀 and more work.`)).toBe(`${"a".repeat(68)}...`);
    expect(title(`${"a".repeat(67)}😀 and more work.`)).toBe(`${"a".repeat(67)}😀...`);
  });
});
