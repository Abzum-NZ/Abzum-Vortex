"use client";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  applicationUses, type ApplicationSourceDocument, type ApplicationUsePlace, type ApplicationUseTarget,
} from "@vortex/platform/schema";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";

/**
 * Where a part of the draft is used, from the draft's one reference index (`applicationUses`): the
 * "Used in" section of an inspector and the "Show me where" list of a refused removal. Each place
 * opens its item in its own tab, selected, through the workspace's one selection store; the
 * workspace provides how (`StudioPlaceOpener`).
 */

export type StudioPlaceOpener = Readonly<{
  /** Opens a place's item in its tab with it selected. Places Studio cannot open are not passed. */
  open: (place: ApplicationUsePlace) => void;
  /** The outline's name of a block or flow step a place opens, when the outline knows it. */
  nameOf: (place: ApplicationUsePlace) => string | undefined;
}>;

const OpenerContext = createContext<StudioPlaceOpener | null>(null);

export function StudioPlaceOpenerProvider({ opener, children }: Readonly<{ opener: StudioPlaceOpener; children: ReactNode }>) {
  return <OpenerContext.Provider value={opener}>{children}</OpenerContext.Provider>;
}

const useOpener = (): StudioPlaceOpener => {
  const opener = useContext(OpenerContext);
  if (opener === null) throw new Error("Studio places are shown inside the Studio workspace only.");
  return opener;
};

const placesWord = (count: number) => count === 1 ? "one place" : `${count} places`;

/** The places, each a link to its item when Studio can open it. `onBeforeOpen` closes a dialog first. */
export function StudioPlaceList({ places, label, onBeforeOpen }: Readonly<{
  places: readonly ApplicationUsePlace[]; label: string; onBeforeOpen?: (() => void) | undefined;
}>) {
  const opener = useOpener();
  return <ul className="list-disc space-y-1 pl-5" aria-label={label}>
    {places.map((place, index) => {
      const name = opener.nameOf(place);
      const text = name === undefined || place.within === undefined ? place.label : `${name}, on the ${place.within}`;
      return <li key={index} className="break-words">
        {place.open.kind === "none" ? text
          : <Button type="button" variant="link" size="sm" className="h-auto whitespace-normal p-0 text-left"
            onClick={() => { onBeforeOpen?.(); opener.open(place); }}>{text}</Button>}
      </li>;
    })}
  </ul>;
}

/**
 * The "Used in" section for one part of the draft: every place that uses it. `collapsed` shows only
 * the count until it is opened, for a row among many (an action, a permission, a stage).
 */
export function StudioUsedIn({ source, target, name, collapsed = false, onBeforeOpen }: Readonly<{
  source: ApplicationSourceDocument;
  target: ApplicationUseTarget;
  /** What the part is called, for the list's accessible name. */
  name: string;
  collapsed?: boolean;
  onBeforeOpen?: () => void;
}>) {
  const places = useMemo(() => applicationUses(source, target), [source, target]);
  const [open, setOpen] = useState(!collapsed);
  if (collapsed && places.length === 0) return <p className="text-xs text-muted-foreground">Not used anywhere yet.</p>;
  return <section aria-label={`Where ${name} is used`} className={collapsed ? "space-y-1" : "space-y-2 border-t border-border pt-3"}>
    {collapsed
      ? <Button type="button" size="xs" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide where it is used" : `Used in ${placesWord(places.length)}`}</Button>
      : <h3 className="text-sm font-semibold">Used in</h3>}
    {open && (places.length === 0
      ? <p className="text-sm text-muted-foreground">Nothing in the draft uses {name} yet.</p>
      : <StudioPlaceList places={places} label={`Where ${name} is used`} onBeforeOpen={onBeforeOpen} />)}
  </section>;
}

/**
 * Why a change was refused while something still uses what it would remove: the reason, and behind
 * "Show me where" the places that use it. Shown only while there are places.
 */
export function StudioReferencesAlert({ name, action, title, issue, references, onBeforeOpen }: Readonly<{
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
  return <Alert variant="destructive" role="alert">
    <AlertTitle>{title ?? `${name} cannot be ${action ?? "changed"}`}</AlertTitle>
    <AlertDescription className="space-y-2">
      <p>{issue ?? `It is used in ${placesWord(references.length)}. Remove those uses first.`}</p>
      <Button type="button" size="xs" variant="outline" aria-expanded={showing} onClick={() => setShowing(!showing)}>
        {showing ? "Hide where" : "Show me where"}</Button>
      {showing && <StudioPlaceList places={references} label={`Where ${name} is used`} onBeforeOpen={onBeforeOpen} />}
    </AlertDescription>
  </Alert>;
}
