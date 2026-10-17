"use client";

import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { describeFailure, type BoardColumnSelector } from "@vortex/platform/schema";
import { Button } from "../components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "../components/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { Icon } from "../icons/icon";
import { cellValueToText, DisplayCellView } from "./cell";
import { formatLocaleNumber } from "./date-format";
import { DisplayHeader } from "./controls";
import { resolveDisplayContext, type DisplayRenderProps } from "./context";
import { DisplayStateContainer } from "./display-state-container";
import { MetricCard } from "./metric-card";
import type { BoardBucketPayload, BoardPayload, DisplaySemanticEvent } from "./projected-data";
import { useRowEntrance } from "./row-entrance";

type BoardBucket = Readonly<{
  key: string;
  label: string;
  selector: BoardColumnSelector;
  values: BoardBucketPayload;
}>;

/** The card a move acts on: its record, the revision it was read at and the column it sits in. */
type BoardMoveCard = Readonly<{
  recordId: string;
  revision: number;
  bucketKey: string;
}>;

/** What a column needs to offer moves: the columns a card may go to and the move in flight. */
type BoardMover = Readonly<{
  targets: readonly BoardBucket[];
  movingRecordId: string | undefined;
  move: (card: BoardMoveCard, target: BoardBucket) => Promise<void>;
  dragged: RefObject<BoardMoveCard | undefined>;
}>;

const countText = (count: number): string => formatLocaleNumber(count);

function MetricValue({
  value,
}: Readonly<{ value: BoardPayload["aggregates"][number]["value"] }>): ReactElement {
  return value.kind === "unavailable" ? (
    <span role="status">Unavailable</span>
  ) : (
    <DisplayCellView value={value} />
  );
}

function BoardMetrics({
  metrics,
}: Readonly<{ metrics: BoardPayload["aggregates"] }>): ReactElement | null {
  if (metrics.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="Protected totals">
      {metrics.map((metric) => (
        <MetricCard key={metric.key} label={metric.label} data-vortex-board-metric="true">
          <MetricValue value={metric.value} />
        </MetricCard>
      ))}
    </div>
  );
}

