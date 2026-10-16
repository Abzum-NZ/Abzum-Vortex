"use client";
import { useMemo, useRef, useState } from "react";

/** Everything in the workspace that holds unapplied input or an in-flight request and so blocks other changes. */
export type StudioBusyKey =
  | "search" | "sourceImport" | "labels" | "appearance" | "composition" | "condition"
  | "flowEditor" | "flowSetting" | "flowAppend" | "publication" | "reopening";

/** `flowText` names the Flow text editor and an unapplied canvas task setting together. */
export type StudioBusyExcept = StudioBusyKey | "flowText";

const expand = (except: readonly StudioBusyExcept[]): ReadonlySet<StudioBusyKey> => new Set(
  except.flatMap((key): StudioBusyKey[] => key === "flowText" ? ["flowEditor", "flowSetting"] : [key]));

const anyIn = (set: ReadonlySet<StudioBusyKey>, except: readonly StudioBusyExcept[]): boolean => {
  const skipped = expand(except);
  for (const key of set) if (!skipped.has(key)) return true;
  return false;
};

/** The live methods read a ref, so request handlers see a flag the moment it is set. The `Rendered` ones follow the last render. */
export type StudioBusy = Readonly<{
  /** True when any key except the listed ones is busy. */
  any: (...except: StudioBusyExcept[]) => boolean;
  is: (key: StudioBusyKey) => boolean;
  /** True when any of the listed keys is busy. */
  anyOf: (...keys: StudioBusyKey[]) => boolean;
  /** For `disabled` props during render only. */
  anyRendered: (...except: StudioBusyExcept[]) => boolean;
  isRendered: (key: StudioBusyKey) => boolean;
  anyOfRendered: (...keys: StudioBusyKey[]) => boolean;
  /**
   * Marks a key busy or idle. Returns whether it changed. A change bumps the preview generation, unless
   * `bump` is false (a request that settles keeps the snapshot it was prepared against).
   */
  report: (key: StudioBusyKey, pending: boolean, bump?: boolean) => boolean;
  /** Marks a derived key busy before its next render computes it (the first keystroke of an edit). */
  touch: (key: StudioBusyKey) => void;
  /** Clears several keys (a selection change or reopen discards their input). */
  clear: (...keys: StudioBusyKey[]) => void;
}>;

/**
 * One owner for the workspace's pending flags. `derived` flags (here the inspector text, computed from
 * the form) follow render output instead of being reported. `onTransition` runs on every change, to
 * invalidate previews of the saved draft. The returned object never changes identity, so it is safe to
 * hand to children and to list in effect dependencies.
 */
export function useStudioBusy(
  derived: Readonly<Partial<Record<StudioBusyKey, boolean>>>,
  onTransition: () => void,
): StudioBusy {
  const live = useRef(new Set<StudioBusyKey>());
  const [rendered, setRendered] = useState<ReadonlySet<StudioBusyKey>>(() => new Set());
  const transition = useRef(onTransition);
  transition.current = onTransition;
  // Derived flags are written during render, exactly as the refs they replace were.
  const derivedKeys = (Object.entries(derived) as [StudioBusyKey, boolean | undefined][]);
  for (const [key, on] of derivedKeys) {
    if (on === true) live.current.add(key); else live.current.delete(key);
  }
  const derivedNames = useRef<ReadonlySet<StudioBusyKey>>(new Set());
  derivedNames.current = new Set(derivedKeys.map(([key]) => key));
  const view = useRef<ReadonlySet<StudioBusyKey>>(rendered);
  view.current = new Set([...rendered, ...derivedKeys.flatMap(([key, on]) => on === true ? [key] : [])]);
  return useMemo<StudioBusy>(() => {
    const report = (key: StudioBusyKey, pending: boolean, bump = true): boolean => {
      if (live.current.has(key) === pending) return false;
      if (pending) live.current.add(key); else live.current.delete(key);
      if (bump) transition.current();
      setRendered(new Set([...live.current].filter((busyKey) => !derivedNames.current.has(busyKey))));
      return true;
    };
    return {
      any: (...except) => anyIn(live.current, except),
      is: (key) => live.current.has(key),
      anyOf: (...keys) => keys.some((key) => live.current.has(key)),
      anyRendered: (...except) => anyIn(view.current, except),
      isRendered: (key) => view.current.has(key),
      anyOfRendered: (...keys) => keys.some((key) => view.current.has(key)),
      report,
      touch: (key) => { live.current.add(key); transition.current(); },
      clear: (...keys) => { for (const key of keys) report(key, false); },
    };
  }, []);
}
