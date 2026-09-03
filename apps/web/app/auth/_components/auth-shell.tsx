import Link from "next/link";
import type { ReactNode } from "react";

type AuthShellProps = Readonly<{
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}>;

export function AuthShell({ eyebrow, title, description, children, footer }: AuthShellProps) {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <Link className="auth-wordmark" href="/" aria-label="Vortex home">
          Vortex
        </Link>
        <div className="auth-heading">
          <p className="auth-eyebrow">{eyebrow}</p>
          <h1 id="auth-title">{title}</h1>
          <p>{description}</p>
        </div>
        {children}
        {footer ? <div className="auth-footer">{footer}</div> : null}
      </section>
    </main>
  );
}
