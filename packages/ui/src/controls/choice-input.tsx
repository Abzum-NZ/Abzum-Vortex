"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  Combobox,
  ComboboxClear,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "../components/combobox";
import { InputGroup, InputGroupAddon } from "../components/input-group";
import { Button } from "../components/button";
import { Field, FieldLabel, FieldLegend, FieldSet } from "../components/field";
import { RadioGroup, RadioGroupItem } from "../components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";
import { DefinitionRenderError } from "../definition-error";
import { flowSetFieldChange } from "../flow-runtime/flow-cycle";
import {
  readChoiceOptionsPage,
  type ChoiceInputPayload,
  type ChoiceOption,
} from "./projected-data";
import {
  readControlSettings,
  resolveControlContext,
  type ControlRenderProps,
} from "./control-context";
import {
  describedBy,
  FieldLabelText,
  FieldMessages,
  inactiveNote,
  useFieldFeedback,
  useFieldIds,
  useSeededState,
  fieldFocusLost,
} from "./field-parts";
import { useFormFieldPublisher, useFormFieldValue, useRequiredFormField } from "./form-context";
import { waitingForParent } from "./dependent-field";

export type ChoiceInputProps = ControlRenderProps<ChoiceInputPayload>;

/** Lists longer than this use a searchable combobox; shorter lists follow the authored variant. */
const SEARCHABLE_OPTION_THRESHOLD = 7;

/**
 * Renders only projected or authored choices. Long and projected reference lists use the
 * searchable combobox; shorter lists keep the authored radio or select presentation.
 */
