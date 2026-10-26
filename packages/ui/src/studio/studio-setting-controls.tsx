"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  canonicalJson,
  recordsTableColumnProblems,
  componentSettingApplies,
  plainSettingValue,
  plainSourceSettingValue,
  typedSourceSettingValue,
  validateComponentSettings,
  queryTotalReferenceProblem,
  type ApplicationSourceDocument,
  type BlockPropertySchemaContract,
  type ComponentSettingFailure,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { followFieldLabels } from "./follow-field-labels";
import { studioTotalMeasureProperty } from "./grid-features/totals";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { Switch } from "../components/switch";
import { ToggleGroup, ToggleGroupItem } from "../components/toggle-group";
import { Input } from "../components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "../components/input-group";
import { Plus } from "lucide-react";
import {
  StudioReferencePicker,
  studioBorrowedGroup,
  type StudioReferencePickerOption,
} from "./studio-reference-picker";
import { StudioField } from "./studio-field";
import { StudioEntryList, useStudioEntryKeys } from "./studio-entry-list";
import { useConfirm } from "../components/confirm-dialog";
import { StudioInspectorGroup } from "./studio-inspector-group";
import { Label } from "../components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";
import { Textarea } from "../components/textarea";
import {
  studioActionChoices,
  studioQueryChoices,
  studioRecordDataChoices,
  studioRelationshipChoices,
  studioSourceFields,
  studioSourceRecordTypes,
  type StudioActionChoice,
  type StudioBorrowedChoices,
  type StudioQueryChoice,
  type StudioQueryField,
  type StudioRelationshipChoice,
} from "./contextual-palette";
import {
  StudioRecordReferenceControl,
  type StudioRecordReader,
} from "./studio-record-reference-control";

/**
 * Studio's one set of typed setting controls: one control per declared block property, chosen by
 * the property's kind. The Set-up dialog of a new block and the inspector of a placed block both
 * draw their settings with these controls, and both hand the typed values to the composition
 * commands, which judge them as stored data.
 */

/** A typed authored setting value, or `undefined` for a setting left unset (its default applies). */
type SettingValue = SourceBlockPropertyValueContract | undefined;
export type StudioSettingValues = Readonly<Record<string, SourceBlockPropertyValueContract>>;

/**
 * What reference settings can point at, all read from the draft being edited: the fields of the
 * block's data (or every field of its record types), its queries, pages, record types, module
 * actions and relationships. Records are not part of a draft: `records` reads them from
 * the builder's preview of the saved draft with their preview access, or is null where none can be read.
 */
export type StudioSettingChoices = Readonly<{
  fields: readonly StudioQueryField[];
  queries: readonly StudioQueryChoice[];
  recordQueries?: readonly StudioQueryChoice[];
  totals: StudioQueryChoice["totals"];
  pages: readonly Readonly<{ key: string; label: string }>[];
  recordTypes: readonly Readonly<{ key: string; label: string }>[];
  actions: readonly StudioActionChoice[];
  relationships: readonly StudioRelationshipChoice[];
  roles: readonly Readonly<{ key: string; label: string }>[];
  records: StudioRecordReader | null;
}>;

/**
 * The one source of every reference picker: the draft being edited, never the installed release.
 * Its own Modules' queries, fields, record types, actions and relationships, its pages, and what the Modules it uses offer (read from their releases, as nothing of theirs is
 * in this draft).
 */
export const studioDraftChoices = (
  source: ApplicationSourceDocument,
  borrowed: StudioBorrowedChoices | null,
  records: StudioRecordReader | null,
  /** The business name of the application with this key, which borrowed choices are grouped by. */
  applicationName: (key: string) => string,
): StudioSettingChoices => {
  const named = <T extends Readonly<{ borrowedFrom?: string }>>(choice: T): T =>
    choice.borrowedFrom === undefined
      ? choice
      : { ...choice, borrowedFrom: applicationName(choice.borrowedFrom) };
  return {
    queries: studioQueryChoices(source, borrowed).map(named),
    recordQueries: studioRecordDataChoices(source),
    totals: [],
    fields: studioSourceFields(source),
    pages: source.body.pages.map((page) => ({ key: page.key, label: page.name })),
    recordTypes: studioSourceRecordTypes(source),
    actions: studioActionChoices(source, borrowed).map(named),
    relationships: studioRelationshipChoices(source, borrowed).map(named),
    roles: source.body.roles.map((role) => ({ key: role.key, label: role.name })),
    records,
  };
};

/**
 * The choices of one block: a block that reads a query picks only that query's fields, and only
 * the relationships of the record type that query reads.
 */
export const studioBlockChoices = (
  draft: StudioSettingChoices,
  query: string | null,
): StudioSettingChoices => {
  const chosen =
    query === null
      ? undefined
      : [...draft.queries, ...(draft.recordQueries ?? [])].find(
          (candidate) => candidate.reference === query,
        );
  return query === null
    ? draft
    : {
        ...draft,
        fields: chosen?.fields ?? [],
        totals: chosen?.totals ?? [],
        relationships: draft.relationships.filter(
          (relationship) => relationship.recordType === chosen?.recordType,
        ),
      };
};

