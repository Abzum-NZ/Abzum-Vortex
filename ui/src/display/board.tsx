"use client";

import { useRef, useState, type ReactElement } from "react";
import type { BoardColumnSelector } from "@vortex/contracts";
import { Button } from "../components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/card";
import { cellValueToText, DisplayCellView } from "./cell";
import { DisplayHeader, RowActionControl } from "./controls";
import { resolveDisplayContext, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import type { BoardBucketPayload, BoardPayload, DisplaySemanticEvent } from "./projected-data";

type BoardBucket = Readonly<{
  key: string;
  label: string;
  selector: BoardColumnSelector;
  values: BoardBucketPayload;
}>;

const countText = (count: number): string => new Intl.NumberFormat("en").format(count);

function BoardMetrics({
  metrics,
}: Readonly<{ metrics: BoardPayload["aggregates"] }>): ReactElement | null {
  if (metrics.length === 0) return null;
  return (
    <dl className="grid gap-2 sm:grid-cols-2" aria-label="Protected totals">
      {metrics.map((metric) => (
        <Card
          key={metric.key}
          size="sm"
          className="gap-1 px-(--card-spacing)"
          data-vortex-board-metric="true"
        >
          <dt className="text-sm text-muted-foreground">{metric.label}</dt>
          <dd className="font-heading text-base font-medium">
            {metric.value.kind === "unavailable" ? (
              <span role="status">Unavailable</span>
            ) : (
              <DisplayCellView value={metric.value} />
            )}
          </dd>
        </Card>
      ))}
    </dl>
  );
}

function BoardColumn({
  bucket,
  cardFieldIds,
  emptyMessage,
  events,
  pending,
  anyPending,
  failed,
  onContinue,
}: Readonly<{
  bucket: BoardBucket;
  cardFieldIds: readonly string[];
  emptyMessage: string;
  events: DisplayRenderProps<BoardPayload>["events"];
  pending: boolean;
  anyPending: boolean;
  failed: boolean;
  onContinue: (bucket: BoardBucket, continuationToken: string) => Promise<void>;
}>): ReactElement {
  const page = bucket.values.page;
  const canContinue =
    events?.page_changed !== undefined && page?.nextContinuationToken !== undefined;
  return (
    <Card className="min-w-64 flex-1 basis-64 gap-0" data-vortex-board-column="true">
      <CardHeader className="border-b">
        <CardTitle>{bucket.label}</CardTitle>
        <CardDescription>
          {countText(bucket.values.rowCount)} {bucket.values.rowCount === 1 ? "record" : "records"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-3">
        <BoardMetrics metrics={bucket.values.aggregates} />
        {page === null ? (
          <p className="text-sm text-muted-foreground" role="status">
            Cards have not been loaded.
          </p>
        ) : page.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" role="status">
            {emptyMessage}
          </p>
        ) : (
          <ul className="flex list-none flex-col gap-2 p-0">
            {page.rows.map((row) => {
              const fieldById = new Map(
                row.fields.map((field) => [field.key.toLowerCase(), field] as const),
              );
              const titleField = fieldById.get(bucketCardTitle(cardFieldIds));
              const title =
                titleField === undefined ? "" : cellValueToText(titleField.value).trim();
              const accessibleTitle = title.length > 0 ? title : "untitled item";
              const details = cardFieldIds.slice(1).flatMap((fieldId) => {
                const field = fieldById.get(fieldId.toLowerCase());
                return field === undefined ? [] : [field];
              });
              return (
                <li key={row.recordId}>
                  <Card size="sm" className="gap-0">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base">
                        {titleField === undefined || title.length === 0 ? (
                          "Untitled item"
                        ) : (
                          <DisplayCellView value={titleField.value} />
                        )}
                      </CardTitle>
                      {events?.row_action === undefined ? null : (
                        <CardAction>
                          <RowActionControl
                            recordId={row.recordId}
                            revision={row.revision}
                            name={accessibleTitle}
                            events={events}
                          />
                        </CardAction>
                      )}
                    </CardHeader>
                    {details.length === 0 ? null : (
                      <CardContent className="pt-0">
                        <dl className="grid gap-2">
                          {details.map((field) => (
                            <div key={field.key} className="grid gap-0.5">
                              <dt className="text-xs text-muted-foreground">{field.label}</dt>
                              <dd className="text-sm">
                                <DisplayCellView value={field.value} />
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </CardContent>
                    )}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
        {pending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading more cards…
          </p>
        ) : null}
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load more cards. Refresh and try again.
          </p>
        ) : null}
        {canContinue ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={anyPending}
            onClick={() => {
              const token = page?.nextContinuationToken;
              if (token !== undefined) void onContinue(bucket, token);
            }}
          >
            Show more
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

const bucketCardTitle = (cardFieldIds: readonly string[]): string =>
  cardFieldIds[0]?.toLowerCase() ?? "";

/** Installed query-bound board; it renders projected values and requests one declared bucket page. */
export function BoardDisplay(props: DisplayRenderProps<BoardPayload>): ReactElement {
  const { placementId, availability } = props;
  const {
    title,
    accessibleName,
    values,
    state,
    emptyMessage,
    refusedMessage,
    errorMessage,
    events,
  } = resolveDisplayContext<BoardPayload>(props, () => false, "No records to show");
  const [pendingKey, setPendingKey] = useState<string>();
  const [failedKey, setFailedKey] = useState<string>();
  const pendingKeyRef = useRef<string | undefined>(undefined);
  const pageChanged = events?.page_changed as
    ((event: DisplaySemanticEvent) => void | boolean | Promise<void | boolean>) | undefined;

  const buckets: BoardBucket[] =
    values === undefined
      ? []
      : [
          ...values.columns.map((column) => ({
            key: `option:${column.value}`,
            label: column.label,
            selector: { kind: "option" as const, value: column.value },
            values: column,
          })),
          {
            key: "unassigned",
            label: "Unassigned",
            selector: { kind: "unassigned" },
            values: values.unassigned,
          },
        ];

  const continueBucket = async (bucket: BoardBucket, continuationToken: string): Promise<void> => {
    if (pageChanged === undefined || pendingKeyRef.current !== undefined) return;
    const key = bucket.key;
    pendingKeyRef.current = key;
    setPendingKey(key);
    setFailedKey(undefined);
    try {
      const result = await Promise.resolve(
        pageChanged({ event: "page_changed", column: bucket.selector, continuationToken }),
      );
      if (result === false) setFailedKey(key);
    } catch {
      setFailedKey(key);
    } finally {
      if (pendingKeyRef.current === key) pendingKeyRef.current = undefined;
      setPendingKey((current) => (current === key ? undefined : current));
    }
  };

  return (
    <DisplayStateContainer
      accessibleName={accessibleName}
      availability={availability}
      projectedData={state}
      emptyMessage={emptyMessage}
      {...(refusedMessage === undefined ? {} : { refusedMessage })}
      {...(errorMessage === undefined ? {} : { errorMessage })}
    >
      {values === undefined ? null : (
        <section
          data-vortex-display="board"
          data-vortex-placement-id={placementId}
          className="flex min-w-0 flex-col gap-3"
          aria-label={accessibleName}
        >
          <DisplayHeader title={title} accessibleName={accessibleName} events={events} />
          <p className="text-sm text-muted-foreground">
            {countText(values.totalRowCount)} {values.totalRowCount === 1 ? "record" : "records"}
          </p>
          <BoardMetrics metrics={values.aggregates} />
          <div
            className="min-w-0 overflow-x-auto"
            role="region"
            aria-label={`${accessibleName} columns`}
            tabIndex={0}
          >
            <div className="flex min-w-max items-start gap-3 pb-2">
              {buckets.map((bucket) => (
                <BoardColumn
                  key={bucket.key}
                  bucket={bucket}
                  cardFieldIds={values.cardFieldIds}
                  emptyMessage={emptyMessage}
                  events={events}
                  pending={pendingKey === bucket.key}
                  anyPending={pendingKey !== undefined}
                  failed={failedKey === bucket.key}
                  onContinue={continueBucket}
                />
              ))}
            </div>
          </div>
        </section>
      )}
    </DisplayStateContainer>
  );
}
