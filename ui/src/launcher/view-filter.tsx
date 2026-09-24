"use client";

import { useId, useState, type ChangeEvent, type ReactElement } from "react";
import { DefinitionRenderError } from "../definition-error";
import type { PlatformBlockRenderProps } from "../registry";
import { readLauncherSettings } from "./launcher-context";
import {
  createLauncherRowFilter,
  LauncherRowFilterContext,
  useLauncherRowFilter,
  VIEW_FILTER_MATCH_MODES,
} from "./view-filter-context";

/**
 * Browser-safe local view filter. It narrows only the rows the launcher and tile placements in its
 * content slot already received, and never requests, broadens or re-queries data: it is bound to no
 * projected data, declares and emits no semantic event, and filtering is a pure function of those
 * placements' rows and the entered text. Any data or callbacks supplied to it fail closed, so a
 * binding cannot turn filtering into a wider read.
 */
export function ViewFilter(props: PlatformBlockRenderProps): ReactElement {
  const enclosing = useLauncherRowFilter();
  const [query, setQuery] = useState("");
  const inputId = useId();
  const { metadata, placementId } = props;
  const location = {
    placementId,
    blockId: metadata.blockId,
    releaseVersion: metadata.releaseVersion,
  };
  if (
    props.projectedData !== undefined ||
    props.displayEvents !== undefined ||
    props.controlData !== undefined ||
    props.controlEvents !== undefined
  )
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      `View filter '${metadata.key}' never binds data or events; it narrows only its content's rows`,
      location,
    );

  const settings = readLauncherSettings(props, location);
  const label = settings.text("label") ?? metadata.name;
  const placeholder = settings.text("placeholder");
  const help = settings.text("help_text");
  const emptyMessage = settings.text("empty_message") ?? "No matching items";
  const filter = createLauncherRowFilter({
    query,
    matchKey: settings.optionalCellKey("match_key"),
    mode: settings.choice("match_mode", VIEW_FILTER_MATCH_MODES, "contains"),
    caseSensitive: settings.boolean("case_sensitive"),
    emptyMessage,
    enclosing,
  });

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setQuery(event.target.value);
  };

  return (
    <section
      data-vortex-control="view-filter"
      data-vortex-placement-id={placementId}
      className="vortex-view-filter"
      aria-label={label}
    >
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
        {help === undefined ? null : (
          <p id={`${inputId}-help`} className="vortex-field-help">
            {help}
          </p>
        )}
      </div>
      <LauncherRowFilterContext.Provider value={filter}>
        <div className="vortex-view-filter-content">{props.slots.content ?? null}</div>
      </LauncherRowFilterContext.Provider>
    </section>
  );
}