const familyText: Readonly<Record<ComponentSettingFailure["family"], string>> = {
  required_value: "needs a value",
  invalid_value: "is not valid",
  unsupported_choice: "has a choice this block does not offer",
  unknown_property: "is not a setting of this block",
  too_few_items: "needs more entries",
  too_many_items: "has too many entries",
  unsafe_content: "holds content that is not allowed",
};

/** The label path of a failure: each setting's label, and the entry number inside a list. */
const failurePlace = (
  properties: readonly BlockPropertySchemaContract[],
  path: readonly (string | number)[],
  family?: ComponentSettingFailure["family"],
): string => {
  const parts: string[] = [];
  let declarations: readonly BlockPropertySchemaContract[] | undefined = properties;
  let current: BlockPropertySchemaContract | undefined;
  for (const segment of path) {
    if (typeof segment === "number") {
      parts.push(`entry ${segment + 1}`);
      current = current?.kind === "list" ? current.item : undefined;
      declarations = current?.kind === "group" ? current.properties : undefined;
      continue;
    }
    current = declarations?.find((property) => property.key === segment);
    parts.push(current?.label ?? segment);
    declarations = current?.kind === "group" ? current.properties : undefined;
  }
  if (family === undefined) return parts.join(", ");
  if (family !== "required_value" || current?.showWhen === undefined)
    return `${parts.join(", ")} ${familyText[family]}.`;
  // A nested entry keeps its place, so the pre-check names which column needs the value.
  const owner = parts.slice(0, -1).join(", ");
  return owner === ""
    ? conditionalRequiredMessage(current)
    : `${owner}: ${conditionalRequiredMessage(current)}`;
};

/** A setting required by a selected choice asks for its value beside the control. */
const conditionalRequiredMessage = (property: BlockPropertySchemaContract): string =>
  `Choose ${property.label.charAt(0).toLowerCase()}${property.label.slice(1)}.`;

/**
 * The fields a field reference may name: the block's fields, narrowed to the field types its
 * declaration allows. Publication refuses any other, so the picker never offers one.
 */
const studioFittingFields = (
  property: BlockPropertySchemaContract,
  fields: readonly StudioQueryField[],
): readonly StudioQueryField[] =>
  property.kind === "field_reference" && property.fieldTypes !== undefined
    ? fields.filter((field) => (property.fieldTypes as readonly string[]).includes(field.type))
    : fields;

/** Why these settings would be refused, in words, one line per problem; empty when they pass. */
export const studioSettingProblems = (
  values: StudioSettingValues,
  properties: readonly BlockPropertySchemaContract[],
  choices?: Pick<StudioSettingChoices, "fields" | "totals">,
): readonly string[] => {
  const problems = validateComponentSettings(values, properties).map((failure) =>
    failurePlace(properties, failure.path, failure.family),
  );
  if (choices !== undefined) {
    const visit = (
      property: BlockPropertySchemaContract,
      value: SettingValue,
      path: readonly (string | number)[],
    ) => {
      // Binding fields belong to the page subject or parent row, and a row's related columns to
      // the related records query; their own checks judge them, not the block's data.
      if (property.key === "query_parameters" || property.key === "child_columns") return;
      if (property.kind === "total_reference" && value?.kind === "total_reference") {
        const problem = queryTotalReferenceProblem(property.label, value.value, choices.totals);
        if (problem !== undefined) problems.push(problem);
      }
      if (
        property.kind === "field_reference" &&
        value?.kind === "field_reference" &&
        !studioFittingFields(property, choices.fields).some(
          (field) => field.reference === value.field,
        )
      )
        problems.push(
          `${failurePlace(properties, path)} is not offered by the chosen data. Choose another field or remove this entry.`,
        );
      else if (property.kind === "group" && value?.kind === "group")
        for (const child of property.properties)
          visit(child, value.properties[child.key], [...path, child.key]);
      else if (property.kind === "list" && value?.kind === "list")
        value.items.forEach((item, index) => visit(property.item, item, [...path, index]));
    };
    // The shared binding check validates binding fields' scope and type in Studio and publication.
    for (const property of properties) visit(property, values[property.key], [property.key]);
  }
  // Only Records table columns declare field references and default visibility. A Table data
  // field also has a columns list, but its entries declare typed stored values instead.
  const columns = properties.find((property) => property.key === "columns");
  if (
    columns?.kind === "list" &&
    columns.item.kind === "group" &&
    columns.item.properties.some(
      (property) => property.key === "field" && property.kind === "field_reference",
    ) &&
    columns.item.properties.some(
      (property) => property.key === "visible" && property.kind === "boolean",
    )
  )
    problems.push(
      ...recordsTableColumnProblems(values["columns"]).map((problem) => problem.reason),
    );
  return [...new Set(problems)];
};

