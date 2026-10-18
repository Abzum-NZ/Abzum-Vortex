"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  canonicalJson,
  validateComponentSettings,
  type ApplicationSourceDocument,
  type BlockPropertySchemaContract,
  type ComponentSettingFailure,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { Switch } from "../components/switch";
import { Input } from "../components/input";
import { Item, ItemActions, ItemContent, ItemHeader, ItemTitle } from "../components/item";
import { StudioReferencePicker } from "./studio-reference-picker";
import { StudioField, StudioHelp } from "./studio-field";
import { StudioInspectorActions } from "./studio-inspector-actions";
import { useConfirm } from "../components/confirm-dialog";
import { StudioInspectorGroup } from "./studio-inspector-group";
import { Label } from "../components/label";
import { NativeSelect, NativeSelectOption } from "../components/native-select";
import { Textarea } from "../components/textarea";
import {
  studioActionChoices,
  studioQueryChoices,
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
  pages: readonly Readonly<{ key: string; label: string }>[];
  recordTypes: readonly Readonly<{ key: string; label: string }>[];
  actions: readonly StudioActionChoice[];
  relationships: readonly StudioRelationshipChoice[];
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
): StudioSettingChoices => ({
  queries: studioQueryChoices(source, borrowed),
  fields: studioSourceFields(source),
  pages: source.body.pages.map((page) => ({ key: page.key, label: page.name })),
  recordTypes: studioSourceRecordTypes(source),
  actions: studioActionChoices(source, borrowed),
  relationships: studioRelationshipChoices(source, borrowed),
  records,
});

/**
 * The choices of one block: a block that reads a query picks only that query's fields, and only
 * the relationships of the record type that query reads.
 */
