"use client";
import {
  Suspense,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  DEFAULT_SHADCN_ICON_LIBRARY,
  isShadcnIconLibrary,
  VORTEX_ICON_NAMES,
  type ApplicationSourceDocument,
  type VortexIconName,
} from "@vortex/platform/schema";
import { Icon, IconLibraryProvider } from "@vortex/ui";
import { Button } from "@vortex/ui/components/button";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Input } from "@vortex/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@vortex/ui/components/native-select";
import { cn } from "@vortex/ui/lib/utils";
import {
  studioMenuPageChoices,
  studioMenuPosition,
  type StudioMenuCommand,
  type StudioMenuItem,
  type StudioMenuResult,
} from "@vortex/ui/studio";
import { studioAccessGateChoices } from "@vortex/ui/studio";
import { StudioNavTree, type StudioNavNode } from "./studio-nav-tree";
import { StudioPanelShell, StudioSection } from "./studio-frame";
import { StudioField } from "./studio-field";
import { useStudioDraftText } from "./use-studio-draft-text";

type Feedback = Readonly<{ kind: "applied" | "refused"; message: string }>;

const kindWords = (item: StudioMenuItem) =>
  item.type === "heading" ? "Heading" : item.type === "page" ? "Page" : "Link";

/**
 * The Menu tab: the application's navigation as an editable tree. An entry is selected with a
 * click, moved by dragging it onto another entry (onto a heading puts it under that heading) or with
 * Alt and the arrow keys, and changed in a popover anchored to its row. Every change is one command on the
 * draft; a refusal is shown here and nothing changes.
 */
