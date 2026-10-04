"use client";

import type { ReactElement } from "react";
import {
  RECORD_PIN_LINK_TILES_BLOCK_RELEASE,
  mountedRecordPinElementProperty,
  type ProjectedRecordPinTiles,
  type JsonValue,
  type MountedRecordPinFrame,
  type MountedRecordPinMembership,
} from "@vortex/contracts";
import { Button } from "../components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/card";
import { cellValueToText } from "../display/cell";
import { DisplayHeader, RowActionControl } from "../display/controls";
import { DisplayStateContainer } from "../display/display-state-container";
import type { DisplayCellValue, DisplayDataState } from "../display/projected-data";
import {
  readLauncherSettings,
  resolveLauncherListContext,
  type LauncherRenderProps,
} from "./launcher-context";
import { externalLinkActivation } from "./link-navigation";
import { filterLauncherRows, useLauncherRowFilter } from "./view-filter-context";

const cellText = (cells: Readonly<Record<string, DisplayCellValue>>, key: string): string => {
  const cell = cells[key];
  return cell === undefined ? "" : cellValueToText(cell).trim();
};

/**
 * Browser-safe link-tile surface, one shadcn Card per link, for already-returned query rows (see
 * `linkTilesToListValues`). It renders only the declared label, safe HTTPS address and
 * description cells of a closed `list` projection; it never executes the bound query (#584). Each address is re-validated against the
 * bounded HTTPS contract and opened in a new browsing context without opener access or referrer
 * (#619); internal application and page destinations are re-checked on the server by the page
 * capability service, never here. A non-link address cell is ignored rather than promoted, so a
 * tile can show only a validated safe address. An enclosing view filter can only hide rows it
 * already received.
 */
