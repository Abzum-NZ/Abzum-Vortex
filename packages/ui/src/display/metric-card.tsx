import type { ComponentProps, ReactElement, ReactNode } from "react";
import { Card, CardDescription, CardHeader, CardTitle } from "../components/card";

/**
 * One labelled value as a summary card: a small uppercase muted label above a large value. The
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
      <CardHeader>
        <CardDescription className="uppercase tracking-wide">{label}</CardDescription>
        <CardTitle className="break-words text-(length:--text-2xl) tabular-nums">
          {children}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}
