"use client";

import { useId, useState, type ChangeEvent, type ReactElement } from "react";
import { DisplayCellView, cellValueToText } from "../display/cell";
import { DisplayHeader } from "../display/controls";
import { DisplayStateContainer } from "../display/display-state-container";
import type { DisplayRow } from "../display/projected-data";
import type { PlatformBlockRenderProps } from "../registry";
import { readLauncherSettings, resolveLauncherListContext } from "./launcher-context";

const MATCH_MODES = ["contains", "starts_with", "exact"] as const;
type MatchMode = (typeof MATCH_MODES)[number];

const matches = (
  row: DisplayRow,
  matchKey: string,
  needle: string,
  mode: MatchMode,
  caseSensitive: boolean,
): boolean => {
  if (needle.length === 0) return true;
  const cell = row.cells[matchKey];
  if (cell === undefined) return false;
  const haystack = caseSensitive ? cellValueToText(cell) : cellValueToText(cell).toLowerCase();
  const query = caseSensitive ? needle : needle.toLowerCase();
  switch (mode) {
    case "starts_with":
      return haystack.startsWith(query);
    case "exact":
      return haystack === query;
    default:
      return haystack.includes(query);
  }
};

/**
 * Browser-safe local view filter. It narrows only the rows already returned for this placement and
 * never requests, broadens or re-queries data: filtering is a pure function of the projected rows
 * and the entered text. The block emits no event, so a bound flow cannot turn filtering into a
 * wider read.
 */
export function ViewFilter(props: PlatformBlockRenderProps): ReactElement {
  const context = resolveLauncherListContext(props);
  const settings = readLauncherSettings(props, context.location);
  const [query, setQuery] = useState("");
  const inputId = useId();
  const values = context.values;
  const label = settings.text("label") ?? context.accessibleName;
  const placeholder = settings.text("placeholder");
  const help = settings.text("help_text");
  const emptyMessage = settings.text("empty_message") ?? "No matching items";
  const matchMode = settings.choice("match_mode", MATCH_MODES, "contains");
  const caseSensitive = settings.boolean("case_sensitive");
  const matchKey = settings.cellKey("match_key", values?.headingKey ?? "name");
  const filtered =
    values === undefined ? [] : values.rows.filter((row) => matches(row, matchKey, query.trim(), matchMode, caseSensitive));

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setQuery(event.target.value);
  };

  return (
    <DisplayStateContainer
      accessibleName={context.accessibleName}
      availability={props.availability}
      projectedData={context.state}
      emptyMessage="No items to filter"
    >
      {values === undefined ? null : (
        <section
          data-vortex-display="view-filter"
          data-vortex-placement-id={props.placementId}
          className="vortex-view-filter"
          aria-label={context.accessibleName}
        >
          <DisplayHeader
            title={context.title}
            accessibleName={context.accessibleName}
            events={context.events}
          />
          <div className="vortex-view-filter-field">
            <label htmlFor={inputId} className="vortex-field-label">
              {label}
            </label>
            <input
              id={inputId}
              type="search"
              value={query}
              onChange={onChange}
              {...(placeholder === undefined ? {} : { placeholder })}
              {...(help === undefined ? {} : { "aria-describedby": `${inputId}-help` })}
              className="vortex-input"
            />
          </div>
          {help === undefined ? null : (
            <p id={`${inputId}-help`} className="vortex-field-help">
              {help}
            </p>
          )}
          {filtered.length === 0 ? (
            <p className="vortex-view-filter-empty" role="status">
              {emptyMessage}
            </p>
          ) : (
            <ul className="vortex-view-filter-rows">
              {filtered.map((row) => {
                const heading = row.cells[values.headingKey];
                const secondary =
                  values.secondaryKey === undefined ? undefined : row.cells[values.secondaryKey];
                return (
                  <li
                    key={row.recordId}
                    data-vortex-record-id={row.recordId}
                    className="vortex-view-filter-row"
                  >
                    <span className="vortex-view-filter-heading">
                      <DisplayCellView value={heading ?? { kind: "empty" }} />
                    </span>
                    {secondary === undefined ? null : (
                      <span className="vortex-view-filter-secondary">
                        <DisplayCellView value={secondary} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </DisplayStateContainer>
  );
}
