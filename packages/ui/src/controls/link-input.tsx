"use client";

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Button } from "../components/button";
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
import { Field, FieldLabel } from "../components/field";
import { InputGroup, InputGroupAddon } from "../components/input-group";
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
import { useFormFieldValue, useRequiredFormField } from "./form-context";
import { labelInSentence, waitingForParent } from "./dependent-field";
import {
  readRecordChoicePage,
  type LinkInputPayload,
  type RecordChoiceOption,
  type TypedRecordReference,
} from "./projected-data";

export type LinkInputProps = ControlRenderProps<LinkInputPayload>;

/** How long typing rests before the records are searched, so a word costs one read, not one per key. */
const SEARCH_DELAY_MS = 250;

/** The picked record: its identity and the title the person picked it by. */
type Picked = Readonly<{ reference: TypedRecordReference; title: string; typeLabel?: string }>;

const choiceKey = (reference: TypedRecordReference): string =>
  `${reference.recordTypeId.toLowerCase()}:${reference.recordId.toLowerCase()}`;

const seededPick = (values: LinkInputPayload | undefined): Picked | null =>
  values?.value === undefined || values.value === null || values.title === undefined
    ? null
    : { reference: values.value, title: values.title };

/**
 * A link field: a searchable, paged picker over the records of the record types the field may
 * point at. It asks its page for records through its `records_requested` event (search text and a
 * continuation, nothing else) and shows each by its title; the server reads them under the
 * person's own access. It emits `field_changed` with the picked record's typed reference and
 * publishes it to its enclosing form. Without a page to ask, it offers no records.
 */
