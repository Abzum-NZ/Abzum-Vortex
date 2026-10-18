"use client";

import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Icon, type VortexIconName } from "@vortex/ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "@vortex/ui/components/tooltip";
import { Item } from "@vortex/ui/components/item";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@vortex/ui/components/empty";
import { cn } from "@vortex/ui/lib/utils";

type NavProps = Omit<ComponentProps<"button">, "children"> &
  Readonly<{
    label: string;
    icon?: VortexIconName | undefined;
    meta?: ReactNode;
    description?: string | undefined;
    selected?: boolean | undefined;
    hint?: string | undefined;
    expanded?: boolean | undefined;
    onToggle?: (() => void) | undefined;
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
  icon,
  meta,
  description,
  selected,
  expanded,
  onToggle,
  hint,
  className,
  ...props
}: NavProps) {
  const row = (
    <Item
      size="sm"
      variant="navigation"
      data-two-line={description !== undefined ? "true" : undefined}
      className={cn(
        "flex-nowrap text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring",
        selected && "bg-accent font-medium text-accent-foreground",
        className,
      )}
      render={
        <button
          type="button"
          aria-current={selected ? "true" : undefined}
          aria-expanded={expanded}
          {...props}
        />
      }
    >
      {(onToggle !== undefined || props.role === "treeitem") && (
        <span
          className="flex size-6 shrink-0 items-center justify-center"
          aria-hidden="true"
          onClick={
            onToggle === undefined
              ? undefined
              : (event) => {
                  event.stopPropagation();
                  onToggle();
                }
          }
        >
          {onToggle !== undefined && (
            <Icon name={expanded ? "chevron-down" : "chevron-right"} className="size-4" />
          )}
        </span>
      )}
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
  return hint === undefined ? (
    row
  ) : (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
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

/** Roving focus follows visible rows; left/right collapse, expand, or visit the parent/first child. */
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
    const rows = host.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]');
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
        <li role="none" key={node.key}>
          <StudioNavItem
            {...node.props}
            label={node.label}
            icon={node.icon}
            meta={node.meta}
            selected={node.selected}
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={node.selected === true}
            aria-owns={open ? groupId : undefined}
            data-tree-key={node.key}
            expanded={branch ? open : undefined}
            onToggle={branch ? () => toggle(node) : undefined}
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
            <ul
              id={groupId}
              role="group"
              className={cn("m-0 list-none space-y-1", depth === 0 ? "pl-4" : "pl-0")}
            >
              {rows(node.children ?? [], depth + 1)}
            </ul>
          )}
        </li>
      );
    });
  return (
    <ul ref={host} role="tree" aria-label={label} className="m-0 list-none space-y-1 p-0">
      {rows(nodes, 0)}
    </ul>
  );
}
