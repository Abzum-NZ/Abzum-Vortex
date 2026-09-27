"use client";

import type { ReactElement } from "react";
import { Card, CardFooter, CardHeader, CardTitle } from "../components/card";
import { cellValueToText } from "../display/cell";
import { DisplayHeader, RowActionControl } from "../display/controls";
import { DisplayStateContainer } from "../display/display-state-container";
import type { DisplayCellValue } from "../display/projected-data";
import {
  readLauncherSettings,
  resolveLauncherListContext,
  type LauncherRenderProps,
} from "./launcher-context";
import { filterLauncherRows, useLauncherRowFilter } from "./view-filter-context";

const cellText = (cells: Readonly<Record<string, DisplayCellValue>>, key: string): string => {
  const cell = cells[key];
  return cell === undefined ? "" : cellValueToText(cell).trim();
};

/**
 * Browser-safe launcher tile surface, one shadcn Card per application. It renders only the
 * declared name and icon cells of a closed launcher list (see the launcher bindings); it never
 * fetches, queries or resolves a destination. The open control shows only while the declared
 * `row_action` is bound and invocable. Tile activation emits the declared `row_action` with the
 * application's key, and destination safety remains the server recheck's decision. An enclosing
 * view filter can only hide rows it already received.
 */
export function ApplicationLauncher(props: LauncherRenderProps): ReactElement {
  const filter = useLauncherRowFilter();
  const context = resolveLauncherListContext(props);
  const settings = readLauncherSettings(props, context.location);
  const nameKey = settings.cellKey("name_key", "name");
  const iconKey = settings.cellKey("icon_key", "icon");
  const values = context.values;
  const rows = values === undefined ? [] : filterLauncherRows(values.rows, filter, nameKey);
  const sidePanel = props.slots.side_panel ?? null;
  // A tile shows its open control only when the declared row action is bound and invocable.
  const openable = context.events?.row_action !== undefined;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 md:flex-row">
      <div className="flex min-w-0 flex-1 flex-col">
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
              className="flex flex-col"
              aria-label={context.accessibleName}
            >
              <DisplayHeader
                title={context.title}
                accessibleName={context.accessibleName}
                events={context.events}
              />
              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground" role="status">
                  {filter?.emptyMessage ?? "No applications to show"}
                </p>
              ) : (
                <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
                  {rows.map((row) => {
                    const name = cellText(row.cells, nameKey) || "untitled application";
                    const icon = cellText(row.cells, iconKey);
                    return (
                      <li key={row.recordId} data-vortex-record-id={row.recordId} className="flex">
                        <Card size="sm" className="w-full">
                          <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                              {icon === "" ? null : (
                                <span data-vortex-icon={icon} aria-hidden="true" />
                              )}
                              <span>{name}</span>
                            </CardTitle>
                          </CardHeader>
                          {openable ? (
                            <CardFooter className="mt-auto">
                              <RowActionControl
                                recordId={row.recordId}
                                name={name}
                                events={context.events}
                              />
                            </CardFooter>
                          ) : null}
                        </Card>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
        </DisplayStateContainer>
      </div>
      {sidePanel === null ? null : <aside className="min-w-0 md:w-1/3">{sidePanel}</aside>}
    </div>
  );
}
