"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import {
  encodeRecordsTableFieldFilter,
  type GridLayout,
  type GridViewCommand,
  type GridViewCommandResult,
  type GridViewItem,
  type GridViewShareTargets,
  type GridViewsState,
  type SelectedGridView,
} from "@vortex/platform/schema";
import { Badge } from "../../components/badge";
import { Button } from "../../components/button";
import { Checkbox } from "../../components/checkbox";
import { useConfirm } from "../../components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/dialog";
import { Input } from "../../components/input";
import { Label } from "../../components/label";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../../components/popover";
import { Separator } from "../../components/separator";
import { Icon } from "../../icons/icon";
import type { GridFeatureContext, GridFeatureModule, GridFeaturePointProps } from "./registry";

/**
 * Saved views: the view switcher in the grid's toolbar. A view is the whole state of the table
 * (column order, visibility, widths, density, sort, filters and search) stored as configuration
 * only; opening one re-evaluates it under the viewer's own access on the server. The switcher lists
 * the viewer's own views and the ones shared with them, searchable, and offers Save view, Save as,
 * Rename, Share and Delete where the viewer may, and Reset to default. A shared view is read-only
 * for a recipient, who can save their own copy.
 */

const NAME_LIMIT = 80;

const sameKey = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const columnsKey = (layout: GridLayout): string =>
  JSON.stringify([
    layout.columns.map((column) => [
      column.fieldId,
      column.visible,
      column.pin,
      column.width ?? null,
    ]),
    layout.density ?? null,
  ]);

/** The sort, filters and search the page was read with, in one comparable spelling. */
const queryKey = (
  sort: readonly Readonly<{ fieldId: string; direction: string }>[],
  filters: readonly Readonly<{ fieldId: string; filter: string }>[],
  search: string | null,
): string =>
  JSON.stringify([
    sort.map((key) => [key.fieldId.toLowerCase(), key.direction]),
    [...filters]
      .map((filter) => [filter.fieldId.toLowerCase(), filter.filter])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    search ?? null,
  ]);

/** True when the grid as the person has it now differs from the selected view. */
const differsFrom = (context: GridFeatureContext, selected: SelectedGridView): boolean => {
  const { document } = selected;
  const current = queryKey(
    context.sort?.explicit === true ? context.sort.keys : [],
    (context.narrowing?.filters ?? []).map((filter) => ({
      fieldId: filter.fieldId,
      filter: encodeRecordsTableFieldFilter(filter.filter),
    })),
    context.narrowing?.search ?? null,
  );
  const saved = queryKey(document.sort ?? [], document.filters ?? [], document.search ?? null);
  return current !== saved || columnsKey(context.arrangement) !== columnsKey(document);
};

type Request = (command: GridViewCommand) => Promise<GridViewCommandResult>;

const requestOf = (context: GridFeatureContext): Request | undefined => {
  const handler = context.events?.grid_view_requested;
  if (handler === undefined) return undefined;
  return async (command) => {
    const result = await handler({ event: "grid_view_requested", command });
    return typeof result === "object" && result !== null && "outcome" in result
      ? (result as GridViewCommandResult)
      : { outcome: "unavailable" };
  };
};

const hiddenSentence = (selected: SelectedGridView): string | undefined => {
  const parts = [
    [selected.hidden.columns, "column"],
    [selected.hidden.filters, "filter"],
    [selected.hidden.sort, "sort key"],
  ].flatMap(([count, noun]) =>
    typeof count === "number" && count > 0
      ? [`${count} ${String(noun)}${count === 1 ? " is" : "s are"} hidden for your role`]
      : [],
  );
  return parts.length === 0 ? undefined : parts.join("; ");
};

