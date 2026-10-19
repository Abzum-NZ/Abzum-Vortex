"use client";

import { useId, useState, type ReactElement } from "react";
import { Button } from "../../components/button";
import { Input } from "../../components/input";
import { Label } from "../../components/label";
import type { DisplayEventHandlers } from "../projected-data";
import type { GridFeatureModule, GridFeaturePointProps } from "./registry";

/**
 * The table's search box, shown only when the placement enables search and the host supplies the
 * declared `search_changed` event. It reports the query; the host sends it to the Query engine.
 */
function SearchControl({
  accessibleName,
  initialQuery,
  events,
}: Readonly<{
  accessibleName: string;
  /** The search the shown page was read with; empty when it was not searched. */
  initialQuery: string;
  events: DisplayEventHandlers | undefined;
}>): ReactElement | null {
  const [query, setQuery] = useState(initialQuery);
  const inputId = useId();
  const onSearch = events?.search_changed;
  if (onSearch === undefined) return null;
  return (
    <form
      className="flex w-full min-w-0 items-end gap-1.5 sm:w-auto"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        onSearch({ event: "search_changed", query });
      }}
    >
      <Label htmlFor={inputId} className="sr-only">
        Search {accessibleName}
      </Label>
      <Input
        id={inputId}
        type="search"
        className="min-w-0 flex-1 sm:w-auto sm:min-w-48 sm:flex-none"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <Button type="submit" size="sm">
        Search
      </Button>
    </form>
  );
}

/** Search: the search box in the table's toolbar, starting from the search the page was read with. */
function SearchToolbar({ context }: GridFeaturePointProps): ReactElement {
  return (
    <SearchControl
      accessibleName={context.accessibleName}
      initialQuery={context.narrowing?.search ?? ""}
      events={context.events}
    />
  );
}

export const gridFeature: GridFeatureModule = { ToolbarItems: SearchToolbar };
