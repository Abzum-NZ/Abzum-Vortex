"use client";

import Link from "next/link";
import type { ComponentProps, ReactElement } from "react";
import { destinationOf } from "./destination";
import { useHostNavigator } from "./navigator";

export type NavigationLinkProps = Omit<
  ComponentProps<typeof Link>,
  "href" | "replace" | "prefetch" | "onNavigate" | "as" | "legacyBehavior" | "passHref" | "shallow"
> &
  Readonly<{
    href: string;
    /** Replaces the current history entry instead of adding one. */
    replace?: boolean;
    /** Prefetches the destination ahead of the click; only for pages that are not composed per viewer. */
    prefetch?: boolean;
    /** Called when an in-place page change starts from this link (not for modified or external clicks). */
    onNavigate?: () => void;
  }>;

/**
 * The one link for every destination. An internal path renders `next/link`: a plain click changes
 * the page in place through the navigator in force (the document never reloads), while modified,
 * middle and targeted clicks keep the browser's own behaviour. A web, mail or telephone address is
 * the only plain anchor. An address that is neither is a platform defect and fails loudly.
 */
export function NavigationLink({
  href,
  replace,
  prefetch = false,
  onNavigate,
  ...anchor
}: NavigationLinkProps): ReactElement {
  const host = useHostNavigator();
  const destination = destinationOf(href);
  if (destination === undefined) throw new Error(`Refused navigation address: ${href}`);
  if (destination.kind === "external")
    return <a {...anchor} href={destination.address} rel={anchor.rel ?? "noopener noreferrer"} />;
  return (
    <Link
      {...anchor}
      href={destination.path}
      prefetch={prefetch}
      {...(replace === undefined ? {} : { replace })}
      onNavigate={(event) => {
        onNavigate?.();
        if (host === undefined) return;
        // The host carries out the change (unsaved-work question, page-change state).
        event.preventDefault();
        host.navigate(destination.path, replace === undefined ? undefined : { replace });
      }}
    />
  );
}
