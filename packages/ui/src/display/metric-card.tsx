import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Card, CardDescription, CardHeader, CardTitle } from "../components/card";

/**
 * One labelled value as a summary card: a word-wrapped label above a large value. The
 * card's own parts carry the theme's spacing and type, so a style variant restyles every metric.
 */
export function MetricCard({
  label,
  children,
  ...props
}: Readonly<{ label: string; children: ReactNode }> &
  Omit<ComponentProps<"div">, "children">): ReactElement {
  return (
    <Card size="sm" className="min-w-0" {...props}>
      <CardHeader className="min-w-0">
        <CardDescription className="whitespace-normal break-normal text-sm normal-case tracking-normal">
          {label}
        </CardDescription>
        <CardTitle className="min-w-0 text-(length:--text-2xl) tabular-nums [overflow-wrap:anywhere]">
          {children}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}