/** A name prompt for Save as, Save view as and Rename. */
function NameDialog({
  title,
  description,
  initialName,
  confirmLabel,
  onSubmit,
  onClose,
}: Readonly<{
  title: string;
  description: string;
  initialName: string;
  confirmLabel: string;
  onSubmit: (name: string) => Promise<GridViewCommandResult>;
  onClose: () => void;
}>): ReactElement {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const trimmed = name.trim();
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed === "" || busy) return;
            setBusy(true);
            void onSubmit(trimmed).then((result) => {
              setBusy(false);
              // Only a failed write keeps the dialog: any other answer was told by the host.
              if (result.outcome !== "unavailable") onClose();
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={inputId}>View name</Label>
            <Input
              id={inputId}
              value={name}
              maxLength={NAME_LIMIT}
              autoFocus
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={trimmed === "" || busy}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Who a view is shared with: the organisation, roles of the application, or groups. */
function ShareDialog({
  selected,
  request,
  onClose,
}: Readonly<{
  selected: SelectedGridView;
  request: Request;
  onClose: () => void;
}>): ReactElement {
  const [targets, setTargets] = useState<GridViewShareTargets | "loading" | "unavailable">(
    "loading",
  );
  const [organization, setOrganization] = useState(selected.sharing?.organization ?? false);
  const [roleIds, setRoleIds] = useState<ReadonlySet<string>>(
    new Set(selected.sharing?.roleIds ?? []),
  );
  const [groupIds, setGroupIds] = useState<ReadonlySet<string>>(
    new Set(selected.sharing?.groupIds ?? []),
  );
  const [busy, setBusy] = useState(false);
  // The roles and groups are read once when the dialog opens, whatever the grid does meanwhile.
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    let current = true;
    void requestRef.current({ kind: "share_targets" }).then((result) => {
      if (current) setTargets(result.outcome === "targets" ? result.targets : "unavailable");
    });
    return () => {
      current = false;
    };
  }, []);
  const toggle = (
    held: ReadonlySet<string>,
    set: (next: ReadonlySet<string>) => void,
    id: string,
    on: boolean,
  ): void => {
    const next = new Set(held);
    if (on) next.add(id);
    else next.delete(id);
    set(next);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share “{selected.name}”</DialogTitle>
          <DialogDescription>
            People you share with can open the view and save their own copy. They see it under their
            own access, so anything their role cannot see is left out.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-80 flex-col gap-3 overflow-y-auto">
          <Label className="gap-2">
            <Checkbox
              checked={organization}
              onCheckedChange={(checked) => setOrganization(checked === true)}
            />
            Everyone in the organisation
          </Label>
          {targets === "loading" ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading roles and groups…
            </p>
          ) : targets === "unavailable" ? (
            <p role="alert" className="text-sm text-destructive">
              Roles and groups could not be loaded.
            </p>
          ) : (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">Roles</legend>
                {targets.roles.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No roles to share with.</p>
                ) : (
                  targets.roles.map((role) => (
                    <Label key={role.id} className="gap-2 font-normal">
                      <Checkbox
                        checked={roleIds.has(role.id)}
                        onCheckedChange={(checked) =>
                          toggle(roleIds, setRoleIds, role.id, checked === true)
                        }
                      />
                      {role.label}
                    </Label>
                  ))
                )}
              </fieldset>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">Groups</legend>
                {targets.groups.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No groups to share with.</p>
                ) : (
                  targets.groups.map((group) => (
                    <Label key={group.id} className="gap-2 font-normal">
                      <Checkbox
                        checked={groupIds.has(group.id)}
                        onCheckedChange={(checked) =>
                          toggle(groupIds, setGroupIds, group.id, checked === true)
                        }
                      />
                      {group.label}
                    </Label>
                  ))
                )}
              </fieldset>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || targets === "loading" || targets === "unavailable"}
            onClick={() => {
              setBusy(true);
              void request({
                kind: "share",
                viewId: selected.viewId,
                expectedRevision: selected.revision,
                sharing: {
                  organization,
                  roleIds: [...roleIds],
                  groupIds: [...groupIds],
                },
              }).then((result) => {
                setBusy(false);
                if (result.outcome !== "unavailable") onClose();
              });
            }}
          >
            {organization || roleIds.size > 0 || groupIds.size > 0 ? "Share" : "Keep personal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const viewScopeBadge = (view: GridViewItem): ReactElement | null =>
  view.scope !== "personal" ? (
    <Badge variant="secondary" className="shrink-0">
      {view.scope === "default" ? "Default" : "Shared"}
    </Badge>
  ) : null;

type Prompt = "save_as" | "rename" | "share" | null;

function ViewSwitcher({
  context,
  views,
}: Readonly<{ context: GridFeatureContext; views: GridViewsState }>): ReactElement | null {
  const request = useMemo(() => requestOf(context), [context]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [confirm, confirmElement] = useConfirm();
  const searchId = useId();
  if (request === undefined) return null;
  const { selected } = views;
  const needle = search.trim().toLowerCase();
  const shown = views.items.filter(
    (view) => needle === "" || view.name.toLowerCase().includes(needle),
  );
  const personal = shown.filter((view) => view.mine);
  const shared = shown.filter((view) => !view.mine && view.scope === "shared");
  const defaults = shown.filter((view) => view.scope === "default");
  const canChange =
    selected !== null && selected.scope !== "default" && (selected.mine || views.canShare);
  const unsaved = selected !== null && differsFrom(context, selected);
  const hidden = selected === null ? undefined : hiddenSentence(selected);
  const label = selected?.name ?? "Views";
  const close = (): void => setOpen(false);
  const choose = (viewId: string | null): void => {
    close();
    void request({ kind: "select", viewId });
  };

  const listOf = (title: string, items: readonly GridViewItem[]): ReactElement | null =>
    items.length === 0 ? null : (
      <div role="group" aria-label={title} className="flex flex-col gap-0.5">
        <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">{title}</p>
        {items.map((view) => {
          const active = selected !== null && sameKey(view.viewId, selected.viewId);
          return (
            <Button
              key={view.viewId}
              variant={active ? "secondary" : "ghost"}
              size="sm"
              role="option"
              aria-selected={active}
              className="justify-between gap-2"
              onClick={() => choose(view.viewId)}
            >
              <span className="truncate">{view.name}</span>
              <span className="flex items-center gap-1.5">
                {viewScopeBadge(view)}
                {active ? <Icon name="check" aria-hidden="true" /> : null}
              </span>
            </Button>
          );
        })}
      </div>
    );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={<Button variant="outline" size="sm" />}>
          <Icon name="eye" aria-hidden="true" />
          <span className="max-w-40 truncate">{label}</span>
          {unsaved ? (
            <>
              <Badge aria-hidden="true" className="size-2 min-w-0 p-0" />
              <span className="sr-only">Unsaved changes</span>
            </>
          ) : null}
        </PopoverTrigger>
        <PopoverContent className="w-80" align="start">
          <PopoverTitle>Views</PopoverTitle>
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={searchId} className="sr-only">
                Search views
              </Label>
              <Input
                id={searchId}
                type="search"
                placeholder="Search views"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
                onKeyDown={(event) => event.stopPropagation()}
              />
            </div>
            <div
              role="listbox"
              aria-label="Views"
              className="flex max-h-64 flex-col gap-1 overflow-y-auto"
            >
              <Button
                variant={selected === null ? "secondary" : "ghost"}
                size="sm"
                role="option"
                aria-selected={selected === null}
                className="justify-between"
                onClick={() => choose(null)}
              >
                Default view
                {selected === null ? <Icon name="check" aria-hidden="true" /> : null}
              </Button>
              {listOf("Default", defaults)}
              {listOf("Personal", personal)}
              {listOf("Shared with me", shared)}
              {shown.length === 0 && needle !== "" ? (
                <p role="status" className="px-2 py-1 text-sm text-muted-foreground">
                  No matching views
                </p>
              ) : null}
            </div>
            {selected !== null && !selected.mine && !views.canShare ? (
              <p className="text-xs text-muted-foreground">
                Shared with you, so it is read-only. Save as makes your own copy.
              </p>
            ) : null}
            <Separator />
            <div className="flex flex-wrap gap-1.5">
              {selected !== null && canChange ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!unsaved}
                  onClick={() => {
                    close();
                    void request({
                      kind: "save",
                      viewId: selected.viewId,
                      expectedRevision: selected.revision,
                      layout: context.arrangement,
                    });
                  }}
                >
                  Save view
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  close();
                  setPrompt("save_as");
                }}
              >
                {selected === null ? "Save view" : "Save as…"}
              </Button>
              {selected !== null && canChange ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    close();
                    setPrompt("rename");
                  }}
                >
                  Rename…
                </Button>
              ) : null}
              {selected !== null && selected.scope !== "default" && views.canShare ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    close();
                    setPrompt("share");
                  }}
                >
                  <Icon name="users" aria-hidden="true" />
                  Share…
                </Button>
              ) : null}
              {selected !== null && canChange ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => {
                    close();
                    void confirm({
                      title: `Delete “${selected.name}”?`,
                      description: selected.mine
                        ? "The view is removed for you and for everyone it is shared with."
                        : "The view is removed for everyone it is shared with.",
                      confirmLabel: "Delete view",
                      destructive: true,
                    }).then((confirmed) => {
                      if (confirmed)
                        void request({
                          kind: "delete",
                          viewId: selected.viewId,
                          expectedRevision: selected.revision,
                        });
                    });
                  }}
                >
                  Delete
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  close();
                  void request({ kind: "reset" });
                }}
              >
                Reset to default
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {hidden === undefined ? null : (
        <p role="status" className="max-w-sm text-xs text-muted-foreground">
          {hidden}
        </p>
      )}
      {prompt === "save_as" ? (
        <NameDialog
          title={selected === null ? "Save view" : "Save as"}
          description="Saves the table as it is now: columns, sort, filters and search."
          initialName={selected === null ? "" : `${selected.name} copy`.slice(0, NAME_LIMIT)}
          confirmLabel="Save"
          onSubmit={(name) => request({ kind: "create", name, layout: context.arrangement })}
          onClose={() => setPrompt(null)}
        />
      ) : null}
      {prompt === "rename" && selected !== null ? (
        <NameDialog
          title="Rename view"
          description="The name changes for everyone the view is shared with."
          initialName={selected.name}
          confirmLabel="Rename"
          onSubmit={(name) =>
            request({
              kind: "rename",
              viewId: selected.viewId,
              expectedRevision: selected.revision,
              name,
            })
          }
          onClose={() => setPrompt(null)}
        />
      ) : null}
      {prompt === "share" && selected !== null ? (
        <ShareDialog selected={selected} request={request} onClose={() => setPrompt(null)} />
      ) : null}
      {confirmElement}
    </div>
  );
}

/** Saved views: the view switcher in the toolbar, for a grid the person's layout is stored for. */
function SavedViewsToolbar({ context }: GridFeaturePointProps): ReactElement | null {
  return context.views === undefined ? null : (
    <ViewSwitcher context={context} views={context.views} />
  );
}

export const gridFeature: GridFeatureModule = { ToolbarItems: SavedViewsToolbar };
