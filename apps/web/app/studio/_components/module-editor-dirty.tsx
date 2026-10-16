"use client";
import { createContext, useContext, useEffect, useId, useMemo, useRef, type ReactNode } from "react";

/**
 * Module editors keep their unsaved input inside themselves. Each reports whether it holds some, so the
 * Data tab can ask before it replaces the editor (another module or tool) or the page is left.
 */
type Report = (reporter: string, dirty: boolean) => void;
const ModuleEditorDirtyContext = createContext<Report | null>(null);

/** Called by every module editor with its own unsaved-input flag. */
export function useReportModuleEditorDirty(dirty: boolean): void {
  const report = useContext(ModuleEditorDirtyContext);
  const reporter = useId();
  useEffect(() => {
    if (report === null) throw new Error("STUDIO_MODULE_EDITOR_OUTSIDE_DATA_TAB");
    report(reporter, dirty);
    return () => report(reporter, false);
  }, [report, reporter, dirty]);
}

/** Collects the flags of the editors it contains and tells `onChange` whether any of them is dirty. */
export function ModuleEditorDirtyProvider({ onChange, children }: Readonly<{
  onChange: (dirty: boolean) => void;
  children: ReactNode;
}>) {
  const dirty = useRef(new Set<string>());
  const notify = useRef(onChange);
  notify.current = onChange;
  const report = useMemo<Report>(() => (reporter, isDirty) => {
    if (isDirty) dirty.current.add(reporter); else dirty.current.delete(reporter);
    notify.current(dirty.current.size > 0);
  }, []);
  return <ModuleEditorDirtyContext value={report}>{children}</ModuleEditorDirtyContext>;
}
