"use client";

import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { Textarea } from "@vortex/ui/components/textarea";
import {
  StudioHelp,
  StudioInspectorGroup,
  StudioOptionControl,
  StudioSettingFields,
  type StudioSettingChoices,
  type StudioSettingValues,
} from "@vortex/ui/studio";
import {
  fieldTypeKeys,
  moduleFieldTypeLabels,
  plainSourceSettingValue,
  type ApplicationSourceDocument,
  type ApplicationUsePlace,
  type CalculationSettings,
  type FormulaField,
  type moduleFieldSettingDeclarations,
  type LinkCardinality,
  type linkDependencyCandidates,
  type ModuleFieldType,
  type TotalSettings,
} from "@vortex/platform/schema";
import { StudioField } from "./studio-field";
import { StudioPlaceList } from "./studio-used-in";
import { StudioCalculationEditor } from "./studio-calculation-editor";
import { StudioTotalEditor } from "./studio-total-editor";

/*
 * The sections of the field inspector, in the order the inspector shows them. The field editor owns
 * the form state and every edit of the draft; these components only draw one section of it.
 */

type SourceField =
  ApplicationSourceDocument["body"]["modules"][number]["record_types"][number]["fields"][number];
export type Plain = Readonly<Record<string, unknown>>;

export type FieldFormState = Readonly<{
  label: string;
  helpText: string;
  type: ModuleFieldType;
  required: boolean;
  unique: boolean;
  filterable: boolean;
  sortable: boolean;
  searchPriority: NonNullable<SourceField["search_priority"]> | null;
  personalData: SourceField["personal_data"];
  publicDisplay: SourceField["public_display"];
  settings: StudioSettingValues;
  defaultValue: StudioSettingValues;
  /** A calculation's or a total's settings, as its formula or total editor holds them; empty for other types. */
  computed: Plain;
  /** How many records may link to one linked record; read only for a link. */
  cardinality: LinkCardinality;
}>;

/** A text control whose value is held in the control until the draft takes it. */
type DraftText = Readonly<{
  text: string;
  problem: string;
  change: (next: string) => void;
  reset: () => void;
}>;

type Declarations = ReturnType<typeof moduleFieldSettingDeclarations>;

const personalDataOptions = [
  { value: "none", label: "None" },
  { value: "personal", label: "Personal" },
  { value: "sensitive", label: "Sensitive" },
] as const;
const problemOf = (text: string) => (text === "" ? undefined : text);

/**
 * The colour of each option of a published choice field. A published field keeps its stored shape,
 * but an option's colour is presentation and publishes as a patch, so it stays editable while the
 * rest of the options stay fixed. // item 22: CRM-FIX-PLATFORM
 */
function PublishedOptionColours({
  declarations,
  values,
  onChange,
}: Readonly<{
  declarations: Declarations;
  values: StudioSettingValues;
  onChange: (values: StudioSettingValues) => void;
}>) {
  const list = declarations.find((declaration) => declaration.key === "options");
  const current = values["options"];
  if (list?.kind !== "list" || list.item.kind !== "group" || current?.kind !== "list") return null;
  const tone = list.item.properties.find((property) => property.key === "tone");
  if (tone?.kind !== "choice" || current.items.length === 0) return null;
  const withTone = (index: number, next: string) =>
    onChange({
      ...values,
      options: {
        kind: "list",
        items: current.items.map((item, position) => {
          if (position !== index || item.kind !== "group") return item;
          const rest = Object.fromEntries(
            Object.entries(item.properties).filter(([key]) => key !== "tone"),
          );
          return {
            kind: "group",
            properties: next === "" ? rest : { ...rest, tone: { kind: "choice", value: next } },
          };
        }),
      },
    });
  return (
    <div className="space-y-2">
      <Label>Option colours</Label>
      {current.items.map((item, index) => {
        if (item.kind !== "group") return null;
        const label = item.properties["label"];
        const held = item.properties["tone"];
        const id = `module-field-option-colour-${index}`;
        return (
          <div key={id} className="flex items-center justify-between gap-2">
            <Label htmlFor={id}>
              {label?.kind === "text" ? label.value : `Option ${index + 1}`}
            </Label>
            <StudioOptionControl
              id={id}
              value={held?.kind === "choice" ? held.value : ""}
              unset="No colour"
              options={tone.options.map((option) => ({ value: option.key, label: option.label }))}
              disabled={false}
              onChange={(next) => withTone(index, next)}
            />
          </div>
        );
      })}
    </div>
  );
}

