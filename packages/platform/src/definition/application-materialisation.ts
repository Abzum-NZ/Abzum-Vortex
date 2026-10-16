import {
  applicationCompositionCatalogueSnapshotSchema,
  applicationShellSchema,
  applicationThemeSchema,
  canonicalApplicationThemeSelection,
  blockPropertyValueSchema,
  guidedFormPageCompositionSchema,
  findFieldInputBinding,
  pageCompositionSchema,
  validateComponentSettingValue,
  type ApplicationCompositionCatalogueSnapshot,
  type ApplicationContent,
  type ApplicationShell,
  type ApplicationSourceDocument,
  type BlockPropertySchemaContract,
  type BlockPropertyValueContract,
  type ComponentSettingFailure,
  type DefinitionValidationLocation,
  type DefinitionRuleFailure,
  type FieldInputControlKey,
  type PlatformBlockRelease,
  type PlatformThemeRelease,
  type PlatformId,
  type SourceBlockPropertyValueContract,
  type SourceItem,
  type SourceSlotOrder,
  readSourceItem,
  sourcePageDataOf,
  sourcePageRootSlots,
  type SourcePageData,
} from "../schema";
import { FIELD_INPUT_CONTROL_RELEASES } from "./application-composition-catalogue";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json-definition";
import {
  DefinitionCompilationError,
  isDefinitionCompilerRefusalCode,
  type DefinitionCompilerRefusalCode,
} from "./compilation-error";
import type {
  ApplicationCompositionResolution,
  FieldInputSourceField,
} from "./application-resolution";
import {
  createThemeLocation,
  resolveThemeSelection,
  validateApplicationTheme,
  type ThemeResolutionOptions,
  type ThemeTokenValue,
  type ThemeValidationFailure,
} from "../theme/index";

type SourceZone = Readonly<{ items: readonly SourceItem[]; order: SourceSlotOrder | undefined }>;
type CanonicalComposition = ApplicationContent["pages"][number]["composition"];
type CanonicalTheme = ApplicationContent["theme"];

export type MaterialisedApplicationComposition = Readonly<{
  platformBlockDependencies: ApplicationContent["platformBlockDependencies"];
  shells: ApplicationShell[];
  pages: ReadonlyArray<Readonly<{ pageId: string; composition: CanonicalComposition }>>;
  theme: CanonicalTheme;
}>;

const reject = (
  ruleCode: DefinitionCompilerRefusalCode,
  family: ConstructorParameters<typeof DefinitionCompilationError>[1] = "invalid_value",
  location?: DefinitionValidationLocation,
): never => {
  throw new DefinitionCompilationError(ruleCode, family, location);
};

const requireValue = <Value>(
  value: Value | undefined,
  ruleCode: DefinitionCompilerRefusalCode,
  family: ConstructorParameters<typeof DefinitionCompilationError>[1] = "invalid_value",
): Value => value ?? reject(ruleCode, family);

const canonicalDependency = (
  dependency: ApplicationSourceDocument["body"]["platform_block_dependencies"][number],
) => ({
  kind: "platform_block" as const,
  blockId: dependency.block_id,
  releaseVersion: dependency.release_version,
});

const canonicalThemeDependency = (base: ApplicationSourceDocument["body"]["theme"]["base"]) => ({
  kind: "platform_theme" as const,
  catalogueThemeId: base.catalogue_theme_id,
  releaseVersion: base.release_version,
});

const canonicalThemeValue = (value: Record<string, unknown>): unknown => {
  switch (value.kind) {
    case "typography":
      return {
        kind: value.kind,
        family: value.family,
        sizeRem: value.size_rem,
        lineHeight: value.line_height,
        weight: value.weight,
      };
    case "border":
      return {
        kind: value.kind,
        widthRem: value.width_rem,
        style: value.style,
        colorToken: value.color_token,
      };
    case "focus":
      return { kind: value.kind, colorToken: value.color_token, widthRem: value.width_rem };
    case "asset":
      return { kind: value.kind, assetId: value.asset_id };
    default:
      return value;
  }
};

const canonicalPlacementLayout = (value: Record<string, unknown>): Record<string, unknown> => {
  const width = value.width as Record<string, unknown>;
  return {
    visible: value.visible,
    width:
      width.kind === "grid"
        ? { kind: "grid", startColumn: width.start_column, span: width.span }
        : width,
    height: value.height,
  };
};

const validateThemeTokenReferences = (tokens: CanonicalTheme["tokens"]): void => {
  for (const token of Object.values(tokens)) {
    if (token.kind !== "border" && token.kind !== "focus") continue;
    const colour = tokens[token.colorToken];
    if (colour === undefined || colour.kind !== "color_pair")
      reject("vortex.definition.application_block_settings", "broken_reference");
  }
};

/**
 * Runs the Theme engine's readability, focus and asset checks and refuses publication
 * with the first failure, located at the application theme or the overriding placement.
 */
const validateTheme = (
  theme: CanonicalTheme,
  documentKey: string,
  options: ThemeResolutionOptions,
  scope: readonly { kind: "block"; key: string }[] = [],
): void => {
  validateThemeTokenReferences(theme.tokens);
  const result = validateApplicationTheme(theme, { ...options, documentKey });
  const first = result.failures[0];
  if (result.valid || first === undefined) return;
  reject(
    isDefinitionCompilerRefusalCode(first.ruleCode)
      ? first.ruleCode
      : "vortex.definition.application_block_settings",
    first.family,
    createThemeLocation(documentKey, first.tokenKey, scope),
  );
};

