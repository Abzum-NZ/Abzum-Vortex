"use client";

import { Alert, AlertDescription } from "../components/alert";
import { FieldDescription, FieldGroup } from "../components/field";
import { StudioLimitNote, Reasoned, studioLimitReason } from "./studio-limit";
import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  canonicalJson,
  componentSettingApplies,
  isRepeatableSlotIdentity,
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
import { StudioField } from "./studio-field";
import { Label } from "../components/label";
import { StudioEntryList, useStudioEntryKeys } from "./studio-entry-list";
import { useConfirm } from "../components/confirm-dialog";
import { StudioInspectorGroup } from "./studio-inspector-group";
import { Textarea } from "../components/textarea";
import {
  StudioFieldPickerControl,
  StudioRecordControl,
  StudioReferenceControl,
} from "./studio-reference-controls";
import {
  type SettingValue,
  type StudioSettingValues,
  type StudioSettingChoices,
  initialValue,
  settleStudioSetting,
  studioUnsetLabel,
  conditionalRequiredMessage,
  type ControlProps,
} from "./studio-setting-model";
import {
  NumberControl,
  RichTextControl,
  StudioOptionControl,
} from "./studio-setting-basic-controls";

/**
 * Studio's one set of typed setting controls: one control per declared block property, chosen by
 * the property's kind. The Set-up dialog of a new block and the inspector of a placed block both
 * draw their settings with these controls, and both hand the typed values to the composition
 * commands, which judge them as stored data.
 */

