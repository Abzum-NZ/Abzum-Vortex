"use client";

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
  type RefObject,
} from "react";
import {
  describeFailure,
  recordsTableContractOrLog,
  type BoardColumnSelector,
  type PipelineStageTone,
} from "@vortex/platform/schema";
import { Badge } from "../components/badge";
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
import type { BoardBucketPayload, BoardPayload, DisplaySemanticEvent } from "./projected-data";
import { useRowEntrance } from "./row-entrance";

/** The same filters toolbar the table draws, a chunk that loads only for a board that offers filters. */
const BoardFilters = lazy(async () => ({
  default: (await import("./grid-features/column-filters")).FiltersToolbar,
}));

/** Draws a card's matched Formatting rule, a chunk that loads only for a board that has Formatting. */
const BoardCardFormat = lazy(async () => ({
  default: (await import("./grid-features/conditional-format")).BoardCardFormat,
}));

/**
 * What a column read answers: accepted, refused (a real failure), or deferred (put off because the
 * page was busy; the board reads the column again once it is idle).
 */
type BoardColumnReadOutcome = void | boolean | "deferred";

type BoardBucket = Readonly<{
  key: string;
  label: string;
  selector: BoardColumnSelector;
  values: BoardBucketPayload;
  /** The stages a card in this bucket may move to. */
  moves: readonly string[];
  /** The pipeline stage a column is: its colour role, its owning action and whether a new record may start there. */
  stage?: Readonly<{ tone: PipelineStageTone; gatedBy?: string; addable: boolean }>;
}>;

/** Each stage colour role as its theme token; never a colour value. */
const toneClasses: Readonly<Record<PipelineStageTone, string>> = {
  neutral: "bg-muted-foreground",
  primary: "bg-primary",
  destructive: "bg-destructive",
  chart_1: "bg-chart-1",
  chart_2: "bg-chart-2",
  chart_3: "bg-chart-3",
  chart_4: "bg-chart-4",
  chart_5: "bg-chart-5",
};

/** Whether the pipeline lets a card in one bucket move to another column. */
const mayMove = (from: BoardBucket | undefined, to: BoardBucket): boolean =>
  to.selector.kind === "option" &&
  from !== undefined &&
  from.key !== to.key &&
  from.moves.includes(to.selector.value);

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
  /** The bucket a card is being dragged from, so each column can show whether it may go there. */
  draggingFrom: BoardBucket | undefined;
  setDraggingFrom: (bucket: BoardBucket | undefined) => void;
}>;

const countText = (count: number): string => formatLocaleNumber(count);

function MetricValue({
  value,
}: Readonly<{ value: BoardBucketPayload["aggregates"][number]["value"] }>): ReactElement {
  return value.kind === "unavailable" ? (
    <span role="status">Unavailable</span>
  ) : (
    <DisplayCellView value={value} />
  );
}