/** Colour roles are declared by the platform theme release; overrides inherit them. */
const inheritColorRole = (
  inherited: Record<string, unknown> | undefined,
  override: Record<string, unknown>,
): Record<string, unknown> =>
  inherited?.kind === "color_pair" && inherited.role !== undefined
    ? { ...override, role: inherited.role }
    : override;

export type ApplicationThemeMaterialisation =
  | Readonly<{ valid: true; theme: CanonicalTheme; options: ThemeResolutionOptions }>
  | Readonly<{
      valid: false;
      failures: readonly ThemeValidationFailure[];
      refusal: DefinitionRuleFailure;
    }>;

/** The same pure theme producer serves publication and authorized draft feedback. */
export const materialiseApplicationTheme = (
  authored: ApplicationSourceDocument["body"]["theme"],
  documentKey: string,
  release: PlatformThemeRelease,
): ApplicationThemeMaterialisation => {
  if (
    canonicalJson(canonicalThemeDependency(authored.base)) !==
    canonicalJson({
      kind: "platform_theme",
      catalogueThemeId: release.catalogueThemeId,
      releaseVersion: release.releaseVersion,
    })
  )
    reject("vortex.definition.application_dependency_manifest");
  const overrides: Record<string, ThemeTokenValue> = {};
  for (const [key, value] of Object.entries(authored.token_overrides))
    overrides[key] = canonicalThemeValue(
      value as unknown as Record<string, unknown>,
    ) as ThemeTokenValue;
  const selection = resolveThemeSelection({
    base: release,
    baseTokens: release.tokens,
    selection: canonicalApplicationThemeSelection(authored.selection),
    overrides,
    options: { documentKey },
  });
  if (!selection.valid) {
    const first = selection.failures[0];
    return {
      valid: false,
      failures: selection.failures,
      refusal: {
        ruleCode:
          first !== undefined && isDefinitionCompilerRefusalCode(first.ruleCode)
            ? first.ruleCode
            : "vortex.definition.application_block_settings",
        family: first?.family ?? "invalid_value",
        ...(first?.location === undefined ? {} : { location: first.location }),
      },
    };
  }
  const theme = applicationThemeSchema.parse({
    base: {
      ...canonicalThemeDependency(authored.base),
      contentFingerprint: release.contentFingerprint,
    },
    selection: selection.resolved.selection,
    tokens: selection.resolved.tokens,
    ...(authored.loader_mark === undefined
      ? {}
      : {
          loaderMark: {
            segments: authored.loader_mark.segments,
            ...(authored.loader_mark.cycle_seconds === undefined
              ? {}
              : { cycleSeconds: authored.loader_mark.cycle_seconds }),
          },
        }),
  });
  const assetIds = new Set<PlatformId>();
  for (const token of Object.values(release.tokens))
    if (token.kind === "asset") assetIds.add(token.assetId);
  const options: ThemeResolutionOptions = { approvedAssetIds: assetIds, publicAssetIds: assetIds };
  // Keep the original reference-first publication refusal, while locating every bad reference
  // for the feedback consumer. No engine error message crosses the browser boundary.
  try {
    validateThemeTokenReferences(theme.tokens);
  } catch (error) {
    if (!(error instanceof DefinitionCompilationError)) throw error;
    const failures: ThemeValidationFailure[] = [];
    for (const [key, token] of Object.entries(theme.tokens))
      if (
        (token.kind === "border" || token.kind === "focus") &&
        theme.tokens[token.colorToken]?.kind !== "color_pair"
      )
        failures.push({
          code: "BROKEN_TOKEN_REFERENCE",
          ruleCode: error.ruleCode,
          family: error.family,
          message: "A colour token reference cannot be resolved.",
          tokenKey: key,
          location: createThemeLocation(documentKey, key),
        });
    return {
      valid: false,
      failures,
      refusal: {
        ruleCode: error.ruleCode,
        family: error.family,
        ...(error.location === undefined ? {} : { location: error.location }),
      },
    };
  }
  const validation = validateApplicationTheme(theme, { ...options, documentKey });
  const first = validation.failures[0];
  if (!validation.valid && first !== undefined)
    return {
      valid: false,
      failures: validation.failures,
      refusal: {
        ruleCode: isDefinitionCompilerRefusalCode(first.ruleCode)
          ? first.ruleCode
          : "vortex.definition.application_block_settings",
        family: first.family,
        location: createThemeLocation(documentKey, first.tokenKey),
      },
    };
  return { valid: true, theme, options };
};

type MergedPlacementThemeOverrides = Readonly<{
  themeOverrides: Record<string, unknown>;
  effectiveOverrides: Record<string, unknown>;
  failure?: Readonly<{ code: "UNKNOWN_TOKEN_OVERRIDE" | "TOKEN_KIND_MISMATCH"; tokenKey: string }>;
}>;