/** The control of one setting, by its declared kind. */
export function StudioSettingControl(props: ControlProps): ReactElement {
  const { id, property, value, onChange, choices, disabled, descriptionId, invalid } = props;
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
            unset={studioUnsetLabel(property, undefined)}
            disabled={disabled}
            aria-describedby={descriptionId}
            aria-invalid={invalid || undefined}
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
          aria-invalid={invalid || undefined}
          disabled={disabled}
          maxLength={property.maxLength}
          value={text}
          onChange={(event) => change(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          aria-describedby={descriptionId}
          aria-invalid={invalid || undefined}
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
          aria-invalid={invalid || undefined}
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
          aria-invalid={invalid || undefined}
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
          aria-invalid={invalid || undefined}
          disabled={disabled}
          value={value?.kind === "choice" ? value.value : ""}
          unset={studioUnsetLabel(
            property,
            property.options.find((option) => option.key === defaultKey)?.label,
          )}
          options={property.options.map((option) => ({ value: option.key, label: option.label }))}
          onChange={(next) => onChange(next === "" ? undefined : { kind: "choice", value: next })}
        />
      );
    }
    case "field_reference":
      return <StudioFieldPickerControl {...props} />;
    case "total_reference":
    case "query_reference":
    case "page_reference":
    case "record_type_reference":
    case "action_reference":
    case "relationship_reference":
      return <StudioReferenceControl {...props} />;
    case "record_reference":
      return <StudioRecordControl {...props} />;
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

/** A choice of this application or, grouped under its owner's name, of an application it uses. */
function GroupControl({
  id,
  property,
  value,
  onChange,
  choices,
  disabled,
  problems,
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
      problems={problems}
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

/**
 * Why an entry's identity cannot name a slot, or nothing when it can (an empty identity is the
 * required setting's to report). The two rules the stored page applies: a builder key, and not the
 * identity of another entry.
 */
const identityProblem = (
  identity: Readonly<{ family: string; property: string }>,
  entry: SourceBlockPropertyValueContract,
  others: readonly SourceBlockPropertyValueContract[],
  itemName: string,
): string | undefined => {
  const text = (item: SourceBlockPropertyValueContract) => {
    const stored = item.kind === "group" ? item.properties[identity.property] : undefined;
    return stored?.kind === "text" ? stored.value : "";
  };
  const own = text(entry);
  if (own === "") return undefined;
  if (!isRepeatableSlotIdentity(identity.family, own))
    return "Use lowercase letters, digits and underscores, starting with a letter.";
  return others.some((other) => text(other) === own)
    ? `Another ${itemName} already uses this key.`
    : undefined;
};

type HeldEntry = Readonly<{
  entry: SourceBlockPropertyValueContract;
  problem: string;
  against: string;
}>;

function ListControl({
  id,
  property,
  value,
  onChange,
  choices,
  disabled,
  identity,
}: ControlProps): ReactElement {
  const [newLabel, setNewLabel] = useState("");
  // An entry whose identity cannot name a slot: its text stays in the entry, with its message, and
  // never reaches the draft. It is dropped when the stored entry changes under it (Undo, a reload)
  // and when focus leaves the entry, which then shows the identity the draft keeps.
  const [held, setHeld] = useState<Readonly<Record<string, HeldEntry>>>({});
  const dropHeld = (entryKey: string) =>
    setHeld((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([key]) => key !== entryKey)),
    );
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
  // The choice options are the list that states its limit; the other lists only stop at theirs.
  const optionsLimited = property.key === "options";
  const full = items.length >= property.maximumItems;
  const fullReason = optionsLimited ? studioLimitReason("choiceOptions", items.length) : undefined;
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
          const entryKey = keys.current[index]!;
          const heldEntry = held[entryKey];
          const holding = heldEntry?.against === canonicalJson(item) ? heldEntry : undefined;
          const heading = entryHeading(holding?.entry ?? item, property.item, choices);
          return {
            key: entryKey,
            title: heading.title ?? `${property.item.label} ${index + 1}`,
            summary: heading.summary,
            content: (
              <div
                className="contents"
                onBlur={(event) => {
                  if (
                    holding !== undefined &&
                    !event.currentTarget.contains(event.relatedTarget as Node | null)
                  )
                    dropHeld(entryKey);
                }}
              >
                <StudioSettingControl
                  id={`${id}-${entryKey}`}
                  property={property.item}
                  value={holding?.entry ?? item}
                  choices={choices}
                  disabled={disabled}
                  problems={
                    holding === undefined || identity === undefined
                      ? undefined
                      : { [identity.property]: holding.problem }
                  }
                  onChange={(next) => {
                    const replacement = next ?? initialValue(property.item, choices);
                    if (replacement === undefined) return;
                    const problem =
                      identity === undefined
                        ? undefined
                        : identityProblem(
                            identity,
                            replacement,
                            items.filter((_, position) => position !== index),
                            itemName,
                          );
                    if (problem !== undefined) {
                      setHeld((previous) => ({
                        ...previous,
                        [entryKey]: { entry: replacement, problem, against: canonicalJson(item) },
                      }));
                      return;
                    }
                    dropHeld(entryKey);
                    write(
                      items.map((entry, position) => (position === index ? replacement : entry)),
                      keys.current,
                    );
                  }}
                />
              </div>
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
              <Reasoned reason={fullReason}>
                <InputGroupButton
                  aria-label={`Add ${itemName}`}
                  size="icon-xs"
                  disabled={
                    disabled || (full && fullReason === undefined) || newLabel.trim() === ""
                  }
                  onClick={add}
                >
                  <Plus />
                </InputGroupButton>
              </Reasoned>
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
      {optionsLimited && <StudioLimitNote limit="choiceOptions" used={items.length} />}
      {confirmDialog}
    </>
  );
}

/** What a query asks for, in a picker row: its inputs by name, or nothing when it asks for none. */
type SettingFieldsProps = Readonly<{
  idPrefix: string;
  properties: readonly BlockPropertySchemaContract[];
  values: StudioSettingValues;
  onChange: (values: StudioSettingValues) => void;
  choices: StudioSettingChoices;
  disabled: boolean;
  /** Messages for input held out of the values, by the key of the setting they belong to. */
  problems?: Readonly<Record<string, string>> | undefined;
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
  problems,
}: SettingFieldsProps): ReactElement {
  const [touched, setTouched] = useState<{ id: string; keys: ReadonlySet<string> }>({
    id: idPrefix,
    keys: new Set(),
  });
  const useFieldLabel = () => {
    const result = { ...values };
    delete result.label;
    onChange(result);
  };
  return (
    <FieldGroup>
      {properties.map((property) => {
        if (!componentSettingApplies(property, values)) return null;
        const value = Object.hasOwn(values, property.key) ? values[property.key] : undefined;
        const set = (next: SettingValue) => {
          setTouched((previous) => ({
            id: idPrefix,
            keys: new Set([...(previous.id === idPrefix ? previous.keys : []), property.key]),
          }));
          onChange(settleStudioSetting(properties, values, property.key, next));
        };
        return (
          <div key={property.key} className="space-y-2" data-vortex-setting={property.key}>
            <StudioField
              label={property.label}
              optional={!property.required}
              hint={property.help}
              error={
                problems?.[property.key] ??
                (property.required &&
                property.showWhen !== undefined &&
                property.defaultValue === undefined &&
                value === undefined
                  ? conditionalRequiredMessage(property)
                  : undefined)
              }
            >
              {(control) => (
                <StudioSettingControl
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
                  invalid={control["aria-invalid"] === true}
                />
              )}
            </StudioField>
            <StudioSettingNote
              property={property}
              properties={properties}
              values={values}
              choices={choices}
              disabled={disabled}
              scope={idPrefix}
              touched={touched.id === idPrefix ? touched.keys : noKeys}
              onUseFieldLabel={useFieldLabel}
            />
          </div>
        );
      })}
    </FieldGroup>
  );
}

const noKeys: ReadonlySet<string> = new Set();

/** A field's optional label is an override: the text setting named `label` beside a `field` reference. */
const labelPropertyOf = (
  properties: readonly BlockPropertySchemaContract[],
): BlockPropertySchemaContract | undefined =>
  properties.find(
    (property) =>
      property.key === "label" &&
      property.kind === "text" &&
      !property.required &&
      property.defaultValue === undefined,
  );

type SettingNoteProps = Readonly<{
  property: BlockPropertySchemaContract;
  properties: readonly BlockPropertySchemaContract[];
  values: StudioSettingValues;
  choices: StudioSettingChoices;
  disabled: boolean;
  /** What the notes belong to (the selected block): a different scope starts them afresh. */
  scope: string;
  /** The keys of the settings edited since the scope began. */
  touched: ReadonlySet<string>;
  onUseFieldLabel: () => void;
}>;

/**
 * The sibling settings a setting's notes and measure read: the field and the label for the label
 * and auto-size notes, the operation for a total's field. A setting draws again only when one of
 * these (or its own value) changes. Keep it in step with `StudioSettingNote` and
 * `studioTotalMeasureProperty`.
 */
export const studioSiblingSettingKeys = (
  property: BlockPropertySchemaContract,
  properties: readonly BlockPropertySchemaContract[],
): readonly string[] => {
  if (property.key === "field") return ["operation"];
  const hasField = properties.some(
    (candidate) => candidate.key === "field" && candidate.kind === "field_reference",
  );
  return hasField && (property.key === "auto_size" || property.key === "label")
    ? ["field", "label"]
    : [];
};

/**
 * The one copy of the notes under a setting's control: what auto-size and full screen offer, and
 * the label that follows its field. Matching label text follows the field when it changes; other
 * text stays authored, with an explicit way to return to the field's label.
 */
export function StudioSettingNote(props: SettingNoteProps): ReactElement | null {
  const { property, properties, values } = props;
  const fieldProperty = properties.find(
    (candidate) => candidate.key === "field" && candidate.kind === "field_reference",
  );
  if (property.key === "auto_size" && fieldProperty !== undefined) {
    const label = values.label;
    return (
      <FieldDescription>
        {values[fieldProperty.key]?.kind === "field_reference"
          ? "Available"
          : `Not possible - ${(label?.kind === "text" ? label.value : "").trim() || "Column"} has no field to measure`}
      </FieldDescription>
    );
  }
  if (property.key === "allow_full_screen") return <FieldDescription>Available</FieldDescription>;
  if (fieldProperty !== undefined && property === labelPropertyOf(properties))
    return <LabelNote {...props} fieldProperty={fieldProperty} />;
  return null;
}

function LabelNote({
  property,
  values,
  choices,
  disabled,
  scope,
  touched,
  onUseFieldLabel,
  fieldProperty,
}: SettingNoteProps & Readonly<{ fieldProperty: BlockPropertySchemaContract }>): ReactElement {
  const fieldValue = values[fieldProperty.key];
  const fieldReference = fieldValue?.kind === "field_reference" ? fieldValue.field : undefined;
  const field =
    fieldReference === undefined
      ? undefined
      : choices.fields.find((candidate) => candidate.reference === fieldReference);
  const label = values[property.key];
  const labelText = label?.kind === "text" ? label.value : undefined;
  const [labelSource, setLabelSource] = useState({
    scope,
    labelText,
    fieldReference,
    fieldLabel: field?.label,
  });
  if (labelSource.scope !== scope || labelSource.labelText !== labelText)
    setLabelSource({ scope, labelText, fieldReference, fieldLabel: field?.label });
  const fieldChanged =
    labelSource.fieldReference !== fieldReference || labelSource.fieldLabel !== field?.label;
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      {field === undefined && (touched.has(fieldProperty.key) || touched.has(property.key)) ? (
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
                The field changed since this label was set. Keep it as a custom label, or use
                &ldquo;{field.label}&rdquo;.
              </AlertDescription>
            </Alert>
          )}
          <Button
            type="button"
            variant="link"
            size="sm"
            disabled={disabled}
            className="h-auto px-0 whitespace-normal text-left"
            onClick={onUseFieldLabel}
          >
            Use field label: {field.label}
          </Button>
        </>
      ) : (
        <FieldDescription>Uses field label: {field.label}</FieldDescription>
      )}
    </div>
  );
}
