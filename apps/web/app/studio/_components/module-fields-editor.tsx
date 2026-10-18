"use client";
import { useMemo, useState, type FormEvent } from "react";
import { Icon } from "@vortex/ui";
import { StudioDataGroup } from "./studio-data-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@vortex/ui/components/dropdown-menu";
import { Switch } from "@vortex/ui/components/switch";
import { Alert, AlertDescription, AlertTitle } from "@vortex/ui/components/alert";
import { Button } from "@vortex/ui/components/button";
import { Checkbox } from "@vortex/ui/components/checkbox";
import { useConfirm } from "@vortex/ui/components/confirm-dialog";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import { Textarea } from "@vortex/ui/components/textarea";
import {
  applyStudioFieldPlacements,
  studioFieldPlacements,
  studioRelationshipChoices,
  studioSettingProblems,
  StudioOptionControl,
  StudioSettingFields,
  studioSourceRecordTypes,
  type StudioCompositionContext,
  type StudioRecordReader,
  type StudioSettingChoices,
  type StudioSettingValues,
} from "@vortex/ui/studio";
import {
  calculationProblems,
  changeInlineModuleField,
  deleteInlineModuleField,
  deriveFieldKey,
  fieldTypeKeys,
  moduleFieldDefaultDeclaration,
  moduleFieldSettingDeclarations,
  moduleFieldTypeLabels,
  moveInlineModuleField,
  peopleDirectory,
  readModuleFieldDefault,
  readModuleFieldSettings,
  settledCalculation,
  starterModuleFieldSettings,
  totalProblems,
  totalRelationships,
  writeModuleFieldDefault,
  writeModuleFieldSettings,
  type ApplicationSourceDocument,
  type ApplicationUsePlace,
  type LinkCardinality,
  type CalculationSettings,
  type FormulaField,
  type ModuleFieldPublication,
  type ModuleFieldType,
  type PeopleDirectoryOwner,
  type TotalSettings,
} from "@vortex/platform/schema";
import { StudioField } from "./studio-field";
import { StudioReferencesAlert } from "./studio-used-in";
import { StudioLinkSection } from "./studio-link-section";
import { useStudioDraftText } from "./use-studio-draft-text";
import { useStudioDraftHeld } from "./use-studio-draft-held";
import {
  studioEditProblem,
  type StudioCompiledFields,
  type StudioDataEdit,
} from "../_lib/studio-data-model";
import { StudioCalculationEditor } from "./studio-calculation-editor";
import { StudioTotalEditor } from "./studio-total-editor";

/** An application in this organisation, for the link to the owner of a used module. */
export type StudioModuleOwnerApplication = Readonly<{ key: string; rootId: string; name: string }>;

type Source = ApplicationSourceDocument;
type SourceRecord = Source["body"]["modules"][number]["record_types"][number];
type SourceField = SourceRecord["fields"][number];
type Plain = Readonly<Record<string, unknown>>;

/** A record type a link may point at: its qualified key, its name, and the label each record is shown by. */
export type StudioLinkTarget = Readonly<{
  key: string;
  label: string;
  titleLabel: string | undefined;
}>;

/** What the field editor reads besides the draft: where it can link, and what is published. */
export type ModuleFieldEditorContext = Readonly<{
  publication: ModuleFieldPublication;
  composition: StudioCompositionContext;
  /**
   * Record types outside the application's own modules a link may point at: those of the modules
   * it uses, and the people directory's Person, which a link adds to the modules it uses.
   */
  usedRecordTypes: readonly StudioLinkTarget[];
  peopleDirectory: PeopleDirectoryOwner | null;
  readRecords: StudioRecordReader | null;
  /** The saved draft's compiled fields, which a calculation's condition and a total's filter need. */
  compiledFields: StudioCompiledFields | null;
}>;

type FormState = Readonly<{
  label: string;
  helpText: string;
  type: ModuleFieldType;
  required: boolean;
  unique: boolean;
  filterable: boolean;
  sortable: boolean;
  settings: StudioSettingValues;
  defaultValue: StudioSettingValues;
  /** A calculation's or a total's settings, as its formula or total editor holds them; empty for other types. */
  computed: Plain;
  /** How many records may link to one linked record; read only for a link. */
  cardinality: LinkCardinality;
}>;

