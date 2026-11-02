"use client";

import { Alert, AlertDescription } from "../components/alert";
import { FieldGroup } from "../components/field";
import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  canonicalJson,
  componentSettingApplies,
  plainSettingValue,
  plainSourceSettingValue,
  typedSourceSettingValue,
  type BlockPropertySchemaContract,
  type SourceBlockPropertyValueContract,
} from "@vortex/platform/schema";
import { followFieldLabels } from "./follow-field-labels";
import { studioTotalMeasureProperty } from "./grid-features/totals";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { Switch } from "../components/switch";
import { StudioSegmentedControl } from "./studio-segmented-control";
import { Input } from "../components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "../components/input-group";
import { Plus } from "lucide-react";
import { StudioReferencePicker } from "./studio-reference-picker";
import { StudioField } from "./studio-field";
import { Label } from "../components/label";
import { splitMoreSettings } from "./studio-more-settings";
import { StudioEntryList, useStudioEntryKeys } from "./studio-entry-list";
import { useConfirm } from "../components/confirm-dialog";
import { StudioInspectorGroup } from "./studio-inspector-group";
import { Textarea } from "../components/textarea";
import { StudioRecordReferenceControl } from "./studio-record-reference-control";
import {
  type SettingValue,
  type StudioSettingValues,
  type StudioSettingChoices,
  initialValue,
  studioFittingFields,
  conditionalRequiredMessage,
  type ControlProps,
} from "./studio-setting-model";
import {
  NumberControl,
  RichTextControl,
  StudioOptionControl,
} from "./studio-setting-basic-controls";
import { borrowableOption } from "./studio-query-picker";

/**
 * Studio's one set of typed setting controls: one control per declared block property, chosen by
 * the property's kind. The Set-up dialog of a new block and the inspector of a placed block both
 * draw their settings with these controls, and both hand the typed values to the composition
 * commands, which judge them as stored data.
 */

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
      // A display bound to a page value picks it among the values the page declares.
      if (property.kind === "text" && property.key === "page_value")
        return choices.pageValues.length === 0 ? (
          <p className="text-sm text-muted-foreground" id={id}>
            This page declares no values yet. Add one in the page's Page values.
          </p>
        ) : (
          <StudioOptionControl
            id={id}
            value={text}
            options={choices.pageValues.map((entry) => ({ value: entry.key, label: entry.label }))}
            unset={unsetLabel(property, undefined)}
            disabled={disabled}
            aria-describedby={descriptionId}
            onChange={(next) => onChange(next === "" ? undefined : { kind: "text", value: next })}
          />
        );
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
          <StudioSegmentedControl
            id={id}
            label={property.label}
            aria-describedby={descriptionId}
            disabled={disabled}
            value={value?.kind === "choice" ? value.value : defaultKey}
            options={property.options.map((option) => ({ value: option.key, label: option.label }))}
            onChange={(next) => onChange({ kind: "choice", value: next })}
          />
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
        <Label className="gap-2">
          <Checkbox
            checked={group !== undefined}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange(checked === true ? { kind: "group", properties: {} } : undefined)
            }
          />
          Use {property.label.toLowerCase()}
        </Label>
      )}
      {(group !== undefined || !optional) && (
        <FieldGroup>
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
        </FieldGroup>
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
type SettingFieldsProps = Readonly<{
  idPrefix: string;
  /** Optional settings that start in a closed "More settings" section. */
  moreKeys?: ReadonlySet<string> | undefined;
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
  moreKeys,
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
    <FieldGroup>
      {splitMoreSettings(
        properties.flatMap((property) => {
          if (!componentSettingApplies(property, values)) return [];
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
          return {
            key: property.key,
            node: (
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
                      <Alert variant="destructive">
                        <AlertDescription>
                          Choose a field offered by this data to resolve its label.
                        </AlertDescription>
                      </Alert>
                    ) : field === undefined ? null : label?.kind === "text" ? (
                      <>
                        {fieldChanged && label.value !== field.label && (
                          <Alert variant="destructive">
                            <AlertDescription>
                              The field changed since this label was set. Keep it as a custom label,
                              or use &ldquo;{field.label}&rdquo;.
                            </AlertDescription>
                          </Alert>
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
            ),
          };
        }),
        moreKeys,
      )}
    </FieldGroup>
  );
}
