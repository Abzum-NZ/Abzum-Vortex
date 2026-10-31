"use client";

import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from "react";
import { useRouter } from "next/navigation";

export type NavigateOptions = Readonly<{ replace?: boolean }>;

/**
 * The one way the product changes page in place: every internal destination (a link, a menu item,
 * a flow's Navigate step, a toast or notice action) goes through it, so the document never reloads.
 * A host (the application frame) supplies its own navigator to guard unsaved work and to show its
 * page-change state; without one the client router navigates directly.
 */
export type Navigator = Readonly<{
  navigate: (path: string, options?: NavigateOptions) => void;
}>;

const NavigatorContext = createContext<Navigator | undefined>(undefined);

/** Supplies the navigator every link and navigation below uses. */
export function NavigatorProvider({
  navigator,
  children,
}: Readonly<{ navigator: Navigator; children: ReactNode }>): ReactElement {
  return <NavigatorContext.Provider value={navigator}>{children}</NavigatorContext.Provider>;
}

/** The host's navigator, when a host supplies one. */
export const useHostNavigator = (): Navigator | undefined => useContext(NavigatorContext);

/** The navigator in force: the host's, else the client router's. */
export function useNavigator(): Navigator {
  const host = useContext(NavigatorContext);
  const router = useRouter();
  return useMemo<Navigator>(
    () =>
      host ?? {
        navigate: (path, options) => (options?.replace ? router.replace(path) : router.push(path)),
      },
    [host, router],
  );
}
