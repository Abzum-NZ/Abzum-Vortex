import type { ReactElement } from "react";
import { NavigationLink } from "@vortex/ui/routing";
import { buttonVariants } from "@vortex/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@vortex/ui/components/empty";
import { TryAgainButton } from "./try-again-button";

/** The one way forward a state offers: draw it again, or go back to where the person can work. */
export type UnavailableWay =
  | Readonly<{ kind: "retry"; reset?: () => void }>
  | Readonly<{ kind: "back"; label: string; href: string }>;

/**
 * The one state for a page that could not be shown: one heading, the product sentence for its
 * cause, and one way forward. It never shows an error's own message or an internal code.
 */
export function UnavailableState({
  title,
  sentence,
  reference,
  way,
  region = "page",
  addressState,
}: Readonly<{
  title: string;
  sentence: string;
  /** The digest Next.js gave the original failure; the server log line carries the same one. */
  reference?: string | undefined;
  way: UnavailableWay;
  /** A page stands alone; content sits inside a landmark the surrounding frame already has. */
  region?: "page" | "content";
  /** Marks the address state this stands for when it replaces an application address. */
  addressState?: string;
}>): ReactElement {
  const Region = region === "page" ? "main" : "section";
  return (
    <Region
      data-vortex-address-state={addressState}
      className={
        region === "page"
          ? "mx-auto flex min-h-svh w-full max-w-xl flex-col justify-center p-6"
          : "flex w-full max-w-xl flex-col"
      }
    >
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <h1 className="text-xl leading-snug font-medium">{title}</h1>
          </EmptyTitle>
          <EmptyDescription className="text-foreground">
            {sentence}
            {reference === undefined ? null : (
              <span className="mt-2 block text-xs">Reference: {reference}</span>
            )}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {way.kind === "retry" ? (
            <TryAgainButton {...(way.reset === undefined ? {} : { reset: way.reset })} />
          ) : (
            <NavigationLink href={way.href} className={buttonVariants({ variant: "outline" })}>
              {way.label}
            </NavigationLink>
          )}
        </EmptyContent>
      </Empty>
    </Region>
  );
}
