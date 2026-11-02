"use client";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  applicationUses,
  describeApplicationUsers,
  type ApplicationPlaceOpen,
  type ApplicationSourceDocument,
  type ApplicationUsePlace,
  type ApplicationUseTarget,
} from "@vortex/platform/schema";
import { StudioInspectorGroup } from "@vortex/ui/studio";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";
import { Fragment } from "react";

/**
 * Where a part of the draft is used, from the draft's one reference index (`applicationUses`): the
 * "Used in" section of an inspector and the "Show me where" list of a refused removal. Each place
 * opens its item in its own tab, selected, through the workspace's one selection store; the
 * workspace provides how (`StudioPlaceOpener`).
 */

export type StudioPlaceOpener = Readonly<{
  /** Opens a place's item in its tab with it selected. Places Studio cannot open are not passed. */
  open: (open: ApplicationPlaceOpen) => void;
  /** The outline's name of a block or flow step, when the outline knows it. */
  nameOf: (open: ApplicationPlaceOpen) => string | undefined;
}>;

const OpenerContext = createContext<StudioPlaceOpener | null>(null);

export function StudioPlaceOpenerProvider({
  opener,
  children,
}: Readonly<{ opener: StudioPlaceOpener; children: ReactNode }>) {
  return <OpenerContext.Provider value={opener}>{children}</OpenerContext.Provider>;
}

/** The workspace's place opener, for a control that opens an item's place itself (a rule's flow). */
export const useStudioPlaceOpener = (): StudioPlaceOpener => {
  const opener = useContext(OpenerContext);
  if (opener === null) throw new Error("Studio places are shown inside the Studio workspace only.");
  return opener;
};

/** A place's path as a person reads it: blocks and steps carry the names Studio's outline shows. */
const trailOf = (place: ApplicationUsePlace, opener: StudioPlaceOpener): readonly string[] =>
  place.trail.map((segment, at) => {
    const named = place.named?.find((entry) => entry.at === at);
    return (named === undefined ? undefined : opener.nameOf(named.open)) ?? segment;
  });

/**
 * The places as breadcrumb rows ("Sales CRM › Menu › Home"). The last segment opens the place's
 * item when Studio can open it; the earlier segments are plain text. `onBeforeOpen` closes a
 * dialog first.
 */
export function StudioPlaceList({
  places,
  label,
  onBeforeOpen,
}: Readonly<{
  places: readonly ApplicationUsePlace[];
  label: string;
  onBeforeOpen?: (() => void) | undefined;
}>) {
  const opener = useStudioPlaceOpener();
  return (
    <ul className="space-y-1 text-sm" aria-label={label}>
      {places.map((place, index) => {
        const trail = trailOf(place, opener);
        const last = trail.length - 1;
        return (
          <li key={index} className="break-words">
            {trail.map((segment, at) => {
              const text =
                at === last && place.open.kind !== "none" ? (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    aria-label={`Go to ${trail.join(" › ")}`}
                    className="h-auto whitespace-normal break-words p-0 text-left text-sm text-foreground"
                    onClick={() => {
                      onBeforeOpen?.();
                      opener.open(place.open);
                    }}
                  >
                    {segment}
                  </Button>
                ) : (
                  <span className={at === last ? undefined : "text-muted-foreground"}>
                    {segment}
                  </span>
                );
              // The separator and the segment after it are one unit, so a line never ends in " › ".
              return at === 0 ? (
                <Fragment key={at}>{text}</Fragment>
              ) : (
                <Fragment key={at}>
                  {" "}
                  <span className="inline-flex max-w-full items-start gap-1 align-top">
                    <span className="shrink-0 text-muted-foreground">›</span>
                    <span className="min-w-0">{text}</span>
                  </span>
                </Fragment>
              );
            })}
          </li>
        );
      })}
    </ul>
  );
}

/** The "Used in" section for one part of the draft: every place that uses it, closed until opened. */
export function StudioUsedIn({
  source,
  target,
  name,
  onBeforeOpen,
}: Readonly<{
  source: ApplicationSourceDocument;
  target: ApplicationUseTarget;
  /** What the part is called, for the list's accessible name. */
  name: string;
  onBeforeOpen?: () => void;
}>) {
  const places = useMemo(() => applicationUses(source, target), [source, target]);
  return (
    <StudioInspectorGroup
      title="Used in"
      defaultOpen={false}
      persist={false}
      summary={
        places.length === 0
          ? "Not used"
          : `${places.length} ${places.length === 1 ? "place" : "places"}`
      }
    >
      {places.length === 0 ? (
        <p className="text-sm text-muted-foreground">Not used anywhere yet.</p>
      ) : (
        <StudioPlaceList
          places={places}
          label={`Where ${name} is used`}
          onBeforeOpen={onBeforeOpen}
        />
      )}
    </StudioInspectorGroup>
  );
}

/**
 * Why a change was refused while something still uses what it would remove: the reason, and behind
 * "Show me where" the places that use it. Shown only while there are places.
 */
export function StudioReferencesAlert({
  name,
  action,
  title,
  issue,
  references,
  onBeforeOpen,
}: Readonly<{
  /** The item's name, as the title says it. */
  name: string;
  /** What was refused, for example "deleted" or "removed". */
  action?: string;
  /** The title, when the refusal is not about removing one item. */
  title?: string;
  /** The reason, when the refusal states its own; otherwise it says how many places use the item. */
  issue?: string | undefined;
  references: readonly ApplicationUsePlace[];
  onBeforeOpen?: () => void;
}>) {
  const [showing, setShowing] = useState(false);
  if (references.length === 0) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{title ?? `${name} cannot be ${action ?? "changed"}`}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          {issue ??
            `${name} is used by ${describeApplicationUsers(references)}. Remove those uses first.`}
        </p>
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-expanded={showing}
          onClick={() => setShowing(!showing)}
        >
          {showing ? "Hide where" : "Show me where"}
        </Button>
        {showing && (
          <StudioPlaceList
            places={references}
            label={`Where ${name} is used`}
            onBeforeOpen={onBeforeOpen}
          />
        )}
      </AlertDescription>
    </Alert>
  );
}