/** The value a new list entry starts with. */
const initialValue = (
  property: BlockPropertySchemaContract,
  choices: StudioSettingChoices,
): SettingValue => {
  switch (property.kind) {
    case "total_reference":
      return choices.totals[0] === undefined
        ? undefined
        : { kind: "total_reference", value: choices.totals[0].alias };
    case "group":
      return { kind: "group", properties: {} };
    case "list":
      return { kind: "list", items: [] };
    case "text":
      return { kind: "text", value: "" };
    case "url":
      return { kind: "url", value: "" };
    case "number":
      return { kind: "number", value: property.minimum ?? 0 };
    case "boolean":
      return { kind: "boolean", value: false };
    case "choice":
      return property.options[0] === undefined
        ? undefined
        : { kind: "choice", value: property.options[0].key };
    case "field_reference": {
      const first = studioFittingFields(property, choices.fields)[0];
      return first === undefined ? undefined : { kind: "field_reference", field: first.reference };
    }
    case "query_reference":
      return choices.queries[0] === undefined
        ? undefined
        : { kind: "query_reference", query: choices.queries[0].reference };
    case "page_reference":
      return choices.pages[0] === undefined
        ? undefined
        : { kind: "page_reference", page: choices.pages[0].key };
    case "record_type_reference":
      return choices.recordTypes[0] === undefined
        ? undefined
        : { kind: "record_type_reference", record_type: choices.recordTypes[0].key };
    case "action_reference":
      return choices.actions[0] === undefined
        ? undefined
        : { kind: "action_reference", action: choices.actions[0].reference };
    case "relationship_reference":
      return choices.relationships[0] === undefined
        ? undefined
        : { kind: "relationship_reference", relationship: choices.relationships[0].reference };
    // A new entry of these starts only once the person writes its text or picks its record.
    case "rich_text":
    case "icon":
    case "record_reference":
    case "asset_reference":
      return undefined;
  }
};

type ControlProps = Readonly<{
  id: string;
  descriptionId?: string | undefined;
  property: BlockPropertySchemaContract;
  value: SettingValue;
  onChange: (value: SettingValue) => void;
  choices: StudioSettingChoices;
  disabled: boolean;
}>;

/** A number typed as text: the draft is kept while it is not a number, and only a number is reported. */
function NumberControl({
  id,
  property,
  value,
  onChange,
  disabled,
  descriptionId,
}: ControlProps): ReactElement {
  const current = value?.kind === "number" ? String(value.value) : "";
  const [draft, setDraft] = useState(current);
  const [seen, setSeen] = useState(current);
  if (current !== seen) {
    setSeen(current);
    setDraft(current);
  }
  const integer = property.kind === "number" && property.integer;
  return (
    <Input
      id={id}
      aria-describedby={descriptionId}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      disabled={disabled}
      value={draft}
      aria-invalid={draft.trim() !== "" && !Number.isFinite(Number(draft))}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        if (text.trim() === "") onChange(undefined);
        else if (
          /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim()) &&
          Number.isFinite(Number(text))
        )
          onChange({ kind: "number", value: Number(text) });
      }}
    />
  );
}

/**
 * A closed choice among labelled options, with the unset state named by what it means (none when
 * a value is always chosen). Short lists open as a styled list; longer ones are searchable.
 */
