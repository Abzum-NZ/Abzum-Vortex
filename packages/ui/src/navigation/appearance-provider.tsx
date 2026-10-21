"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { APPEARANCE_COOKIE, createAppearanceRootProps, type ThemeMode } from "../theme/appearance";

type AppearanceState = Readonly<{ mode: ThemeMode; choose: (mode: ThemeMode) => void }>;
const AppearanceContext = createContext<AppearanceState | null>(null);

export const useAppearance = (): AppearanceState | null => useContext(AppearanceContext);

/** The viewer's choice; system-mode support uses the same browser media query. */
export function useAppearanceMode(): ThemeMode {
  const appearance = useAppearance();
  if (appearance === null) throw new Error("Appearance requires an AppearanceProvider.");
  return appearance.mode;
}

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Shares the server-rendered appearance without loading the menu that edits it. */
export function AppearanceProvider({
  initial,
  children,
}: Readonly<{ initial: ThemeMode; children: ReactNode }>): ReactElement {
  const [mode, setMode] = useState<ThemeMode>(initial);
  const choose = useCallback((next: ThemeMode) => {
    const root = document.documentElement;
    const props = createAppearanceRootProps(next);
    root.style.colorScheme = String(props.style.colorScheme);
    root.setAttribute("data-vortex-theme-mode", props["data-vortex-theme-mode"]);
    document.cookie = `${APPEARANCE_COOKIE}=${next}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
    setMode(next);
  }, []);
  const value = useMemo(() => ({ mode, choose }), [mode, choose]);
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}