/** A placement may only override a token the application theme has, with a value of the same kind. */
const mergePlacementThemeOverrides = (
  theme: CanonicalTheme,
  authoredOverrides: Record<string, unknown>,
): MergedPlacementThemeOverrides => {
  const themeOverrides: Record<string, unknown> = {};
  const effectiveOverrides: Record<string, unknown> = {};
  for (const [key, authoredValue] of Object.entries(authoredOverrides)) {
    const inherited = theme.tokens[key] as Record<string, unknown> | undefined;
    const override = canonicalThemeValue(authoredValue as Record<string, unknown>) as Record<
      string,
      unknown
    >;
    if (inherited === undefined || inherited.kind !== override.kind)
      return {
        themeOverrides,
        effectiveOverrides,
        failure: {
          code: inherited === undefined ? "UNKNOWN_TOKEN_OVERRIDE" : "TOKEN_KIND_MISMATCH",
          tokenKey: key,
        },
      };
    themeOverrides[key] = override;
    effectiveOverrides[key] = inheritColorRole(inherited, override);
  }
  return { themeOverrides, effectiveOverrides };
};

/**
 * Judges one placement's authored theme overrides with the checks publication applies, so Studio
 * can name a refusal where the override is edited instead of when the draft is compiled.
 */
export const checkPlacementThemeOverrides = (
  authoredTheme: ApplicationSourceDocument["body"]["theme"],
  authoredOverrides: Record<string, unknown>,
  documentKey: string,
  release: PlatformThemeRelease,
): readonly Pick<ThemeValidationFailure, "code" | "family" | "tokenKey">[] => {
  const materialised = materialiseApplicationTheme(authoredTheme, documentKey, release);
  if (!materialised.valid) return materialised.failures;
  const { theme, options } = materialised;
  const merged = mergePlacementThemeOverrides(theme, authoredOverrides);
  if (merged.failure !== undefined)
    return [{ ...merged.failure, family: "broken_reference" as const }];
  if (Object.keys(merged.effectiveOverrides).length === 0) return [];
  const effective = applicationThemeSchema.parse({
    base: theme.base,
    selection: theme.selection,
    tokens: { ...theme.tokens, ...merged.effectiveOverrides },
  });
  try {
    validateThemeTokenReferences(effective.tokens);
  } catch (error) {
    if (!(error instanceof DefinitionCompilationError)) throw error;
    return [{ code: "BROKEN_TOKEN_REFERENCE", family: "broken_reference" }];
  }
  return validateApplicationTheme(effective, { ...options, documentKey }).failures;
};

const rejectSettingFailures = (failures: readonly ComponentSettingFailure[]): void => {
  const first = failures[0];
  if (first !== undefined) reject("vortex.definition.application_block_settings", first.family);
};

/** Every theme token a canonical value names, including inside groups and lists, must resolve. */
const validateThemeTokenSettings = (
  value: BlockPropertyValueContract,
  schema: BlockPropertySchemaContract,
  theme: CanonicalTheme,
): void => {
  if (schema.kind === "theme_token" && value.kind === "theme_token") {
    const token = theme.tokens[value.tokenKey];
    if (token === undefined || token.kind !== schema.tokenKind)
      reject("vortex.definition.application_block_settings", "broken_reference");
  } else if (schema.kind === "group" && value.kind === "group") {
    for (const property of schema.properties) {
      const nested = value.properties[property.key];
      if (nested !== undefined) validateThemeTokenSettings(nested, property, theme);
    }
  } else if (schema.kind === "list" && value.kind === "list") {
    for (const item of value.items) validateThemeTokenSettings(item, schema.item, theme);
  }
};

const validateCanonicalPropertyValue = (
  value: BlockPropertyValueContract,
  schema: BlockPropertySchemaContract,
  theme: CanonicalTheme,
): void => {
  rejectSettingFailures(validateComponentSettingValue(value, schema));
  validateThemeTokenSettings(value, schema, theme);
};

const compilePropertyValue = (
  authored: SourceBlockPropertyValueContract,
  schema: BlockPropertySchemaContract,
  resolution: ApplicationCompositionResolution,
  theme: CanonicalTheme,
): BlockPropertyValueContract => {
  let compiled: unknown;
  switch (authored.kind) {
    case "text":
      // Table behaviours name the same event as their flow bindings. Keep both in the release's
      // permanent identity space so a rendered row can dispatch its declared binding.
      compiled =
        schema.key === "event_id"
          ? { kind: "text", value: resolution.identity("event", authored.value) }
          : authored;
      break;
    case "asset_reference":
      compiled = { kind: authored.kind, assetId: authored.asset_id };
      break;
    case "icon":
      compiled = { kind: authored.kind, iconKey: authored.icon_key };
      break;
    case "theme_token":
      compiled = { kind: authored.kind, tokenKey: authored.token };
      break;
    case "field_reference":
      compiled = { kind: authored.kind, fieldId: resolution.field(authored.field) };
      break;
    case "relationship_reference":
      compiled = {
        kind: authored.kind,
        relationshipId: resolution.relationship(authored.relationship),
      };
      break;
    case "action_reference":
      compiled = { kind: authored.kind, actionKey: resolution.action(authored.action) };
      break;
    case "page_reference":
      compiled = { kind: authored.kind, pageId: resolution.identity("page", authored.page) };
      break;
    case "query_reference":
      compiled = { kind: authored.kind, queryId: resolution.moduleQuery(authored.query) };
      break;
    case "pipeline_reference":
      compiled = {
        kind: authored.kind,
        pipelineId: resolution.identity("pipeline", authored.pipeline),
      };
      break;
    case "record_type_reference":
      compiled = { kind: authored.kind, recordType: resolution.recordType(authored.record_type) };
      break;
    case "record_reference":
      compiled = {
        kind: authored.kind,
        recordType: resolution.recordType(authored.record_type),
        recordId: authored.record_id,
      };
      break;
    case "group": {
      const groupSchema =
        schema.kind === "group"
          ? schema
          : reject("vortex.definition.application_block_settings", "invalid_value");
      compiled = {
        kind: "group",
        properties: compileSettings(authored.properties, groupSchema.properties, resolution, theme),
      };
      break;
    }
    case "list": {
      const listSchema =
        schema.kind === "list"
          ? schema
          : reject("vortex.definition.application_block_settings", "invalid_value");
      compiled = {
        kind: "list",
        items: authored.items.map((item) =>
          compilePropertyValue(item, listSchema.item, resolution, theme),
        ),
      };
      break;
    }
    default:
      compiled = authored;
  }
  const parsed = blockPropertyValueSchema.safeParse(compiled);
  if (!parsed.success) reject("vortex.definition.application_block_settings", "invalid_value");
  const value = parsed.data!;
  validateCanonicalPropertyValue(value, schema, theme);
  return value;
};

