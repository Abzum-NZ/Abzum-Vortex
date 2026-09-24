"use client";

import type { ReactElement } from "react";
import { DisplayCellView, cellValueToText } from "../display/cell";
import { DisplayHeader, RowActionControl } from "../display/controls";
import { DisplayStateContainer } from "../display/display-state-container";
import type { DisplayCellValue } from "../display/projected-data";
import type { PlatformBlockRenderProps } from "../registry";
import { readLauncherSettings, resolveLauncherListContext } from "./launcher-context";
import { filterLauncherRows, useLauncherRowFilter } from "./view-filter-context";

const cellText = (cells: Readonly<Record<string, DisplayCellValue>>, key: string): string => {
  const cell = cells[key];
  return cell === undefined ? "" : cellValueToText(cell).trim();
};

/**
 * Browser-safe link-tile surface for already-returned query rows (see `linkTilesToListValues`). It
 * renders only the declared label, safe HTTPS address and description cells of a closed `list`
 * projection; it never executes the bound query (#584) and never resolves a destination (#619). A
 * non-link address cell is ignored rather than promoted, so a tile can show only a validated safe
 * address. An enclosing view filter can only hide rows it already received.
 */
export function LinkTiles(props: PlatformBlockRenderProps): ReactElement {
  const filter = useLauncherRowFilter();
  const context = resolveLauncherListContext(props);
  const settings = readLauncherSettings(props, context.location);
  const labelKey = settings.cellKey("label_key", "label");
  const addressKey = settings.cellKey("address_key", "address");
  const descriptionKey = settings.cellKey("description_key", "description");
  const values = context.values;
  const rows = values === undefined ? [] : filterLauncherRows(values.rows, filter, labelKey);
  const actions = props.slots.actions ?? null;

  return (
    <div className="vortex-link-tiles-layout">
      <DisplayStateContainer
        accessibleName={context.accessibleName}
        availability={props.availability}
        projectedData={context.state}
        emptyMessage="No links to show"
      >
        {values === undefined ? null : (
          <section
            data-vortex-display="link-tiles"
            data-vortex-placement-id={props.placementId}
            className="vortex-link-tiles"
            aria-label={context.accessibleName}
          >
            <DisplayHeader
              title={context.title}
              accessibleName={context.accessibleName}
              events={context.events}
            />
            {rows.length === 0 ? (
              <p className="vortex-link-tiles-empty" role="status">
                {filter?.emptyMessage ?? "No links to show"}
              </p>
            ) : (
              <ul className="vortex-link-tile-list">
                {rows.map((row) => {
                  const label = cellText(row.cells, labelKey) || "untitled link";
                  const description = cellText(row.cells, descriptionKey);
                  const address = row.cells[addressKey];
                  return (
                    <li
                      key={row.recordId}
                      data-vortex-record-id={row.recordId}
                      className="vortex-link-tile"
                    >
                      <span className="vortex-link-tile-label">{label}</span>
                      {address === undefined || address.kind !== "link" ? null : (
                        <span className="vortex-link-tile-address">
                          <DisplayCellView value={address} />
                        </span>
                      )}
                      {description === "" ? null : (
                        <span className="vortex-link-tile-description">{description}</span>
                      )}
                      <RowActionControl recordId={row.recordId} name={label} events={context.events} />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </DisplayStateContainer>
      {actions === null ? null : <div className="vortex-link-tiles-actions">{actions}</div>}
    </div>
  );
}
