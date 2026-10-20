"use client";

import type { ReactElement } from "react";
import { Icon, resolveVortexIconName } from "../icons";
import {
  mountedRecordPinElementProperty,
  type ProjectedLinkTiles,
  type JsonValue,
  type MountedRecordPinFrame,
  type MountedRecordPinMembership,
} from "@vortex/platform/schema";
import { Button } from "../components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/card";
import { Empty, EmptyHeader, EmptyTitle } from "../components/empty";
import { DisplayHeader, RowActionControl } from "../display/controls";
import { DisplayStateContainer } from "../display/display-state-container";
import type { DisplayDataState } from "../display/projected-data";
import {
  readLauncherSettings,
  resolveLauncherListContext,
  type LauncherRenderProps,
} from "./launcher-context";

type LinkTilesRenderProps = LauncherRenderProps &
  Readonly<{
    pinData?: DisplayDataState<ProjectedLinkTiles>;
    openTile?: (
      sourceRecordId: string,
      sourceRevision: number,
      isVisible?: () => boolean,
    ) => Promise<void>;
    pinFrame?: MountedRecordPinFrame;
  }>;

const titleText = (value: JsonValue): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");

/** The one link tiles renderer: record, application, page and external targets. */
export function LinkTiles(props: LinkTilesRenderProps): ReactElement {
  const context = resolveLauncherListContext(props);
  const settings = readLauncherSettings(props, context.location);
  const state = props.pinData ?? { status: "loading" as const };
  const values =
    props.availability === "available" && state.status === "ready" ? state.values : undefined;
  const rows = values?.rows ?? [];
  const events = props.availability === "available" ? props.events : undefined;
  const actionLabel = settings.text("row_action_label");
  const actions = props.slots.actions ?? null;
  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <DisplayStateContainer
        accessibleName={context.accessibleName}
        availability={props.availability}
        projectedData={state}
        emptyMessage="No links to show"
      >
        {values === undefined ? null : (
          <section
            data-vortex-display="link-tiles"
            data-vortex-placement-id={props.placementId}
            aria-label={context.accessibleName}
            className="flex flex-col"
          >
            <DisplayHeader
              title={context.title}
              accessibleName={context.accessibleName}
              events={events}
            />
            {rows.length === 0 ? (
              <Empty
                role="status"
                className="border border-dashed border-border py-12 text-muted-foreground"
                aria-label={`${context.accessibleName}: empty`}
              >
                <EmptyHeader>
                  <EmptyTitle>No links to show</EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map((row) => {
                  const target = row.target;
                  const iconName =
                    target.kind === "application" || target.kind === "page"
                      ? resolveVortexIconName(target.icon)
                      : undefined;
                  const label =
                    target.kind === "record"
                      ? titleText(target.title)
                      : target.kind !== "unavailable"
                        ? target.label
                        : "Unavailable link";
                  return (
                    <li
                      key={row.sourceRecordId}
                      data-vortex-record-id={row.sourceRecordId}
                      className="flex"
                      ref={(element) => {
                        if (element === null) return;
                        // Reading this port does not read a Record or subscribe. Hidden ancestors and
                        // viewport rules make it return no membership, even while the DOM node exists.
                        Object.defineProperty(element, mountedRecordPinElementProperty, {
                          configurable: true,
                          get: (): MountedRecordPinMembership | undefined =>
                            target.kind !== "record" ||
                            props.pinFrame === undefined ||
                            props.availability !== "available" ||
                            !element.isConnected ||
                            element.getClientRects().length === 0 ||
                            getComputedStyle(element).visibility !== "visible"
                              ? undefined
                              : Object.freeze({
                                  ...target.association,
                                  placementId: props.placementId,
                                  sourceRecordId: row.sourceRecordId,
                                  sourceRevision: row.sourceRevision,
                                  frame: props.pinFrame,
                                }),
                        });
                      }}
                    >
                      <Card
                        size="sm"
                        className="group relative flex w-full flex-col justify-between overflow-hidden border-border bg-card text-card-foreground transition-all duration-200 hover:border-primary/50 hover:bg-accent/30 hover:shadow-md focus-within:ring-2 focus-within:ring-ring"
                      >
                        <CardHeader>
                          <CardTitle>
                            {target.kind === "application" || target.kind === "page" ? (
                              <Icon
                                name={iconName ?? "circle"}
                                width={20}
                                height={20}
                                className="mr-2 inline-block size-5 shrink-0 align-middle"
                                data-vortex-icon={iconName ?? "circle"}
                                data-vortex-icon-fallback={
                                  iconName === undefined ? "neutral" : undefined
                                }
                                aria-hidden="true"
                              />
                            ) : null}
                            {label}
                          </CardTitle>
                          {target.kind === "external" && target.description ? (
                            <CardDescription>{target.description}</CardDescription>
                          ) : null}
                        </CardHeader>
                        {target.kind === "unavailable" || props.openTile === undefined ? null : (
                          <CardContent>
                            <Button
                              variant="link"
                              onClick={(event) => {
                                const element = event.currentTarget;
                                void props.openTile?.(
                                  row.sourceRecordId,
                                  row.sourceRevision,
                                  () =>
                                    element.isConnected &&
                                    element.getClientRects().length !== 0 &&
                                    getComputedStyle(element).visibility === "visible",
                                );
                              }}
                            >
                              Open
                              <span className="sr-only">
                                {" "}
                                {label}
                                {target.openBehaviour === "new_page"
                                  ? " (opens in a new page)"
                                  : ""}
                              </span>
                            </Button>
                          </CardContent>
                        )}
                        {events?.row_action === undefined || actionLabel === undefined ? null : (
                          <CardFooter className="mt-auto">
                            <RowActionControl
                              recordId={row.sourceRecordId}
                              revision={row.sourceRevision}
                              name={label}
                              label={actionLabel}
                              events={events}
                            />
                          </CardFooter>
                        )}
                      </Card>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </DisplayStateContainer>
      {actions === null ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
