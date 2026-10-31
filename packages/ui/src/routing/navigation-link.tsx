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
  ...anchor
}: NavigationLinkProps): ReactElement {
  const navigator = useNavigator();
  const router = useRouter();
  const prefetched = useRef(false);
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
  if (destination === undefined) throw new Error(`Refused navigation address: ${href}`);
  if (destination.kind === "fragment") return <a {...anchor} href={destination.address} />;
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
      onPointerEnter={(event) => {
        anchor.onPointerEnter?.(event);
        intend();
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
        setPending(window.location.pathname + window.location.search);
        // The navigator in force carries out the change (unsaved-work question, page-change state).
        event.preventDefault();
        navigator.navigate(path, {
          ...(replace === undefined ? {} : { replace }),
          onCancelled: () => setPending(undefined),
        });
      }}
    />
  );
}
