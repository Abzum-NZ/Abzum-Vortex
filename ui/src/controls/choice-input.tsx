"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  Combobox,
  ComboboxClear,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxInputAddon,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "../components/combobox";
import { Field, FieldLabel } from "../components/field";
import { RadioGroup, RadioGroupItem } from "../components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";
import { DefinitionRenderError } from "../definition-error";
import type { ChoiceInputPayload, ChoiceOption } from "./projected-data";
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
} from "./field-parts";
import { useFormField } from "./form-context";

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
    ...(["1.1.0", "1.2.0"].includes(props.metadata.releaseVersion)
      ? ["choices_requested" as const] : []),
  ]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const placeholder = settings.text("placeholder") ?? "Select an option";
  const required = settings.boolean("required");
  const variant = settings.choice<"select" | "radio">("variant", "select");
  const draftFeedback = useFieldFeedback(fieldKey);
  const disabled =
    context.inactive || settings.boolean("disabled") || draftFeedback?.disabled === true ||
    (props.metadata.releaseVersion === "1.2.0" && context.values?.dependencyKey === null);
  const options = context.values?.options ?? settings.options("options");
  const error = context.values?.error;
  const note = inactiveNote(context);
  const projected = context.values?.value;

  if (
    projected !== undefined &&
    projected !== null &&
    !options.some((option) => option.key === projected)
  )
    throw new DefinitionRenderError(
      "INVALID_COMPOSITION",
      "Choice value '" + projected + "' is not an available option",
      context.location,
    );

  const [selected, setSelected] = useSeededState<string | null>(projected ?? null);
  const [searchTerm, setSearchTerm] = useState("");
  const [comboboxOpen, setComboboxOpen] = useState(false);
  const [selectOpen, setSelectOpen] = useState(false);
  const lastRequestedSearch = useRef<string | undefined>(undefined);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const choiceRequestGeneration = useRef(0);
  const [previousDependency, setPreviousDependency] = useState(context.values?.dependencyKey);
  const [previouslyOffered, setPreviouslyOffered] = useState(options.length > 0);
  const [previouslyInactive, setPreviouslyInactive] = useState(context.inactive);
  if (props.metadata.releaseVersion === "1.2.0" &&
      (context.values?.dependencyKey !== previousDependency ||
        (context.inactive && !previouslyInactive) ||
        (context.values?.dependencyKey !== undefined && previouslyOffered && options.length === 0))) {
    setPreviousDependency(context.values?.dependencyKey);
    setSelected(null);
    setSearchTerm("");
    setComboboxOpen(false);
    setSelectOpen(false);
    lastRequestedSearch.current = undefined;
    setRemoteLoading(false);
    choiceRequestGeneration.current += 1;
  }
  if (props.metadata.releaseVersion === "1.2.0" && previouslyOffered !== (options.length > 0))
    setPreviouslyOffered(options.length > 0);
  if (props.metadata.releaseVersion === "1.2.0" && previouslyInactive !== context.inactive)
    setPreviouslyInactive(context.inactive);

  // Only a currently offered option may be registered in the form or submitted.
  const permittedSelected =
    selected !== null && options.some((option) => option.key === selected) ? selected : null;
  const selectedOption = options.find((option) => option.key === permittedSelected) ?? null;
  useFormField(fieldKey, props.placementId, permittedSelected);

  const change = (next: string | null): void => {
    if (disabled) return;
    const value = next !== null && options.some((option) => option.key === next) ? next : null;
    setSelected(value);
    context.events?.field_changed?.({ event: "field_changed", fieldKey, value });
  };

  const referenceChoices = context.values?.options !== undefined;
  const choicesRequested = useRef(context.events?.choices_requested);
  choicesRequested.current = context.events?.choices_requested;
  const requestChoices = useRef(
    (search: string, continuationToken?: string): void => undefined,
  );
  requestChoices.current = (search, continuationToken) => {
    const handler = choicesRequested.current;
    if (handler === undefined || (props.metadata.releaseVersion === "1.2.0" && disabled)) return;
    const boundedSearch = search.trim().slice(0, 100);
    const selectedEvidence =
      permittedSelected === null
        ? undefined
        : context.values?.optionEvidence?.[permittedSelected];
    const event = {
      event: "choices_requested" as const,
      ...(boundedSearch === "" ? {} : { search: boundedSearch }),
      ...(continuationToken === undefined ? {} : { continuationToken }),
      ...(permittedSelected === null
        ? {}
        : {
            selectedKey: permittedSelected,
            ...(selectedEvidence === undefined ? {} : { selectedEvidence }),
          }),
    };
    const request = ++choiceRequestGeneration.current;
    setRemoteLoading(true);
    void Promise.resolve(handler(event)).finally(() => {
      if (props.metadata.releaseVersion !== "1.2.0" || choiceRequestGeneration.current === request)
        setRemoteLoading(false);
    });
  };
  useEffect(() => {
    if (!referenceChoices || !comboboxOpen || choicesRequested.current === undefined) return;
    const search = searchTerm.trim();
    if (search === "" && lastRequestedSearch.current === undefined) return;
    if (search === lastRequestedSearch.current) return;
    lastRequestedSearch.current = search;
    const timeout = setTimeout(() => requestChoices.current(search), 200);
    return () => clearTimeout(timeout);
  }, [comboboxOpen, referenceChoices, searchTerm]);
  const loadMoreChoices = (): void => {
    const continuationToken = context.values?.nextContinuationToken;
    if (continuationToken !== undefined && !remoteLoading)
      requestChoices.current(searchTerm.trim(), continuationToken);
  };
  const searchable = referenceChoices || options.length > SEARCHABLE_OPTION_THRESHOLD;
  const radio = variant === "radio" && !searchable;
  const described = describedBy(ids, help, error, note, draftFeedback);
  const ariaRequired = required || described["aria-required"] === true;

  return (
    <div
      data-vortex-control="choice-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
      data-vortex-variant={variant}
      data-vortex-searchable={searchable ? "true" : "false"}
      className="vortex-field"
    >
      {radio ? (
        <fieldset disabled={disabled}>
          <legend id={ids.label} className="vortex-field-label">
            <FieldLabelText label={label} required={required} />
          </legend>
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
        </fieldset>
      ) : searchable ? (
        <>
          <label id={ids.label} htmlFor={ids.control} className="vortex-field-label">
            <FieldLabelText label={label} required={required} />
          </label>
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
                item.key === permittedSelected ||
                item.label.toLowerCase().includes(normalizedQuery)
              );
            }}
            name={fieldKey}
            required={required}
            disabled={disabled}
          >
            <ComboboxInputGroup>
              <ComboboxInput
                id={ids.control}
                placeholder={placeholder}
                disabled={disabled}
                aria-labelledby={ids.label}
                aria-describedby={described["aria-describedby"]}
                aria-required={ariaRequired}
                aria-invalid={error !== undefined}
              />
              <ComboboxInputAddon>
                <ComboboxTrigger
                  aria-label={"Show " + label + " options"}
                  disabled={disabled}
                />
                <ComboboxClear
                  aria-label={"Clear " + label + " selection"}
                  disabled={disabled || selectedOption === null}
                />
              </ComboboxInputAddon>
            </ComboboxInputGroup>
            <ComboboxContent>
              <ComboboxList>
                {(item: ChoiceOption) => (
                  <ComboboxItem key={item.key} value={item}>
                    {item.label}
                  </ComboboxItem>
                )}
              </ComboboxList>
              <ComboboxEmpty role="status">
                {remoteLoading ? "Searching choices…" : "No matching options"}
              </ComboboxEmpty>
              {referenceChoices && context.values?.nextContinuationToken !== undefined ? (
                <button
                  type="button"
                  disabled={remoteLoading}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={loadMoreChoices}
                  className="w-full px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
                >
                  {remoteLoading ? "Loading choices…" : "Load more choices"}
                </button>
              ) : null}
            </ComboboxContent>
          </Combobox>
        </>
      ) : (
        <>
          <label id={ids.label} htmlFor={ids.control} className="vortex-field-label">
            <FieldLabelText label={label} required={required} />
          </label>
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
    </div>
  );
}
