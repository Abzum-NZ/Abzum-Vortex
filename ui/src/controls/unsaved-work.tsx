"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import type { UnsavedWorkGuard } from "../launcher/link-navigation";

type RegisteredForm = Readonly<{
  dirty: boolean;
  resetBaseline: () => void;
  registration: object;
}>;

type UnsavedWorkRegistry = Readonly<{
  registerForm: (formId: string, resetBaseline: () => void) => () => void;
  setDirty: (formId: string, dirty: boolean) => void;
  clearAll: () => void;
  hasUnsavedWork: () => boolean;
  subscribe: (listener: () => void) => () => void;
}>;

const UnsavedWorkContext = createContext<UnsavedWorkRegistry | undefined>(undefined);

function createUnsavedWorkRegistry(): UnsavedWorkRegistry {
  const forms = new Map<string, RegisteredForm>();
  const listeners = new Set<() => void>();
  const hasUnsavedWork = (): boolean => [...forms.values()].some((form) => form.dirty);
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    registerForm: (formId, resetBaseline) => {
      const previous = forms.get(formId);
      const registration = {};
      const form = { dirty: previous?.dirty ?? false, resetBaseline, registration };
      forms.set(formId, form);
      return () => {
        if (forms.get(formId)?.registration !== registration) return;
        const wasDirty = hasUnsavedWork();
        forms.delete(formId);
        if (wasDirty !== hasUnsavedWork()) notify();
      };
    },
    setDirty: (formId, dirty) => {
      const form = forms.get(formId);
      if (form === undefined || form.dirty === dirty) return;
      const wasDirty = hasUnsavedWork();
      forms.set(formId, { ...form, dirty });
      if (wasDirty !== hasUnsavedWork()) notify();
    },
    clearAll: () => {
      const wasDirty = hasUnsavedWork();
      for (const [formId, form] of forms) {
        form.resetBaseline();
        forms.set(formId, { ...form, dirty: false });
      }
      if (wasDirty) notify();
    },
    hasUnsavedWork,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Provides one unsaved-form registry for the current application page. */
export function UnsavedWorkProvider({ children }: Readonly<{ children: ReactNode }>): ReactElement {
  const [registry] = useState(createUnsavedWorkRegistry);
  return <UnsavedWorkContext.Provider value={registry}>{children}</UnsavedWorkContext.Provider>;
}

/** The page registry used by forms to report draft changes, when one is provided. */
export function useUnsavedWorkRegistry(): UnsavedWorkRegistry | undefined {
  return useContext(UnsavedWorkContext);
}

/** The current dirty state and navigation guard backed by the nearest page registry. */
export function useUnsavedWorkGuard(
  confirmDiscardUnsavedWork: UnsavedWorkGuard["confirmDiscardUnsavedWork"],
): Readonly<{ hasUnsavedWork: boolean; guard: UnsavedWorkGuard }> {
  const registry = useUnsavedWorkRegistry();
  if (registry === undefined)
    throw new Error("An unsaved-work guard requires an UnsavedWorkProvider");
  const hasUnsavedWork = useSyncExternalStore(
    registry.subscribe,
    registry.hasUnsavedWork,
    () => false,
  );
  const guard = useMemo<UnsavedWorkGuard>(
    () => ({
      hasUnsavedWork: registry.hasUnsavedWork,
      confirmDiscardUnsavedWork,
    }),
    [confirmDiscardUnsavedWork, registry],
  );
  return { hasUnsavedWork, guard };
}