const compileSettings = (
  authored: Record<string, SourceBlockPropertyValueContract>,
  declarations: readonly BlockPropertySchemaContract[],
  resolution: ApplicationCompositionResolution,
  theme: CanonicalTheme,
): Record<string, BlockPropertyValueContract> => {
  const result: Record<string, BlockPropertyValueContract> = {};
  for (const declaration of declarations) {
    const value = authored[declaration.key];
    if (value !== undefined)
      result[declaration.key] = compilePropertyValue(value, declaration, resolution, theme);
    else if (declaration.defaultValue !== undefined) {
      validateCanonicalPropertyValue(declaration.defaultValue, declaration, theme);
      result[declaration.key] = declaration.defaultValue;
    }
  }
  return result;
};

/**
 * The control one automatic field input renders and the canonical settings that follow from its
 * field type. A type with no exact existing control is refused with `unsupported_field_type`.
 */
type DerivedFieldInput = Readonly<{
  control: FieldInputControlKey;
  settings: Readonly<Record<string, unknown>>;
}>;

/** The text input type a text field's declared format selects; any other format stays plain text. */
const TEXT_FORMAT_INPUT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  email_address: "email",
  web_address: "url",
});

const deriveFieldInputContract = (field: FieldInputSourceField): DerivedFieldInput => {
  switch (field.type) {
    case "text": {
      const inputType =
        field.textFormat === undefined ? undefined : TEXT_FORMAT_INPUT_TYPES[field.textFormat];
      return {
        control: "text",
        settings:
          inputType === undefined ? {} : { input_type: { kind: "choice", value: inputType } },
      };
    }
    case "email_address":
      return {
        control: "text",
        settings: { input_type: { kind: "choice", value: "email" } },
      };
    case "long_text":
      return { control: "text", settings: { multiline: { kind: "boolean", value: true } } };
    case "formatted_text":
      return { control: "rich_text", settings: {} };
    case "whole_number":
      return { control: "number", settings: { integer: { kind: "boolean", value: true } } };
    case "decimal_number":
    case "money":
      return { control: "number", settings: {} };
    case "yes_no":
      return { control: "boolean", settings: {} };
    case "date":
      return { control: "date", settings: {} };
    case "date_time":
      return {
        control: "date_time",
        settings:
          field.displayTimeZone === undefined
            ? {}
            : {
                display_time_zone: {
                  kind: "choice",
                  value: field.displayTimeZone,
                },
              },
      };
    case "choice":
    case "several_choices":
      return {
        control: field.type,
        settings: {
          options: {
            kind: "list",
            items: field.choices.map((choice) => ({
              kind: "group",
              properties: {
                key: { kind: "text", value: choice.key },
                label: { kind: "text", value: choice.label },
              },
            })),
          },
          ...(field.type === "several_choices" && field.maximumSelections !== undefined
            ? {
                maximum_selections: {
                  kind: "number",
                  value: field.maximumSelections,
                },
              }
            : {}),
        },
      };
    case "link":
    case "link_to_one_of_several":
      return {
        control: "link",
        settings: {
          record_types: {
            kind: "list",
            items: field.recordTypes.map((recordType) => ({
              kind: "record_type_reference",
              recordType,
            })),
          },
        },
      };
    default:
      return reject("vortex.definition.unsupported_field_type", "unsupported_choice");
  }
};

/** One canonical value, parsed through the closed value contract and checked by its declaration. */
const derivedPropertyValue = (
  value: unknown,
  declaration: BlockPropertySchemaContract | undefined,
): BlockPropertyValueContract => {
  const parsed = blockPropertyValueSchema.safeParse(value);
  const canonical = parsed.success
    ? parsed.data
    : reject("vortex.definition.unsupported_field_type", "unsupported_choice");
  if (declaration === undefined || validateComponentSettingValue(canonical, declaration).length > 0)
    reject("vortex.definition.unsupported_field_type", "unsupported_choice");
  return canonical;
};

