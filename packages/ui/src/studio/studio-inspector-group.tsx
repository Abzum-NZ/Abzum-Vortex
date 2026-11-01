"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { Icon } from "../icons/icon";
import { StudioHelp } from "./studio-field";

/**
 * Inspector disclosures remember the builder's preference. The header can carry an info icon
 * (`hint`), a short `summary` shown while the section is closed, and one `action` icon button.
 */
export function StudioInspectorGroup({
  title,
  children,
  defaultOpen = true,
  hint,
  summary,
  action,
}: Readonly<{
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Instruction text for the whole section, shown in an info tooltip. */
  hint?: string;
  /** A short muted text after the title while the section is closed. */
  summary?: ReactNode;
  /** One icon button at the right of the header. */
  action?: ReactNode;
}>) {
  const [open, setOpen] = useState(defaultOpen);
  const key = "vortex:studio:inspector:v2:" + title;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      setOpen(saved === null ? defaultOpen : saved === "true");
    } catch {
      /* Storage may be disabled. */
    }
  }, [key, defaultOpen]);
  const toggle = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(key, String(next));
    } catch {
      /* Storage may be disabled. */
    }
  };
  return (
    <Collapsible open={open} onOpenChange={toggle} className="border-t first:border-t-0">
      <div className="flex min-h-9 items-center gap-1">
        <CollapsibleTrigger className="flex min-w-0 shrink-0 items-center gap-2 text-left text-sm font-medium">
          <Icon name="chevron-down" className={open ? "size-4" : "size-4 -rotate-90"} />
          {title}
        </CollapsibleTrigger>
        {hint !== undefined && <StudioHelp hint={hint} />}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          className="min-w-0 flex-1 self-stretch truncate px-1 text-left text-xs text-muted-foreground"
          onClick={() => toggle(!open)}
        >
          {open ? null : summary}
        </button>
        {action}
      </div>
      <CollapsibleContent keepMounted>
        <div className="space-y-4 pb-3 pt-1">{children}</div>
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
