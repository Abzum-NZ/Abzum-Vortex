import type { PipelineStageTone } from "@vortex/platform/schema";
import { cn } from "../lib/utils";

/**
 * A choice option's colour role from the definition, rendered only through the theme's tokens.
 * Lists and details show it as a dot before the option's word; the board and the choice input
 * show it as a bar.
 */
/** Each option colour role as its one theme token, for a bar, a strip or a dot. */
export const optionToneFillClass: Readonly<Record<PipelineStageTone, string>> = Object.freeze({
  neutral: "bg-muted-foreground",
  primary: "bg-primary",
  destructive: "bg-destructive",
  chart_1: "bg-chart-1",
  chart_2: "bg-chart-2",
  chart_3: "bg-chart-3",
  chart_4: "bg-chart-4",
  chart_5: "bg-chart-5",
});

/** One small mark in an option's colour, or nothing for the neutral role. */
export function OptionToneMark({
  tone,
  className,
}: Readonly<{ tone: PipelineStageTone | undefined; className?: string }>) {
  if (tone === undefined || tone === "neutral") return null;
  return (
    <span
      aria-hidden="true"
      data-vortex-option-tone={tone}
      className={cn("inline-block h-3.5 w-1 shrink-0", optionToneFillClass[tone], className)}
    />
  );
}

/** The dot a list or detail puts before a choice option's word; the neutral role is a muted dot. */
export function OptionToneDot({ tone }: Readonly<{ tone: PipelineStageTone | undefined }>) {
  return (
    <span
      aria-hidden="true"
      data-vortex-option-tone={tone ?? "neutral"}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        optionToneFillClass[tone ?? "neutral"],
      )}
    />
  );
}