const computedTypes: ReadonlySet<ModuleFieldType> = new Set(["calculation", "total"]);
const linkTypes: ReadonlySet<string> = new Set(["link", "link_to_one_of_several"]);
/** A person is linked with a Link to a record whose target is the people directory's Person, not this older type. */
const replacedFieldTypes: ReadonlySet<string> = new Set(["link_to_person"]);

/**
 * The one field editor of the Data tab. Without a field it is the form that adds a field to a
 * record type of a module this application owns, with every setting its type declares and, in the
 * same edit, the record type's pages it is also shown on. With a field it changes that field: each
 * valid change is one edit of the draft at once (typing is one Undo step); a label, setting or
 * default that is not valid yet stays in its control with why, and never holds back another change.
 * A field can be moved or removed; removal is refused while anything uses it. A field in a published
 * version keeps its stored shape.
 */
export function ModuleFieldsEditor({
  source,
  moduleKey,
  recordKey,
  fieldKey,
  initialType = "text",
  disabled,
  context,
  edit,
  onAdded,
  onRemoved,
}: Readonly<{
  source: Source;
  moduleKey: string;
  recordKey: string;
  /** The field to change; absent to add a new field. */
  fieldKey: string | undefined;
  /** The type a new field starts as. */
  initialType?: ModuleFieldType;
  disabled: boolean;
  context: ModuleFieldEditorContext;
  edit: StudioDataEdit;
  /** Called with the key of the field the form added. */
  onAdded?: (fieldKey: string) => void;
  /** Called after the field is removed from the draft. */
  onRemoved?: () => void;
}>) {
  const [confirm, confirmDialog] = useConfirm();
  const module = source.body.modules.find((item) => item.key === moduleKey);
  const record = module?.record_types.find((item) => item.key === recordKey);
  const existing =
    fieldKey === undefined ? undefined : record?.fields.find((item) => item.key === fieldKey);
  const adding = fieldKey === undefined;
  const qualifiedRecord = `${moduleKey}:${recordKey}`;
  const published =
    existing !== undefined && context.publication.fields.has(`${qualifiedRecord}.${existing.key}`);
  const recordPublished = context.publication.recordTypes.has(qualifiedRecord);

  const recordTypes = useMemo(
    (): readonly StudioLinkTarget[] => [
      ...studioSourceRecordTypes(source).map((item) => {
        const [owner, local] = item.key.split(":");
        const target = source.body.modules
          .find((candidate) => candidate.key === owner)
          ?.record_types.find((candidate) => candidate.key === local);
        return {
          ...item,
          titleLabel: target?.fields.find((field) => field.key === target.title_field)?.label,
        };
      }),
      ...context.usedRecordTypes,
    ],
    [source, context.usedRecordTypes],
  );
  const relationships = useMemo(() => studioRelationshipChoices(source, null), [source]);
  const totalLinks = useMemo(
    () => totalRelationships(source, moduleKey, recordKey),
    [source, moduleKey, recordKey],
  );
  const formulaFields: readonly FormulaField[] = useMemo(
    () =>
      (record?.fields ?? [])
        .filter((item) => item.key !== existing?.key)
        .map((item) => ({
          key: item.key,
          label: item.label,
          type: item.type,
          settings: item.settings,
        })),
    [record, existing],
  );
  const formulaFieldsByKey = useMemo(
    () => new Map(formulaFields.map((item) => [item.key, item])),
    [formulaFields],
  );
  const otherFields = formulaFields.map(({ key, label, type }) => ({ key, label, type }));
  const declarationsFor = (type: ModuleFieldType) =>
    moduleFieldSettingDeclarations(type, {
      fields: otherFields,
      permissions: (module?.permissions ?? []).map(({ key, label }) => ({ key, label })),
    });
  const startSettings = (type: ModuleFieldType): Record<string, unknown> => {
    const start = starterModuleFieldSettings(type, {
      recordTypes: recordTypes.map((item) => item.key),
      titleField: record?.title_field ?? "",
      relationships: totalLinks.map((item) => item.reference),
    });
    // A new calculation is settled like every edit of its formula, so it is read-time when it must be.
    if (type === "calculation")
      return settledCalculation(start as CalculationSettings, formulaFieldsByKey);
    // A new link reads back from the linked record by this record type's plural name, for example assets.
    const back = type === "link" ? record?.plural_name : undefined;
    return back === undefined ? start : { ...start, reverse_name: back };
  };
  /** The stored settings a type keeps: the field's own while it keeps its type, else the new type's starting settings. */
  const plainOf = (type: ModuleFieldType): Plain =>
    existing !== undefined && existing.type === type
      ? (existing.settings as Plain)
      : startSettings(type);
  const read = (type: ModuleFieldType, plain: Plain, stored: unknown) => {
    const reading = readModuleFieldSettings(type, plain, declarationsFor(type));
    const defaultDeclaration = moduleFieldDefaultDeclaration(type, plain);
    const typedDefault =
      defaultDeclaration.kind === "declared"
        ? readModuleFieldDefault(type, stored, defaultDeclaration.declaration)
        : undefined;
    return {
      reading,
      defaultValue: typedDefault === undefined ? {} : { default: typedDefault },
      computed: computedTypes.has(type) ? plain : {},
    };
  };
  const storedDefault = (existing as { default?: unknown } | undefined)?.default;
  // The field as the draft holds it, or a new field's starting form.
  const readForm = (): FormState => {
    const type = (existing?.type ?? initialType) as ModuleFieldType;
    const relationship =
      existing === undefined
        ? undefined
        : record?.relationships.find((item) => item.from_field === existing.key);
    const reading = read(type, plainOf(type), storedDefault);
    return {
      label: existing?.label ?? "",
      helpText: existing?.help_text ?? "",
      type,
      required: existing?.required ?? false,
      unique: existing?.unique ?? false,
      filterable: existing?.filterable ?? false,
      sortable: existing?.sortable ?? false,
      settings: reading.reading.values,
      defaultValue: reading.defaultValue,
      computed: reading.computed,
      cardinality: relationship?.cardinality === "one_to_one" ? "one_to_one" : "many_to_one",
    };
  };
  const [created, setCreated] = useState<FormState>(readForm);
  const stored = adding || existing === undefined ? created : readForm();
  const readFailures =
    existing === undefined
      ? []
      : read(existing.type as ModuleFieldType, existing.settings as Plain, storedDefault).reading
          .failures;
  const [placements, setPlacements] = useState<ReadonlySet<string>>(new Set());
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [references, setReferences] = useState<readonly ApplicationUsePlace[]>([]);
  const [computedValid, setComputedValid] = useState(true);

  const computedProblems = (type: ModuleFieldType, settings: Plain): readonly string[] =>
    type === "calculation"
      ? calculationProblems(settings as CalculationSettings, formulaFieldsByKey, existing?.key)
      : type === "total"
        ? totalProblems(
            settings as TotalSettings,
            totalLinks.find((item) => item.reference === (settings as TotalSettings).relationship),
          )
        : [];

  /** One edit of the field: the patch over the field as the draft holds it. */
  const commit = (patch: Partial<FormState>, merge?: string): string | undefined => {
    if (existing === undefined || record === undefined)
      return "The field is not in this record type any more.";
    const next: FormState = { ...stored, ...patch };
    const typeChanged = next.type !== existing.type;
    const plain = plainOf(next.type);
    const declarations = declarationsFor(next.type);
    let settings: Plain;
    if (computedTypes.has(next.type) && (patch.computed !== undefined || typeChanged)) {
      const problems = computedProblems(next.type, next.computed);
      if (problems.length > 0) return problems.join(" ");
      settings = next.computed;
    } else if (patch.settings === undefined && !typeChanged) settings = existing.settings as Plain;
    else if (readFailures.length > 0 && !typeChanged) settings = plain;
    else {
      const problems = studioSettingProblems(next.settings, declarations);
      if (problems.length > 0) return problems.map((problem) => `Settings: ${problem}`).join(" ");
      settings = writeModuleFieldSettings(next.type, next.settings, declarations, plain);
    }
    const defaultModel = moduleFieldDefaultDeclaration(next.type, settings);
    if (patch.defaultValue !== undefined && defaultModel.kind === "declared") {
      const problems = studioSettingProblems(next.defaultValue, [defaultModel.declaration]);
      if (problems.length > 0) return problems.join(" ");
    }
    return studioEditProblem(
      edit(
        (current) =>
          changeInlineModuleField(
            current,
            {
              moduleKey,
              recordAlias: record.id,
              fieldAlias: existing.id,
              label: next.label,
              helpText: next.helpText,
              required: next.required,
              unique: next.unique,
              filterable: next.filterable,
              sortable: next.sortable,
              type: next.type,
              settings,
              defaultValue:
                defaultModel.kind === "declared"
                  ? writeModuleFieldDefault(next.type, next.defaultValue.default)
                  : storedDefault,
              cardinality: linkTypes.has(next.type) ? next.cardinality : undefined,
            },
            { publication: context.publication, peopleDirectory: context.peopleDirectory },
          ),
        merge === undefined ? {} : { merge },
      ),
    );
  };
  const mergeKey = (part: string) => `field-${part}:${qualifiedRecord}.${fieldKey ?? ""}`;
  const label = useStudioDraftText(existing?.label ?? "", (next) =>
    adding ? true : (commit({ label: next }, mergeKey("label")) ?? true),
  );
  const helpText = useStudioDraftText(existing?.help_text ?? "", (next) =>
    adding ? true : (commit({ helpText: next }, mergeKey("help")) ?? true),
  );
  const settingsValue = useStudioDraftHeld(stored.settings);
  const defaultValue = useStudioDraftHeld(stored.defaultValue);
  const computedValue = useStudioDraftHeld(stored.computed);
  const form: FormState = {
    ...stored,
    label: label.text,
    helpText: helpText.text,
    settings: settingsValue.value,
    defaultValue: defaultValue.value,
    computed: computedValue.value,
  };

  const plainBase = plainOf(form.type);
  const computed = computedTypes.has(form.type);
  const declarations = declarationsFor(form.type);
  const plainSettings = computed
    ? form.computed
    : writeModuleFieldSettings(form.type, form.settings, declarations, plainBase);
  const defaultModel = moduleFieldDefaultDeclaration(form.type, plainSettings);
  const compiledOf = (recordType: string) => context.compiledFields?.recordTypes[recordType];
  const choices: StudioSettingChoices = {
    fields: [],
    queries: [],
    pages: [],
    recordTypes,
    actions: [],
    relationships,
    records: context.readRecords,
  };
  const offered = studioFieldPlacements(
    { ...context.composition, source },
    moduleKey,
    recordKey,
    form.type,
    existing?.key,
  );
  const nextKey =
    adding && record !== undefined && form.label.trim() !== ""
      ? deriveFieldKey(form.label, new Set(record.fields.map((item) => item.key)))
      : undefined;
  const unreadable =
    readFailures.length > 0 && existing !== undefined && form.type === existing.type;

  if (
    module === undefined ||
    record === undefined ||
    (fieldKey !== undefined && existing === undefined)
  )
    return (
      <p role="status" className="text-sm">
        This field is not in the draft any more. Choose another item in the Data panel.
      </p>
    );

  // A discrete choice applies at once; a refused one is answered with why and the draft keeps its value.
  const change = (patch: Partial<FormState>) => {
    if (adding) {
      setCreated({ ...created, ...patch });
      setIssues([]);
      return;
    }
    const problem = commit(patch);
    setIssues(problem === undefined ? [] : [problem]);
  };
  const changeType = (type: ModuleFieldType) => {
    // A field that is not published takes the new type's starting settings; no value is converted.
    const fresh = read(
      type,
      plainOf(type),
      existing !== undefined && existing.type === type ? storedDefault : undefined,
    );
    setComputedValid(true);
    change({
      type,
      settings: fresh.reading.values,
      defaultValue: fresh.defaultValue,
      computed: fresh.computed,
    });
  };
  const changeSettings = (settings: StudioSettingValues) => {
    if (adding) {
      setCreated({ ...created, settings });
      setIssues([]);
      return;
    }
    const problem = commit({ settings }, mergeKey("settings"));
    if (problem === undefined) settingsValue.applied(settings);
    else settingsValue.hold(settings, problem);
  };
  const changeDefault = (value: StudioSettingValues) => {
    if (adding) {
      setCreated({ ...created, defaultValue: value });
      setIssues([]);
      return;
    }
    const problem = commit({ defaultValue: value }, mergeKey("default"));
    if (problem === undefined) defaultValue.applied(value);
    else defaultValue.hold(value, problem);
  };
  const changeComputed = (next: Plain, valid: boolean) => {
    if (adding) {
      setComputedValid(valid);
      setCreated({ ...created, computed: next });
      computedValue.applied(next);
      setIssues([]);
      return;
    }
    const problem = valid
      ? commit({ computed: next }, mergeKey("computed"))
      : `${form.type === "total" ? "Filter" : "Condition"}: complete or remove the comparisons marked above.`;
    if (problem === undefined) computedValue.applied(next);
    else computedValue.hold(next, problem);
  };

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || !adding) return;
    const problems = [
      ...studioSettingProblems(form.settings, declarations).map(
        (problem) => `Settings: ${problem}`,
      ),
      ...(computed && !computedValid
        ? [
            `${form.type === "total" ? "Filter" : "Condition"}: complete or remove the comparisons marked above.`,
          ]
        : []),
      ...computedProblems(form.type, form.computed),
      ...(defaultModel.kind === "declared"
        ? studioSettingProblems(form.defaultValue, [defaultModel.declaration])
        : []),
    ];
    if (problems.length > 0) {
      setIssues(problems);
      return;
    }
    const settings = plainSettings;
    const result = edit((current) => {
      const added = changeInlineModuleField(
        current,
        {
          moduleKey,
          recordAlias: record.id,
          label: form.label,
          helpText: form.helpText,
          required: form.required,
          unique: form.unique,
          filterable: form.filterable,
          sortable: form.sortable,
          type: form.type,
          settings,
          defaultValue:
            defaultModel.kind === "declared"
              ? writeModuleFieldDefault(form.type, form.defaultValue.default)
              : undefined,
          cardinality: linkTypes.has(form.type) ? form.cardinality : undefined,
        },
        { publication: context.publication, peopleDirectory: context.peopleDirectory },
      );
      if (added.kind !== "changed" || placements.size === 0) return added;
      // "Also show it on": the same draft edit, through the one composition command path.
      const placed = applyStudioFieldPlacements(
        { ...context.composition, source: added.source },
        { moduleKey, recordKey, key: added.fieldKey, label: form.label.trim(), type: form.type },
        [...placements],
      );
      return placed.kind === "refused"
        ? {
            kind: "refused" as const,
            issues: [
              "The field was not added. Untick the places that can't show it, or correct them, and try again.",
              ...placed.reasons,
            ],
          }
        : { ...added, source: placed.source };
    });
    if (result.kind !== "changed") {
      setIssues(result.kind === "blocked" ? [result.message] : result.issues);
      return;
    }
    onAdded?.(result.fieldKey);
  };

  const move = (by: -1 | 1) => {
    if (existing === undefined) return;
    const problem = studioEditProblem(
      edit((current) => moveInlineModuleField(current, moduleKey, recordKey, existing.key, by)),
    );
    setIssues(problem === undefined ? [] : [problem]);
  };
  const showOnPages = () => {
    if (existing === undefined) return;
    const result = edit((current) => {
      const placed = applyStudioFieldPlacements(
        { ...context.composition, source: current },
        { moduleKey, recordKey, key: existing.key, label: existing.label, type: existing.type },
        [...placements],
      );
      return placed.kind === "applied"
        ? { kind: "changed", source: placed.source }
        : { kind: "invalid", issues: placed.reasons };
    });
    const problem = studioEditProblem(result);
    setIssues(problem === undefined ? [] : [problem]);
    if (problem === undefined) setPlacements(new Set());
  };
  const remove = async () => {
    if (existing === undefined) return;
    setIssues([]);
    setReferences([]);
    const check = deleteInlineModuleField(
      source,
      moduleKey,
      recordKey,
      existing.key,
      context.publication,
    );
    if (check.kind === "referenced") {
      setReferences(check.references);
      return;
    }
    if (check.kind === "invalid") {
      setIssues(check.issues);
      return;
    }
    if (
      !(await confirm({
        title: `Remove ${existing.label}?`,
        description: `${existing.label} leaves ${record.plural_name} in the draft. It was never published, so no stored value is lost.`,
        confirmLabel: "Remove field",
      }))
    )
      return;
    const result = edit((current) =>
      deleteInlineModuleField(current, moduleKey, recordKey, existing.key, context.publication),
    );
    if (result.kind === "changed") onRemoved?.();
    else if (result.kind === "referenced") setReferences(result.references);
    else setIssues([studioEditProblem(result) ?? "The field was not removed."]);
  };

  const shapeLocked = published;
  const shapeHint = shapeLocked
    ? "Published fields keep their stored shape. Labels, help, defaults and link-back names can change."
    : undefined;
  const flag = (
    key: "required" | "unique" | "filterable" | "sortable",
    text: string,
    extraDisabled = false,
  ) => (
    <div className="flex items-center gap-2">
      <Switch
        id={`module-field-${key}`}
        checked={form[key]}
        disabled={disabled || shapeLocked || extraDisabled}
        onCheckedChange={(checked) => change({ [key]: checked })}
      />
      <Label htmlFor={`module-field-${key}`}>{text}</Label>
    </div>
  );
  const problemOf = (text: string) => (text === "" ? undefined : text);

  return (
    <form
      className="space-y-4"
      onSubmit={add}
      aria-label={adding ? `New field of ${record.name}` : `Field ${existing!.label}`}
    >
      {existing === undefined ? null : (
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold">{existing.label}</h3>
            <p className="text-xs text-muted-foreground">Field</p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More options for ${existing.label}`}
                />
              }
            >
              <Icon name="more-horizontal" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                disabled={disabled || record.fields[0]?.key === existing.key}
                onClick={() => move(-1)}
              >
                Move earlier
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={disabled || record.fields.at(-1)?.key === existing.key}
                onClick={() => move(1)}
              >
                Move later
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={disabled}
                onClick={() => {
                  void remove();
                }}
              >
                Remove field
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <StudioDataGroup title="General">
        <StudioField
          label="Label"
          error={problemOf(label.problem)}
          hint={
            adding
              ? nextKey === undefined
                ? "The label people see on forms and lists. A short key is made from it."
                : `Its key will be "${nextKey}". It does not change later.`
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
              onChange={(event) => {
                label.change(event.target.value);
                if (adding) setIssues([]);
              }}
            />
          )}
        </StudioField>
        <StudioField
          label="Type"
          hint={
            shapeLocked
              ? "Published: the type is fixed. To hold another kind of value, add a new field."
              : existing !== undefined
                ? "Changing the type starts this field's settings and default afresh. No stored value is converted."
                : undefined
          }
        >
          {(control) => (
            <StudioOptionControl
              id={control.id}
              value={form.type}
              disabled={disabled || shapeLocked}
              options={fieldTypeKeys
                .filter((item) => !replacedFieldTypes.has(item))
                .map((item) => ({ value: item, label: moduleFieldTypeLabels[item] }))}
              onChange={(next) => changeType(next as ModuleFieldType)}
            />
          )}
        </StudioField>
        {flag("required", "Required", adding && recordPublished)}
      </StudioDataGroup>
      <StudioDataGroup
        title={form.type === "choice" || form.type === "several_choices" ? "Choices" : "Format"}
      >
        {shapeHint === undefined ? null : (
          <p className="text-sm text-muted-foreground" role="note">
            {shapeHint}
          </p>
        )}
        {form.type === "calculation" ? (
          <StudioCalculationEditor
            key={`calculation:${computedValue.epoch}`}
            idPrefix="module-field-formula"
            settings={form.computed as CalculationSettings}
            fields={formulaFields}
            compiled={compiledOf(`${moduleKey}:${recordKey}`)}
            disabled={disabled || shapeLocked}
            onChange={changeComputed}
          />
        ) : form.type === "total" ? (
          <StudioTotalEditor
            key={`total:${computedValue.epoch}`}
            settings={form.computed as TotalSettings}
            relationships={totalLinks}
            compiledOf={compiledOf}
            disabled={disabled || shapeLocked}
            onChange={changeComputed}
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
          declarations.map((declaration) => (
            <StudioSettingFields
              key={declaration.key}
              idPrefix="module-field-setting"
              properties={[declaration]}
              values={form.settings}
              choices={choices}
              disabled={disabled || (shapeLocked && declaration.key !== "reverse_name")}
              onChange={changeSettings}
            />
          ))
        )}
        {settingsValue.problem === "" ? null : (
          <p role="alert" className="text-sm text-destructive">
            {settingsValue.problem}
          </p>
        )}
        {computedValue.problem === "" ? null : (
          <p role="alert" className="text-sm text-destructive">
            {computedValue.problem}
          </p>
        )}
      </StudioDataGroup>
      {linkTypes.has(form.type) && (
        <StudioLinkSection
          settings={form.settings}
          cardinality={form.cardinality}
          label={form.label}
          recordName={record.name}
          recordPlural={record.plural_name}
          targets={recordTypes}
          disabled={disabled || shapeLocked}
          usesDirectory={source.body.uses.some((use) => use.module === peopleDirectory.module)}
          onCardinality={(cardinality) =>
            change(cardinality === "one_to_one" ? { cardinality, unique: true } : { cardinality })
          }
        />
      )}
      <StudioDataGroup title="Default value">
        {defaultModel.kind === "declared" ? (
          <StudioSettingFields
            idPrefix="module-field-default"
            properties={[defaultModel.declaration]}
            values={form.defaultValue}
            choices={choices}
            disabled={disabled}
            onChange={changeDefault}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Default value: {defaultModel.reason}</p>
        )}
        {defaultValue.problem === "" ? null : (
          <p role="alert" className="text-sm text-destructive">
            {defaultValue.problem}
          </p>
        )}
      </StudioDataGroup>
      <StudioDataGroup title="Behaviour">
        <StudioField
          label="Help text"
          hint="Shown under the field on forms. Optional."
          error={problemOf(helpText.problem)}
        >
          {(control) => (
            <Textarea
              {...control}
              value={helpText.text}
              disabled={disabled}
              maxLength={200}
              onChange={(event) => helpText.change(event.target.value)}
            />
          )}
        </StudioField>
        {flag(
          "unique",
          "Unique value",
          linkTypes.has(form.type) && form.cardinality === "one_to_one",
        )}
        {flag("filterable", "Allow filtering")}
        {flag("sortable", "Allow sorting")}
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">Also show it on</legend>
          {offered.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {record.name} has no detail, list or form page with a list of fields yet.
            </p>
          ) : (
            offered.map((place) => (
              <div key={place.id} className="flex items-start gap-2">
                <Checkbox
                  id={`module-field-place-${place.id}`}
                  checked={place.shown === true || placements.has(place.id)}
                  disabled={disabled || place.shown === true || place.unavailable !== undefined}
                  onCheckedChange={(checked) => {
                    const next = new Set(placements);
                    if (checked === true) next.add(place.id);
                    else next.delete(place.id);
                    setPlacements(next);
                    setIssues([]);
                  }}
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
              disabled={disabled || placements.size === 0}
              onClick={showOnPages}
            >
              Show field on selected pages
            </Button>
          )}
        </fieldset>
      </StudioDataGroup>
      <StudioDataGroup title="Access" defaultOpen={false}>
        <p className="text-sm text-muted-foreground">Field permissions are managed in Access.</p>
      </StudioDataGroup>
      {adding && (
        <Button type="submit" size="sm" disabled={disabled || form.label.trim() === ""}>
          Add field
        </Button>
      )}
      {issues.length === 0 ? null : (
        <ul
          className="space-y-1 text-sm text-destructive"
          aria-label={adding ? "Why the field was not added" : "Why the field was not changed"}
          role="alert"
        >
          {issues.map((issue, index) => (
            <li key={index} className="break-words">
              {issue}
            </li>
          ))}
        </ul>
      )}
      {existing === undefined ? null : (
        <>
          <StudioReferencesAlert name={existing.label} action="removed" references={references} />
          <StudioDataGroup title="Details" defaultOpen={false}>
            <dl className="space-y-2 font-mono text-xs">
              <div>
                <dt>Key</dt>
                <dd>{existing.key}</dd>
              </div>
              <div>
                <dt>Record type</dt>
                <dd>{qualifiedRecord}</dd>
              </div>
            </dl>
          </StudioDataGroup>
        </>
      )}
      {confirmDialog}
    </form>
  );
}

/**
 * The published record types and fields. The workspace always loads them with the draft (they are
 * read from the stored releases, whether or not the draft compiles); a view without them counts
 * every saved one as published, so nothing published is ever offered a change its records can't take.
 */
export const studioFieldPublication = (
  published: Readonly<{ recordTypes: readonly string[]; fields: readonly string[] }> | null,
  saved: Source,
): ModuleFieldPublication => {
  if (published !== null)
    return { recordTypes: new Set(published.recordTypes), fields: new Set(published.fields) };
  const records = saved.body.modules.flatMap((module) =>
    module.record_types.map((record) => ({ module, record })),
  );
  return {
    recordTypes: new Set(records.map(({ module, record }) => `${module.key}:${record.key}`)),
    fields: new Set(
      records.flatMap(({ module, record }) =>
        record.fields.map((field: SourceField) => `${module.key}:${record.key}.${field.key}`),
      ),
    ),
  };
};