/** A column's own totals as compact muted lines in its header, never a card inside the column. */
function ColumnMetrics({
  metrics,
}: Readonly<{ metrics: BoardPayload["aggregates"] }>): ReactElement | null {
  if (metrics.length === 0) return null;
  return (
    <div role="group" aria-label="Protected totals" className="flex flex-col">
      {metrics.map((metric) => (
        <p key={metric.key} className="m-0 text-muted-foreground" data-vortex-board-metric="true">
          {metric.label}:{" "}
          <span className="font-medium text-foreground">
            <MetricValue value={metric.value} />
          </span>
        </p>
      ))}
    </div>
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
  mover,
  choiceFieldId,
}: Readonly<{
  bucket: BoardBucket;
  cardFieldIds: readonly string[];
  emptyMessage: string;
  events: DisplayRenderProps<BoardPayload>["events"];
  pending: boolean;
  anyPending: boolean;
  failed: boolean;
  onContinue: (bucket: BoardBucket, continuationToken: string) => Promise<void>;
  mover: BoardMover | undefined;
  choiceFieldId: string;
}>): ReactElement {
  const page = bucket.values.page;
  const canContinue =
    events?.page_changed !== undefined && page?.nextContinuationToken !== undefined;
  return (
    <div
      className="flex min-w-64 flex-1 basis-64 flex-col gap-3"
      data-vortex-board-column="true"
      {...(mover === undefined || bucket.selector.kind !== "option"
        ? {}
        : {
            onDragOver: (event: DragEvent) => {
              if (mover.dragged.current !== undefined) event.preventDefault();
            },
            onDrop: (event: DragEvent) => {
              const card = mover.dragged.current;
              if (card === undefined) return;
              event.preventDefault();
              mover.dragged.current = undefined;
              void mover.move(card, bucket);
            },
          })}
    >
      <header className="flex flex-col">
        <h3 className="m-0 font-medium">{bucket.label}</h3>
        <p className="m-0 text-muted-foreground">
          {countText(bucket.values.rowCount)} {bucket.values.rowCount === 1 ? "record" : "records"}
        </p>
        <ColumnMetrics metrics={bucket.values.aggregates} />
      </header>
      <div className="flex flex-col gap-3">
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
              const card: BoardMoveCard = {
                recordId: row.recordId,
                revision: row.revision,
                bucketKey: bucket.key,
              };
              const moving = mover?.movingRecordId === row.recordId;
              // Only a card whose row capabilities let the viewer change the choice field can move;
              // the server still refuses any other move.
              const movable =
                mover !== undefined &&
                row.capabilities.actions.includes("update") &&
                row.capabilities.changeableFieldIds.some(
                  (changeable) => changeable.toLowerCase() === choiceFieldId.toLowerCase(),
                );
              const idle = movable && mover.movingRecordId === undefined;
              return (
                <li key={row.recordId} data-vortex-board-card="">
                  <Card
                    size="sm"
                    className={moving ? "opacity-60" : undefined}
                    aria-busy={moving}
                    data-vortex-board-card-moving={moving ? "true" : undefined}
                    {...(idle
                      ? {
                          draggable: true,
                          onDragStart: (event: DragEvent) => {
                            mover.dragged.current = card;
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", accessibleTitle);
                          },
                          onDragEnd: () => {
                            mover.dragged.current = undefined;
                          },
                        }
                      : {})}
                  >
                    <CardHeader>
                      <CardTitle className="min-w-0 break-words">
                        {titleField === undefined || title.length === 0 ? (
                          "Untitled item"
                        ) : (
                          <DisplayCellView value={titleField.value} />
                        )}
                      </CardTitle>
                      {events?.row_action === undefined && !movable ? null : (
                        <CardAction>
                          <CardActionsMenu
                            card={card}
                            name={accessibleTitle}
                            events={events}
                            mover={movable ? mover : undefined}
                            disabled={mover?.movingRecordId !== undefined}
                          />
                        </CardAction>
                      )}
                    </CardHeader>
                    {moving || details.length > 0 ? (
                      <CardContent className="flex flex-col">
                        {moving ? (
                          <p role="status" className="m-0 text-muted-foreground">
                            Moving…
                          </p>
                        ) : null}
                        {details.map((field) => (
                          <p key={field.key} className="m-0 flex min-w-0 justify-between gap-2">
                            <span className="min-w-0 text-muted-foreground">{field.label}</span>
                            <span className="shrink-0 whitespace-nowrap text-right">
                              <DisplayCellView value={field.value} />
                            </span>
                          </p>
                        ))}
                      </CardContent>
                    ) : null}
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
      </div>
    </div>
  );
}

/**
 * The card's one actions menu: Open, plus the keyboard and pointer alternative to dragging, the
 * columns the card may move to. It is an icon trigger, so it never takes room from the title.
 */
function CardActionsMenu({
  card,
  name,
  events,
  mover,
  disabled,
}: Readonly<{
  card: BoardMoveCard;
  name: string;
  events: DisplayRenderProps<BoardPayload>["events"];
  mover: BoardMover | undefined;
  disabled: boolean;
}>): ReactElement | null {
  const onRowAction = events?.row_action;
  const targets = mover?.targets.filter((target) => target.key !== card.bucketKey) ?? [];
  if (onRowAction === undefined && targets.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Actions for ${name}`}
            disabled={disabled}
            data-vortex-board-move={card.recordId}
          />
        }
      >
        <Icon name="more-horizontal" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onRowAction === undefined ? null : (
          <DropdownMenuItem
            onClick={() =>
              onRowAction({ event: "row_action", recordId: card.recordId, revision: card.revision })
            }
          >
            Open
          </DropdownMenuItem>
        )}
        {onRowAction === undefined || targets.length === 0 ? null : <DropdownMenuSeparator />}
        {mover === undefined || targets.length === 0 ? null : (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Move to</DropdownMenuLabel>
            {targets.map((target) => (
              <DropdownMenuItem key={target.key} onClick={() => void mover.move(card, target)}>
                {target.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
  const cardMoved = events?.card_moved as
    ((event: DisplaySemanticEvent) => void | boolean | Promise<void | boolean>) | undefined;
  const [moving, setMoving] = useState<BoardMoveCard>();
  const movingRef = useRef(false);
  const focusAfterMoveRef = useRef<string | undefined>(undefined);
  const draggedRef = useRef<BoardMoveCard | undefined>(undefined);

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

  const cardsRef = useRowEntrance<HTMLElement>(
    buckets.flatMap((bucket) => bucket.values.page?.rows.map((row) => row.recordId) ?? []),
    "[data-vortex-board-card]",
  );

  const releaseMove = (): void => {
    movingRef.current = false;
    setMoving(undefined);
  };

  // An accepted move keeps its card pending until the refreshed columns show it somewhere else (or
  // at a newer revision); a refused move is released by the handler's answer instead.
  useEffect(() => {
    if (moving === undefined) return;
    for (const bucket of buckets)
      for (const row of bucket.values.page?.rows ?? [])
        if (row.recordId === moving.recordId) {
          if (bucket.key === moving.bucketKey && row.revision === moving.revision) return;
          releaseMove();
          return;
        }
    releaseMove();
  });

  // Whether the move was saved, refused or cancelled at a form, focus comes back to the card's own
  // Move control once the move settles, so a keyboard user continues where they were.
  useEffect(() => {
    const recordId = focusAfterMoveRef.current;
    if (recordId === undefined || moving !== undefined) return;
    focusAfterMoveRef.current = undefined;
    cardsRef.current
      ?.querySelector<HTMLElement>(`[data-vortex-board-move="${CSS.escape(recordId)}"]`)
      ?.focus();
  });

  const moveCard = async (card: BoardMoveCard, target: BoardBucket): Promise<void> => {
    if (
      cardMoved === undefined ||
      values === undefined ||
      target.selector.kind !== "option" ||
      target.key === card.bucketKey ||
      movingRef.current
    )
      return;
    movingRef.current = true;
    focusAfterMoveRef.current = card.recordId;
    setMoving(card);
    try {
      const accepted = await Promise.resolve(
        cardMoved({
          event: "card_moved",
          recordId: card.recordId,
          revision: card.revision,
          field: values.choiceFieldKey,
          value: target.selector.value,
        }),
      );
      if (accepted !== true) releaseMove();
    } catch (error) {
      console.error(`[board] card move failed: ${describeFailure(error)}`);
      releaseMove();
    }
  };

  const mover: BoardMover | undefined =
    cardMoved === undefined
      ? undefined
      : {
          targets: buckets.filter((bucket) => bucket.selector.kind === "option"),
          movingRecordId: moving?.recordId,
          move: moveCard,
          dragged: draggedRef,
        };

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
          ref={cardsRef}
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
            className="relative min-w-0 overflow-x-auto"
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
                  mover={mover}
                  choiceFieldId={values.choiceFieldId}
                />
              ))}
            </div>
          </div>
        </section>
      )}
    </DisplayStateContainer>
  );
}
