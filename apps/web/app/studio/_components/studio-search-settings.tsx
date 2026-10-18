"use client";
import { useState } from "react";
import {
  applicationSearchEntry,
  fieldCanBeSearched,
  setApplicationSearchEnabled,
  setApplicationSearchRecordType,
  type ApplicationSearchEntry,
  type ApplicationSearchPriority,
  type ApplicationSourceDocument,
} from "@vortex/platform/schema";
import { StudioOptionControl, type StudioDataSelection } from "@vortex/ui/studio";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Label } from "@vortex/ui/components/label";
import { Switch } from "@vortex/ui/components/switch";
import {
  studioEditProblem,
  type StudioDataEdit,
  type StudioDataModule,
  type StudioDataRecordType,
} from "../_lib/studio-data-model";

type Source = ApplicationSourceDocument;

const priorities: readonly Readonly<{ value: ApplicationSearchPriority; label: string }>[] = [
  { value: "first", label: "Found first" },
  { value: "normal", label: "Normal" },
  { value: "last", label: "Found last" },
];

type Form = Readonly<{
  on: boolean;
  fields: Readonly<Record<string, ApplicationSearchPriority>>;
  title: string;
  subtitle: string;
  page: string;
}>;

/**
 * Whether people find one record type in the application's search, by which fields, what a result
 * shows and the page it opens. A field of a module this application owns is indexed when it is
 * chosen; a used module's record type is found only by the fields its own module indexes. Each
 * choice is one edit of the draft; a choice that would leave the search entry incomplete is refused
 * with why, and the entry stays as it was.
 */
