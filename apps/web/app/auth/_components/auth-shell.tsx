import Link from "next/link";
import type { ReactNode } from "react";
import { organizationChooserShell } from "@vortex/platform/server";
import { Badge } from "@vortex/ui/components/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@vortex/ui/components/card";

type AuthShellProps = Readonly<{
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}>;

export function AuthShell({ eyebrow, title, description, children, footer }: AuthShellProps) {
  return (
    <main className="flex min-h-svh items-center justify-center p-4 sm:p-6 md:p-8">
      <section aria-labelledby="auth-title" className="w-full max-w-md sm:max-w-lg">
        <Card className="border-border bg-card text-card-foreground shadow-sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <Link
                className="text-xs font-bold tracking-widest text-primary uppercase transition-colors hover:text-primary/80"
                href="/"
                aria-label={`${organizationChooserShell.name} home`}
              >
                {organizationChooserShell.name}
              </Link>
              {eyebrow ? (
                <Badge variant="secondary" className="text-[11px] font-medium tracking-wide uppercase">
                  {eyebrow}
                </Badge>
              ) : null}
            </div>
            <CardTitle>
              <h1 id="auth-title" className="font-heading text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                {title}
              </h1>
            </CardTitle>
            <CardDescription className="text-sm text-muted-foreground">{description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">{children}</CardContent>
          {footer ? <CardFooter className="flex flex-col items-stretch">{footer}</CardFooter> : null}
        </Card>
      </section>
    </main>
  );
}
