"use client";

import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Icon, type VortexIconName } from "@vortex/ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import { Button } from "@vortex/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@vortex/ui/components/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@vortex/ui/components/dropdown-menu";
import { Item } from "@vortex/ui/components/item";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@vortex/ui/components/empty";
import { cn } from "@vortex/ui/lib/utils";

type NavAction = Readonly<{
  label: string;
  icon: VortexIconName;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}>;

type NavProps = Omit<ComponentProps<"button">, "children"> &
  Readonly<{
    label: string;
    dragHandle?: ComponentProps<"button">;
    actions?: readonly NavAction[];
    moreActions?: readonly NavAction[];
    settings?: ReactNode;
    settingsOpen?: boolean;
    onSettingsOpenChange?: (open: boolean) => void;
    icon?: VortexIconName | undefined;
    meta?: ReactNode;
    description?: string | undefined;
    selected?: boolean | undefined;
    hint?: string | undefined;
    /** A branch of `StudioNavTree`: whether its children are shown, and the toggle for them. */
    expanded?: boolean | undefined;
    onToggle?: (() => void) | undefined;
    /** The id of the list of children the toggle shows, while it is shown. */
    toggleControls?: string | undefined;
    /** Marks a row of `StudioNavTree`: its key for the roving focus, and room for a chevron. */
    treeKey?: string | undefined;
  }>;