export function StudioOptionControl({
  id,
  value,
  options,
  unset,
  disabled,
  onChange,
  "aria-describedby": describedBy,
  "aria-label": label,
  "aria-invalid": invalid,
}: Readonly<{
  id?: string | undefined;
  value: string;
  options: readonly Readonly<{ value: string; label: string; disabled?: boolean | undefined }>[];
  "aria-describedby"?: string | undefined;
  "aria-label"?: string | undefined;
  "aria-invalid"?: boolean | undefined;
  unset?: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
}>): ReactElement {
  const known = value === "" || options.some((option) => option.value === value);
  if (options.length > 8)
    return (
      <StudioReferencePicker
        id={id}
        value={value}
        options={options}
        unset={unset}
        disabled={disabled}
        onChange={onChange}
        aria-describedby={describedBy}
        aria-label={label}
        aria-invalid={invalid}
      />
    );
  const entries = [
    ...(unset === undefined ? [] : [{ value: "", label: unset, disabled: false }]),
    ...(known ? [] : [{ value, label: "A removed item", disabled: true }]),
    ...options,
  ];
  return (
    <Select
      items={entries.map((entry) => ({ value: entry.value, label: entry.label }))}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        aria-invalid={invalid === true || !known}
        disabled={disabled}
      >
        <SelectValue placeholder={unset ?? "Choose…"} />
      </SelectTrigger>
      <SelectContent>
        {entries.map((entry) => (
          <SelectItem key={entry.value} value={entry.value} disabled={entry.disabled}>
            {entry.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const unsetLabel = (
  property: BlockPropertySchemaContract,
  defaultLabel: string | undefined,
): string =>
  defaultLabel !== undefined
    ? `Default (${defaultLabel})`
    : property.required
      ? "Choose…"
      : "Not set";

/** The control of one setting, by its declared kind. */
function SettingControl(props: ControlProps): ReactElement {
  const { id, property, value, onChange, choices, disabled, descriptionId } = props;
  switch (property.kind) {
    case "text":
    case "url": {
      const text = value?.kind === property.kind ? value.value : "";
      const change = (next: string) =>
        onChange(
          next === ""
            ? undefined
            : property.kind === "text"
              ? { kind: "text", value: next }
              : { kind: "url", value: next },
        );
      return property.kind === "text" && property.maxLength > 160 ? (
        <Textarea
          id={id}
          aria-describedby={descriptionId}
          disabled={disabled}
          maxLength={property.maxLength}
          value={text}
          onChange={(event) => change(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          aria-describedby={descriptionId}
          type={property.kind === "url" ? "url" : "text"}
          disabled={disabled}
          {...(property.kind === "text" ? { maxLength: property.maxLength } : {})}
          placeholder={
            property.defaultValue?.kind === property.kind ? property.defaultValue.value : undefined
          }
          value={text}
          onChange={(event) => change(event.target.value)}
        />
      );
    }
    case "icon":
      return (
        <Input
          id={id}
          aria-describedby={descriptionId}
          disabled={disabled}
          value={value?.kind === "icon" ? value.icon_key : ""}
          onChange={(event) =>
            onChange(
              event.target.value === ""
                ? undefined
                : { kind: "icon", icon_key: event.target.value },
            )
          }
        />
      );
    case "number":
      return <NumberControl {...props} />;
    case "boolean": {
      const fallback =
        property.defaultValue?.kind === "boolean" ? property.defaultValue.value : false;
      return (
        <Switch
          id={id}
          aria-describedby={descriptionId}
          disabled={disabled}
          checked={value?.kind === "boolean" ? value.value : fallback}
          onCheckedChange={(checked) => onChange({ kind: "boolean", value: checked === true })}
        />
      );
    }
    case "choice": {
      const defaultKey =
        property.defaultValue?.kind === "choice" ? property.defaultValue.value : undefined;
      // A short choice that always has a value (its definition default) reads at a glance as a
      // segmented control; it shows the default as selected until the person picks another.
      if (defaultKey !== undefined && property.options.length <= 4)
        return (
          <ToggleGroup
            id={id}
            aria-label={property.label}
            aria-describedby={descriptionId}
            variant="outline"
            size="sm"
            className="w-full"
            disabled={disabled}
            value={[value?.kind === "choice" ? value.value : defaultKey]}
            onValueChange={(next) => {
              if (next[0] !== undefined) onChange({ kind: "choice", value: next[0] });
            }}
          >
            {property.options.map((option) => (
              <ToggleGroupItem key={option.key} value={option.key} className="flex-1">
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        );
      return (
        <StudioOptionControl
          id={id}
          aria-describedby={descriptionId}
          disabled={disabled}
          value={value?.kind === "choice" ? value.value : ""}
          unset={unsetLabel(
            property,
            property.options.find((option) => option.key === defaultKey)?.label,
          )}
          options={property.options.map((option) => ({ value: option.key, label: option.label }))}
          onChange={(next) => onChange(next === "" ? undefined : { kind: "choice", value: next })}
        />
      );
    }
    case "field_reference":
      return (
        <StudioReferencePicker
          id={id}
          aria-describedby={descriptionId}
          disabled={disabled}
          value={value?.kind === "field_reference" ? value.field : ""}
          unset={
            choices.fields.length === 0 ? "Choose the data first" : unsetLabel(property, undefined)
          }
          options={studioFittingFields(property, choices.fields).map((field) => ({
            value: field.reference,
            label: field.label,
          }))}
          onChange={(next) =>
            onChange(next === "" ? undefined : { kind: "field_reference", field: next })
          }
        />
      );
    case "total_reference":
      return (
        <StudioReferencePicker
          id={id}
          aria-describedby={descriptionId}
          disabled={disabled}
          value={value?.kind === "total_reference" ? value.value : ""}
          unset={
            choices.totals.length === 0
              ? "Add a total to the query first"
              : unsetLabel(property, undefined)
          }
          options={choices.totals.map((total) => ({
            value: total.alias,
            label: total.label,
            group: "Totals of the query",
          }))}
          onChange={(next) =>
            onChange(next === "" ? undefined : { kind: "total_reference", value: next })
          }
        />
      );
    case "query_reference":
      return (
        <StudioReferencePicker
          id={id}
          aria-describedby={descriptionId}
          disabled={disabled}
          value={value?.kind === "query_reference" ? value.query : ""}
          unset={unsetLabel(property, undefined)}
          options={choices.queries.map(borrowableOption)}
          onChange={(next) =>
            onChange(next === "" ? undefined : { kind: "query_reference", query: next })
          }
        />
      );
    case "page_reference":
      return (
        <StudioReferencePicker
          id={id}
          aria-describedby={descriptionId}
          disabled={disabled}
          value={value?.kind === "page_reference" ? value.page : ""}
          unset={unsetLabel(property, undefined)}
          options={choices.pages.map((page) => ({ value: page.key, label: page.label }))}
          onChange={(next) =>
            onChange(next === "" ? undefined : { kind: "page_reference", page: next })
          }
        />
      );
    case "record_type_reference":
      return (
        <StudioReferencePicker
          id={id}
          aria-describedby={descriptionId}
          disabled={disabled}
          value={value?.kind === "record_type_reference" ? value.record_type : ""}
          unset={unsetLabel(property, undefined)}
          options={choices.recordTypes.map((recordType) => ({
            value: recordType.key,
            label: recordType.label,
          }))}
          onChange={(next) =>
            onChange(next === "" ? undefined : { kind: "record_type_reference", record_type: next })
          }
        />
      );
    case "action_reference":
      return (
        <BorrowableReferenceControl
          id={id}
          disabled={disabled}
          choices={choices.actions}
          value={value?.kind === "action_reference" ? value.action : ""}
          unset={
            choices.actions.length === 0
              ? "This application has no actions yet"
              : unsetLabel(property, undefined)
          }
          onChange={(next) =>
            onChange(next === "" ? undefined : { kind: "action_reference", action: next })
          }
        />
      );
    case "relationship_reference":
      return (
        <BorrowableReferenceControl
          id={id}
          disabled={disabled}
          choices={choices.relationships}
          value={value?.kind === "relationship_reference" ? value.relationship : ""}
          unset={
            choices.relationships.length === 0
              ? "Its records have no relationships"
              : unsetLabel(property, undefined)
          }
          onChange={(next) =>
            onChange(
              next === "" ? undefined : { kind: "relationship_reference", relationship: next },
            )
          }
        />
      );
    case "record_reference":
      return (
        <StudioRecordReferenceControl
          id={id}
          disabled={disabled}
          recordTypes={choices.recordTypes}
          read={choices.records}
          value={
            value?.kind === "record_reference"
              ? { recordType: value.record_type, recordId: value.record_id }
              : undefined
          }
          onChange={(next) =>
            onChange(
              next === undefined
                ? undefined
                : {
                    kind: "record_reference",
                    record_type: next.recordType,
                    record_id: next.recordId,
                  },
            )
          }
        />
      );
    case "rich_text":
      return <RichTextControl {...props} />;
    case "group":
      return <GroupControl {...props} />;
    case "list":
      return <ListControl {...props} />;
    case "asset_reference":
      // Vortex has no asset library to pick from, so this kind is refused where it is declared.
      return (
        <p
          role="alert"
          className="text-sm text-destructive"
          id={id}
          aria-describedby={descriptionId}
          data-vortex-setting-refused={property.key}
        >
          {property.label} points at an asset, and Vortex has no asset library yet, so it can't be
          set here.
        </p>
      );
    default: {
      // A kind outside the closed contract fails closed, named by where it is declared.
      const kind = (property as { kind: unknown }).kind;
      console.error(
        `[studio] setting control refused: setting=${id} kind=${String(kind)} reason=unknown_kind`,
      );
      return (
        <p
          role="alert"
          className="text-sm text-destructive"
          id={id}
          aria-describedby={descriptionId}
          data-vortex-setting-refused={id}
        >
          {`${(property as { label?: string }).label ?? id} has a kind of setting Studio does not know, so it can't be edited.`}
        </p>
      );
    }
  }
}

type RichTextDocument = Extract<SourceBlockPropertyValueContract, { kind: "rich_text" }>["value"];
type RichTextInline = Extract<
  RichTextDocument["blocks"][number],
  { kind: "paragraph" }
>["children"][number];

const inlineWords = (inline: RichTextInline): string =>
  inline.kind === "text" ? inline.text : inline.children.map(inlineWords).join("");

/** The plain words of a rich-text document, one line per paragraph, heading or list item. */
const richTextWords = (document: RichTextDocument): string =>
  document.blocks
    .map((block) =>
      block.kind === "paragraph" || block.kind === "heading"
        ? block.children.map(inlineWords).join("")
        : block.items.map((item) => item.map(inlineWords).join("")).join("\n"),
    )
    .join("\n");

/**
 * Formatted text written as plain paragraphs. The stored document is kept as it is until the
 * person changes the words; an edit stores one paragraph per non-blank line.
 */
function RichTextControl({ id, value, onChange, disabled }: ControlProps): ReactElement {
  const current = value?.kind === "rich_text" ? richTextWords(value.value) : "";
  const [draft, setDraft] = useState(current);
  const [seen, setSeen] = useState(current);
  if (current !== seen) {
    setSeen(current);
    setDraft(current);
  }
  return (
    <Textarea
      id={id}
      disabled={disabled}
      value={draft}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const paragraphs = text
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        onChange(
          paragraphs.length === 0
            ? undefined
            : {
                kind: "rich_text",
                value: {
                  blocks: paragraphs.map((line) => ({
                    kind: "paragraph" as const,
                    children: [{ kind: "text" as const, text: line }],
                  })),
                },
              },
        );
      }}
    />
  );
}

/**
 * A reference to something of this application or of a Module it uses: its own first, then the
 * borrowed ones, which are chosen as they are and changed in their own application.
 */
function BorrowableReferenceControl({
  id,
  value,
  choices,
  unset,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  value: string;
  choices: readonly Readonly<{
    reference: string;
    label: string;
    borrowedFrom?: string | undefined;
  }>[];
  unset: string;
  disabled: boolean;
  onChange: (value: string) => void;
}>): ReactElement {
  return (
    <StudioReferencePicker
      id={id}
      value={value}
      disabled={disabled}
      unset={unset}
      onChange={onChange}
      options={choices.map(borrowableOption)}
    />
  );
}

/** A choice of this application or, grouped under its owner's name, of an application it uses. */
const borrowableOption = (
  choice: Readonly<{ reference: string; label: string; borrowedFrom?: string | undefined }>,
): StudioReferencePickerOption => ({
  value: choice.reference,
  label: choice.label,
  group:
    choice.borrowedFrom === undefined
      ? "This application"
      : studioBorrowedGroup(choice.borrowedFrom),
  readOnly: choice.borrowedFrom !== undefined,
});

function GroupControl({
  id,
  property,
  value,
  onChange,
  choices,
  disabled,
}: ControlProps): ReactElement {
  if (property.kind !== "group") throw new TypeError("A group control needs a group setting.");
  const group = value?.kind === "group" ? value : undefined;
  const optional = !property.required && property.defaultValue === undefined;
  const named = property.namedEntry;
  const fields = (properties: readonly BlockPropertySchemaContract[], locked = disabled) => (
    <SettingFields
      idPrefix={id}
      properties={properties}
      values={group?.properties ?? {}}
      choices={choices}
      disabled={locked}
      onChange={(properties) => onChange({ kind: "group", properties: { ...properties } })}
    />
  );
  return (
    <div className="space-y-2">
      {optional && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={group !== undefined}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange(checked === true ? { kind: "group", properties: {} } : undefined)
            }
          />
          Use {property.label.toLowerCase()}
        </label>
      )}
      {(group !== undefined || !optional) && (
        <div className="space-y-4">
          {named === undefined ? (
            fields(property.properties)
          ) : (
            <>
              {fields(property.properties.filter((child) => child.key === named.label))}
              <StudioInspectorGroup title="Details" defaultOpen={false}>
                {fields(
                  property.properties.filter((child) => child.key === named.value),
                  true,
                )}
                {fields(
                  property.properties.filter(
                    (child) => child.key !== named.label && child.key !== named.value,
                  ),
                )}
              </StudioInspectorGroup>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The name and one-line summary of a list entry: its label and the field it shows, when it has them. */
const entryHeading = (
  item: SourceBlockPropertyValueContract,
  declaration: BlockPropertySchemaContract,
  choices: StudioSettingChoices,
): Readonly<{ title: string | undefined; summary: string | undefined }> => {
  const fieldLabel = (reference: string) =>
    choices.fields.find((field) => field.reference === reference)?.label ??
    "Field not offered by this data";
  if (item.kind === "text") return { title: item.value || undefined, summary: undefined };
  if (item.kind === "field_reference") return { title: fieldLabel(item.field), summary: undefined };
  if (item.kind !== "group" || declaration.kind !== "group")
    return { title: undefined, summary: undefined };
  const values = Object.values(item.properties);
  const stored = item.properties[declaration.namedEntry?.label ?? "label"];
  const label = stored?.kind === "text" && stored.value !== "" ? stored.value : undefined;
  const field = values.find((entry) => entry.kind === "field_reference");
  const fieldName = field?.kind === "field_reference" ? fieldLabel(field.field) : undefined;
  const text = values.find((entry) => entry.kind === "text" && entry.value !== "");
  return label !== undefined
    ? { title: label, summary: fieldName === label ? undefined : fieldName }
    : fieldName !== undefined
      ? { title: fieldName, summary: undefined }
      : { title: text?.kind === "text" ? text.value : undefined, summary: undefined };
};

function ListControl({
  id,
  property,
  value,
  onChange,
  choices,
  disabled,
}: ControlProps): ReactElement {
  const [newLabel, setNewLabel] = useState("");
  const [confirm, confirmDialog] = useConfirm();
  if (property.kind !== "list") throw new TypeError("A list control needs a list setting.");
  const items = value?.kind === "list" ? value.items : [];
  const { keys, newKey } = useStudioEntryKeys(items.length);
  const named = property.item.kind === "group" ? property.item.namedEntry : undefined;
  const labelProperty =
    property.item.kind === "group" && named !== undefined
      ? property.item.properties.find((child) => child.key === named.label)
      : undefined;
  const valueProperty =
    property.item.kind === "group" && named !== undefined
      ? property.item.properties.find((child) => child.key === named.value)
      : undefined;
  const maximum = valueProperty?.kind === "text" ? valueProperty.maxLength : 120;
  const taken = new Set(
    items.flatMap((item) => {
      const stored =
        item.kind === "group" && named !== undefined ? item.properties[named.value] : undefined;
      return stored?.kind === "text" ? [stored.value] : [];
    }),
  );
  const base =
    newLabel
      .trim()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, maximum) || "option";
  let generated = base;
  for (let suffix = 2; taken.has(generated); suffix += 1) {
    const ending = `_${suffix}`;
    generated = `${base.slice(0, maximum - ending.length)}${ending}`;
  }
  const write = (next: SourceBlockPropertyValueContract[], nextKeys: string[]) => {
    keys.current = nextKeys;
    onChange(next.length === 0 && !property.required ? undefined : { kind: "list", items: next });
  };
  const fresh =
    named === undefined
      ? initialValue(property.item, choices)
      : {
          kind: "group" as const,
          properties: {
            [named.label]: { kind: "text" as const, value: newLabel.trim() },
            [named.value]: { kind: "text" as const, value: generated },
          },
        };
  const itemName = property.item.label.toLowerCase();
  const full = items.length >= property.maximumItems;
  const add = () => {
    if (fresh === undefined) return;
    write([...items, fresh], [...keys.current, newKey()]);
    setNewLabel("");
  };
  return (
    <>
      <StudioEntryList
        label={property.label}
        itemName={itemName}
        disabled={disabled}
        empty="No entries yet."
        items={items.map((item, index) => {
          const heading = entryHeading(item, property.item, choices);
          return {
            key: keys.current[index]!,
            title: heading.title ?? `${property.item.label} ${index + 1}`,
            summary: heading.summary,
            content: (
              <SettingControl
                id={`${id}-${keys.current[index]}`}
                property={property.item}
                value={item}
                choices={choices}
                disabled={disabled}
                onChange={(next) => {
                  const replacement = next ?? initialValue(property.item, choices);
                  if (replacement === undefined) return;
                  write(
                    items.map((entry, position) => (position === index ? replacement : entry)),
                    keys.current,
                  );
                }}
              />
            ),
          };
        })}
        onMove={(from, to) => {
          const next = [...items];
          const nextKeys = [...keys.current];
          const [moved] = next.splice(from, 1);
          const [movedKey] = nextKeys.splice(from, 1);
          if (moved === undefined || movedKey === undefined) return;
          next.splice(to, 0, moved);
          nextKeys.splice(to, 0, movedKey);
          write(next, nextKeys);
        }}
        onRemove={(index) => {
          void (async () => {
            const name =
              entryHeading(items[index]!, property.item, choices).title ??
              `${itemName} ${index + 1}`;
            if (
              await confirm({
                title: `Remove ${name}?`,
                description: "This entry will be removed. Undo restores it.",
                confirmLabel: "Remove",
                destructive: true,
              })
            )
              write(
                items.filter((_, position) => position !== index),
                keys.current.filter((_, position) => position !== index),
              );
          })();
        }}
      >
        {named !== undefined ? (
          <InputGroup>
            <InputGroupInput
              id={`${id}-new-label`}
              aria-label={`New ${itemName} label`}
              placeholder={`New ${itemName}`}
              value={newLabel}
              disabled={disabled || full}
              maxLength={labelProperty?.kind === "text" ? labelProperty.maxLength : undefined}
              onChange={(event) => setNewLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && newLabel.trim() !== "") {
                  event.preventDefault();
                  add();
                }
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label={`Add ${itemName}`}
                size="icon-xs"
                disabled={disabled || full || newLabel.trim() === ""}
                onClick={add}
              >
                <Plus />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || fresh === undefined || full}
            onClick={add}
          >
            <Plus />
            Add {itemName}
          </Button>
        )}
      </StudioEntryList>
      {confirmDialog}
    </>
  );
}

/** What a query asks for, in a picker row: its inputs by name, or nothing when it asks for none. */
const queryInputsDescription = (query: StudioQueryChoice): string | undefined =>
  query.inputs.length === 0
    ? undefined
    : `Asks for ${query.inputs.map((input) => (input.required ? input.label : `${input.label} (optional)`)).join(", ")}`;

/**
 * The data a block reads: one of the application's own queries or an exposed query of a Module it
 * uses, which is chosen as it is. `onNewQuery` opens the query sheet, which creates a query in one
 * of the application's own Modules and comes back with it chosen.
 */
export function StudioQueryPicker({
  id,
  queries,
  recordQueries = [],
  value,
  onChange,
  onNewQuery,
  disabled,
}: Readonly<{
  id: string;
  queries: readonly StudioQueryChoice[];
  recordQueries?: readonly StudioQueryChoice[] | undefined;
  value: string;
  onChange: (reference: string) => void;
  onNewQuery?: (() => void) | undefined;
  disabled: boolean;
}>): ReactElement {
  return (
    <div className="space-y-2" data-vortex-setting="query">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>Data</Label>
        {onNewQuery === undefined ? null : (
          <Button type="button" size="xs" variant="ghost" disabled={disabled} onClick={onNewQuery}>
            <Plus />
            New query
          </Button>
        )}
      </div>
      <StudioReferencePicker
        id={id}
        value={value}
        disabled={disabled}
        unset="Choose data"
        onChange={onChange}
        options={[
          ...recordQueries.map((query) => ({
            value: query.reference,
            label: query.label,
            group: "Record types",
            description: `Show all ${query.label.toLowerCase()}`,
          })),
          ...queries.map((query) => ({
            ...borrowableOption(query),
            description: queryInputsDescription(query),
          })),
        ]}
      />
      {queries.length === 0 && recordQueries.length === 0 && (
        <p role="status" className="text-sm">
          {onNewQuery === undefined
            ? "Add a query in the Data tab first."
            : "Add a query with New query."}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        Choose a record type to show all its records, or use an existing query.
      </p>
    </div>
  );
}

/**
 * The typed controls of a set of declared settings, each with its label, whether it is required,
 * its help and its default. `values` holds the settings that are set; a setting left out takes
 * its default.
 */
type SettingFieldsProps = Readonly<{
  idPrefix: string;
  properties: readonly BlockPropertySchemaContract[];
  values: StudioSettingValues;
  onChange: (values: StudioSettingValues) => void;
  choices: StudioSettingChoices;
  disabled: boolean;
}>;

export function StudioSettingFields(props: SettingFieldsProps): ReactElement {
  // Keep the previously committed choices: an inline query can disappear from the new choices.
  const previous = useRef({
    values: props.values,
    fields: props.choices.fields,
    id: props.idPrefix,
  });
  useEffect(() => {
    const before = previous.current;
    previous.current = { values: props.values, fields: props.choices.fields, id: props.idPrefix };
    // New settings came from an edit callback, selection or history, rather than a query switch.
    if (
      props.disabled ||
      before.id !== props.idPrefix ||
      (before.values !== props.values &&
        canonicalJson(before.values) !== canonicalJson(props.values))
    )
      return;
    const values = followFieldLabels(
      props.properties,
      props.values,
      before.values,
      props.choices.fields,
      before.fields,
    );
    if (values !== props.values) props.onChange(values);
  }, [
    props.values,
    props.choices.fields,
    props.properties,
    props.idPrefix,
    props.disabled,
    props.onChange,
  ]);
  return (
    <SettingFields
      {...props}
      onChange={(values) =>
        props.onChange(
          followFieldLabels(
            props.properties,
            values,
            props.values,
            props.choices.fields,
            props.choices.fields,
          ),
        )
      }
    />
  );
}

function SettingFields({
  idPrefix,
  properties,
  values,
  onChange,
  choices,
  disabled,
}: SettingFieldsProps): ReactElement {
  const [touched, setTouched] = useState<{ id: string; keys: ReadonlySet<string> }>({
    id: idPrefix,
    keys: new Set(),
  });
  // A field's optional label is an override. Matching text follows the field when it changes;
  // other text stays authored, with an explicit way to return to the field's label.
  const fieldProperty = properties.find(
    (property) => property.key === "field" && property.kind === "field_reference",
  );
  const labelProperty = properties.find(
    (property) =>
      property.key === "label" &&
      property.kind === "text" &&
      !property.required &&
      property.defaultValue === undefined,
  );
  const fieldValue = fieldProperty === undefined ? undefined : values[fieldProperty.key];
  const field =
    fieldValue?.kind === "field_reference"
      ? choices.fields.find((candidate) => candidate.reference === fieldValue.field)
      : undefined;
  const label = labelProperty === undefined ? undefined : values[labelProperty.key];
  const labelText = label?.kind === "text" ? label.value : undefined;
  const fieldReference = fieldValue?.kind === "field_reference" ? fieldValue.field : undefined;
  const [labelSource, setLabelSource] = useState({
    idPrefix,
    labelText,
    fieldReference,
    fieldLabel: field?.label,
  });
  if (labelSource.idPrefix !== idPrefix || labelSource.labelText !== labelText)
    setLabelSource({ idPrefix, labelText, fieldReference, fieldLabel: field?.label });
  const fieldChanged =
    labelSource.fieldReference !== fieldReference || labelSource.fieldLabel !== field?.label;
  const useFieldLabel = () => {
    const result = { ...values };
    delete result.label;
    onChange(result);
  };
  return (
    <div className="space-y-4">
      {properties.map((property) => {
        if (!componentSettingApplies(property, values)) return null;
        const value = Object.hasOwn(values, property.key) ? values[property.key] : undefined;
        const set = (next: SettingValue) => {
          setTouched((previous) => ({
            id: idPrefix,
            keys: new Set([...(previous.id === idPrefix ? previous.keys : []), property.key]),
          }));
          const result: Record<string, SourceBlockPropertyValueContract> = { ...values };
          if (next === undefined) delete result[property.key];
          // A group's declared defaults are part of its typed value. Materialize them here,
          // including new list entries, before the composition command checks its round trip.
          // Incomplete user input stays in the ordinary settings validation path.
          else
            result[property.key] =
              typedSourceSettingValue(
                plainSourceSettingValue(next),
                property,
                [property.key],
                [],
              ) ?? next;
          for (const sibling of properties) {
            if (!componentSettingApplies(sibling, result)) delete result[sibling.key];
            else if (result[sibling.key] === undefined && sibling.defaultValue !== undefined) {
              const initial = typedSourceSettingValue(
                plainSettingValue(sibling.defaultValue),
                sibling,
                [sibling.key],
                [],
              );
              if (initial === undefined)
                throw new TypeError(`The declared default for ${sibling.key} is invalid.`);
              result[sibling.key] = initial;
            }
          }
          onChange(result);
        };
        return (
          <div key={property.key} className="space-y-2" data-vortex-setting={property.key}>
            <StudioField
              label={property.label}
              optional={!property.required}
              hint={property.help}
              error={
                property.required &&
                property.showWhen !== undefined &&
                property.defaultValue === undefined &&
                value === undefined
                  ? conditionalRequiredMessage(property)
                  : undefined
              }
            >
              {(control) => (
                <SettingControl
                  id={control.id}
                  descriptionId={control["aria-describedby"]}
                  property={studioTotalMeasureProperty(
                    property,
                    properties,
                    values,
                    choices.fields,
                  )}
                  value={value}
                  onChange={set}
                  choices={choices}
                  disabled={disabled}
                />
              )}
            </StudioField>
            {property.key === "auto_size" && fieldProperty !== undefined && (
              <p className="text-sm text-muted-foreground">
                {fieldReference !== undefined
                  ? "Available"
                  : `Not possible - ${labelText?.trim() || "Column"} has no field to measure`}
              </p>
            )}
            {property.key === "allow_full_screen" && (
              <p className="text-sm text-muted-foreground">Available</p>
            )}
            {property === labelProperty && fieldProperty !== undefined && (
              <div className="space-y-1 text-sm text-muted-foreground">
                {field === undefined &&
                touched.id === idPrefix &&
                (touched.keys.has(fieldProperty.key) || touched.keys.has(property.key)) ? (
                  <p role="alert">Choose a field offered by this data to resolve its label.</p>
                ) : field === undefined ? null : label?.kind === "text" ? (
                  <>
                    {fieldChanged && label.value !== field.label && (
                      <p role="alert">
                        The field changed since this label was set. Keep it as a custom label, or
                        use &ldquo;{field.label}&rdquo;.
                      </p>
                    )}
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      disabled={disabled}
                      className="h-auto px-0 whitespace-normal text-left"
                      onClick={useFieldLabel}
                    >
                      Use field label: {field.label}
                    </Button>
                  </>
                ) : (
                  <p className="text-muted-foreground">Uses field label: {field.label}</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