export function LinkInput(props: LinkInputProps): ReactElement {
  const context = resolveControlContext<LinkInputPayload>(props, [
    "field_changed",
    "field_focus_lost",
    "records_requested",
  ]);
  const settings = readControlSettings(props, context.location);
  const ids = useFieldIds();
  const fieldKey = settings.fieldKey();
  const label = context.accessibleName ?? props.metadata.name;
  const help = settings.text("help_text");
  const placeholder = settings.text("placeholder") ?? "Search by name";
  const required = settings.boolean("required");
  const readOnly = settings.boolean("read_only");
  const draftFeedback = useFieldFeedback(fieldKey);
  const disabled =
    context.inactive || settings.boolean("disabled") || draftFeedback?.disabled === true;
  // A dependent link offers only the records of what the form's draft holds in its parent field.
  const dependsOn = settings.dependsOn();
  const parentValue = useFormFieldValue(dependsOn?.fieldKey);
  const parentRecordId =
    typeof parentValue === "object" && parentValue !== null && "recordId" in parentValue
      ? parentValue.recordId
      : undefined;
  const waiting = dependsOn !== undefined && parentRecordId === undefined;
  const allowedRecordTypeIds = settings.recordTypeIds("record_types").map((id) => id.toLowerCase());
  const severalTypes = allowedRecordTypeIds.length > 1;
  const projectedError = context.values?.error;
  const note = inactiveNote(context);

  // The projected values are parsed afresh on every render, so the seed is keyed by the linked
  // record and its title: a person's pick is replaced only when the projected value itself changes.
  const projected = seededPick(context.values);
  const seedKey =
    projected === null ? "" : `${choiceKey(projected.reference)}\u0000${projected.title}`;
  const seed = useMemo(() => projected, [seedKey]);
  const [picked, setPicked] = useSeededState<Picked | null>(seed);
  const permitted =
    picked !== null && allowedRecordTypeIds.includes(picked.reference.recordTypeId.toLowerCase())
      ? picked
      : null;
  const validationError = useRequiredFormField(
    fieldKey,
    props.placementId,
    permitted?.reference ?? null,
    { label, missing: required && !disabled && !readOnly && permitted === null },
  );
  const error = projectedError ?? validationError;

  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [choices, setChoices] = useState<readonly RecordChoiceOption[]>([]);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const requestRecords = useRef(context.events?.records_requested);
  requestRecords.current = context.events?.records_requested;
  const parent = useRef(parentRecordId);
  parent.current = parentRecordId;
  const location = useRef(context.location);
  location.current = context.location;

  /** Reads one page; a newer request or a closed picker discards the answer of an older one. */
  const load = useRef<(search: string, continuationToken?: string) => void>(() => undefined);
  load.current = (search, continuationToken) => {
    const handler = requestRecords.current;
    if (handler === undefined) return;
    const request = ++generation.current;
    setLoading(true);
    setFailed(false);
    const bounded = search.trim().slice(0, 100);
    void Promise.resolve(
      handler({
        event: "records_requested",
        ...(bounded === "" ? {} : { search: bounded }),
        ...(continuationToken === undefined ? {} : { continuationToken }),
        ...(parent.current === undefined ? {} : { parentRecordId: parent.current }),
      }),
    )
      .then((answer) => {
        if (generation.current !== request) return;
        const page = readRecordChoicePage(answer, location.current);
        setChoices((current) =>
          continuationToken === undefined ? page.choices : [...current, ...page.choices],
        );
        setNext(page.nextContinuationToken);
      })
      .catch((cause: unknown) => {
        if (generation.current !== request) return;
        console.error("[link-input] records unavailable", cause);
        setFailed(true);
      })
      .finally(() => {
        if (generation.current === request) setLoading(false);
      });
  };

  // Opening reads the first page; typing reads again once the person pauses. Closing abandons any
  // answer still on its way.
  useEffect(() => {
    if (!open) {
      generation.current += 1;
      return;
    }
    const timeout = setTimeout(
      () => load.current(searchTerm),
      searchTerm.trim() === "" ? 0 : SEARCH_DELAY_MS,
    );
    return () => clearTimeout(timeout);
  }, [open, searchTerm]);

  const pickedOption: RecordChoiceOption | null =
    permitted === null
      ? null
      : {
          ...permitted.reference,
          title: permitted.title,
          typeLabel: permitted.typeLabel ?? "",
        };
  const items =
    pickedOption === null || choices.some((choice) => choiceKey(choice) === choiceKey(pickedOption))
      ? choices
      : [pickedOption, ...choices];

  // A changed parent leaves this field holding a record the server would refuse: it clears with it,
  // in the same draft, and the records offered are read again for the new parent.
  const previousParent = useRef(parentRecordId);
  useEffect(() => {
    const before = previousParent.current;
    previousParent.current = parentRecordId;
    // A parent that was not registered yet (a form starting with its stored values) is no change.
    if (before === undefined || before === parentRecordId) return;
    setChoices([]);
    setNext(undefined);
    if (picked !== null) {
      setPicked(null);
      context.events?.field_changed?.({
        event: "field_changed",
        origin: "user",
        depth: 0,
        immediate: true,
        fieldKey,
        value: null,
      });
    }
  }, [parentRecordId]);

  const change = (item: RecordChoiceOption | null): void => {
    if (disabled || readOnly) return;
    const reference =
      item === null || !allowedRecordTypeIds.includes(item.recordTypeId.toLowerCase())
        ? null
        : Object.freeze({ recordTypeId: item.recordTypeId, recordId: item.recordId });
    setPicked(
      reference === null || item === null
        ? null
        : { reference, title: item.title, typeLabel: item.typeLabel },
    );
    context.events?.field_changed?.({
      event: "field_changed",
      origin: "user",
      depth: 0,
      immediate: true,
      fieldKey,
      value: reference,
    });
  };

  const described = describedBy(ids, help, error, note, draftFeedback);
  const ariaRequired = required || described["aria-required"] === true;
  const inactive = disabled || readOnly || waiting;
  const shownPlaceholder = waiting ? waitingForParent(dependsOn.label) : placeholder;

  return (
    <Field
      onBlur={(event) => {
        if (!disabled && !readOnly)
          fieldFocusLost(
            event,
            context.events?.field_focus_lost,
            fieldKey,
            permitted?.reference ?? null,
          );
      }}
      data-vortex-control="link-input"
      hidden={draftFeedback?.hidden === true}
      data-vortex-placement-id={props.placementId}
      data-vortex-field-key={fieldKey}
    >
      <FieldLabel id={ids.label} htmlFor={ids.control}>
        <FieldLabelText label={label} required={required} />
      </FieldLabel>
      <Combobox
        items={items}
        value={pickedOption}
        inputValue={open ? searchTerm : (pickedOption?.title ?? "")}
        onOpenChange={(next) => {
          if (inactive && next) return;
          setOpen(next);
          setSearchTerm("");
          if (!next) {
            setChoices([]);
            setNext(undefined);
            setLoading(false);
          }
        }}
        onInputValueChange={setSearchTerm}
        onValueChange={(item) => change(item)}
        itemToStringLabel={(item) => item.title}
        itemToStringValue={(item) => choiceKey(item)}
        isItemEqualToValue={(item, value) => choiceKey(item) === choiceKey(value)}
        // The server already searched: the list shows exactly the records it returned, as they
        // arrive, without filtering them again.
        filteredItems={items}
        filter={null}
        name={fieldKey}
        required={required}
        disabled={inactive}
      >
        <InputGroup>
          <ComboboxInput
            id={ids.control}
            placeholder={shownPlaceholder}
            // While it waits for its parent the field says what to do first, in readable text.
            {...(waiting
              ? { className: "disabled:opacity-100 placeholder:text-muted-foreground" }
              : {})}
            disabled={inactive}
            readOnly={readOnly}
            aria-labelledby={ids.label}
            aria-describedby={described["aria-describedby"]}
            aria-required={ariaRequired}
            aria-invalid={error !== undefined}
          />
          <InputGroupAddon align="inline-end">
            <ComboboxTrigger aria-label={"Show choices for " + label} disabled={inactive} />
            <ComboboxClear
              aria-label={"Clear " + label}
              disabled={inactive || pickedOption === null}
            />
          </InputGroupAddon>
        </InputGroup>
        <ComboboxContent>
          <ComboboxList>
            {(item: RecordChoiceOption) => (
              <ComboboxItem key={choiceKey(item)} value={item}>
                <span className="truncate">{item.title}</span>
                {severalTypes && item.typeLabel !== "" ? (
                  <span className="ml-auto text-xs text-muted-foreground">{item.typeLabel}</span>
                ) : null}
              </ComboboxItem>
            )}
          </ComboboxList>
          <ComboboxEmpty role="status">
            {loading
              ? "Searching…"
              : failed
                ? "Records could not be loaded. Try again."
                : searchTerm.trim() === ""
                  ? `No ${labelInSentence(label)} to choose from yet`
                  : `No ${labelInSentence(label)} matches your search`}
          </ComboboxEmpty>
          {next !== undefined ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={loading}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => load.current(searchTerm, next)}
              className="w-full justify-start text-muted-foreground"
            >
              {loading ? "Loading…" : "Show more"}
            </Button>
          ) : null}
        </ComboboxContent>
      </Combobox>
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