export function StudioNavEmpty({
  title,
  description,
  icon,
}: Readonly<{
  title: string;
  description: string;
  icon: VortexIconName;
}>) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon name={icon} />
        </EmptyMedia>
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        <EmptyDescription className="text-sm">{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** A single selectable row, shared by every Studio navigator. */
export function StudioNavItem({
  label,
  dragHandle,
  actions,
  moreActions,
  settings,
  settingsOpen,
  onSettingsOpenChange,
  icon,
  meta,
  description,
  selected,
  expanded,
  onToggle,
  toggleControls,
  treeKey,
  hint,
  className,
  ...props
}: NavProps) {
  const row = (
    <Item
      size="sm"
      variant="navigation"
      data-vortex-focus-primary=""
      data-two-line={description !== undefined ? "true" : undefined}
      className={cn(
        "min-w-0 flex-1 flex-nowrap text-left text-sm hover:bg-accent hover:text-accent-foreground",
        selected && "bg-accent font-medium text-accent-foreground",
        className,
      )}
      render={
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          data-tree-key={treeKey}
          {...props}
        />
      }
    >
      {icon !== undefined && (
        <Icon
          name={icon}
          className={cn(
            "size-4 shrink-0",
            selected
              ? "text-accent-foreground"
              : "text-muted-foreground group-hover/item:text-accent-foreground",
          )}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {description !== undefined && (
          <span
            className={cn(
              "block truncate text-xs font-normal",
              selected
                ? "text-accent-foreground"
                : "text-muted-foreground group-hover/item:text-accent-foreground",
            )}
          >
            {description}
          </span>
        )}
      </span>
      {meta !== undefined && (
        <span
          className={cn(
            "shrink-0 text-xs font-normal tabular-nums",
            selected
              ? "text-accent-foreground"
              : "text-muted-foreground group-hover/item:text-accent-foreground",
          )}
        >
          {meta}
        </span>
      )}
    </Item>
  );
  const selectable =
    hint === undefined ? (
      row
    ) : (
      <Tooltip>
        <TooltipTrigger render={row} />
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    );
  return (
    <div
      data-vortex-focus-group=""
      className={cn(
        "group/nav-row flex min-w-0 items-center rounded-md hover:bg-accent focus-within:bg-accent",
        selected && "bg-accent",
      )}
    >
      {onToggle !== undefined ? (
        // The row's own arrow keys expand and collapse it; this toggle serves the pointer and
        // screen readers, so it is not a second Tab stop.
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                tabIndex={-1}
                className="shrink-0"
                aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
                aria-expanded={expanded}
                aria-controls={toggleControls}
                onClick={onToggle}
              />
            }
          >
            <Icon name={expanded ? "chevron-down" : "chevron-right"} className="size-4" />
          </TooltipTrigger>
          <TooltipContent>
            {expanded ? "Collapse" : "Expand"} {label}
          </TooltipContent>
        </Tooltip>
      ) : (
        treeKey !== undefined &&
        dragHandle === undefined && <span className="size-6 shrink-0" aria-hidden="true" />
      )}
      {dragHandle !== undefined && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                {...dragHandle}
                className="shrink-0 cursor-grab active:cursor-grabbing"
                aria-label={`Move ${label}`}
              />
            }
          >
            <Icon name="grip-vertical" className="size-4" />
          </TooltipTrigger>
          <TooltipContent>Drag to move. Alt + arrow keys also move this entry.</TooltipContent>
        </Tooltip>
      )}
      {settings === undefined ? (
        selectable
      ) : (
        <Popover
          open={settingsOpen}
          onOpenChange={(open, details) => {
            // The save badge explains why an edit is not saved; pressing it or its popover must not close the editor, which would discard the edit it explains.
            const target =
              details.event instanceof FocusEvent
                ? details.event.relatedTarget
                : details.event.target;
            if (
              !open &&
              target instanceof Element &&
              target.closest("[data-studio-save-state]") !== null
            ) {
              details.cancel();
              return;
            }
            onSettingsOpenChange?.(open);
          }}
        >
          <PopoverTrigger render={selectable} />
          <PopoverContent
            side="right"
            align="start"
            className="max-h-(--available-height) w-80 overflow-y-auto"
          >
            <PopoverTitle className="mb-4">{label}</PopoverTitle>
            {settings}
          </PopoverContent>
        </Popover>
      )}
      {(actions !== undefined || moreActions !== undefined) && (
        <div className="flex shrink-0 items-center opacity-0 group-hover/nav-row:opacity-100 group-focus-within/nav-row:opacity-100 has-data-popup-open:opacity-100">
          {actions?.map((action) => (
            <Tooltip key={action.label}>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={action.label}
                    disabled={action.disabled}
                    onClick={action.onClick}
                    className={action.destructive ? "hover:text-destructive" : undefined}
                  />
                }
              >
                <Icon name={action.icon} className="size-4" />
              </TooltipTrigger>
              <TooltipContent>{action.label}</TooltipContent>
            </Tooltip>
          ))}
          {moreActions !== undefined && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`More actions for ${label}`}
                          disabled={props.disabled}
                        />
                      }
                    />
                  }
                >
                  <Icon name="more-horizontal" className="size-4" />
                </TooltipTrigger>
                <TooltipContent>More actions for {label}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-48">
                {moreActions.map((action) => (
                  <DropdownMenuItem
                    key={action.label}
                    onClick={action.onClick}
                    disabled={action.disabled}
                    variant={action.destructive ? "destructive" : "default"}
                  >
                    <Icon name={action.icon} className="size-4" />
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  );
}

export type StudioNavNode = Readonly<{
  key: string;
  label: string;
  icon?: VortexIconName | undefined;
  meta?: ReactNode;
  selected?: boolean;
  onSelect?: (() => void) | undefined;
  children?: readonly StudioNavNode[] | undefined;
  defaultExpanded?: boolean;
  props?: Omit<NavProps, "label">;
}>;

/**
 * Nested lists of rows with roving focus: the arrow keys follow the visible rows, left and right
 * collapse, expand, or visit the parent or first child. A row holds more than its button (a drag
 * handle, actions, a settings popover), which an ARIA tree does not allow, so the list carries no
 * tree roles; the selected row is `aria-current` and a branch's toggle button says `aria-expanded`.
 */
export function StudioNavTree({
  nodes,
  label,
  disabled = false,
  expandAll = false,
}: Readonly<{
  nodes: readonly StudioNavNode[];
  label: string;
  disabled?: boolean;
  expandAll?: boolean;
}>) {
  const id = useId();
  const host = useRef<HTMLUListElement>(null);
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  useEffect(() => {
    if (expandAll) setExpanded(new Map());
  }, [expandAll]);
  const isOpen = (node: StudioNavNode) =>
    expanded.get(node.key) ?? (expandAll || node.defaultExpanded !== false);
  const [focused, setFocused] = useState<string | null>(null);
  const visible: { node: StudioNavNode; parent?: string | undefined }[] = [];
  const visit = (entries: readonly StudioNavNode[], parent?: string) =>
    entries.forEach((node) => {
      visible.push({ node, parent });
      if (isOpen(node)) visit(node.children ?? [], node.key);
    });
  visit(nodes);
  const current =
    visible.find((entry) => entry.node.key === focused)?.node.key ??
    visible.find((entry) => entry.node.selected)?.node.key ??
    visible[0]?.node.key;
  const toggle = (node: StudioNavNode) =>
    setExpanded((previous) => new Map(previous).set(node.key, !isOpen(node)));
  const focus = (key: string | undefined) => {
    if (key === undefined) return;
    setFocused(key);
    const rows = host.current?.querySelectorAll<HTMLButtonElement>("[data-tree-key]");
    rows?.forEach((row) => {
      if (row.dataset.treeKey === key) row.focus();
    });
  };
  const rows = (entries: readonly StudioNavNode[], depth: number): ReactNode =>
    entries.map((node) => {
      const branch = (node.children?.length ?? 0) > 0;
      const open = branch && isOpen(node);
      const groupId = `${id}-${encodeURIComponent(node.key)}`;
      return (
        <li key={node.key}>
          <StudioNavItem
            {...node.props}
            label={node.label}
            icon={node.icon}
            meta={node.meta}
            selected={node.selected}
            treeKey={node.key}
            expanded={branch ? open : undefined}
            onToggle={branch ? () => toggle(node) : undefined}
            toggleControls={open ? groupId : undefined}
            tabIndex={node.props?.disabled || disabled ? -1 : node.key === current ? 0 : -1}
            disabled={disabled || node.props?.disabled}
            onFocus={() => setFocused(node.key)}
            onClick={() => node.onSelect?.()}
            onKeyDown={(event) => {
              node.props?.onKeyDown?.(event);
              if (
                event.defaultPrevented ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey
              )
                return;
              const index = visible.findIndex((entry) => entry.node.key === node.key);
              if (
                !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(
                  event.key,
                )
              )
                return;
              event.preventDefault();
              if (event.key === "ArrowDown") focus(visible[index + 1]?.node.key);
              if (event.key === "ArrowUp") focus(visible[index - 1]?.node.key);
              if (event.key === "Home") focus(visible[0]?.node.key);
              if (event.key === "End") focus(visible.at(-1)?.node.key);
              if (event.key === "ArrowRight") {
                if (branch && !open) toggle(node);
                else if (open) focus(node.children?.[0]?.key);
              }
              if (event.key === "ArrowLeft") {
                if (open) toggle(node);
                else focus(visible[index]?.parent);
              }
            }}
          />
          {open && (
            // shadcn-only: the navigation list has no shadcn equivalent (nested lists with roving focus)
            <ul id={groupId} className={cn("m-0 list-none space-y-1", depth < 8 ? "pl-3" : "pl-0")}>
              {rows(node.children ?? [], depth + 1)}
            </ul>
          )}
        </li>
      );
    });
  return (
    // shadcn-only: the navigation list has no shadcn equivalent (nested lists with roving focus)
    <ul ref={host} aria-label={label} className="m-0 list-none space-y-1 p-0">
      {rows(nodes, 0)}
    </ul>
  );
}
