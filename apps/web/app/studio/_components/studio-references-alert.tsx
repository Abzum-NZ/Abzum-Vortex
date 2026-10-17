"use client";
import { useState } from "react";
import type { InlineRecordTypeReference } from "@vortex/platform/schema";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";

/**
 * Why a delete or removal was refused: where the item is used, behind "Show me where", each place
 * a link to it in Studio when Studio can open it. Shown only while there are references.
 */
export function StudioReferencesAlert({ name, action, references, onShow }: Readonly<{
  /** The item's name, as the title says it. */
  name: string;
  /** What was refused, for example "deleted" or "removed". */
  action: string;
  references: readonly InlineRecordTypeReference[];
  onShow?: ((reference: InlineRecordTypeReference) => void) | undefined;
}>) {
  const [showing, setShowing] = useState(false);
  if (references.length === 0) return null;
  return <Alert variant="destructive" role="alert">
    <AlertTitle>{name} cannot be {action}</AlertTitle>
    <AlertDescription className="space-y-2">
      <p>It is used in {references.length} {references.length === 1 ? "place" : "places"}. Remove those uses first.</p>
      <Button type="button" size="xs" variant="outline" aria-expanded={showing} onClick={() => setShowing(!showing)}>
        {showing ? "Hide where" : "Show me where"}</Button>
      {showing && <ul className="list-disc space-y-1 pl-5" aria-label={`Where ${name} is used`}>
        {references.map((reference) => <li key={reference.label} className="break-words">
          {reference.open.kind === "none" || onShow === undefined ? reference.label
            : <Button type="button" variant="link" size="sm" className="h-auto whitespace-normal p-0 text-left"
              onClick={() => onShow(reference)}>{reference.label}</Button>}
        </li>)}
      </ul>}
    </AlertDescription>
  </Alert>;
}
