/** Context attached to every code Q&A question; evals import it so they test this text. */
export const CODE_QA_CONTEXT_INSTRUCTIONS = [
  "Answer about the captured diff excerpt.",
  "If the repository history or the parent thread does not record why a change was made, label that reason as an inference.",
  "Explain only; do not modify files or run side-effecting commands.",
].join(" ");
