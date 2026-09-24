import type { ReactElement } from "react";
import { DisplayCellView, cellValueToText } from "../display/cell";
import { DisplayHeader } from "../display/controls";
import { DisplayStateContainer } from "../display/display-state-container";
import type { DisplayCellValue } from "../display/projected-data";
import type { PlatformBlockRenderProps } from "../registry";
import { readLauncherSettings, resolveLauncherListContext } from "./launcher-context";

const cellText = (
  cells: Readonly<Record<string, DisplayCellValue>>,
  key: string,
): string => {
  const cell = cells[key];
  return cell === undefined ? "" : cellValueToText(cell).trim();
};

/**
 * Browser-safe launcher tile surface. It renders only the declared name, icon and safe link cells
 * of a closed permitted-applications projection; it never fetches, queries or resolves a
 * destination. Tile activation emits the declared `row_action` with the application's permanent
 * identity, and destination safety remains the bound flow's decision (#619).
 */
export function ApplicationLauncher(props: PlatformBlockRenderProps): ReactElement {
  const context = resolveLauncherListContext(props);
  const settings = readLauncherSettings(props, context.location);
  const nameKey = settings.cellKey("name_key", "name");
  const iconKey = settings.cellKey("icon_key", "icon");
  const linkKey = settings.cellKey("link_key", "link");
  const values = context.values;

  return (
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
          <ul className="vortex-launcher-tiles">
            {values.rows.map((row) => {
              const name = cellText(row.cells, nameKey) || "untitled application";
              const icon = cellText(row.cells, iconKey);
              const link = row.cells[linkKey];
              const onRowAction = context.events?.row_action;
              return (
                <li
                  key={row.recordId}
                  data-vortex-record-id={row.recordId}
                  className="vortex-launcher-tile"
                >
                  {icon === "" ? null : (
                    <span className="vortex-launcher-tile-icon" aria-hidden="true">
                      {icon}
                    </span>
                  )}
                  <span className="vortex-launcher-tile-name">{name}</span>
                  {link === undefined || link.kind !== "link" ? null : (
                    <span className="vortex-launcher-tile-address">
                      <DisplayCellView value={link} />
                    </span>
                  )}
                  {onRowAction === undefined ? null : (
                    <button
                      type="button"
                      className="vortex-launcher-tile-open"
                      aria-label={`Open ${name}`}
                      onClick={() => onRowAction({ event: "row_action", recordId: row.recordId })}
                    >
                      Open
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </DisplayStateContainer>
  );
}