/**
 * Derives an automatic field input's canonical settings from the module field its binding setting
 * references: the field's key becomes the form field key, its label the accessible name (unless the
 * author overrode it), its required flag the requirement, and its type, format, choices and link
 * targets the control. Every resulting setting must satisfy the delegated input release's own
 * declarations, so the renderer receives exactly the values that control already accepts: a field
 * it cannot represent exactly is refused with `unsupported_field_type`, and an authored override
 * the delegated control does not declare with `application_block_settings`.
 */
const applyFieldInputDerivation = (
  release: PlatformBlockRelease,
  settings: Record<string, BlockPropertyValueContract>,
  resolution: ApplicationCompositionResolution,
): void => {
  const binding = findFieldInputBinding(release.properties);
  if (binding === undefined) return;
  const compiledBinding = settings[binding.key];
  const fieldId =
    compiledBinding?.kind === "field_reference"
      ? compiledBinding.fieldId
      : reject("vortex.definition.application_block_settings", "required_value");
  const field = requireValue(
    resolution.fieldInput(fieldId),
    "vortex.definition.module_field_references",
    "broken_reference",
  );
  const derived = deriveFieldInputContract(field);
  const target = FIELD_INPUT_CONTROL_RELEASES[derived.control];
  const declaration = (key: string): BlockPropertySchemaContract | undefined =>
    target.properties.find((property) => property.key === key);
  for (const [key, value] of Object.entries(settings)) {
    if (key === binding.key) continue;
    const targetDeclaration = declaration(key);
    if (targetDeclaration === undefined)
      reject("vortex.definition.application_block_settings", "unknown_property");
    else rejectSettingFailures(validateComponentSettingValue(value, targetDeclaration));
  }
  const authoredLabel = settings["label"];
  const derivedValues: Record<string, unknown> = {
    name: { kind: "text", value: field.key },
    ...(authoredLabel?.kind === "text" && authoredLabel.value.trim().length > 0
      ? {}
      : { label: { kind: "text", value: field.label } }),
    required: { kind: "boolean", value: field.required },
    ...derived.settings,
  };
  for (const [key, value] of Object.entries(derivedValues))
    settings[key] = derivedPropertyValue(value, declaration(key));
  settings["control"] = { kind: "choice", value: derived.control };
  for (const property of target.properties)
    if (property.required && settings[property.key] === undefined)
      reject("vortex.definition.unsupported_field_type", "unsupported_choice");
};

const validateAccessibleName = (
  settings: Readonly<Record<string, BlockPropertyValueContract>>,
  release: PlatformBlockRelease,
): void => {
  if (release.capabilities.accessibleName === "not_applicable") return;
  const [first, ...rest] = release.capabilities.accessibleNamePropertyPath;
  let value = settings[first!];
  for (const key of rest) {
    if (value === undefined) break;
    if (value.kind !== "group")
      return reject("vortex.definition.application_block_settings", "invalid_value");
    value = value.properties[key];
  }
  if (value === undefined) {
    if (release.capabilities.accessibleName === "required")
      reject("vortex.definition.application_block_settings", "required_value");
    return;
  }
  if (value.kind !== "text" || value.value.trim().length === 0)
    reject("vortex.definition.application_block_settings", "invalid_value");
};

const materialiseResponsive = (
  authored: Record<string, unknown>,
  release: PlatformBlockRelease,
): Record<string, unknown> => {
  const desktop = canonicalPlacementLayout(authored.desktop as Record<string, unknown>);
  const tablet = canonicalPlacementLayout(
    (authored.tablet as Record<string, unknown> | undefined) ??
      (authored.desktop as Record<string, unknown>),
  );
  const phone = canonicalPlacementLayout(
    (authored.phone as Record<string, unknown> | undefined) ??
      (authored.tablet as Record<string, unknown> | undefined) ??
      (authored.desktop as Record<string, unknown>),
  );
  const layouts = { desktop, tablet, phone };
  if (
    !release.capabilities.responsiveVisibility &&
    (tablet.visible !== desktop.visible || phone.visible !== desktop.visible)
  )
    reject("vortex.definition.application_layout_complete");
  for (const layout of Object.values(layouts)) {
    const width = layout.width as Record<string, unknown>;
    const height = layout.height as Record<string, unknown>;
    if (!release.capabilities.gridWidth && width.kind === "grid")
      reject("vortex.definition.application_layout_complete");
    if (release.capabilities.height === "content" && height.kind !== "content")
      reject("vortex.definition.application_layout_complete");
  }
  return layouts;
};

const materialiseOrder = (
  authored: SourceZone,
  resolvePlacement: (alias: string) => string,
  responsiveOrderAllowed: boolean,
) => {
  const aliases = authored.items.map((item) => item.props.id);
  const desktop = aliases.map(resolvePlacement);
  const tablet = (authored.order?.tablet ?? aliases).map(resolvePlacement);
  const phone = (authored.order?.phone ?? authored.order?.tablet ?? aliases).map(resolvePlacement);
  if (
    !responsiveOrderAllowed &&
    (canonicalJson(tablet) !== canonicalJson(desktop) ||
      canonicalJson(phone) !== canonicalJson(desktop))
  )
    reject("vortex.definition.application_layout_complete");
  return { tablet, phone };
};

/** One compiled zone: its items in desktop order and its complete tablet and phone order. */
type CompiledZone = {
  items: Record<string, unknown>[];
  order: { tablet: string[]; phone: string[] };
};

