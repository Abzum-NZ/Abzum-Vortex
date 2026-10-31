import type { PipelineStageTone } from "@vortex/platform/schema";
import { cn } from "../lib/utils";

/**
 * A choice option's colour role from the definition, rendered only through the theme's tokens.
 * Lists and details show it as a badge tint; the board and the choice input show it as a dot.
 */
export const optionToneBadgeClass = (tone: PipelineStageTone | undefined): string => {
  switch (tone) {
    case "primary":
      return "border-primary/40 bg-primary/10 text-primary";
    case "destructive":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    case "chart_1":
      return "border-chart-1/40 bg-chart-1/15 text-chart-1";
    case "chart_2":
      return "border-chart-2/40 bg-chart-2/15 text-chart-2";
    case "chart_3":
      return "border-chart-3/40 bg-chart-3/15 text-chart-3";
    case "chart_4":
      return "border-chart-4/40 bg-chart-4/15 text-chart-4";
    case "chart_5":
      return "border-chart-5/40 bg-chart-5/15 text-chart-5";
    case "neutral":
    case undefined:
      return "";
  }
};

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

/** One small dot in an option's colour, or nothing for the neutral role. */
export function OptionToneDot({
  tone,
  className,
}: Readonly<{ tone: PipelineStageTone | undefined; className?: string }>) {
  if (tone === undefined || tone === "neutral") return null;
  return (
    <span
      aria-hidden="true"
      data-vortex-option-tone={tone}
      className={cn("inline-block size-2 shrink-0 rounded-full", optionToneFillClass[tone], className)}
    />
  );
}