/** One yes or no setting of the field: a checkbox and its label, with the reason when it is fixed. */
function FieldFlag({
  name,
  text,
  checked,
  disabled,
  reason,
  onChange,
}: Readonly<{
  name: string;
  text: string;
  checked: boolean;
  disabled: boolean;
  /** Why the setting cannot be changed, shown behind an info icon. */
  reason?: string | undefined;
  onChange: (checked: boolean) => void;
}>) {
  const id = `module-field-${name}`;
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <Label htmlFor={id} className="font-normal">
        {text}
      </Label>
      {reason !== undefined && <StudioHelp hint={reason} />}
    </div>
  );
}

/** Label, type and whether the field is required. */
export function FieldGeneralSection({
  adding,
  nextKey,
  label,
  onLabel,
  typeProblem,
  type,
  typeHint,
  onType,
  required,
  requiredReason,
  disabled,
  typeLocked,
  onRequired,
}: Readonly<{
  adding: boolean;
  /** The key a new field will get from its label. */
  nextKey: string | undefined;
  label: DraftText;
  onLabel: (next: string) => void;
  typeProblem: string;
  type: ModuleFieldType;
  typeHint: string | undefined;
  onType: (type: ModuleFieldType) => void;
  required: boolean;
  /** Why Required cannot be changed, when it cannot. */
  requiredReason: string | undefined;
  disabled: boolean;
  typeLocked: boolean;
  onRequired: (required: boolean) => void;
}>) {
  return (
    <StudioInspectorGroup title="General">
      <StudioField
        label="Label"
        error={problemOf(label.problem)}
        onUndo={label.reset}
        hint={
          adding && nextKey === undefined
            ? "The label people see on forms and lists. A short key is made from it."
            : undefined
        }
      >
        {(control) => (
          <Input
            {...control}
            className="w-full"
            value={label.text}
            disabled={disabled}
            maxLength={60}
            onChange={(event) => onLabel(event.target.value)}
          />
        )}
      </StudioField>
      {adding && nextKey !== undefined && (
        <p className="-mt-2 text-xs text-muted-foreground">
          Its key will be &quot;{nextKey}&quot;. It does not change later.
        </p>
      )}
      <StudioField label="Type" error={problemOf(typeProblem)} hint={typeHint}>
        {(control) => (
          <StudioOptionControl
            id={control.id}
            value={type}
            disabled={disabled || typeLocked}
            options={fieldTypeKeys.map((item) => ({
              value: item,
              label: moduleFieldTypeLabels[item],
            }))}
            onChange={(next) => onType(next as ModuleFieldType)}
          />
        )}
      </StudioField>
      <FieldFlag
        name="required"
        text="Required"
        checked={required}
        disabled={disabled || requiredReason !== undefined}
        reason={requiredReason}
        onChange={onRequired}
      />
    </StudioInspectorGroup>
  );
}