function ExternalLinkTiles(props: LauncherRenderProps): ReactElement {
  const filter = useLauncherRowFilter();
  const context = resolveLauncherListContext(props);
  const settings = readLauncherSettings(props, context.location);
  const labelKey = settings.cellKey("label_key", "label");
  const addressKey = settings.cellKey("address_key", "address");
  const descriptionKey = settings.cellKey("description_key", "description");
  const values = context.values;
  const rows = values === undefined ? [] : filterLauncherRows(values.rows, filter, labelKey);
  const actions = props.slots.actions ?? null;
  // A tile shows its open control only when the declared row action is bound and invocable.
  const openable = context.events?.row_action !== undefined;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
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
                {filter?.emptyMessage ?? "No links to show"}
              </p>
            ) : (
              <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
                {rows.map((row) => {
                  const label = cellText(row.cells, labelKey) || "untitled link";
                  const description = cellText(row.cells, descriptionKey);
                  const address = row.cells[addressKey];
                  return (
                    <li key={row.recordId} data-vortex-record-id={row.recordId} className="flex">
                      <Card size="sm" className="w-full">
                        <CardHeader>
                          <CardTitle>{label}</CardTitle>
                          {description === "" ? null : (
                            <CardDescription>{description}</CardDescription>
                          )}
                        </CardHeader>
                        {address === undefined || address.kind !== "link" ? null : (
                          <CardContent>
                            <a
                              className="text-sm text-foreground underline underline-offset-4 hover:decoration-2"
                              {...externalLinkActivation(address.address)}
                            >
                              {address.label}
                              <span aria-hidden="true"> ↗</span>
                              <span className="sr-only"> (external link, opens in a new page)</span>
                            </a>
                          </CardContent>
                        )}
                        {openable ? (
                          <CardFooter className="mt-auto">
                            <RowActionControl
                              recordId={row.recordId}
                              name={label}
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
      {actions === null ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

type RecordPinRenderProps = LauncherRenderProps & Readonly<{
  pinData?: DisplayDataState<ProjectedRecordPinTiles>;
  openTile?: (sourceRecordId: string, sourceRevision: number) => Promise<void>;
  pinFrame?: MountedRecordPinFrame;
}>;

const titleText = (value: JsonValue): string =>
  typeof value === "string" ? value : JSON.stringify(value) ?? "";

/** The same registered renderer keeps old releases in their original external-only component. */
export function LinkTiles(props: RecordPinRenderProps): ReactElement {
  return props.metadata.blockId === RECORD_PIN_LINK_TILES_BLOCK_RELEASE.blockId &&
    props.metadata.releaseVersion === RECORD_PIN_LINK_TILES_BLOCK_RELEASE.releaseVersion
    ? <RecordPinTiles {...props} /> : <ExternalLinkTiles {...props} />;
}

function RecordPinTiles(props: RecordPinRenderProps): ReactElement {
  const filter = useLauncherRowFilter();
  const context = resolveLauncherListContext(props);
  const settings = readLauncherSettings(props, context.location);
  const labelKey = settings.cellKey("label_key", "label");
  const state = props.pinData ?? { status: "loading" as const };
  const values = props.availability === "available" && state.status === "ready" ? state.values : undefined;
  const rows = values?.rows.filter((row) => {
    const label = row.target.kind === "record" ? titleText(row.target.title)
      : row.target.kind === "external" ? row.target.label : "Unavailable record";
    return filter?.matches({ recordId: row.sourceRecordId,
      cells: { [labelKey]: { kind: "text", text: label } } }, labelKey) ?? true;
  }) ?? [];
  const events = props.availability === "available" ? props.events : undefined;
  const actionLabel = settings.text("row_action_label");
  const actions = props.slots.actions ?? null;
  return <div className="flex w-full min-w-0 flex-col gap-4">
    <DisplayStateContainer accessibleName={context.accessibleName} availability={props.availability}
      projectedData={state} emptyMessage="No links to show">
      {values === undefined ? null : <section data-vortex-display="record-pin-tiles"
        data-vortex-placement-id={props.placementId} aria-label={context.accessibleName} className="flex flex-col">
        <DisplayHeader title={context.title} accessibleName={context.accessibleName} events={events} />
        {rows.length === 0 ? <p role="status" className="text-sm text-muted-foreground">
          {filter?.emptyMessage ?? "No links to show"}
        </p> : <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((row) => {
            const target = row.target;
            const label = target.kind === "record" ? titleText(target.title)
              : target.kind === "external" ? target.label : "Unavailable record";
            return <li key={row.sourceRecordId} data-vortex-record-id={row.sourceRecordId} className="flex"
              ref={(element) => {
                if (element === null) return;
                // Reading this port does not read a Record or subscribe. Hidden ancestors and
                // viewport rules make it return no membership, even while the DOM node exists.
                Object.defineProperty(element, mountedRecordPinElementProperty, {
                  configurable: true,
                  get: (): MountedRecordPinMembership | undefined => target.kind !== "record" || props.pinFrame === undefined || props.availability !== "available" ||
                    !element.isConnected || element.getClientRects().length === 0 ||
                    getComputedStyle(element).visibility !== "visible" ? undefined : Object.freeze({
                      ...target.association, placementId: props.placementId,
                      sourceRecordId: row.sourceRecordId, sourceRevision: row.sourceRevision,
                      frame: props.pinFrame,
                    }),
                });
              }}>
              <Card size="sm" className="w-full">
                <CardHeader><CardTitle>{label}</CardTitle>
                  {target.kind === "external" && target.description ?
                    <CardDescription>{target.description}</CardDescription> : null}
                </CardHeader>
                {target.kind === "unavailable" || props.openTile === undefined ? null : <CardContent>
                  <Button variant="link" onClick={() => { void props.openTile?.(row.sourceRecordId, row.sourceRevision); }}>
                    Open<span className="sr-only"> {label}{target.openBehaviour === "new_page" ? " (opens in a new page)" : ""}</span>
                  </Button>
                </CardContent>}
                {events?.row_action === undefined || actionLabel === undefined ? null : <CardFooter className="mt-auto">
                  <RowActionControl recordId={row.sourceRecordId} revision={row.sourceRevision}
                    name={label} label={actionLabel} events={events} />
                </CardFooter>}
              </Card>
            </li>;
          })}
        </ul>}
      </section>}
    </DisplayStateContainer>
    {actions === null ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
  </div>;
}