export function StudioRecordTypeSearch({
  source,
  module,
  record,
  disabled,
  edit,
}: Readonly<{
  source: Source;
  module: StudioDataModule;
  record: StudioDataRecordType;
  disabled: boolean;
  edit: StudioDataEdit;
}>) {
  const reference = `${module.key}:${record.key}`;
  const owned = module.ownerApplication === undefined;
  const entry = applicationSearchEntry(source, reference);
  const qualified = (key: string) => `${reference}.${key}`;
  const local = (field: string) => field.slice(reference.length + 1);
  const eligible = record.fields.filter(
    (field) => fieldCanBeSearched(field) && (owned || field.searchPriority !== undefined),
  );
  const pages = source.body.pages.filter(
    (page) => page.type === "detail" && page.record_type === reference,
  );
  const [issues, setIssues] = useState<readonly string[]>([]);
  const titleField = (eligible.find((field) => field.key === record.titleFieldKey) ?? eligible[0])
    ?.key;
  const form: Form = {
    on: entry !== undefined,
    fields: Object.fromEntries(
      (entry?.fields ?? []).map((field) => [local(field.field), field.priority]),
    ),
    title: entry === undefined ? (titleField ?? "") : local(entry.title_field),
    subtitle: entry?.subtitle_field === undefined ? "" : local(entry.subtitle_field),
    page: entry?.target_page ?? pages[0]?.key ?? "",
  };

  const change = (patch: Partial<Form>) => {
    // Turning search on starts with the field each result is named by.
    const next: Form =
      patch.on === true && !form.on && titleField !== undefined
        ? {
            ...form,
            ...patch,
            fields: {
              [titleField]:
                eligible.find((field) => field.key === titleField)?.searchPriority ?? "normal",
            },
          }
        : { ...form, ...patch };
    let written: ApplicationSearchEntry | undefined;
    if (next.on) {
      const problems = [
        ...(Object.keys(next.fields).length === 0
          ? ["Search: choose at least one field people can find them by."]
          : []),
        ...(next.title === ""
          ? ["Search, result title: choose the field a result is named by."]
          : []),
        ...(next.page === ""
          ? [
              `Search, opens: ${record.name} has no detail page yet. Add one in Structure first: a result opens it.`,
            ]
          : []),
      ];
      if (problems.length > 0) {
        setIssues(problems);
        return;
      }
      written = {
        record_type: reference,
        fields: eligible
          .filter((field) => next.fields[field.key] !== undefined)
          .map((field) => ({ field: qualified(field.key), priority: next.fields[field.key]! })),
        title_field: qualified(next.title),
        ...(next.subtitle === "" ? {} : { subtitle_field: qualified(next.subtitle) }),
        target_page: next.page,
      };
    }
    const problem = studioEditProblem(
      edit((current) => setApplicationSearchRecordType(current, reference, written)),
    );
    setIssues(problem === undefined ? [] : [problem]);
  };
  const options = eligible.map((field) => ({ value: field.key, label: field.label }));

  return (
    <section className="space-y-6" aria-label={`Search for ${record.pluralName}`}>
      <h3 className="text-base font-semibold">Search</h3>
      <div className="flex items-center gap-2">
        <Switch
          id={`search-${reference}`}
          checked={form.on}
          disabled={disabled}
          onCheckedChange={(on) => change({ on })}
        />
        <Label htmlFor={`search-${reference}`} className="font-normal">
          People can find {record.pluralName.toLowerCase()} in search
        </Label>
      </div>
      {!form.on ? null : eligible.length === 0 ? (
        <p role="note" className="text-sm">
          {owned
            ? `No field of ${record.name} can be searched: search finds text, numbers, dates and choices.`
            : `${module.name} indexes no field of ${record.name} for search.`}
        </p>
      ) : (
        <>
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Found by</legend>
            {eligible.map((field) => {
              const priority = form.fields[field.key];
              return (
                <div key={field.key} className="flex flex-wrap items-center gap-2">
                  <Checkbox
                    id={`search-${reference}-${field.key}`}
                    checked={priority !== undefined}
                    disabled={disabled}
                    onCheckedChange={(checked) => {
                      const rest = { ...form.fields };
                      delete rest[field.key];
                      change({
                        fields:
                          checked === true
                            ? { ...rest, [field.key]: field.searchPriority ?? "normal" }
                            : rest,
                      });
                    }}
                  />
                  <Label
                    htmlFor={`search-${reference}-${field.key}`}
                    className="min-w-0 flex-1 font-normal"
                  >
                    {field.label}
                  </Label>
                  {priority === undefined ? null : (
                    <div className="w-32">
                      <StudioOptionControl
                        id={`search-${reference}-${field.key}-priority`}
                        value={priority}
                        disabled={disabled}
                        options={priorities}
                        onChange={(value) =>
                          change({
                            fields: {
                              ...form.fields,
                              [field.key]: value as ApplicationSearchPriority,
                            },
                          })
                        }
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </fieldset>
          <div className="space-y-2">
            <Label htmlFor={`search-${reference}-title`} className="text-sm">
              A result is named by
            </Label>
            <StudioOptionControl
              id={`search-${reference}-title`}
              value={form.title}
              disabled={disabled}
              options={options}
              onChange={(title) => change({ title })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`search-${reference}-subtitle`} className="text-sm">
              Under its name it shows
            </Label>
            <StudioOptionControl
              id={`search-${reference}-subtitle`}
              value={form.subtitle}
              unset="Nothing"
              disabled={disabled}
              options={options}
              onChange={(subtitle) => change({ subtitle })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`search-${reference}-page`} className="text-sm">
              A result opens
            </Label>
            {pages.length === 0 ? (
              <p role="note" className="text-sm">
                {record.name} has no detail page yet. Add one in Structure: a result opens it.
              </p>
            ) : (
              <StudioOptionControl
                id={`search-${reference}-page`}
                value={form.page}
                disabled={disabled}
                options={pages.map((page) => ({ value: page.key, label: page.name }))}
                onChange={(page) => change({ page })}
              />
            )}
          </div>
        </>
      )}
      {form.on ? (
        <p className="text-sm text-muted-foreground">
          Publish the application to use these search settings.
        </p>
      ) : null}
      {issues.length === 0 ? null : (
        <ul role="alert" className="space-y-1 text-sm text-destructive">
          {issues.map((issue, index) => (
            <li key={index} className="break-words">
              {issue}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The application's search at a glance: on or off, and the record types people find, each opening its settings. */
export function StudioSearchOverview({
  source,
  modules,
  disabled,
  edit,
  onSelect,
}: Readonly<{
  source: Source;
  modules: readonly StudioDataModule[];
  disabled: boolean;
  edit: StudioDataEdit;
  onSelect: (selection: StudioDataSelection) => void;
}>) {
  const [problem, setProblem] = useState("");
  const search = source.body.search;
  const found = (search?.record_types ?? []).map((entry) => {
    const separator = entry.record_type.indexOf(":");
    const module = modules.find((item) => item.key === entry.record_type.slice(0, separator));
    const record = module?.recordTypes.find(
      (item) => item.key === entry.record_type.slice(separator + 1),
    );
    return { reference: entry.record_type, module, record };
  });
  const toggle = (enabled: boolean) =>
    setProblem(
      studioEditProblem(edit((current) => setApplicationSearchEnabled(current, enabled))) ?? "",
    );
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Choose which record types people can find in this application.
      </p>
      {search === undefined ? (
        <p className="text-sm text-muted-foreground">
          People can&apos;t search this application yet. Select a record type and turn on its
          search.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Switch
              id="studio-search-enabled"
              checked={search.enabled}
              disabled={disabled}
              onCheckedChange={toggle}
            />
            <Label htmlFor="studio-search-enabled" className="font-normal">
              Search is on
            </Label>
          </div>
          <ul className="list-none space-y-2" aria-label="Found in search">
            {found.map(({ reference, module, record }) => (
              <li key={reference}>
                {module === undefined || record === undefined ? (
                  <span className="text-sm">{reference}</span>
                ) : (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="dark:text-foreground dark:underline"
                    onClick={() =>
                      onSelect({
                        kind: "record_type",
                        moduleKey: module.key,
                        recordKey: record.key,
                      })
                    }
                  >
                    {record.pluralName}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {problem === "" ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
