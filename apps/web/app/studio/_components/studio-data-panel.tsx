"use client";
import { useMemo, useState } from "react";
import { Icon } from "@vortex/ui";
import { Badge } from "@vortex/ui/components/badge";
import { Button } from "@vortex/ui/components/button";
import { StudioPanelShell, StudioSearchBox, StudioSection } from "./studio-frame";
import { StudioNavItem, StudioNavTree, type StudioNavNode } from "./studio-nav-tree";
import type { StudioModuleOwnerApplication } from "./module-fields-editor";
import type { StudioDataSelection } from "@vortex/ui/studio";
import type { StudioDataModule } from "../_lib/studio-data-model";

const sameSelection = (left: StudioDataSelection | null, right: StudioDataSelection): boolean =>
  left !== null && JSON.stringify(left) === JSON.stringify(right);

/** Keeps the modules, record types and fields whose names match the search, with what leads to them. */
const filterModules = (
  modules: readonly StudioDataModule[],
  query: string,
): readonly StudioDataModule[] => {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return modules;
  const matches = (text: string) => text.toLocaleLowerCase().includes(needle);
  return modules.flatMap((module) => {
    if (matches(module.name)) return [module];
    const recordTypes = module.recordTypes.flatMap((record) => {
      if (matches(record.name) || matches(record.pluralName)) return [record];
      const fields = record.fields.filter((field) => matches(field.label));
      return fields.length === 0 ? [] : [{ ...record, fields }];
    });
    return recordTypes.length === 0 ? [] : [{ ...module, recordTypes }];
  });
};

/**
 * The Data tab's tree: the modules this application owns, their record types and each record
 * type's fields and queries, then the modules it uses from other applications, read-only. The
 * application's search settings follow below.
 */
export function StudioDataPanel({
  hidden,
  owned,
  used,
  applications,
  selected,
  onSelect,
  onCreate,
  disabled,
  searchSelected,
  onSearch,
}: Readonly<{
  hidden: boolean;
  /** The modules the draft owns. */
  owned: readonly StudioDataModule[];
  /** The modules the application uses, as their installed release defines them; null while unknown. */
  used: readonly StudioDataModule[] | null;
  /** The organisation's applications, to name the owner of a used module. */
  applications: readonly StudioModuleOwnerApplication[];
  selected: StudioDataSelection | null;
  onSelect: (selection: StudioDataSelection) => void;
  /** Opens the new record type form. */
  onCreate: () => void;
  disabled: boolean;
  searchSelected: boolean;
  onSearch: () => void;
}>) {
  const [query, setQuery] = useState("");
  const ownedShown = useMemo(() => filterModules(owned, query), [owned, query]);
  const usedShown = useMemo(() => filterModules(used ?? [], query), [used, query]);
  const searching = query.trim() !== "";
  const ownerName = (key: string | undefined) =>
    applications.find((application) => application.key === key)?.name ?? key;
  const moduleNode = (module: StudioDataModule, readonly: boolean): StudioNavNode => {
    const selection = { kind: "module", moduleKey: module.key } as const;
    const node = (
      key: string,
      label: string,
      selection: StudioDataSelection,
      children?: readonly StudioNavNode[],
      meta?: string,
    ): StudioNavNode => ({
      key,
      label,
      icon:
        selection.kind === "module" || selection.kind === "record_type" ? "database" : "panel-left",
      selected: sameSelection(selected, selection),
      onSelect: () => onSelect(selection),
      children,
      meta,
    });
    return {
      ...node(
        module.key,
        module.name,
        selection,
        module.recordTypes.map((record) =>
          node(
            `${module.key}:${record.key}`,
            record.pluralName,
            { kind: "record_type", moduleKey: module.key, recordKey: record.key },
            [
              ...record.fields.map((field) =>
                node(
                  `${module.key}:${record.key}:${field.key}`,
                  field.label,
                  {
                    kind: "field",
                    moduleKey: module.key,
                    recordKey: record.key,
                    fieldKey: field.key,
                  },
                  undefined,
                  field.key === record.titleFieldKey ? "Title" : undefined,
                ),
              ),
              ...module.queries
                .filter((query) => query.recordKey === record.key)
                .map((query) =>
                  node(
                    `${module.key}:query:${query.key}`,
                    query.label,
                    { kind: "query", moduleKey: module.key, queryKey: query.key },
                    undefined,
                    "Query",
                  ),
                ),
            ],
            `${record.fields.length} fields`,
          ),
        ),
      ),
      meta: readonly ? (
        <Badge variant="outline">
          <Icon name="shield" />
          Read-only
        </Badge>
      ) : undefined,
      props: {
        hint: readonly
          ? `Owned by ${ownerName(module.ownerApplication) ?? "another application"}. Edit it in its owner's Studio.`
          : undefined,
      },
    };
  };
  return (
    <StudioPanelShell
      title="Data"
      hidden={hidden}
      action={
        <Button type="button" size="sm" variant="secondary" onClick={onCreate} disabled={disabled}>
          <Icon name="plus" />
          Record type
        </Button>
      }
      search={
        <StudioSearchBox
          value={query}
          onChange={setQuery}
          placeholder="Find a record type or field"
          label="Find a record type or field"
        />
      }
    >
      {owned.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This application owns no record types yet. Add its first record type: its module is
          created with it.
        </p>
      ) : owned.every((module) => module.recordTypes.length === 0) ? (
        <p className="text-sm text-muted-foreground">
          This application has no record types yet. Add its first one, for example Asset.
        </p>
      ) : null}
      {ownedShown.length > 0 && (
        <StudioSection title="This application" count={ownedShown.length} storageKey="data:owned">
          <StudioNavTree
            label="This application's data"
            nodes={ownedShown.map((module) => moduleNode(module, false))}
            expandAll={searching}
          />
        </StudioSection>
      )}
      {used === null && !searching ? (
        <p className="text-sm text-muted-foreground">
          The modules this application uses are listed after the draft is compiled.
        </p>
      ) : null}
      {usedShown.length > 0 && (
        <StudioSection
          title="From other applications"
          count={usedShown.length}
          storageKey="data:used"
        >
          <StudioNavTree
            label="Read-only data"
            nodes={usedShown.map((module) => moduleNode(module, true))}
            expandAll={searching}
          />
        </StudioSection>
      )}
      {searching && ownedShown.length === 0 && usedShown.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing matches.</p>
      ) : null}
      <StudioSection title="Application">
        <StudioNavItem
          label="Search settings"
          icon="search"
          selected={searchSelected}
          onClick={onSearch}
        />
      </StudioSection>
    </StudioPanelShell>
  );
}
