"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { Icon } from "../icons/icon";

/** Inspector disclosures remember the builder's preference. */
export function StudioInspectorGroup({
  title,
  children,
  defaultOpen = true,
}: Readonly<{
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}>) {
  const [open, setOpen] = useState(defaultOpen);
  const key = "vortex:studio:inspector:" + title;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      setOpen(saved === null ? defaultOpen : saved === "true");
    } catch {
      /* Storage may be disabled. */
    }
  }, [key, defaultOpen]);
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        try {
          localStorage.setItem(key, String(next));
        } catch {
          /* Storage may be disabled. */
        }
      }}
    >
      <CollapsibleTrigger className="flex min-h-8 w-full items-center justify-between gap-2 text-left text-sm font-medium">
        {title}
        <Icon name="chevron-down" className={open ? "size-4" : "size-4 -rotate-90"} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-4 pt-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
