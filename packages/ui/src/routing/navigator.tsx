"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { forgetPagesWrittenSince } from "./prefetch";

export type NavigateOptions = Readonly<{
  replace?: boolean;
  /**
   * The change only replaces the shown page's own query (a calendar period, a search expression):
   * nothing the person entered is discarded, so the unsaved-work question is not asked.
   */
  withinPage?: boolean;
  /** The change did not start (the person chose to stay with unsaved work). */
  onCancelled?: () => void;
}>;

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

/**
 * The host navigator mounted now. Parts drawn outside the host's tree (the notifications region of
 * the document, where a toast's link action renders) still change page through it, so they ask
 * about unsaved work as every link inside the frame does.
 */
let mountedHost: Navigator | undefined;

/** Supplies the navigator every link and navigation below uses. */
export function NavigatorProvider({
  navigator,
  children,
}: Readonly<{ navigator: Navigator; children: ReactNode }>): ReactElement {
  useEffect(() => {
    mountedHost = navigator;
    return () => {
      if (mountedHost === navigator) mountedHost = undefined;
    };
  }, [navigator]);
  return <NavigatorContext.Provider value={navigator}>{children}</NavigatorContext.Provider>;
}

/** The navigator in force: the host's, else the mounted host's, else the client router's. */
export function useNavigator(): Navigator {
  const host = useContext(NavigatorContext);
  const router = useRouter();
  return useMemo<Navigator>(
    () =>
      host ?? {
        navigate: (path, options) => {
          if (mountedHost !== undefined) {
            mountedHost.navigate(path, options);
            return;
          }
          forgetPagesWrittenSince(router);
          if (options?.replace === true) router.replace(path);
          else router.push(path);
        },
      },
    [host, router],
  );
}