export function StudioMenuPanel({
  source,
  selectedAlias,
  onSelect,
  onCommand,
  onOpenAccess,
  disabled,
  hidden,
}: Readonly<{
  source: ApplicationSourceDocument;
  selectedAlias: string | null;
  onSelect: (alias: string | null) => void;
  /** Opens the Access tab, where who can see an entry is set. */
  onOpenAccess: () => void;
  /** One menu edit; `merge` joins a run of edits to one value (typing a label) into one Undo step. */
  onCommand: (command: StudioMenuCommand, merge?: string) => StudioMenuResult;
  disabled: boolean;
  hidden: boolean;
}>) {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [editing, setEditing] = useState<string | null>(null);
  const treeHost = useRef<HTMLDivElement>(null);
  const [newPage, setNewPage] = useState("");
  const pages = useMemo(() => studioMenuPageChoices(source), [source]);
  const library = source.body.theme.selection.icon_library;

  const run = (command: StudioMenuCommand, merge?: string): boolean => {
    const result = onCommand(command, merge);
    setFeedback({ kind: result.kind, message: result.message });
    return result.kind === "applied";
  };
  const selected = selectedAlias === null ? undefined : studioMenuPosition(source, selectedAlias);
  const selectedHeading =
    selected?.item.type === "heading" ? selected.item.id : (selected?.headingAlias ?? null);

  const moveBy = (alias: string, key: string): boolean => {
    const position = studioMenuPosition(source, alias);
    if (position === undefined) return false;
    const { headingAlias, index, length, item } = position;
    if (key === "ArrowUp" && index > 0)
      return run({ kind: "move", alias, headingAlias, index: index - 1 });
    if (key === "ArrowDown" && index < length - 1)
      return run({ kind: "move", alias, headingAlias, index: index + 1 });
    if (key === "ArrowLeft" && headingAlias !== null) {
      const heading = studioMenuPosition(source, headingAlias)!;
      return run({ kind: "move", alias, headingAlias: null, index: heading.index + 1 });
    }
    if (key === "ArrowRight" && item.type !== "heading") {
      const siblings = headingAlias === null ? source.body.navigation : undefined;
      const previous = siblings?.[index - 1];
      if (previous?.type === "heading")
        return run({
          kind: "move",
          alias,
          headingAlias: previous.id,
          index: previous.children.length,
        });
    }
    setFeedback({
      kind: "refused",
      message:
        key === "ArrowRight" && item.type === "heading"
          ? `The heading “${item.label}” cannot go under another heading: the menu has one level of headings.`
          : key === "ArrowRight"
            ? "Alt and Right arrow puts an entry under the heading just above it; there is none."
            : key === "ArrowLeft"
              ? "The entry is not under a heading."
              : "The entry is already at that end.",
    });
    return false;
  };
  const keyMove = (event: KeyboardEvent<HTMLButtonElement>, alias: string) => {
    if (
      !event.altKey ||
      disabled ||
      !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
    )
      return;
    event.preventDefault();
    moveBy(alias, event.key);
  };

  const drop = (event: DragEvent<HTMLElement>, target: StudioMenuItem | null) => {
    event.preventDefault();
    const alias = dragging ?? event.dataTransfer.getData("text/plain");
    setDragging(null);
    setDropTarget(null);
    if (disabled || alias.length === 0 || alias === target?.id) return;
    const moving = studioMenuPosition(source, alias);
    if (moving === undefined) return;
    if (target === null) {
      run({ kind: "move", alias, headingAlias: null, index: source.body.navigation.length });
      return;
    }
    // Onto a heading: under it, at its end. Onto an entry: in its place, before it.
    if (target.type === "heading" && moving.item.type !== "heading") {
      run({ kind: "move", alias, headingAlias: target.id, index: target.children.length });
      return;
    }
    const at = studioMenuPosition(source, target.id)!;
    const shift = at.headingAlias === moving.headingAlias && moving.index < at.index ? 1 : 0;
    run({ kind: "move", alias, headingAlias: at.headingAlias, index: at.index - shift });
  };

  const focusRow = (alias: string | undefined) => {
    requestAnimationFrame(() => {
      const rows = treeHost.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]');
      rows?.forEach((row) => {
        if (row.dataset.treeKey === alias) row.focus();
      });
    });
  };
  const remove = async (item: StudioMenuItem) => {
    if (
      !(await confirm({
        title: `Remove "${item.label}" from the menu?`,
        description:
          item.type === "heading"
            ? "The heading goes; the entries under it stay in the menu."
            : "The page itself stays; only its menu entry goes. Undo brings it back.",
        confirmLabel: "Remove entry",
      }))
    )
      return;
    const entries = source.body.navigation.flatMap((entry) =>
      entry.type === "heading" ? [entry, ...entry.children] : [entry],
    );
    const index = entries.findIndex((entry) => entry.id === item.id);
    const next = entries[index + 1]?.id ?? entries[index - 1]?.id;
    if (run({ kind: "remove", alias: item.id })) {
      setEditing(null);
      onSelect(next ?? null);
      focusRow(next);
    }
  };
  const row = (item: StudioMenuItem): StudioNavNode => {
    const position = studioMenuPosition(source, item.id)!;
    const move = (key: string) => {
      if (moveBy(item.id, key)) focusRow(item.id);
    };
    const moveActions = [
      {
        label: `Move ${item.label} up`,
        icon: "arrow-up" as const,
        disabled: disabled || position.index === 0,
        onClick: () => move("ArrowUp"),
      },
      {
        label: `Move ${item.label} down`,
        icon: "arrow-down" as const,
        disabled: disabled || position.index === position.length - 1,
        onClick: () => move("ArrowDown"),
      },
    ];
    const removeAction = {
      label: `Remove ${item.label}`,
      icon: "close" as const,
      disabled,
      destructive: true,
      onClick: () => {
        void remove(item);
      },
    };
    return {
      key: item.id,
      label: item.label,
      icon: item.icon,
      selected: item.id === selectedAlias,
      onSelect: () => {
        onSelect(item.id);
        setEditing(item.id);
      },
      children: item.type === "heading" ? item.children.map(row) : [],
      props: {
        disabled,
        description:
          item.type === "page"
            ? source.body.pages.find((page) => page.key === item.page)?.name
            : kindWords(item),
        "aria-description": "Alt and the arrow keys move this entry. Enter opens settings.",
        onKeyDown: (event) => {
          keyMove(event, item.id);
          if (event.defaultPrevented) focusRow(item.id);
        },
        dragHandle: {
          draggable: !disabled,
          disabled,
          onKeyDown: (event) => {
            keyMove(event, item.id);
            if (event.defaultPrevented) focusRow(item.id);
          },
          onDragStart: (event) => {
            event.dataTransfer.setData("text/plain", item.id);
            event.dataTransfer.effectAllowed = "move";
            setEditing(null);
            setDragging(item.id);
          },
          onDragEnd: () => {
            setDragging(null);
            setDropTarget(null);
            focusRow(item.id);
          },
        },
        actions: [...moveActions, removeAction],
        moreActions: [
          {
            label: "Edit entry",
            icon: "sliders-horizontal",
            disabled,
            onClick: () => {
              onSelect(item.id);
              setEditing(item.id);
            },
          },
          ...moveActions.map((action, index) => ({
            ...action,
            label: index === 0 ? "Move up" : "Move down",
          })),
          ...(position.headingAlias !== null
            ? [
                {
                  label: "Move out of heading",
                  icon: "chevron-left" as const,
                  disabled,
                  onClick: () => move("ArrowLeft"),
                },
              ]
            : []),
          { ...removeAction, label: item.type === "heading" ? "Remove heading" : "Remove entry" },
        ],
        settingsOpen: editing === item.id && !hidden,
        onSettingsOpenChange: (open) => {
          setEditing(open ? item.id : null);
          if (open) onSelect(item.id);
        },
        settings:
          editing === item.id ? (
            <StudioMenuEntryEditor
              key={item.id}
              source={source}
              item={item}
              position={position}
              disabled={disabled}
              run={run}
              onOpenAccess={onOpenAccess}
            />
          ) : null,
        onDragOver: (event) => {
          if (dragging !== null && dragging !== item.id) {
            event.preventDefault();
            setDropTarget(item.id);
          }
        },
        onDragLeave: () => setDropTarget((current) => (current === item.id ? null : current)),
        onDrop: (event) => {
          drop(event, item);
          focusRow(dragging ?? undefined);
        },
        className: cn(
          dropTarget === item.id && "ring-1 ring-primary",
          dragging === item.id && "opacity-50",
        ),
      },
    };
  };

  const addEntry = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPage.length === 0) {
      setFeedback({ kind: "refused", message: "Choose the page the new entry opens." });
      return;
    }
    if (run({ kind: "add_entry", pageKey: newPage, headingAlias: selectedHeading })) setNewPage("");
  };

  return (
    <StudioPanelShell title="Menu" hidden={hidden}>
      <IconLibraryProvider
        library={isShadcnIconLibrary(library) ? library : DEFAULT_SHADCN_ICON_LIBRARY}
      >
        {!isShadcnIconLibrary(library) && (
          <p role="alert" className="text-sm text-destructive">
            The theme names an icon library Studio does not offer, so icons here are drawn with
            Lucide. Choose an icon library in Theme.
          </p>
        )}
        <form onSubmit={addEntry} className="flex items-end gap-2" aria-label="New menu entry">
          <StudioField
            label={
              selectedHeading === null
                ? "Add an entry for a page"
                : "Add an entry under the selected heading"
            }
          >
            {(control) => (
              <NativeSelect
                {...control}
                value={newPage}
                disabled={disabled}
                onChange={(event) => setNewPage(event.target.value)}
              >
                <NativeSelectOption value="">Choose a page</NativeSelectOption>
                {pages.map((page) => (
                  <NativeSelectOption key={page.key} value={page.key}>
                    {page.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </StudioField>
          <Button type="submit" size="sm" disabled={disabled}>
            Add
          </Button>
        </form>
        {/* A newly chosen icon library loads before its icons draw; only this list waits for it, not Studio. */}
        <Suspense
          fallback={
            <p role="status" className="text-sm text-muted-foreground">
              Loading the icon library…
            </p>
          }
        >
          {source.body.navigation.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This application has no menu entries yet.
            </p>
          ) : (
            <StudioSection title="Menu entries" count={source.body.navigation.length}>
              <div ref={treeHost}>
                <StudioNavTree
                  label="Menu entries"
                  nodes={source.body.navigation.map(row)}
                  disabled={disabled}
                />
              </div>
            </StudioSection>
          )}
          {dragging !== null && (
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDropTarget("__end");
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(event) => drop(event, null)}
              className={cn(
                "rounded-md border border-dashed border-border p-2 text-center text-xs text-muted-foreground",
                dropTarget === "__end" && "border-primary text-foreground",
              )}
            >
              Drop here to move it to the end of the menu
            </div>
          )}
          {feedback !== null && (
            <p
              role={feedback.kind === "refused" ? "alert" : "status"}
              className={
                feedback.kind === "refused"
                  ? "text-sm text-destructive"
                  : "text-sm text-muted-foreground"
              }
            >
              {feedback.message}
            </p>
          )}
          {confirmDialog}
        </Suspense>
      </IconLibraryProvider>
    </StudioPanelShell>
  );
}

/** The selected entry's settings, anchored to its row. */
function StudioMenuEntryEditor({
  source,
  item,
  position,
  disabled,
  run,
  onOpenAccess,
}: Readonly<{
  source: ApplicationSourceDocument;
  item: StudioMenuItem;
  position: NonNullable<ReturnType<typeof studioMenuPosition>>;
  disabled: boolean;
  run: (command: StudioMenuCommand, merge?: string) => boolean;
  onOpenAccess: () => void;
}>) {
  const label = useStudioDraftText(item.label, (next) =>
    next.trim().length === 0
      ? "Enter a label."
      : run(
          { kind: "change", alias: item.id, changes: { label: next } },
          `menu-label:${item.id}`,
        ) || "",
  );
  const address = useStudioDraftText(
    item.type === "external" ? item.address : "",
    (next) =>
      run(
        { kind: "change", alias: item.id, changes: { address: next } },
        `menu-address:${item.id}`,
      ) || "",
  );
  const [headingLabel, setHeadingLabel] = useState("");
  const pages = useMemo(() => studioMenuPageChoices(source), [source]);
  const permissions = useMemo(() => studioAccessGateChoices(source), [source]);
  const headings = source.body.navigation.filter((entry) => entry.type === "heading");
  const permission =
    item.type === "heading"
      ? undefined
      : permissions.find((choice) => choice.key === item.permission);
  const change = (command: Extract<StudioMenuCommand, { kind: "change" }>) => run(command);
  return (
    <section aria-label={`Menu entry ${item.label}`} className="space-y-4">
      <p className="text-sm font-medium">
        {kindWords(item)} “{item.label}”
      </p>
      <StudioField
        label="Label"
        error={label.problem === "" ? undefined : label.problem}
        onUndo={label.reset}
      >
        {(control) => (
          <Input
            {...control}
            value={label.text}
            maxLength={60}
            disabled={disabled}
            onChange={(event) => label.change(event.target.value)}
          />
        )}
      </StudioField>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Icon</legend>
        <p className="text-xs text-muted-foreground">
          Drawn from the application&apos;s icon library, chosen in Theme.
        </p>
        <div role="radiogroup" aria-label="Icon" className="grid grid-cols-7 gap-1">
          {VORTEX_ICON_NAMES.map((name: VortexIconName) => (
            <button
              key={name}
              type="button"
              role="radio"
              aria-checked={item.icon === name}
              aria-label={name.replaceAll("-", " ")}
              title={name.replaceAll("-", " ")}
              disabled={disabled}
              onClick={() => {
                if (item.icon !== name)
                  change({ kind: "change", alias: item.id, changes: { icon: name } });
              }}
              className={cn(
                "flex aspect-square items-center justify-center rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-ring",
                item.icon === name
                  ? "border-primary bg-accent"
                  : "border-transparent hover:bg-accent",
              )}
            >
              <Icon name={name} className="size-4" />
            </button>
          ))}
        </div>
      </fieldset>
      {item.type === "page" && (
        <StudioField
          label="Opens the page"
          error={
            pages.some((page) => page.key === item.page)
              ? undefined
              : "This entry's page is not in the application any more. Choose another page."
          }
        >
          {(control) => (
            <NativeSelect
              {...control}
              value={item.page}
              disabled={disabled}
              onChange={(event) =>
                change({ kind: "change", alias: item.id, changes: { page: event.target.value } })
              }
            >
              {pages.some((page) => page.key === item.page) ? null : (
                <NativeSelectOption value={item.page}>Missing page</NativeSelectOption>
              )}
              {pages.map((page) => (
                <NativeSelectOption key={page.key} value={page.key}>
                  {page.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </StudioField>
      )}
      {item.type === "external" && (
        <StudioField
          label="Address"
          error={address.problem === "" ? undefined : address.problem}
          onUndo={address.reset}
        >
          {(control) => (
            <Input
              {...control}
              value={address.text}
              disabled={disabled}
              onChange={(event) => address.change(event.target.value)}
            />
          )}
        </StudioField>
      )}
      {item.type !== "heading" && (
        <div className="space-y-1">
          <p className="text-sm font-medium">Who can see it</p>
          <p className="text-sm text-muted-foreground">
            {permission === undefined
              ? "This entry names a permission the application does not declare."
              : `People who hold “${permission.label}”: ${permission.roles.length === 0 ? "no role holds it yet" : permission.roles.join(", ")}.`}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={onOpenAccess}>
            <Icon name="shield" />
            Change in Access
          </Button>
        </div>
      )}
      {item.type === "heading" && (
        <p className="text-xs text-muted-foreground">
          A heading shows when a person can see at least one entry under it.
        </p>
      )}
      {item.type !== "heading" && headings.length > 0 && (
        <StudioField label="Put under a heading">
          {(control) => (
            <NativeSelect
              {...control}
              value={position.headingAlias ?? ""}
              disabled={disabled}
              onChange={(event) => {
                const target = headings.find((heading) => heading.id === event.target.value);
                run(
                  target === undefined
                    ? {
                        kind: "move",
                        alias: item.id,
                        headingAlias: null,
                        index: source.body.navigation.length,
                      }
                    : {
                        kind: "move",
                        alias: item.id,
                        headingAlias: target.id,
                        index: target.type === "heading" ? target.children.length : 0,
                      },
                );
              }}
            >
              <NativeSelectOption value="">No heading (top level)</NativeSelectOption>
              {headings.map((heading) => (
                <NativeSelectOption key={heading.id} value={heading.id}>
                  {heading.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </StudioField>
      )}
      {item.type !== "heading" && position.headingAlias === null && (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (run({ kind: "add_heading", label: headingLabel, aroundAlias: item.id }))
              setHeadingLabel("");
          }}
        >
          <StudioField label="Group under a new heading">
            {(control) => (
              <Input
                {...control}
                value={headingLabel}
                maxLength={60}
                placeholder="Heading label"
                disabled={disabled}
                onChange={(event) => setHeadingLabel(event.target.value)}
              />
            )}
          </StudioField>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={disabled || headingLabel.trim().length === 0}
          >
            Group
          </Button>
        </form>
      )}
    </section>
  );
}
