"use client";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { FieldGroup } from "../components/field";
import { Icon } from "../icons/icon";
import { StudioHelp } from "./studio-field";

/**
 * Inspector disclosures remember the builder's preference. The header can carry an info icon
 * (`hint`), a short `summary` shown while the section is closed, and one `action` icon button.
 * A section that repeats (a row's "Used in") passes `persist={false}`: it always starts closed.
 */
export function StudioInspectorGroup({
  title,
  children,
  defaultOpen = true,
  persist = true,
  hint,
  summary,
  action,
}: Readonly<{
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  persist?: boolean;
  /** Instruction text for the whole section, shown in an info tooltip. */
  hint?: string;
  /** A short muted text after the title while the section is closed. */
  summary?: ReactNode;
  /** One icon button at the right of the header. */
  action?: ReactNode;
}>) {
  const [open, setOpen] = useState(defaultOpen);
  const summaryId = useId();
  const key = "vortex:studio:inspector:v2:" + title;
  useEffect(() => {
    if (!persist) return;
    try {
      const saved = localStorage.getItem(key);
      setOpen(saved === null ? defaultOpen : saved === "true");
    } catch {
      /* Storage may be disabled. */
    }
  }, [key, defaultOpen, persist]);
  const toggle = (next: boolean) => {
    setOpen(next);
    if (!persist) return;
    try {
      localStorage.setItem(key, String(next));
    } catch {
      /* Storage may be disabled. */
    }
  };
  const showSummary = !open && summary !== undefined;
  return (
    <Collapsible open={open} onOpenChange={toggle} className="border-t first:border-t-0">
      <div className="flex min-h-9 items-center gap-1">
        <CollapsibleTrigger
          className="flex min-w-0 shrink-0 items-center gap-2 text-left text-sm font-medium"
          {...(showSummary ? { "aria-describedby": summaryId } : {})}
        >
          <Icon name="chevron-down" className={open ? "size-4" : "size-4 -rotate-90"} />
          {title}
        </CollapsibleTrigger>
        {hint !== undefined && <StudioHelp hint={hint} />}
        {/* A larger click target for the mouse; the trigger carries the same text for assistive technology. */}
        <span
          id={summaryId}
          title={typeof summary === "string" ? summary : undefined}
          className="min-w-0 flex-1 self-stretch truncate px-1 text-xs leading-9 text-muted-foreground"
          onClick={() => toggle(!open)}
        >
          {showSummary ? summary : null}
        </span>
        {action}
      </div>
      <CollapsibleContent keepMounted>
        <FieldGroup className="pb-3 pt-1">{children}</FieldGroup>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Raw Studio source uses the same quiet disclosure as the inspector's other details. */
export function StudioSourceView({
  value,
  title = "View source",
}: Readonly<{ value: unknown; title?: string }>) {
  return (
    <StudioInspectorGroup title={title} defaultOpen={false}>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
        {JSON.stringify(value, null, 2)}
      </pre>
    </StudioInspectorGroup>
  );
}