/** A column's own totals as compact muted lines in its header, never a card inside the column. */
function ColumnMetrics({
  metrics,
}: Readonly<{ metrics: BoardBucketPayload["aggregates"] }>): ReactElement | null {
  if (metrics.length === 0) return null;
  return (
    <div role="group" aria-label="Totals" className="flex flex-col">
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

type BoardRowAction = Readonly<{ eventId: string; label: string }>;

function BoardColumn({
  bucket,
  wipLimit,
  active,
  cardFieldIds,
  formatting,
  emptyMessage,
  events,
  rowActions,
  pending,
  anyPending,
  failed,
  onContinue,
  mover,
  choiceFieldId,
  onRetry,
  onAdd,
}: Readonly<{
  bucket: BoardBucket;
  /** The cards the column should not exceed; undefined when the board sets no limit. */
  wipLimit: number | undefined;
  /** On a phone only the active column shows; a wider screen shows them all. */
  active: boolean;
  cardFieldIds: readonly string[];
  /** The styles cards name through their format; absent when the board has no Formatting. */
  formatting: BoardPayload["formatting"];
  emptyMessage: string;
  events: DisplayRenderProps<BoardPayload>["events"];
  /** The grid's declared row actions; a card offers each one, by its own event identity. */
  rowActions: readonly BoardRowAction[];
  pending: boolean;
  anyPending: boolean;
  failed: boolean;
  onContinue: (bucket: BoardBucket, continuationToken: string) => Promise<void>;
  mover: BoardMover | undefined;
  choiceFieldId: string;
  onRetry: (bucket: BoardBucket) => void;
  /** Adds a card with this column's stage chosen; absent unless the board offers quick add. */
  onAdd: ((bucket: BoardBucket) => void) | undefined;
}>): ReactElement {
  const page = bucket.values.page;
  const canContinue =
    events?.page_changed !== undefined && page?.nextContinuationToken !== undefined;
  // While a card is dragged, every other column says whether the pipeline lets it go there.
  const from = mover?.draggingFrom;
  const dropAllowed = from !== undefined && mayMove(from, bucket);
  const dropRefused = from !== undefined && from.key !== bucket.key && !dropAllowed;
  return (
    <div
      className={`flex min-w-64 flex-1 basis-64 flex-col gap-3 transition-opacity max-md:min-w-0 max-md:basis-full ${
        active ? "" : "max-md:hidden"
      } ${dropRefused ? "opacity-50" : dropAllowed ? "ring-2 ring-ring" : ""}`}
      data-vortex-board-column="true"
      data-vortex-board-key={bucket.key}
      data-vortex-board-state={pending ? "reading" : bucket.values.state}
      data-vortex-board-drop={dropAllowed ? "allowed" : dropRefused ? "refused" : undefined}
      {...(mover === undefined || bucket.selector.kind !== "option"
        ? {}
        : {
            onDragOver: (event: DragEvent) => {
              if (mover.dragged.current !== undefined && dropAllowed) event.preventDefault();
            },
            onDrop: (event: DragEvent) => {
              const card = mover.dragged.current;
              if (card === undefined || !dropAllowed) return;
              event.preventDefault();
              mover.dragged.current = undefined;
              mover.setDraggingFrom(undefined);
              void mover.move(card, bucket);
            },
          })}
    >
      <header className="flex flex-col gap-1">
        <h3 className="m-0 flex items-center gap-2 font-medium">
          {bucket.stage === undefined ? null : (
            <span
              aria-hidden="true"
              className={`h-4 w-1 shrink-0 ${toneClasses[bucket.stage.tone]}`}
            />
          )}
          {bucket.label}
          {onAdd === undefined || bucket.stage?.addable !== true ? null : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              aria-label={`Add a card to ${bucket.label}`}
              data-vortex-board-add={bucket.key}
              onClick={() => onAdd(bucket)}
            >
              <Icon name="plus" />
            </Button>
          )}
        </h3>
        {bucket.values.rowCount === null ? null : (
          <p className="m-0 text-muted-foreground">
            {countText(bucket.values.rowCount)}{" "}
            {bucket.values.rowCount === 1 ? "record" : "records"}
            {wipLimit === undefined || bucket.selector.kind !== "option"
              ? null
              : ` of ${countText(wipLimit)}`}
          </p>
        )}
        {bucket.values.rowCount !== null &&
        wipLimit !== undefined &&
        bucket.selector.kind === "option" &&
        bucket.values.rowCount > wipLimit ? (
          <Badge variant="destructive" role="status" data-vortex-board-over-limit="true">
            Over the limit of {countText(wipLimit)} cards
          </Badge>
        ) : null}
        <ColumnMetrics metrics={bucket.values.aggregates} />
        {dropRefused ? (
          <p role="status" className="m-0 text-sm text-muted-foreground">
            {from.label} can&apos;t move here.
          </p>
        ) : null}
      </header>
      <div className="flex flex-col gap-3">
        {page === null ? (
          pending ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading cards…
            </p>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={anyPending || events?.page_changed === undefined}
              onClick={() => onRetry(bucket)}
            >
              Show cards
              {bucket.values.rowCount === null ? "" : ` (${countText(bucket.values.rowCount)})`}
            </Button>
          )
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
              const cardStyle =
                row.format === undefined ? undefined : formatting?.styles[row.format.row];
              const cardElement = (
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
                          mover.setDraggingFrom(bucket);
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", accessibleTitle);
                        },
                        onDragEnd: () => {
                          mover.dragged.current = undefined;
                          mover.setDraggingFrom(undefined);
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
                    {(events?.row_action === undefined || rowActions.length === 0) &&
                    !movable ? null : (
                      <CardAction>
                        <CardActionsMenu
                          card={card}
                          from={bucket}
                          name={accessibleTitle}
                          events={events}
                          rowActions={rowActions}
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
                        <div
                          key={field.key}
                          role="group"
                          aria-label={`${field.label}: ${cellValueToText(field.value)}`}
                          className="min-w-0 text-sm text-muted-foreground"
                        >
                          <div className="min-w-0 break-words">
                            <DisplayCellView value={field.value} />
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  ) : null}
                </Card>
              );
              return (
                <li key={row.recordId} data-vortex-board-card="">
                  {cardStyle === undefined ? (
                    cardElement
                  ) : (
                    <Suspense fallback={cardElement}>
                      <BoardCardFormat style={cardStyle}>{cardElement}</BoardCardFormat>
                    </Suspense>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {pending && page !== null ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading more cards…
          </p>
        ) : null}
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load cards.{" "}
            <Button variant="link" size="sm" disabled={anyPending} onClick={() => onRetry(bucket)}>
              Try again
            </Button>
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
  from,
  name,
  events,
  rowActions,
  mover,
  disabled,
}: Readonly<{
  card: BoardMoveCard;
  /** The column the card is in: its pipeline stage decides where the card may move. */
  from: BoardBucket;
  name: string;
  events: DisplayRenderProps<BoardPayload>["events"];
  rowActions: readonly BoardRowAction[];
  mover: BoardMover | undefined;
  disabled: boolean;
}>): ReactElement | null {
  const onRowAction = rowActions.length === 0 ? undefined : events?.row_action;
  const targets = mover?.targets.filter((target) => mayMove(from, target)) ?? [];
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
        {onRowAction === undefined
          ? null
          : rowActions.map((action) => (
              <DropdownMenuItem
                key={action.eventId}
                onClick={() =>
                  onRowAction({
                    event: "row_action",
                    eventId: action.eventId,
                    recordId: card.recordId,
                    revision: card.revision,
                  })
                }
              >
                {action.label}
              </DropdownMenuItem>
            ))}
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

/**
 * The Data grid in Board mode: a card board of the projected columns that requests one declared
 * column page at a time. It is the grid's own view, not a second block.
 */
export function BoardView(props: DisplayRenderProps<BoardPayload>): ReactElement {
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
  // The board's cards offer the grid's own declared row actions, each by its event identity.
  const contract = recordsTableContractOrLog(props.settings, "board display");
  const rowActions: readonly BoardRowAction[] = contract?.features.rowActions.enabled
    ? contract.rowBehaviours.rowActions
    : [];
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set());
  const [failedKeys, setFailedKeys] = useState<ReadonlySet<string>>(new Set());
  // Columns whose read was put off because the page was busy or another read of this board was in
  // flight: not a failure, they are read again as soon as the board is idle.
  const [deferredKeys, setDeferredKeys] = useState<ReadonlySet<string>>(new Set());
  const visibleKeysRef = useRef<Set<string>>(new Set());
  const pendingKeyRef = useRef<string | undefined>(undefined);
  const pageChanged = events?.page_changed as
    | ((event: DisplaySemanticEvent) => BoardColumnReadOutcome | Promise<BoardColumnReadOutcome>)
    | undefined;
  const cardMoved = events?.card_moved as
    ((event: DisplaySemanticEvent) => void | boolean | Promise<void | boolean>) | undefined;
  const cardAdded = events?.card_added as
    ((event: DisplaySemanticEvent) => void | boolean | Promise<void | boolean>) | undefined;
  const [moving, setMoving] = useState<BoardMoveCard>();
  const movingRef = useRef(false);
  const focusAfterMoveRef = useRef<string | undefined>(undefined);
  const draggedRef = useRef<BoardMoveCard | undefined>(undefined);
  const [draggingFrom, setDraggingFrom] = useState<BoardBucket>();
  const [chosenKey, setChosenKey] = useState<string>();
  const columnsRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ start: false, end: false });
  useEffect(() => {
    const element = columnsRef.current;
    if (element === null) return;
    const update = (): void => {
      const start = element.scrollLeft > 1;
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setOverflow((held) => (held.start === start && held.end === end ? held : { start, end }));
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const content = element.firstElementChild;
    if (content !== null) observer.observe(content);
    element.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, [values]);

  const buckets: BoardBucket[] =
    values === undefined
      ? []
      : [
          ...values.columns.map((column) => ({
            key: `option:${column.value}`,
            label: column.label,
            selector: { kind: "option" as const, value: column.value },
            values: column,
            moves: column.moves,
            stage: {
              tone: column.tone,
              ...(column.gatedBy === undefined ? {} : { gatedBy: column.gatedBy }),
              addable: column.addable,
            },
          })),
          // A required stage hides Unassigned once a read finds it empty; until then it is unknown.
          ...(values.choiceFieldRequired && values.unassigned.rowCount === 0
            ? []
            : [
                {
                  key: "unassigned",
                  label: "Unassigned",
                  selector: { kind: "unassigned" as const },
                  values: values.unassigned,
                  moves: values.unassigned.moves,
                },
              ]),
        ];

  // A phone shows one column at a time; the chosen column stays while it still exists.
  const activeKey = buckets.some((bucket) => bucket.key === chosenKey)
    ? chosenKey
    : buckets[0]?.key;

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
      !mayMove(
        buckets.find((bucket) => bucket.key === card.bucketKey),
        target,
      ) ||
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
          draggingFrom,
          setDraggingFrom,
        };

  const readBuckets = useCallback(
    async (targets: readonly BoardBucket[], continuationToken?: string): Promise<void> => {
      if (pageChanged === undefined || pendingKeyRef.current !== undefined || targets.length === 0)
        return;
      const keys = new Set(targets.map((bucket) => bucket.key));
      const key = targets[0]!.key;
      pendingKeyRef.current = key;
      setPendingKeys(keys);
      setFailedKeys((current) => new Set([...current].filter((candidate) => !keys.has(candidate))));
      try {
        const accepted = await Promise.resolve(
          pageChanged({
            event: "page_changed",
            columns: targets.map((bucket) => bucket.selector),
            ...(continuationToken === undefined ? {} : { continuationToken }),
          }),
        );
        if (accepted === "deferred") setDeferredKeys((current) => new Set([...current, ...keys]));
        else {
          setDeferredKeys(
            (current) => new Set([...current].filter((candidate) => !keys.has(candidate))),
          );
          if (accepted === false) setFailedKeys((current) => new Set([...current, ...keys]));
        }
      } catch (error) {
        console.error("[board] column read failed", error);
        setFailedKeys((current) => new Set([...current, ...keys]));
      } finally {
        pendingKeyRef.current = undefined;
        setPendingKeys(new Set());
      }
    },
    [pageChanged],
  );

  // The viewport clips the horizontal scroller and hidden phone columns. Batch newly visible
  // placeholders into one bounded read; loaded columns keep their independent pages and cursors.
  // One observer per payload: it reads the current columns through a ref, not once per render.
  const unreadRef = useRef({ buckets, failedKeys, readBuckets });
  unreadRef.current = { buckets, failedKeys, readBuckets };
  useEffect(() => {
    const section = cardsRef.current;
    if (section === null || pageChanged === undefined) return;
    const visible = visibleKeysRef.current;
    visible.clear();
    let frame: number | undefined;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.vortexBoardKey!;
        if (
          entry.isIntersecting &&
          entry.intersectionRect.width > 0 &&
          entry.intersectionRect.height > 0
        )
          visible.add(key);
        else visible.delete(key);
      }
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const { buckets, failedKeys, readBuckets } = unreadRef.current;
        const unread = buckets.filter(
          (bucket) =>
            visible.has(bucket.key) &&
            bucket.values.state === "unread" &&
            !failedKeys.has(bucket.key),
        );
        void readBuckets(unread);
      });
    });
    for (const node of section.querySelectorAll("[data-vortex-board-key]")) observer.observe(node);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [values, pageChanged]);

  // A deferred column is read again once the board is idle and the column is still on screen.
  useEffect(() => {
    if (deferredKeys.size === 0 || pendingKeys.size > 0) return;
    const timer = setTimeout(() => {
      const { buckets, readBuckets } = unreadRef.current;
      const again = buckets.filter(
        (bucket) =>
          deferredKeys.has(bucket.key) &&
          visibleKeysRef.current.has(bucket.key) &&
          bucket.values.state === "unread",
      );
      if (again.length === 0) setDeferredKeys(new Set());
      else void readBuckets(again);
    }, 250);
    return () => clearTimeout(timer);
  }, [deferredKeys, pendingKeys]);

  const addCard = (bucket: BoardBucket): void => {
    if (
      cardAdded === undefined ||
      values === undefined ||
      bucket.selector.kind !== "option" ||
      bucket.stage?.addable !== true
    )
      return;
    void Promise.resolve(
      cardAdded({
        event: "card_added",
        field: values.choiceFieldKey,
        value: bucket.selector.value,
      }),
    ).catch((error: unknown) =>
      console.error(`[board] card add failed: ${describeFailure(error)}`),
    );
  };

  const continueBucket = (bucket: BoardBucket, continuationToken: string): Promise<void> =>
    readBuckets([bucket], continuationToken);

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
          {values.filters === undefined ? null : (
            <Suspense fallback={null}>
              <BoardFilters
                context={{
                  accessibleName,
                  features: { columnFilters: values.filters.fields },
                  narrowing: { search: null, filters: values.filters.applied },
                  events,
                }}
              />
            </Suspense>
          )}
          <div
            className="flex gap-2 overflow-x-auto md:hidden"
            role="group"
            aria-label={`${accessibleName} column`}
          >
            {buckets.map((bucket) => (
              <Button
                key={bucket.key}
                type="button"
                size="sm"
                variant={bucket.key === activeKey ? "default" : "outline"}
                aria-pressed={bucket.key === activeKey}
                onClick={() => setChosenKey(bucket.key)}
              >
                {bucket.label}
                {bucket.values.rowCount === null ? "" : ` (${countText(bucket.values.rowCount)})`}
              </Button>
            ))}
          </div>
          <div className="relative min-w-0">
            {overflow.start ? (
              <div className="pointer-events-none absolute inset-y-0 left-0 z-10 flex w-12 items-center bg-linear-to-r from-background to-transparent max-md:hidden">
                <Button
                  variant="secondary"
                  size="icon-sm"
                  className="pointer-events-auto"
                  aria-label="Scroll to previous columns"
                  onClick={() =>
                    columnsRef.current?.scrollBy({
                      left: -320,
                      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                        ? "instant"
                        : "smooth",
                    })
                  }
                >
                  <Icon name="chevron-left" aria-hidden="true" />
                </Button>
              </div>
            ) : null}
            {overflow.end ? (
              <div className="pointer-events-none absolute inset-y-0 right-0 z-10 flex w-12 items-center justify-end bg-linear-to-l from-background to-transparent max-md:hidden">
                <Button
                  variant="secondary"
                  size="icon-sm"
                  className="pointer-events-auto"
                  aria-label="Scroll to next columns"
                  onClick={() =>
                    columnsRef.current?.scrollBy({
                      left: 320,
                      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                        ? "instant"
                        : "smooth",
                    })
                  }
                >
                  <Icon name="chevron-right" aria-hidden="true" />
                </Button>
              </div>
            ) : null}
            <div
              ref={columnsRef}
              className="relative min-w-0 overflow-x-auto"
              role="region"
              aria-label={`${accessibleName} columns`}
              tabIndex={0}
            >
              <div className="flex min-w-max items-start gap-3 pb-2 max-md:min-w-0">
                {buckets.map((bucket) => (
                  <BoardColumn
                    key={bucket.key}
                    bucket={bucket}
                    wipLimit={values.wipLimit}
                    active={bucket.key === activeKey}
                    cardFieldIds={values.cardFieldIds}
                    formatting={values.formatting}
                    emptyMessage={emptyMessage}
                    events={events}
                    rowActions={rowActions}
                    pending={pendingKeys.has(bucket.key)}
                    anyPending={pendingKeys.size > 0}
                    failed={failedKeys.has(bucket.key)}
                    onContinue={continueBucket}
                    onRetry={(bucket) => void readBuckets([bucket])}
                    onAdd={values.quickAdd && cardAdded !== undefined ? addCard : undefined}
                    mover={mover}
                    choiceFieldId={values.choiceFieldId}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>
      )}
    </DisplayStateContainer>
  );
}
