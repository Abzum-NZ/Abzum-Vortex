"use client";

import type { ReactElement } from "react";
import { cellValueToText } from "../display/cell";
import { DisplayHeader, RowActionControl } from "../display/controls";
import { DisplayStateContainer } from "../display/display-state-container";
import type { DisplayCellValue } from "../display/projected-data";
import type { PlatformBlockRenderProps } from "../registry";
import { readLauncherSettings, resolveLauncherListContext } from "./launcher-context";
import { filterLauncherRows, useLauncherRowFilter } from "./view-filter-context";

const cellText = (
  cells: Readonly<Record<string, DisplayCellValue>>,
  key: string,
): string => {
  const cell = cells[key];
  return cell === undefined ? "" : cellValueToText(cell).trim();
};

/**
 * Browser-safe launcher tile surface. It renders only the declared name and icon cells of the closed
 * permitted-applications projection (see `permittedApplicationsToListValues`); it never fetches,
 * queries or resolves a destination. Tile activation emits the declared `row_action` with the
 * application's permanent identity, and destination safety remains the bound flow's decision
 * (#619). An enclosing view filter can only hide rows it already received.
 */
export function ApplicationLauncher(props: PlatformBlockRenderProps): ReactElement {
  const filter = useLauncherRowFilter();
  const context = resolveLauncherListContext(props);
  const settings = readLauncherSettings(props, context.location);
  const nameKey = settings.cellKey("name_key", "name");
  const iconKey = settings.cellKey("icon_key", "icon");
  const values = context.values;
  const rows = values === undefined ? [] : filterLauncherRows(values.rows, filter, nameKey);
  const sidePanel = props.slots.side_panel ?? null;

  return (
    <div className="vortex-launcher-layout">
      <DisplayStateContainer
        accessibleName={context.accessibleName}
        availability={props.availability}
        projectedData={context.state}
        emptyMessage="No applications to show"
      >
        {values === undefined ? null : (
          <section
            data-vortex-display="application-launcher"
            data-vortex-placement-id={props.placementId}
            className="vortex-launcher"
            aria-label={context.accessibleName}
          >
            <DisplayHeader
              title={context.title}
              accessibleName={context.accessibleName}
              events={context.events}
            />
            {rows.length === 0 ? (
              <p className="vortex-launcher-empty" role="status">
                {filter?.emptyMessage ?? "No applications to show"}
              </p>
            ) : (
              <ul className="vortex-launcher-tiles">
                {rows.map((row) => {
                  const name = cellText(row.cells, nameKey) || "untitled application";
                  const icon = cellText(row.cells, iconKey);
                  return (
                    <li
                      key={row.recordId}
                      data-vortex-record-id={row.recordId}
                      className="vortex-launcher-tile"
                    >
                      {icon === "" ? null : (
                        <span
                          className="vortex-launcher-tile-icon"
                          data-vortex-icon={icon}
                          aria-hidden="true"
                        />
                      )}
                      <span className="vortex-launcher-tile-name">{name}</span>
                      <RowActionControl recordId={row.recordId} name={name} events={context.events} />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </DisplayStateContainer>
      {sidePanel === null ? null : <aside className="vortex-launcher-side-panel">{sidePanel}</aside>}
    </div>
  );
}
