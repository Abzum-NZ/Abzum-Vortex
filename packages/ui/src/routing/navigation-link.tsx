"use client";

import Link from "next/link";
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { PageNavigationBusyContext } from "../navigation/navigation";
import { destinationOf } from "./destination";
import { useNavigator } from "./navigator";
import { prefetchPage } from "./prefetch";

export type NavigationLinkProps = Omit<
  ComponentProps<typeof Link>,
  "href" | "replace" | "prefetch" | "onNavigate" | "as" | "legacyBehavior" | "passHref" | "shallow"
> &
  Readonly<{
    href: string;
    /** Replaces the current history entry instead of adding one. */
    replace?: boolean;
    /** Called when an in-place page change starts from this link (not for modified or external clicks). */
    onNavigate?: () => void;
    /** Called when that change did not start after all (the person chose to stay). */
    onCancelled?: () => void;
  }>;

/**
 * The one link for every destination. An internal path renders `next/link`: a plain click changes
 * the page in place through the navigator in force (the document never reloads), while modified,
 * middle and targeted clicks keep the browser's own behaviour. The page is prefetched once, when the
 * person points at, focuses or touches the link, never merely because it is on screen. A web, mail
 * or telephone address is the only plain anchor. An address that is neither is a platform defect
 * and fails loudly.
 */
export function NavigationLink({
  href,
  replace,
  onNavigate,
  onCancelled,
  ...anchor
}: NavigationLinkProps): ReactElement {
  const navigator = useNavigator();
  const router = useRouter();
  const prefetched = useRef(false);
  const dwell = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(dwell.current), []);
  // The change this link started (the address it started from), until the address has changed
  // once the host's page change is over, or the change was cancelled. Only this link shows it.
  const pathname = usePathname();
  const busy = useContext(PageNavigationBusyContext);
  const [pending, setPending] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (pending === undefined || busy) return;
    if (window.location.pathname + window.location.search !== pending) setPending(undefined);
  }, [busy, pathname, pending]);
  useEffect(() => {
    if (pending === undefined) return;
    const timer = window.setTimeout(() => setPending(undefined), 10_000);
    return () => window.clearTimeout(timer);
  }, [pending]);
  const destination = destinationOf(href);
  if (destination === undefined) {
    // An address no link may follow is shown as its label alone, and the cause is logged.
    console.error(`[navigation] refused address: ${JSON.stringify(href.slice(0, 200))}`);
    return <span className={anchor.className}>{anchor.children}</span>;
  }
  if (destination.kind === "fragment") return <a {...anchor} href={destination.address} />;
  // A server route (signing out, an API answer) is a document request the browser makes itself.
  if (destination.kind === "server_route") return <a {...anchor} href={destination.path} />;
  if (destination.kind === "external")
    return <a {...anchor} href={destination.address} rel={anchor.rel ?? "noopener noreferrer"} />;
  const path = destination.path;
  const intend = (): void => {
    if (prefetched.current) return;
    prefetched.current = true;
    prefetchPage(router, path);
  };
  return (
    <Link
      {...anchor}
      href={path}
      prefetch={false}
      {...(replace === undefined ? {} : { replace })}
      {...(pending === undefined ? {} : { "aria-busy": true, "data-vortex-link-pending": "" })}
      // A pointer that rests on the link for a moment shows intent; one sweeping across a list
      // of links prefetches nothing.
      onPointerEnter={(event) => {
        anchor.onPointerEnter?.(event);
        window.clearTimeout(dwell.current);
        dwell.current = window.setTimeout(intend, 80);
      }}
      onPointerLeave={(event) => {
        anchor.onPointerLeave?.(event);
        window.clearTimeout(dwell.current);
      }}
      onFocus={(event) => {
        anchor.onFocus?.(event);
        intend();
      }}
      onTouchStart={(event) => {
        anchor.onTouchStart?.(event);
        intend();
      }}
      onNavigate={(event) => {
        onNavigate?.();
        const here = window.location.pathname + window.location.search;
        // A link to the address shown now changes nothing worth showing as pending.
        if (path !== here) setPending(here);
        // The navigator in force carries out the change (unsaved-work question, page-change state).
        event.preventDefault();
        navigator.navigate(path, {
          ...(replace === undefined ? {} : { replace }),
          onCancelled: () => {
            setPending(undefined);
            onCancelled?.();
          },
        });
      }}
    />
  );
}
