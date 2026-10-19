"use client";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { ArrowDown, ArrowUp, ChevronRight, CircleAlert, GripVertical, Trash2 } from "lucide-react";
import { Button } from "../components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { cn } from "../lib/utils";

/** Editor-only identities. Callers carry these keys alongside insertions, removals and moves. */
export function useStudioEntryKeys(count: number) {
  const prefix = useId();
  const keys = useRef<string[]>([]);
  const sequence = useRef(0);
  const newKey = () => `${prefix}-${(sequence.current += 1)}`;
  // An externally replaced list has no known correspondence with the previous editor rows.
  if (keys.current.length !== count) keys.current = Array.from({ length: count }, newKey);
  return { keys, newKey };
}

/** A small repeated action drawn as an icon, named by its tooltip and accessible label. */
export function StudioIconButton({
  label,
  disabled,
  destructive = false,
  onClick,
  children,
}: Readonly<{
  label: string;
  disabled?: boolean | undefined;
  destructive?: boolean;
  onClick: () => void;
  children: ReactNode;
}>): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            disabled={disabled}
            className={destructive ? "hover:text-destructive" : undefined}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export type StudioEntryListItem = Readonly<{
  /** Stable while the entry exists, so its open state and inputs survive reordering. */
  key: string;
  title: string;
  /** One line under the title, such as the field a column shows. */
  summary?: string | undefined;
  /** The entry's settings, shown in its row while it is open. Absent: the row does not open. */
  content?: ReactNode;
  /** The entry holds a problem; its row says so while it is closed. */
  invalid?: boolean | undefined;
}>;

/**
 * Studio's one repeated-item editor: a flat list of rows, each with a drag handle, its name and a
 * one-line summary, and icon actions shown on hover or focus. One row is open at a time, with its
 * settings inline. Alt+Arrow keys on a row move it.
 */
export function StudioEntryList({
  label,
  itemName,
  items,
  disabled = false,
  empty,
  onMove,
  onRemove,
  children,
}: Readonly<{
  /** The list's accessible name. */
  label: string;
  /** What one entry is called, in lower case: "column" gives "Move column up", "Remove column". */
  itemName: string;
  items: readonly StudioEntryListItem[];
  disabled?: boolean;
  empty?: string | undefined;
  onMove?: ((from: number, to: number) => void) | undefined;
  onRemove?: ((index: number) => void) | undefined;
  /** The add affordance, after the rows. */
  children?: ReactNode;
}>): ReactElement {
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const headings = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterMove = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (focusAfterMove.current === null) return;
    headings.current.get(focusAfterMove.current)?.focus();
    focusAfterMove.current = null;
  }, [items]);
  const seen = useRef(items.map((item) => item.key));
  // A newly added entry opens, so its settings can be filled in at once.
  useEffect(() => {
    const before = seen.current;
    seen.current = items.map((item) => item.key);
    const added = items.filter((item) => !before.includes(item.key));
    if (added.length === 1 && items.length > before.length && added[0]!.content !== undefined)
      setOpen(added[0]!.key);
  }, [items]);
  const movable = onMove !== undefined && !disabled;
  const move = (from: number, to: number) => {
    if (movable && to >= 0 && to < items.length && to !== from) {
      focusAfterMove.current = items[from]!.key;
      onMove(from, to);
    }
  };
  return (
    <div className="space-y-1">
      {items.length === 0 && empty !== undefined && (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
      <ul aria-label={label} className="m-0 list-none space-y-px p-0">
        {items.map((item, index) => {
          const expanded = open === item.key && item.content !== undefined;
          return (
            <li
              key={item.key}
              className={cn("group/entry rounded-md", dragging === index && "opacity-50")}
              onDragOver={(event) => {
                if (dragging === null) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== null) move(dragging, index);
                setDragging(null);
              }}
            >
              <div
                className={cn(
                  "flex min-h-9 items-center gap-1 rounded-md px-1 hover:bg-muted focus-within:bg-muted",
                  expanded && "bg-muted",
                )}
              >
                {onMove !== undefined && (
                  <span
                    draggable={movable}
                    aria-hidden="true"
                    className={cn(
                      "text-muted-foreground",
                      movable ? "cursor-grab active:cursor-grabbing" : "opacity-50",
                    )}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", item.key);
                      const row = event.currentTarget.closest("li");
                      if (row !== null) event.dataTransfer.setDragImage(row, 0, 0);
                      setDragging(index);
                    }}
                    onDragEnd={() => setDragging(null)}
                  >
                    <GripVertical className="size-4" />
                  </span>
                )}
                <button
                  ref={(element) => {
                    if (element === null) headings.current.delete(item.key);
                    else headings.current.set(item.key, element);
                  }}
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border-0 bg-transparent px-0 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-expanded={item.content === undefined ? undefined : expanded}
                  aria-keyshortcuts={movable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                  onClick={() => {
                    if (item.content !== undefined) setOpen(expanded ? null : item.key);
                  }}
                  onKeyDown={(event) => {
                    if (!event.altKey) return;
                    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                      event.preventDefault();
                      move(index, event.key === "ArrowUp" ? index - 1 : index + 1);
                    }
                  }}
                >
                  {item.content !== undefined && (
                    <ChevronRight
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        expanded && "rotate-90",
                      )}
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    {item.summary !== undefined && item.summary !== "" && (
                      <span
                        className={cn(
                          "block truncate text-xs",
                          expanded
                            ? "text-foreground"
                            : "text-muted-foreground group-hover/entry:text-foreground group-focus-within/entry:text-foreground",
                        )}
                      >
                        {item.summary}
                      </span>
                    )}
                  </span>
                  {item.invalid === true && (
                    <CircleAlert
                      className="size-4 shrink-0 text-destructive"
                      aria-label="Has a problem"
                    />
                  )}
                </button>
                <span className="flex shrink-0 items-center opacity-0 group-hover/entry:opacity-100 group-focus-within/entry:opacity-100">
                  {onMove !== undefined && (
                    <>
                      <StudioIconButton
                        label={`Move ${itemName} up`}
                        disabled={!movable || index === 0}
                        onClick={() => move(index, index - 1)}
                      >
                        <ArrowUp />
                      </StudioIconButton>
                      <StudioIconButton
                        label={`Move ${itemName} down`}
                        disabled={!movable || index === items.length - 1}
                        onClick={() => move(index, index + 1)}
                      >
                        <ArrowDown />
                      </StudioIconButton>
                    </>
                  )}
                  {onRemove !== undefined && (
                    <StudioIconButton
                      label={`Remove ${itemName}`}
                      disabled={disabled}
                      destructive
                      onClick={() => onRemove(index)}
                    >
                      <Trash2 />
                    </StudioIconButton>
                  )}
                </span>
              </div>
              {item.content !== undefined && (
                <div hidden={!expanded} className="space-y-4 px-1 pt-2 pb-4">
                  {item.content}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {children}
    </div>
  );
}
