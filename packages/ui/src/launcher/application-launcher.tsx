"use client";

import type { ReactElement } from "react";
import { Icon, resolveVortexIconName } from "../icons";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/empty";
import { cellValueToText } from "../display/cell";
import { DisplayHeader, RowActionControl } from "../display/controls";
import { rowActionEventIdOf } from "../display/context";
import { DisplayStateContainer } from "../display/display-state-container";
import type { DisplayCellValue } from "../display/projected-data";
import { cn } from "../lib/utils";
import {
  readLauncherSettings,
  resolveLauncherListContext,
  type LauncherRenderProps,
} from "./launcher-context";

const cellText = (cells: Readonly<Record<string, DisplayCellValue>>, key: string): string => {
  const cell = cells[key];
  return cell === undefined ? "" : cellValueToText(cell).trim();
};

/**
 * Browser-safe launcher tile surface, one shadcn Card per application. It renders only the
 * declared name, icon and description cells of a closed launcher list (see the launcher bindings);
 * it never fetches, queries or resolves a destination. The open control shows only while the
 * declared `row_action` is bound and invocable. Tile activation emits only the row identity:
 * query-bound application rows use the application key, and the organisation launcher uses the
 * stable root identity. The addressed application page rechecks either value before opening.
 */
export function ApplicationLauncher(props: LauncherRenderProps): ReactElement {
  const context = resolveLauncherListContext(props);
  const settings = readLauncherSettings(props, context.location);
  const nameKey = settings.cellKey("name_key", "name");
  const iconKey = settings.cellKey("icon_key", "icon");
  // The launcher bindings write an optional fixed `description` cell; it is not a declared setting.
  const descriptionKey = "description";
  const values = context.values;
  const rows = values?.rows ?? [];
  const sidePanel = props.slots.side_panel ?? null;
  // A tile shows its open control only when the declared row action is bound and invocable.
  const rowActionEventId =
    context.events?.row_action === undefined ? undefined : rowActionEventIdOf(props);
  const openable = rowActionEventId !== undefined;

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
                <Empty
                  role="status"
                  data-vortex-display-state="empty"
                  className="border border-dashed border-border text-muted-foreground"
                  aria-label={`${context.accessibleName}: empty`}
                >
                  <EmptyHeader>
                    <EmptyTitle>No applications to show</EmptyTitle>
                    <EmptyDescription>
                      No applications match your search or are available for this account.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
                  {rows.map((row) => {
                    const name = cellText(row.cells, nameKey) || "untitled application";
                    const icon = cellText(row.cells, iconKey);
                    const description = cellText(row.cells, descriptionKey);
                    const iconName = resolveVortexIconName(icon);
                    return (
                      <li key={row.recordId} data-vortex-record-id={row.recordId} className="flex">
                        <Card
                          size="sm"
                          className={cn(
                            "group relative flex w-full flex-col justify-between overflow-hidden border-border bg-card text-card-foreground transition-all duration-200",
                            openable &&
                              "cursor-pointer hover:border-primary/50 hover:bg-accent/30 hover:shadow-md focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
                          )}
                          tabIndex={openable ? 0 : undefined}
                          role={openable ? "button" : undefined}
                          aria-label={openable ? `Open ${name}` : undefined}
                          onClick={
                            openable
                              ? () =>
                                  context.events?.row_action?.({
                                    event: "row_action",
                                    eventId: rowActionEventId,
                                    recordId: row.recordId,
                                  })
                              : undefined
                          }
                          onKeyDown={
                            openable
                              ? (event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    context.events?.row_action?.({
                                      event: "row_action",
                                      eventId: rowActionEventId,
                                      recordId: row.recordId,
                                    });
                                  }
                                }
                              : undefined
                          }
                        >
                          <CardHeader>
                            <div className="flex items-start gap-3">
                              <EmptyMedia
                                variant="icon"
                                className={cn(
                                  "size-10 transition-colors",
                                  openable && "group-hover:bg-primary/10 group-hover:text-primary",
                                )}
                                aria-hidden="true"
                              >
                                <Icon
                                  name={iconName ?? "circle"}
                                  width={20}
                                  height={20}
                                  className="size-5 shrink-0"
                                  data-vortex-icon={iconName ?? "circle"}
                                  data-vortex-icon-fallback={
                                    iconName === undefined ? "neutral" : undefined
                                  }
                                />
                              </EmptyMedia>
                              <div className="flex min-w-0 flex-1 flex-col gap-1">
                                <CardTitle className="transition-colors group-hover:text-primary">
                                  {name}
                                </CardTitle>
                                {description === "" ? null : (
                                  <CardDescription className="line-clamp-2">
                                    {description}
                                  </CardDescription>
                                )}
                              </div>
                            </div>
                          </CardHeader>
                          {openable ? (
                            <CardFooter className="mt-auto">
                              <RowActionControl
                                recordId={row.recordId}
                                name={name}
                                eventId={rowActionEventId}
                                events={context.events}
                                label="Open"
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