export function ChoiceInput(props: ChoiceInputProps): ReactElement {
  const context = resolveControlContext<ChoiceInputPayload>(props, [
    "field_changed",
    "field_focus_lost",
    "options_requested",
  ]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds(props.placementId);
  const fieldKey = settings.fieldKey();
  const publish = useFormFieldPublisher(fieldKey);
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const authoredPlaceholder = settings.text("placeholder") ?? "Select an option";
  const required = settings.boolean("required");
  const variant = settings.choice<"select" | "radio">("variant", "select");
  const draftFeedback = useFieldFeedback(fieldKey);
  const explicitlyDisabled =
    context.inactive || settings.boolean("disabled") || draftFeedback?.disabled === true;
  const baseOptions = context.values?.options ?? settings.options("options");
  // The options of a field whose source the page runs are the page's answers; until the first one
  // the field offers only what it holds, never the declared list the source may narrow.
  const remoteOptions = context.events?.options_requested !== undefined;
  const [remote, setRemote] = useState<
    Readonly<{ options: readonly ChoiceOption[]; next?: string }> | undefined
  >(undefined);
  const projected = context.values?.value;
  const [selected, setSelected] = useSeededState<string | null>(projected ?? null);
  // The chosen option stays listed while the page's answer no longer offers it, so the person sees
  // what the field holds and the server refuses a value that is no longer allowed.
  const heldOption = baseOptions.find((option) => option.key === selected);
  const declaredOptions =
    remote === undefined
      ? remoteOptions
        ? heldOption === undefined
          ? []
          : [heldOption]
        : baseOptions
      : heldOption === undefined || remote.options.some((option) => option.key === selected)
        ? remote.options
        : [heldOption, ...remote.options];
  // A dependent choice offers only the options that belong to what the form's draft holds in its
  // parent field, and waits while that is empty; the server judges the pair again at save.
  const dependsOn = settings.dependsOn();
  const parentValue = useFormFieldValue(dependsOn?.fieldKey);
  const parentKey = typeof parentValue === "string" && parentValue !== "" ? parentValue : undefined;
  const optionParents = dependsOn === undefined ? undefined : settings.optionParents("options");
  const waiting = dependsOn !== undefined && parentKey === undefined;
  const disabled = explicitlyDisabled || waiting;
  const placeholder =
    waiting && dependsOn !== undefined ? waitingForParent(dependsOn.label) : authoredPlaceholder;
  const options =
    optionParents === undefined
      ? declaredOptions
      : declaredOptions.filter(
          (option) => parentKey !== undefined && optionParents.get(option.key)?.includes(parentKey),
        );
  const projectedError = context.values?.error;
  const note = inactiveNote(context);

  if (
    projected !== undefined &&
    projected !== null &&
    !baseOptions.some((option) => option.key === projected)
  )
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "Choice value '" + projected + "' is not an available option",
      context.location,
    );

  const [searchTerm, setSearchTerm] = useState("");
  const [comboboxOpen, setComboboxOpen] = useState(false);
  const [selectOpen, setSelectOpen] = useState(false);
  const lastRequestedSearch = useRef<string | undefined>(undefined);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteFailed, setRemoteFailed] = useState(false);
  const choiceRequestGeneration = useRef(0);
  const [previouslyInactive, setPreviouslyInactive] = useState(context.inactive);
  if (context.inactive && !previouslyInactive) {
    setSelected(null);
    setSearchTerm("");
    setComboboxOpen(false);
    setSelectOpen(false);
    lastRequestedSearch.current = undefined;
    setRemoteLoading(false);
    choiceRequestGeneration.current += 1;
  }
  if (previouslyInactive !== context.inactive) setPreviouslyInactive(context.inactive);

  // Only a currently offered option may be registered in the form or submitted.
  const permittedSelected =
    selected !== null && options.some((option) => option.key === selected) ? selected : null;
  const selectedOption = options.find((option) => option.key === permittedSelected) ?? null;
  const validationError = useRequiredFormField(
    fieldKey,
    props.placementId,
    permittedSelected,
    { label, missing: required && !explicitlyDisabled && permittedSelected === null },
    (value, cycle) => {
      if (disabled || draftFeedback?.hidden === true) return undefined;
      if (
        value !== null &&
        (typeof value !== "string" || !options.some((option) => option.key === value))
      )
        return undefined;
      return {
        value,
        apply: () => setSelected(value),
        emit: () => context.events?.field_changed?.(flowSetFieldChange(cycle, fieldKey, value)),
      };
    },
  );
  const error = projectedError ?? validationError;

  // A changed parent leaves this field holding an option that no longer belongs: it clears with it.
  const previousParent = useRef(parentKey);
  useEffect(() => {
    const before = previousParent.current;
    previousParent.current = parentKey;
    // A parent that was not registered yet (a form starting with its stored values) is no change.
    if (before === undefined || before === parentKey) return;
    if (selected !== null) {
      setSelected(null);
      publish(null);
      context.events?.field_changed?.({
        event: "field_changed",
        origin: "user",
        depth: 0,
        immediate: true,
        fieldKey,
        value: null,
      });
    }
  }, [parentKey]);

  const change = (next: string | null): void => {
    if (disabled) return;
    const value = next !== null && options.some((option) => option.key === next) ? next : null;
    setSelected(value);
    publish(value);
    context.events?.field_changed?.({
      event: "field_changed",
      origin: "user",
      depth: 0,
      immediate: true,
      fieldKey,
      value,
    });
  };

  const optionsRequested = useRef(context.events?.options_requested);
  optionsRequested.current = context.events?.options_requested;
  const requestChoices = useRef<(search: string, continuationToken?: string) => void>(
    () => undefined,
  );
  requestChoices.current = (search, continuationToken) => {
    const handler = optionsRequested.current;
    if (handler === undefined || disabled) return;
    const boundedSearch = search.trim().slice(0, 100);
    setRemoteFailed(false);
    const event = {
      event: "options_requested" as const,
      ...(boundedSearch === "" ? {} : { search: boundedSearch }),
      ...(continuationToken === undefined ? {} : { continuationToken }),
    };
    const request = ++choiceRequestGeneration.current;
    setRemoteLoading(true);
    void Promise.resolve(handler(event))
      .then((answer) => {
        if (choiceRequestGeneration.current !== request) return;
        const page = readChoiceOptionsPage(answer, context.location);
        setRemote((current) => ({
          options:
            continuationToken === undefined || current === undefined
              ? page.options
              : [...current.options, ...page.options],
          ...(page.nextContinuationToken === undefined ? {} : { next: page.nextContinuationToken }),
        }));
      })
      .catch((cause: unknown) => {
        if (choiceRequestGeneration.current !== request) return;
        console.error("[choice-input] options unavailable", cause);
        setRemoteFailed(true);
      })
      .finally(() => {
        if (choiceRequestGeneration.current === request) setRemoteLoading(false);
      });
  };
  // Opening reads the first page at once; typing reads again once the person pauses.
  useEffect(() => {
    // Closing leaves what was read as the previous items; opening reads again, and the page answers
    // from its cache while the inputs are the same.
    if (!comboboxOpen) lastRequestedSearch.current = undefined;
    if (!remoteOptions || !comboboxOpen || optionsRequested.current === undefined) return;
    const search = searchTerm.trim();
    if (search === lastRequestedSearch.current) return;
    const first = lastRequestedSearch.current === undefined;
    lastRequestedSearch.current = search;
    if (first) {
      requestChoices.current(search);
      return;
    }
    const timeout = setTimeout(() => requestChoices.current(search), 200);
    return () => clearTimeout(timeout);
  }, [comboboxOpen, remoteOptions, searchTerm]);
  // A changed parent makes the options read for the old one stale: they are read again on opening.
  useEffect(() => {
    setRemote(undefined);
    lastRequestedSearch.current = undefined;
    choiceRequestGeneration.current += 1;
    setRemoteLoading(false);
  }, [parentKey]);
  const loadMoreChoices = (): void => {
    const continuationToken = remote?.next;
    if (continuationToken !== undefined && !remoteLoading)
      requestChoices.current(searchTerm.trim(), continuationToken);
  };
  const searchable = remoteOptions || options.length > SEARCHABLE_OPTION_THRESHOLD;
  const radio = variant === "radio" && !searchable;
  const described = describedBy(ids, help, error, note, draftFeedback);
  const ariaRequired = required || described["aria-required"] === true;

  return (
    <Field
      onBlur={(event) => {
        if (!disabled)
          fieldFocusLost(event, context.events?.field_focus_lost, fieldKey, permittedSelected);
      }}
      data-vortex-control="choice-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
      data-vortex-variant={variant}
      data-vortex-searchable={searchable ? "true" : "false"}
    >
      {radio ? (
        <FieldSet disabled={disabled}>
          <FieldLegend id={ids.label} variant="label">
            <FieldLabelText label={label} required={required} />
          </FieldLegend>
          <RadioGroup
            name={ids.control}
            value={permittedSelected ?? ""}
            onValueChange={(value) => change(typeof value === "string" ? value : null)}
            disabled={disabled}
            required={required}
            aria-labelledby={ids.label}
            aria-describedby={described["aria-describedby"]}
            aria-required={ariaRequired}
            aria-invalid={error !== undefined}
          >
            {options.map((option, index) => {
              const optionId = `${ids.control}-option-${index}`;
              return (
                <Field key={option.key} orientation="horizontal">
                  <RadioGroupItem
                    id={optionId}
                    value={option.key}
                    aria-invalid={error !== undefined}
                  />
                  <FieldLabel htmlFor={optionId}>{option.label}</FieldLabel>
                </Field>
              );
            })}
          </RadioGroup>
        </FieldSet>
      ) : searchable ? (
        <>
          <FieldLabel id={ids.label} htmlFor={ids.control}>
            <FieldLabelText label={label} required={required} />
          </FieldLabel>
          <Combobox
            items={options}
            value={selectedOption}
            inputValue={comboboxOpen ? searchTerm : (selectedOption?.label ?? "")}
            onOpenChange={(open) => {
              setComboboxOpen(open);
              setSearchTerm("");
            }}
            onInputValueChange={setSearchTerm}
            onValueChange={(item) => change(item?.key ?? null)}
            itemToStringLabel={(item) => item.label}
            itemToStringValue={(item) => item.key}
            isItemEqualToValue={(item, value) => item.key === value.key}
            filter={(item, query) => {
              const normalizedQuery = query.trim().toLowerCase();
              return (
                item.key === permittedSelected || item.label.toLowerCase().includes(normalizedQuery)
              );
            }}
            name={fieldKey}
            required={required}
            disabled={disabled}
          >
            <InputGroup>
              <ComboboxInput
                id={ids.control}
                placeholder={placeholder}
                disabled={disabled}
                aria-labelledby={ids.label}
                aria-describedby={described["aria-describedby"]}
                aria-required={ariaRequired}
                aria-invalid={error !== undefined}
              />
              <InputGroupAddon align="inline-end">
                <ComboboxTrigger aria-label={"Show " + label + " options"} disabled={disabled} />
                <ComboboxClear
                  aria-label={"Clear " + label + " selection"}
                  disabled={disabled || selectedOption === null}
                />
              </InputGroupAddon>
            </InputGroup>
            <ComboboxContent>
              <ComboboxList>
                {(item: ChoiceOption) => (
                  <ComboboxItem key={item.key} value={item}>
                    {item.label}
                  </ComboboxItem>
                )}
              </ComboboxList>
              <ComboboxEmpty role="status">
                {remoteLoading
                  ? "Searching choices…"
                  : remoteFailed
                    ? "Choices are unavailable. Close and reopen to retry."
                    : "No matching options"}
              </ComboboxEmpty>
              {remoteOptions && remote?.next !== undefined ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={remoteLoading}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={loadMoreChoices}
                  className="w-full justify-start text-muted-foreground"
                >
                  {remoteLoading ? "Loading choices…" : "Load more choices"}
                </Button>
              ) : null}
            </ComboboxContent>
          </Combobox>
        </>
      ) : (
        <>
          <FieldLabel id={ids.label} htmlFor={ids.control}>
            <FieldLabelText label={label} required={required} />
          </FieldLabel>
          <Select
            items={[
              { value: null, label: placeholder },
              ...options.map((option) => ({ value: option.key, label: option.label })),
            ]}
            value={permittedSelected}
            open={selectOpen}
            onOpenChange={setSelectOpen}
            onValueChange={(next) => {
              change(next);
              setSelectOpen(false);
            }}
            name={fieldKey}
            required={required}
            disabled={disabled}
          >
            <SelectTrigger
              id={ids.control}
              aria-labelledby={ids.label}
              aria-describedby={described["aria-describedby"]}
              aria-required={ariaRequired}
              aria-invalid={error !== undefined}
              disabled={disabled}
            >
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={null}>{placeholder}</SelectItem>
              {options.map((option) => (
                <SelectItem key={option.key} value={option.key}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}
      <FieldMessages
        ids={ids}
        help={help}
        error={error}
        note={note}
        draftFeedback={draftFeedback}
      />
    </Field>
  );
}
