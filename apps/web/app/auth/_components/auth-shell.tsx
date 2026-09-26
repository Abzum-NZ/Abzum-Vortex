import Link from "next/link";
import type { ReactNode } from "react";
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
    <main className="flex min-h-svh items-center justify-center p-6">
      <section aria-labelledby="auth-title" className="w-full max-w-lg">
        <Card>
          <CardHeader>
            <Link
              className="text-xs font-semibold tracking-widest uppercase"
              href="/"
              aria-label="Vortex home"
            >
              Vortex
            </Link>
            <p className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
              {eyebrow}
            </p>
            <CardTitle>
              <h1 id="auth-title" className="text-3xl font-semibold tracking-tight">
                {title}
              </h1>
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">{children}</CardContent>
          {footer ? <CardFooter>{footer}</CardFooter> : null}
        </Card>
      </section>
    </main>
  );
}