export const studioBlockChoices = (
  draft: StudioSettingChoices,
  query: string | null,
): StudioSettingChoices => {
  const chosen =
    query === null ? undefined : draft.queries.find((candidate) => candidate.reference === query);
  return chosen === undefined
    ? draft
    : {
        ...draft,
        fields: chosen.fields,
        relationships: draft.relationships.filter(
          (relationship) => relationship.recordType === chosen.recordType,
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
  return parts.join(", ");
};

/** Why these settings would be refused, in words, one line per problem; empty when they pass. */
export const studioSettingProblems = (
  values: StudioSettingValues,
  properties: readonly BlockPropertySchemaContract[],
): readonly string[] => [
  ...new Set(
    validateComponentSettings(values, properties).map(
      (failure) => `${failurePlace(properties, failure.path)} ${familyText[failure.family]}.`,
    ),
  ),
];

/** The value a new list entry starts with. */
const initialValue = (
  property: BlockPropertySchemaContract,
  choices: StudioSettingChoices,
): SettingValue => {
  switch (property.kind) {
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
    case "field_reference":
      return choices.fields[0] === undefined
        ? undefined
        : { kind: "field_reference", field: choices.fields[0].reference };
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

/** A closed choice among labelled options, with the unset state named by what it means (none when a value is always chosen). */
export function StudioOptionControl({
  id,
  value,
  options,
  unset,
  disabled,
  onChange,
  "aria-describedby": describedBy,
}: Readonly<{
  id: string;
  value: string;
  options: readonly Readonly<{ value: string; label: string; disabled?: boolean }>[];
  "aria-describedby"?: string | undefined;
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
      />
    );
  return (
    <NativeSelect
      id={id}
      aria-describedby={describedBy}
      className="w-full"
      disabled={disabled}
      value={value}
      aria-invalid={!known}
      onChange={(event) => onChange(event.target.value)}
    >
      {unset === undefined ? null : <NativeSelectOption value="">{unset}</NativeSelectOption>}
      {known ? null : (
        <NativeSelectOption value={value}>{`${value} (not offered here)`}</NativeSelectOption>
      )}
      {options.map((option) => (
        <NativeSelectOption key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </NativeSelectOption>
      ))}
    </NativeSelect>
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
          options={choices.fields.map((field) => ({ value: field.reference, label: field.label }))}
          onChange={(next) =>
            onChange(next === "" ? undefined : { kind: "field_reference", field: next })
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
          options={choices.queries.map((query) => ({
            value: query.reference,
            label: queryChoiceLabel(query),
          }))}
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
  choices: readonly Readonly<{ reference: string; label: string; borrowedFrom?: string }>[];
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
      options={choices.map((choice) => ({
        value: choice.reference,
        label: choice.label,
        group:
          choice.borrowedFrom === undefined ? "This application" : "Used from other applications",
        description:
          choice.borrowedFrom === undefined ? undefined : `From ${choice.borrowedFrom}, read-only`,
      }))}
    />
  );
}

/** The label a query choice shows: its own, and for a borrowed one where it comes from. */
export const queryChoiceLabel = (query: StudioQueryChoice): string =>
  query.borrowedFrom === undefined
    ? query.label
    : `${query.label} (from ${query.borrowedFrom}, read-only)`;

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
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, maximum) || "option";
  let generated = base;
  for (let suffix = 2; taken.has(generated); suffix += 1) {
    const ending = `_${suffix}`;
    generated = `${base.slice(0, maximum - ending.length)}${ending}`;
  }
  const write = (next: SourceBlockPropertyValueContract[]) =>
    onChange(next.length === 0 && !property.required ? undefined : { kind: "list", items: next });
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
  const move = (index: number, by: -1 | 1) => {
    const next = [...items];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(index + by, 0, moved);
    write(next);
  };
  return (
    <div className="space-y-2">
      {items.length === 0 && <p className="text-sm text-muted-foreground">No entries yet.</p>}
      <ol className="space-y-2">
        {items.map((item, index) => (
          <Item key={index} render={<li />} variant="outline" size="sm">
            <ItemHeader className="flex-wrap gap-2">
              <ItemTitle>
                {property.item.label} {index + 1}
              </ItemTitle>
              <ItemActions>
                <StudioInspectorActions
                  actions={[
                    {
                      label: "Move up",
                      disabled: disabled || index === 0,
                      onSelect: () => move(index, -1),
                    },
                    {
                      label: "Move down",
                      disabled: disabled || index === items.length - 1,
                      onSelect: () => move(index, 1),
                    },
                    {
                      label: "Remove",
                      disabled,
                      destructive: true,
                      onSelect: () => {
                        void (async () => {
                          if (
                            await confirm({
                              title: `Remove ${property.item.label} ${index + 1}?`,
                              description: "This entry will be removed. Undo restores it.",
                              confirmLabel: "Remove",
                              destructive: true,
                            })
                          )
                            write(items.filter((_, position) => position !== index));
                        })();
                      },
                    },
                  ]}
                />
              </ItemActions>
            </ItemHeader>
            <ItemContent className="basis-full">
              <SettingControl
                id={`${id}-${index}`}
                property={property.item}
                value={item}
                choices={choices}
                disabled={disabled}
                onChange={(next) => {
                  const replacement = next ?? initialValue(property.item, choices);
                  if (replacement === undefined) return;
                  write(items.map((entry, position) => (position === index ? replacement : entry)));
                }}
              />
            </ItemContent>
          </Item>
        ))}
      </ol>
      {named !== undefined && (
        <div className="space-y-1">
          <Label htmlFor={`${id}-new-label`}>New {property.item.label.toLowerCase()} label</Label>
          <Input
            id={`${id}-new-label`}
            value={newLabel}
            disabled={disabled || items.length >= property.maximumItems}
            maxLength={labelProperty?.kind === "text" ? labelProperty.maxLength : undefined}
            onChange={(event) => setNewLabel(event.target.value)}
          />
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={
          disabled ||
          fresh === undefined ||
          items.length >= property.maximumItems ||
          (named !== undefined && newLabel.trim() === "")
        }
        onClick={() => {
          if (fresh !== undefined) {
            write([...items, fresh]);
            setNewLabel("");
          }
        }}
      >
        Add {property.item.label.toLowerCase()}
      </Button>
      {confirmDialog}
    </div>
  );
}

/**
 * The data a block reads: one of the queries the application already has, its own Modules' first
 * and then the borrowed ones of the Modules it uses, which are chosen as they are. Queries are
 * created in the Data tab.
 */
export function StudioQueryPicker({
  id,
  queries,
  value,
  onChange,
  disabled,
}: Readonly<{
  id: string;
  queries: readonly StudioQueryChoice[];
  value: string;
  onChange: (reference: string) => void;
  disabled: boolean;
}>): ReactElement {
  return (
    <div className="space-y-2" data-vortex-setting="query">
      <Label htmlFor={id}>Data</Label>
      <StudioReferencePicker
        id={id}
        value={value}
        disabled={disabled}
        unset="Choose data"
        onChange={onChange}
        options={queries.map((query) => ({
          value: query.reference,
          label: query.label,
          group:
            query.borrowedFrom === undefined ? "This application" : "Used from other applications",
          description:
            query.borrowedFrom === undefined ? undefined : `From ${query.borrowedFrom}, read-only`,
        }))}
      />
      {queries.length === 0 && (
        <p role="status" className="text-sm">
          Add a query in the Data tab first.
        </p>
      )}
      <StudioHelp hint="The records this block shows. Queries are created and changed in the Data tab." />
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

/** Remove copied field labels in one update, including every column affected by a query change. */
const followFieldLabels = (
  properties: readonly BlockPropertySchemaContract[],
  values: StudioSettingValues,
  previous: StudioSettingValues,
  fields: readonly StudioQueryField[],
  previousFields: readonly StudioQueryField[],
): StudioSettingValues => {
  let result = values;
  const write = (key: string, value: SettingValue) => {
    const next = { ...result };
    if (value === undefined) delete next[key];
    else next[key] = value;
    result = next;
  };
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
  const oldField = fieldProperty === undefined ? undefined : previous.field;
  const newField = fieldProperty === undefined ? undefined : values.field;
  const oldLabel =
    oldField?.kind === "field_reference"
      ? previousFields.find((field) => field.reference === oldField.field)?.label
      : undefined;
  const newLabel =
    newField?.kind === "field_reference"
      ? fields.find((field) => field.reference === newField.field)?.label
      : undefined;
  const label = labelProperty === undefined ? undefined : values.label;
  if (
    label?.kind === "text" &&
    previous.label?.kind === "text" &&
    label.value === previous.label.value &&
    label.value === oldLabel &&
    oldField?.kind === "field_reference" &&
    (newField?.kind !== "field_reference" ||
      oldField.field !== newField.field ||
      oldLabel !== newLabel)
  )
    write("label", undefined);

  const visit = (
    property: BlockPropertySchemaContract,
    value: SettingValue,
    before: SettingValue,
  ): SettingValue => {
    if (property.kind === "group" && value?.kind === "group") {
      const children = followFieldLabels(
        property.properties,
        value.properties,
        before?.kind === "group" ? before.properties : {},
        fields,
        previousFields,
      );
      return children === value.properties ? value : { ...value, properties: { ...children } };
    }
    if (property.kind === "list" && value?.kind === "list") {
      const items = value.items.map((item, index) =>
        visit(property.item, item, before?.kind === "list" ? before.items[index] : undefined)!,
      );
      return items.every((item, index) => item === value.items[index])
        ? value
        : { ...value, items };
    }
    return value;
  };
  for (const property of properties) {
    const value = visit(property, values[property.key], previous[property.key]);
    if (value !== values[property.key]) write(property.key, value);
  }
  return result;
};

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
  const visible = (property: BlockPropertySchemaContract, settings: StudioSettingValues) => {
    if (property.showWhen === undefined) return true;
    const selected = settings[property.showWhen.property];
    return selected?.kind === "choice" && property.showWhen.values.includes(selected.value);
  };
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
        if (!visible(property, values)) return null;
        const value = Object.hasOwn(values, property.key) ? values[property.key] : undefined;
        const set = (next: SettingValue) => {
          const result: Record<string, SourceBlockPropertyValueContract> = { ...values };
          if (next === undefined) delete result[property.key];
          else result[property.key] = next;
          for (const sibling of properties)
            if (!visible(sibling, result)) delete result[sibling.key];
          onChange(result);
        };
        return (
          <div key={property.key} className="space-y-2" data-vortex-setting={property.key}>
            <StudioField label={property.label} optional={!property.required} hint={property.help}>
              {(control) => (
                <SettingControl
                  id={control.id}
                  descriptionId={control["aria-describedby"]}
                  property={property}
                  value={value}
                  onChange={set}
                  choices={choices}
                  disabled={disabled}
                />
              )}
            </StudioField>
            {property === labelProperty && fieldProperty !== undefined && (
              <div className="space-y-1 text-xs">
                {field === undefined ? (
                  <p role="alert">Choose a field offered by this data to resolve its label.</p>
                ) : label?.kind === "text" ? (
                  <>
                    {fieldChanged && label.value !== field.label && (
                      <p role="alert">
                        The field changed since this label was set. Keep it as a custom label, or
                        use &ldquo;{field.label}&rdquo;.
                      </p>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={disabled}
                      className="h-auto whitespace-normal text-left"
                      onClick={useFieldLabel}
                    >
                      Use field label: {field.label}
                    </Button>
                  </>
                ) : (
                  <p>Uses field label: {field.label}</p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