/** Pure  composition materialisation; it does not activate any compiler or reader dispatch. */
export const materialiseApplicationComposition = (
  source: ApplicationSourceDocument,
  snapshotInput: ApplicationCompositionCatalogueSnapshot,
  resolution: ApplicationCompositionResolution,
): MaterialisedApplicationComposition => {
  const snapshot = applicationCompositionCatalogueSnapshotSchema.parse(snapshotInput);
  const { fingerprint, ...snapshotEvidence } = snapshot;
  if (fingerprintCanonicalValue(snapshotEvidence) !== fingerprint)
    reject("vortex.definition.application_dependency_manifest");

  const dependencies = source.body.platform_block_dependencies.map(canonicalDependency);
  const selectedDependencies = snapshot.platformBlocks.releases.map((release) => ({
    kind: "platform_block" as const,
    blockId: release.blockId,
    releaseVersion: release.releaseVersion,
    contentFingerprint: release.contentFingerprint,
  }));
  const selectedIdentities = selectedDependencies.map(({ kind, blockId, releaseVersion }) => ({
    kind,
    blockId,
    releaseVersion,
  }));
  if (canonicalJson(dependencies) !== canonicalJson(selectedIdentities))
    reject("vortex.definition.application_dependency_manifest");
  if (
    canonicalJson(canonicalThemeDependency(source.body.theme.base)) !==
    canonicalJson({
      kind: "platform_theme",
      catalogueThemeId: snapshot.platformTheme.catalogueThemeId,
      releaseVersion: snapshot.platformTheme.releaseVersion,
    })
  )
    reject("vortex.definition.application_dependency_manifest");

  const materialisedTheme = materialiseApplicationTheme(
    source.body.theme,
    source.key,
    snapshot.platformTheme,
  );
  if (!materialisedTheme.valid) {
    const first = materialisedTheme.refusal;
    return reject(
      isDefinitionCompilerRefusalCode(first.ruleCode)
        ? first.ruleCode
        : "vortex.definition.application_block_settings",
      first.family,
      first.location,
    );
  }
  const { theme, options: themeValidationOptions } = materialisedTheme;

  const releaseByIdentity = new Map(
    snapshot.platformBlocks.releases.map((release) => [
      `${release.blockId}:${release.releaseVersion}`,
      release,
    ]),
  );
  const allPlacementIds = new Set<string>();
  let placementCount = 0;
  const shellPlacementTargets = new Map<
    string,
    { canonicalId: string; depth: number; release: PlatformBlockRelease }
  >();

  const compileSlot = (
    authored: SourceZone,
    options: {
      depth: number;
      allowedCategories?: ReadonlySet<string>;
      responsiveOrderAllowed: boolean;
      publicSurface: boolean;
      reserved?: ReadonlySet<string>;
      captureShellPlacements?: boolean;
    },
  ): CompiledZone => {
    const resolvedByAlias = new Map(
      authored.items.map((item) => [
        item.props.id,
        resolution.identity("block_placement", item.props.id, "content"),
      ]),
    );
    if (resolvedByAlias.size !== authored.items.length)
      reject("vortex.definition.application_identity_unique", "duplicate_key");
    const resolvePlacement = (alias: string): string =>
      requireValue(resolvedByAlias.get(alias), "vortex.definition.application_layout_complete");
    const items: Record<string, unknown>[] = [];
    for (const item of authored.items) {
      const alias = item.props.id;
      const authoredPlacement = item.props.vortex;
      const canonicalId = resolvePlacement(alias);
      if (allPlacementIds.has(canonicalId))
        reject("vortex.definition.application_identity_unique", "duplicate_key");
      allPlacementIds.add(canonicalId);
      placementCount += 1;
      if (
        placementCount > snapshot.platformBlocks.compositionPolicy.maximumPlacements ||
        options.depth > snapshot.platformBlocks.compositionPolicy.maximumDepth
      )
        reject("vortex.definition.application_layout_complete");
      const release = requireValue(
        releaseByIdentity.get(
          `${authoredPlacement.block.block_id}:${authoredPlacement.block.release_version}`,
        ),
        "vortex.definition.application_block_references",
        "broken_reference",
      );
      if (item.type !== release.rendererKey)
        reject("vortex.definition.application_block_references", "invalid_value");
      if (
        options.allowedCategories !== undefined &&
        !options.allowedCategories.has(release.paletteGroup)
      )
        reject("vortex.definition.application_block_references", "incompatible_version");
      if (options.publicSurface && release.capabilities.publicSurface !== "allowed")
        reject("vortex.definition.application_public_surface");
      const reading = readSourceItem(item, release);
      const repeatableFailure =
        reading.repeatableFailures.find((failure) => failure.family === "duplicate_key") ??
        reading.repeatableFailures[0];
      if (repeatableFailure !== undefined)
        reject("vortex.definition.application_block_settings", repeatableFailure.family);
      if (reading.unknownKeys.length > 0)
        reject("vortex.definition.application_block_references", "unknown_property");
      if (reading.malformedSlots.length > 0)
        reject("vortex.definition.application_block_references", "invalid_value");
      const slots: Record<string, unknown> = {};
      const slotOrders: Record<string, unknown> = {};
      for (const [slotKey, { declaration, items: children }] of reading.slots) {
        const reserved = options.reserved?.has(`${alias}:${slotKey}`) === true;
        if (
          declaration.repeats === undefined &&
          declaration.required &&
          !reserved &&
          (children === undefined || children.length === 0)
        )
          reject("vortex.definition.application_block_references", "required_value");
        if (children === undefined) continue;
        const zone = compileSlot(
          { items: children, order: authoredPlacement.slot_orders?.[slotKey] },
          {
            depth: options.depth + 1,
            allowedCategories: new Set(declaration.allowedChildCategories),
            responsiveOrderAllowed: release.capabilities.responsiveOrder,
            publicSurface: options.publicSurface,
            ...(options.reserved === undefined ? {} : { reserved: options.reserved }),
            ...(options.captureShellPlacements === undefined
              ? {}
              : { captureShellPlacements: options.captureShellPlacements }),
          },
        );
        slots[slotKey] = zone.items;
        slotOrders[slotKey] = zone.order;
      }
      if (
        Object.keys(authoredPlacement.slot_orders ?? {}).some(
          (slotKey) => reading.slots.get(slotKey)?.items === undefined,
        )
      )
        reject("vortex.definition.application_layout_complete");
      const responsive = materialiseResponsive(
        authoredPlacement.responsive as unknown as Record<string, unknown>,
        release,
      );
      const merged = mergePlacementThemeOverrides(theme, authoredPlacement.theme_overrides);
      if (merged.failure !== undefined)
        reject("vortex.definition.application_block_settings", "broken_reference");
      const { themeOverrides, effectiveOverrides } = merged;
      if (Object.keys(effectiveOverrides).length > 0)
        validateTheme(
          applicationThemeSchema.parse({
            base: theme.base,
            selection: theme.selection,
            tokens: { ...theme.tokens, ...effectiveOverrides },
          }),
          source.key,
          themeValidationOptions,
          [{ kind: "block", key: alias }],
        );
      rejectSettingFailures(reading.settingFailures);
      const settings = compileSettings(reading.settings, release.properties, resolution, theme);
      applyFieldInputDerivation(release, settings, resolution);
      validateAccessibleName(settings, release);
      const vortex = {
        block: {
          blockId: release.blockId,
          releaseVersion: release.releaseVersion,
        },
        ...(authoredPlacement.view_permission === undefined
          ? {}
          : { viewPermissionKey: resolution.permission(authoredPlacement.view_permission) }),
        ...(authoredPlacement.use_permission === undefined
          ? {}
          : { usePermissionKey: resolution.permission(authoredPlacement.use_permission) }),
        ...(authoredPlacement.visibility_condition === undefined
          ? {}
          : { visibilityCondition: resolution.condition(authoredPlacement.visibility_condition) }),
        ...(authoredPlacement.query === undefined
          ? {}
          : { queryId: resolution.moduleQuery(authoredPlacement.query) }),
        themeOverrides,
        responsive,
        slotOrders,
      };
      items.push({
        type: release.rendererKey,
        props: { id: canonicalId, settings, ...slots, vortex },
      });
      if (options.captureShellPlacements)
        shellPlacementTargets.set(alias, { canonicalId, depth: options.depth, release });
    }
    return {
      items,
      order: materialiseOrder(authored, resolvePlacement, options.responsiveOrderAllowed),
    };
  };

  type ShellInfo = {
    canonical: ApplicationShell;
    contentSlots: Map<
      string,
      {
        canonicalId: string;
        required: boolean;
        allowed: ReadonlySet<string>;
        depth: number;
        responsiveOrderAllowed: boolean;
      }
    >;
    publicSafe: boolean;
  };
  const shells: ApplicationShell[] = [];
  const shellByAlias = new Map<string, ShellInfo>();
  for (const shell of source.body.shells) {
    const reserved = new Set(
      shell.content_slots.map((slot) => `${slot.parent_placement}:${slot.parent_slot}`),
    );
    const beforeShellIds = new Set(allPlacementIds);
    const layout = compileSlot(
      { items: shell.layout.content, order: shell.layout.root.props.vortex.slot_orders.content },
      {
        depth: 1,
        allowedCategories: new Set(["layout"]),
        responsiveOrderAllowed: true,
        publicSurface: false,
        reserved,
        captureShellPlacements: true,
      },
    );
    const contentSlots = new Map<
      string,
      {
        canonicalId: string;
        required: boolean;
        allowed: ReadonlySet<string>;
        depth: number;
        responsiveOrderAllowed: boolean;
      }
    >();
    const canonicalSlots = shell.content_slots.map((slot) => {
      const parent = requireValue(
        shellPlacementTargets.get(slot.parent_placement),
        "vortex.definition.application_block_references",
        "broken_reference",
      );
      const declaration = parent.release.slots.find((entry) => entry.key === slot.parent_slot);
      if (
        declaration === undefined ||
        (declaration.required && !slot.required) ||
        slot.allowed_child_categories.some(
          (category) => !declaration.allowedChildCategories.includes(category),
        )
      )
        reject("vortex.definition.application_block_references", "broken_reference");
      const canonicalId = resolution.identity("shell_content_slot", slot.id, "content");
      contentSlots.set(slot.id, {
        canonicalId,
        required: slot.required,
        allowed: new Set(slot.allowed_child_categories),
        depth: parent.depth + 1,
        responsiveOrderAllowed: parent.release.capabilities.responsiveOrder,
      });
      return {
        slotId: canonicalId,
        key: slot.key,
        label: slot.label,
        required: slot.required,
        allowedChildCategories: slot.allowed_child_categories,
        parentPlacementId: parent.canonicalId,
        parentSlotKey: slot.parent_slot,
      };
    });
    const canonical = applicationShellSchema.parse({
      shellId: resolution.identity("shell", shell.id, "content"),
      key: shell.key,
      name: shell.name,
      presentation: {
        sidebar: {
          collapsible: shell.presentation.sidebar.collapsible,
          defaultCollapsed: shell.presentation.sidebar.default_collapsed,
        },
        topBar: {
          breadcrumbs: shell.presentation.top_bar.breadcrumbs,
          organizationSwitcher: shell.presentation.top_bar.organization_switcher,
          applicationSwitcher: shell.presentation.top_bar.application_switcher,
          accountMenu: shell.presentation.top_bar.account_menu,
          appearanceToggle: shell.presentation.top_bar.appearance_toggle,
        },
      },
      layout: {
        root: { props: { vortex: { slotOrders: { content: layout.order } } } },
        content: layout.items,
      },
      contentSlots: canonicalSlots,
    });
    const shellIds = [...allPlacementIds].filter((id) => !beforeShellIds.has(id));
    const publicSafe = shellIds.every((id) => {
      for (const target of shellPlacementTargets.values())
        if (target.canonicalId === id)
          return target.release.capabilities.publicSurface === "allowed";
      return true;
    });
    shells.push(canonical);
    shellByAlias.set(shell.id, { canonical, contentSlots, publicSafe });
  }

  const compileApplicationShellContent = (
    shellAlias: string,
    authoredContent: ReadonlyMap<string, SourceZone>,
    publicSurface: boolean,
  ) => {
    const shell = requireValue(
      shellByAlias.get(shellAlias),
      "vortex.definition.application_block_references",
      "broken_reference",
    );
    if (publicSurface && !shell.publicSafe) reject("vortex.definition.application_public_surface");
    if ([...authoredContent.keys()].some((alias) => !shell.contentSlots.has(alias)))
      reject("vortex.definition.application_block_references", "unknown_property");
    const content = new Map<string, CompiledZone>();
    for (const [alias, slot] of shell.contentSlots) {
      const authored = authoredContent.get(alias);
      if (authored === undefined) {
        if (slot.required)
          reject("vortex.definition.application_block_references", "required_value");
        continue;
      }
      if (slot.required && authored.items.length === 0)
        reject("vortex.definition.application_block_references", "required_value");
      content.set(
        slot.canonicalId,
        compileSlot(authored, {
          depth: slot.depth,
          allowedCategories: slot.allowed,
          responsiveOrderAllowed: slot.responsiveOrderAllowed,
          publicSurface,
        }),
      );
    }
    return { shell, content };
  };

  const pages: Array<{ pageId: string; composition: CanonicalComposition }> = [];
  for (const page of source.body.pages) {
    const pageId = resolution.identity("page", page.id, "content");
    const publicSurface = page.type === "public";
    const composition = page.composition;
    if ((page.type === "guided_form") !== "step_content" in composition)
      reject("vortex.definition.application_layout_complete");
    const steps = page.type === "guided_form" ? page.steps : [];
    const shellAliases = new Set(
      sourcePageDataOf(composition).map((data) => data.root.props.vortex.shell),
    );
    if (shellAliases.size > 1) reject("vortex.definition.application_layout_complete");
    const compileData = (data: SourcePageData): Record<string, unknown> => {
      const vortex = data.root.props.vortex;
      if (vortex.shell === null) {
        const zone = compileSlot(
          { items: data.content, order: vortex.slot_orders.content },
          { depth: 1, responsiveOrderAllowed: true, publicSurface },
        );
        return {
          root: { props: { vortex: { shellId: null, slotOrders: { content: zone.order } } } },
          content: zone.items,
        };
      }
      const { shell, content } = compileApplicationShellContent(
        vortex.shell,
        new Map(
          sourcePageRootSlots(data).map(([alias, items]) => [
            alias,
            { items, order: vortex.slot_orders[alias] },
          ]),
        ),
        publicSurface,
      );
      return {
        root: {
          props: {
            vortex: {
              shellId: shell.canonical.shellId,
              slotOrders: Object.fromEntries(
                [...content].map(([slotId, zone]) => [slotId, zone.order]),
              ),
            },
            ...Object.fromEntries([...content].map(([slotId, zone]) => [slotId, zone.items])),
          },
        },
        content: [],
      };
    };
    let canonical: unknown;
    if ("step_content" in composition) {
      const stepContent: Record<string, unknown> = {};
      for (const step of steps) {
        const stepId = resolution.identity("guided_step", step.id, `page:${page.key}`);
        stepContent[stepId] = compileData(
          requireValue(
            composition.step_content[step.id],
            "vortex.definition.application_layout_complete",
          ),
        );
      }
      canonical = guidedFormPageCompositionSchema.parse({ stepContent });
    } else canonical = pageCompositionSchema.parse(compileData(composition));
    pages.push({ pageId, composition: canonical as CanonicalComposition });
  }

  return { platformBlockDependencies: selectedDependencies, shells, pages, theme };
};
