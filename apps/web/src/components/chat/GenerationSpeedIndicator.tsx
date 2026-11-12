import type { GenerationSpeedPresentation } from "@t3tools/client-runtime/state/generation-speed";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function GenerationSpeedIndicator(props: {
  readonly presentation: GenerationSpeedPresentation;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-generation-speed="true"
            aria-label={props.presentation.details}
            tabIndex={0}
            className="inline-flex shrink-0 cursor-default items-center rounded px-1.5 py-0.5 text-2xs text-muted-foreground/70 tabular-nums"
          />
        }
      >
        {props.presentation.label}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.presentation.details}</TooltipPopup>
    </Tooltip>
  );
}
