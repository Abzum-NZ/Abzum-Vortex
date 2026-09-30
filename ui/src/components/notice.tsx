"use client";

import { safeHttpsUrlMaximumLength, safeHttpsUrlSchema } from "@vortex/contracts";
import { Fragment, useState, type ReactElement, type ReactNode } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./alert";

export type NoticeSeverity = "info" | "success" | "warning" | "critical";

/** A text value or link is represented as data; notice content is never interpreted as markup. */
export type NoticeContentPart =
  | Readonly<{ kind: "text"; value: string }>
  | Readonly<{ kind: "link"; label: string; href: string }>;

/** Plain text or ordered text and link parts for one notice message. */
export type NoticeContent = string | readonly NoticeContentPart[];

export interface NoticeProps {
  severity: NoticeSeverity;
  content: NoticeContent;
  title?: string;
  dismissible?: boolean;
}

const NOTICE_BASE_ORIGIN = "https://vortex.invalid";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

const SEVERITY_LABELS: Readonly<Record<NoticeSeverity, string>> = {
  info: "Information",
  success: "Success",
  warning: "Warning",
  critical: "Critical",
};

const SEVERITY_COLORS: Readonly<Record<NoticeSeverity, string>> = {
  info: "var(--vortex-info-text)",
  // The current theme vocabulary has no separate success text role.
  success: "var(--vortex-info-text)",
  warning: "var(--vortex-warning-text)",
  critical: "var(--vortex-danger-text)",
};

/** Accept only root-relative application paths or credential-free HTTPS addresses. */
function safeNoticeHref(href: string): string | undefined {
  if (
    href.length === 0 ||
    href.length > safeHttpsUrlMaximumLength ||
    CONTROL_CHARACTER.test(href) ||
    href.includes("\\")
  )
    return undefined;

  if (href.startsWith("/") && !href.startsWith("//")) {
    try {
      return new URL(href, NOTICE_BASE_ORIGIN).origin === NOTICE_BASE_ORIGIN ? href : undefined;
    } catch {
      return undefined;
    }
  }

  if (!/^https:\/\//i.test(href)) return undefined;
  const parsed = safeHttpsUrlSchema.safeParse(href);
  return parsed.success ? parsed.data : undefined;
}

function renderNoticeContent(content: NoticeContent): ReactNode {
  if (typeof content === "string") return content;

  return content.map((part, index) => {
    const key = `${part.kind}-${index}`;
    if (part.kind === "text") return <Fragment key={key}>{part.value}</Fragment>;
    if (part.label.trim().length === 0) return <Fragment key={key}>{part.label}</Fragment>;

    const href = safeNoticeHref(part.href);
    const external = href !== undefined && /^https:\/\//i.test(href);
    return href === undefined ? (
      <Fragment key={key}>{part.label}</Fragment>
    ) : (
      <a
        key={key}
        href={href}
        referrerPolicy={external ? "no-referrer" : undefined}
        className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {part.label}
        {external ? <span className="ml-1 text-xs">(external)</span> : null}
      </a>
    );
  });
}

/**
 * A themed, accessible notice with optional per-instance dismissal. It has no enter or exit
 * animation, so the state change remains immediate and understandable with reduced motion.
 */
export function Notice({
  severity,
  content,
  title,
  dismissible = false,
}: NoticeProps): ReactElement | null {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const critical = severity === "critical";
  const severityColor = SEVERITY_COLORS[severity];

  return (
    <div
      data-slot="notice"
      data-vortex-severity={severity}
    >
      <Alert
        role={critical ? "alert" : "status"}
        aria-live={critical ? "assertive" : "polite"}
        aria-atomic="true"
        variant={critical ? "destructive" : "default"}
        className="border-l-4"
        style={{ borderLeftColor: severityColor }}
      >
        <div className="min-w-0">
          <AlertTitle className="mb-1 font-bold" style={{ color: severityColor }}>
            {SEVERITY_LABELS[severity]}
            {title ? `: ${title}` : null}
          </AlertTitle>
          <AlertDescription style={{ color: "var(--vortex-text)" }}>
            <p className="m-0">{renderNoticeContent(content)}</p>
          </AlertDescription>
        </div>
        {dismissible ? (
          <AlertAction>
            <button
              type="button"
              aria-label="Dismiss notice"
              onClick={() => setDismissed(true)}
              style={{ color: "var(--vortex-text)" }}
              className="shrink-0 rounded px-2 py-1 text-sm underline underline-offset-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              Dismiss
            </button>
          </AlertAction>
        ) : null}
      </Alert>
    </div>
  );
}