/** The type's own settings: a format, the choices, a formula or a total. */
export function FieldFormatSection({
  type,
  hint,
  candidates,
  linkTarget,
  calculation,
  total,
  unreadable,
  readFailures,
  declarations,
  settings,
  choices,
  disabled,
  shapeLocked,
  onSettings,
  settingsProblem,
  computedProblem,
}: Readonly<{
  type: ModuleFieldType;
  hint: string | undefined;
  candidates: ReturnType<typeof linkDependencyCandidates> | undefined;
  /** What "Open …" goes to when the options depend on another link; absent when it cannot be opened. */
  linkTarget: Readonly<{ label: string; open: () => void }> | undefined;
  calculation: Readonly<{
    key: string;
    settings: CalculationSettings;
    fields: readonly FormulaField[];
    compiled: Parameters<typeof StudioCalculationEditor>[0]["compiled"];
    onChange: (next: Plain, valid: boolean) => void;
  }>;
  total: Readonly<{
    key: string;
    settings: TotalSettings;
    relationships: Parameters<typeof StudioTotalEditor>[0]["relationships"];
    compiledOf: Parameters<typeof StudioTotalEditor>[0]["compiledOf"];
    onChange: (next: Plain, valid: boolean) => void;
  }>;
  unreadable: boolean;
  readFailures: readonly Readonly<{ path: readonly (string | number)[] }>[];
  declarations: Declarations;
  settings: StudioSettingValues;
  choices: StudioSettingChoices;
  disabled: boolean;
  shapeLocked: boolean;
  onSettings: (values: StudioSettingValues) => void;
  settingsProblem: string;
  computedProblem: string;
}>) {
  return (
    <StudioInspectorGroup
      title={type === "choice" || type === "several_choices" ? "Choices" : "Format"}
      {...(hint === undefined ? {} : { hint })}
    >
      {candidates?.kind === "unavailable" && (
        <Alert variant="info" role="note">
          <AlertTitle>Choices depend on another link</AlertTitle>
          <AlertDescription>
            <p>{candidates.message}</p>
            {candidates.reason !== "no_parent_link" && linkTarget !== undefined && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto whitespace-normal text-left"
                onClick={linkTarget.open}
              >
                {linkTarget.label}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {type === "calculation" ? (
        <StudioCalculationEditor
          key={calculation.key}
          idPrefix="module-field-formula"
          settings={calculation.settings}
          fields={calculation.fields}
          compiled={calculation.compiled}
          disabled={disabled}
          shapeLocked={shapeLocked}
          onChange={calculation.onChange}
        />
      ) : type === "total" ? (
        <StudioTotalEditor
          key={total.key}
          settings={total.settings}
          relationships={total.relationships}
          compiledOf={total.compiledOf}
          disabled={disabled || shapeLocked}
          onChange={total.onChange}
        />
      ) : unreadable ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>These settings can&apos;t be read</AlertTitle>
          <AlertDescription>
            {`${[...new Set(readFailures.map((failure) => failure.path.join(", ")))].join("; ")}: ` +
              "not in a form Studio edits, so the settings are not changed here. Change them in the application source."}
          </AlertDescription>
        </Alert>
      ) : declarations.length === 0 ? (
        <p className="text-sm text-muted-foreground">This type has no settings.</p>
      ) : (
        <>
          {declarations.map((declaration) => (
            <StudioSettingFields
              key={declaration.key}
              idPrefix="module-field-setting"
              properties={[declaration]}
              values={settings}
              choices={choices}
              disabled={disabled || (shapeLocked && declaration.key !== "reverse_name")}
              onChange={onSettings}
            />
          ))}
          {shapeLocked && !disabled && (
            <PublishedOptionColours
              declarations={declarations}
              values={settings}
              onChange={onSettings}
            />
          )}
        </>
      )}
      {settingsProblem === "" ? null : (
        <Alert variant="destructive">
          <AlertDescription>{settingsProblem}</AlertDescription>
        </Alert>
      )}
      {computedProblem === "" ? null : (
        <Alert variant="destructive">
          <AlertDescription>{computedProblem}</AlertDescription>
        </Alert>
      )}
    </StudioInspectorGroup>
  );
}

/** What a stored default reads as in a section header. */
const defaultSummary = (value: StudioSettingValues["default"] | undefined): string => {
  if (value === undefined) return "None";
  const plain = plainSourceSettingValue(value);
  return typeof plain === "string" || typeof plain === "number" || typeof plain === "boolean"
    ? String(plain)
    : plain === undefined || plain === null
      ? "None"
      : "Set";
};

/** The value a new record starts with. */
export function FieldDefaultSection({
  declaration,
  reason,
  values,
  choices,
  disabled,
  onChange,
  problem,
}: Readonly<{
  declaration: Declarations[number] | undefined;
  /** Why the type has no default, when it has none. */
  reason: string | undefined;
  values: StudioSettingValues;
  choices: StudioSettingChoices;
  disabled: boolean;
  onChange: (values: StudioSettingValues) => void;
  problem: string;
}>) {
  return (
    <StudioInspectorGroup
      title="Default value"
      defaultOpen={false}
      summary={defaultSummary(declaration === undefined ? undefined : values["default"])}
    >
      {declaration !== undefined ? (
        <StudioSettingFields
          idPrefix="module-field-default"
          properties={[declaration]}
          values={values}
          choices={choices}
          disabled={disabled}
          onChange={onChange}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Default value: {reason}</p>
      )}
      {problem === "" ? null : (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
    </StudioInspectorGroup>
  );
}

/** A place the field can also be shown on. */
export type FieldPlacementOffer = Readonly<{
  id: string;
  label: string;
  shown?: boolean | undefined;
  unavailable?: string | undefined;
}>;

/** Help text, the constraints that shape forms and lists, and the pages that show the field. */
export function FieldFormsAndListsSection({
  helpText,
  onHelpText,
  disabled,
  flags,
  offered,
  checkedPlaces,
  onPlace,
  onShowOnPages,
  canShowOnPages,
  adding,
  recordName,
  onFlag,
}: Readonly<{
  helpText: DraftText;
  onHelpText: (next: string) => void;
  disabled: boolean;
  flags: Readonly<{
    unique: Readonly<{ checked: boolean; reason: string | undefined }>;
    filterable: Readonly<{ checked: boolean; reason: string | undefined }>;
    sortable: Readonly<{ checked: boolean; reason: string | undefined }>;
  }>;
  offered: readonly FieldPlacementOffer[];
  checkedPlaces: ReadonlySet<string>;
  onPlace: (id: string, checked: boolean) => void;
  onShowOnPages: () => void;
  canShowOnPages: boolean;
  adding: boolean;
  recordName: string;
  onFlag: (key: "unique" | "filterable" | "sortable", checked: boolean) => void;
}>) {
  const on = [
    flags.unique.checked ? "unique" : undefined,
    flags.filterable.checked ? "filter" : undefined,
    flags.sortable.checked ? "sort" : undefined,
  ].filter((word) => word !== undefined);
  return (
    <StudioInspectorGroup
      title="Forms and lists"
      defaultOpen={false}
      summary={on.length === 0 ? "None" : on.join(", ").replace(/^./, (c) => c.toUpperCase())}
    >
      <StudioField
        label="Help text"
        hint="Shown under the field on forms. Optional."
        error={problemOf(helpText.problem)}
        onUndo={helpText.reset}
      >
        {(control) => (
          <Textarea
            {...control}
            value={helpText.text}
            disabled={disabled}
            maxLength={200}
            onChange={(event) => onHelpText(event.target.value)}
          />
        )}
      </StudioField>
      <div className="space-y-1.5">
        {(
          [
            ["unique", "Unique value"],
            ["filterable", "Allow filtering"],
            ["sortable", "Allow sorting"],
          ] as const
        ).map(([key, text]) => (
          <FieldFlag
            key={key}
            name={key}
            text={text}
            checked={flags[key].checked}
            disabled={disabled || flags[key].reason !== undefined}
            reason={flags[key].reason}
            onChange={(checked) => onFlag(key, checked)}
          />
        ))}
      </div>
      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 text-sm font-medium">Also show it on</legend>
        {offered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {recordName} has no detail, list or form page with a list of fields yet.
          </p>
        ) : (
          offered.map((place) => (
            <div key={place.id} className="flex items-start gap-2">
              <Checkbox
                id={`module-field-place-${place.id}`}
                checked={place.shown === true || checkedPlaces.has(place.id)}
                disabled={disabled || place.shown === true || place.unavailable !== undefined}
                onCheckedChange={(checked) => onPlace(place.id, checked === true)}
              />
              <Label htmlFor={`module-field-place-${place.id}`} className="font-normal">
                {place.label}
                {place.shown === true
                  ? " (already shown)"
                  : place.unavailable === undefined
                    ? ""
                    : ` (${place.unavailable})`}
              </Label>
            </div>
          ))
        )}
        {!adding && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || !canShowOnPages}
            onClick={onShowOnPages}
          >
            Show field on selected pages
          </Button>
        )}
      </fieldset>
    </StudioInspectorGroup>
  );
}

/** How the field is ranked when it is indexed for search. */
export function FieldSearchSection({
  value,
  disabled,
  onChange,
}: Readonly<{
  value: FieldFormState["searchPriority"];
  disabled: boolean;
  onChange: (value: FieldFormState["searchPriority"]) => void;
}>) {
  const labels = { first: "Found first", normal: "Normal", last: "Found last" } as const;
  return (
    <StudioInspectorGroup
      title="Search"
      defaultOpen={false}
      summary={value === null ? "Not indexed" : labels[value]}
    >
      <StudioField
        label="Search index priority"
        hint="Rank this field when it is indexed. Field type and privacy rules still decide which values enter search. Choose application result fields in the record type's Search tab."
      >
        {(control) => (
          <StudioOptionControl
            {...control}
            value={value ?? ""}
            unset="Not indexed"
            disabled={disabled}
            options={Object.entries(labels).map(([key, label]) => ({ value: key, label }))}
            onChange={(next) => onChange(next === "" ? null : (next as typeof value))}
          />
        )}
      </StudioField>
    </StudioInspectorGroup>
  );
}

/** Personal data and public display. */
export function FieldPrivacySection({
  personalData,
  publicDisplay,
  disabled,
  carriedBy,
  fieldLabel,
  onPersonalData,
  onPublicDisplay,
  permissionsPlace,
}: Readonly<{
  personalData: FieldFormState["personalData"];
  publicDisplay: FieldFormState["publicDisplay"];
  disabled: boolean;
  /** The events that still carry the field although it holds personal or sensitive data. */
  carriedBy: readonly string[];
  fieldLabel: string;
  onPersonalData: (value: FieldFormState["personalData"]) => void;
  onPublicDisplay: (value: FieldFormState["publicDisplay"]) => void;
  /** Where the field's permissions are managed, shown as a path to the Access tab's permissions. */
  permissionsPlace: ApplicationUsePlace;
}>) {
  return (
    <StudioInspectorGroup
      title="Privacy"
      defaultOpen={false}
      summary={`Personal data: ${personalDataOptions.find((option) => option.value === personalData)?.label ?? personalData}`}
    >
      {carriedBy.length === 0 ? null : (
        <Alert variant="destructive">
          <AlertDescription>
            {fieldLabel} contains personal or sensitive data, but is still carried by{" "}
            {carriedBy.join(", ")}. Publishing is refused. Set Personal data to None to correct the
            event&apos;s carried fields, then apply the privacy choice again.
          </AlertDescription>
        </Alert>
      )}
      <StudioField
        label="Personal data"
        hint="Sensitive values never enter search. Personal values follow the organisation's search policy."
      >
        {(control) => (
          <StudioOptionControl
            {...control}
            value={personalData}
            disabled={disabled}
            options={personalDataOptions}
            onChange={(next) => onPersonalData(next as FieldFormState["personalData"])}
          />
        )}
      </StudioField>
      <StudioField
        label="Public display"
        hint="Eligibility for public pages only. Record and field permissions still control access."
      >
        {(control) => (
          <StudioOptionControl
            {...control}
            value={publicDisplay}
            disabled={disabled}
            options={[
              { value: "refused", label: "Refused" },
              { value: "allowed", label: "Allowed" },
            ]}
            onChange={(next) => onPublicDisplay(next as FieldFormState["publicDisplay"])}
          />
        )}
      </StudioField>
      <StudioPlaceList places={[permissionsPlace]} label="Field permissions" />
    </StudioInspectorGroup>
  );
}
