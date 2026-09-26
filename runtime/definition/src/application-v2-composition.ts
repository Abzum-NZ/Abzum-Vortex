import {
  applicationCompositionCatalogueSnapshotV2Schema,
  applicationShellV2Schema,
  applicationThemeV2Schema,
  canonicalApplicationThemeSelectionV2,
  blockPropertyValueV2Schema,
  builderKeySchema,
  guidedFormPageCompositionV2Schema,
  isRepeatableSlotIdentityV2,
  findFieldInputBinding,
  FIELD_INPUT_CONTROL_RELEASES,
  pageCompositionV2Schema,
  repeatableSlotItemIdentitiesV2,
  repeatableSlotKeyV2,
  validateComponentSettingValue,
  validateComponentSettings,
  type ApplicationCompositionCatalogueSnapshotV2,
  type ApplicationContentV2,
  type ApplicationShellV2,
  type ApplicationSourceDocumentV2,
  type BlockPropertySchemaV2Contract,
  type BlockPropertyValueV2Contract,
  type ComponentSettingFailure,
  type DefinitionValidationLocation,
  type FieldInputControlKey,
  type PlatformBlockReleaseV2,
  type PlatformId,
  type ProtectedReadModelKey,
  type SourceBlockPropertyValueV2Contract,
} from "@vortex/contracts";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json";
import {
  DefinitionCompilationError,
  isDefinitionCompilerRefusalCode,
  type DefinitionCompilerRefusalCode,
} from "./compilation-error";
import type {
  ApplicationCompositionResolutionV2,
  FieldInputSourceField,
} from "./application-v2-resolution";
import {
  createThemeLocation,
  resolveThemeSelection,
  validateApplicationTheme,
  type ThemeResolutionOptions,
  type ThemeTokenValueV2,
  type ThemeValidationFailure,
} from "@vortex/theme";

type SourceSlot = {
  placements: Record<string, SourcePlacement>;
  order: { desktop: string[]; tablet?: string[]; phone?: string[] };
};
type SourcePlacement = {
  block: { block_id: string; release_version: string };
  view_permission?: string;
  use_permission?: string;
  visibility_condition?: Parameters<ApplicationCompositionResolutionV2["condition"]>[0];
  query?: string;
  read_model?: ProtectedReadModelKey;
  settings: Record<string, SourceBlockPropertyValueV2Contract>;
  theme_overrides: Record<string, unknown>;
  responsive: Record<string, unknown>;
  slots: Record<string, SourceSlot>;
};
type CanonicalComposition = ApplicationContentV2["pages"][number]["composition"];
type CanonicalTheme = ApplicationContentV2["theme"];

export type MaterialisedApplicationCompositionV2 = Readonly<{
  platformBlockDependencies: ApplicationContentV2["platformBlockDependencies"];
  shells: ApplicationShellV2[];
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

const asSourceSlot = (value: unknown): SourceSlot => value as SourceSlot;
const asSourcePlacement = (value: unknown): SourcePlacement => value as SourcePlacement;

const canonicalDependency = (
  dependency: ApplicationSourceDocumentV2["body"]["platform_block_dependencies"][number],
) => ({
  kind: "platform_block" as const,
  blockId: dependency.block_id,
  releaseVersion: dependency.release_version,
  contentFingerprint: dependency.content_fingerprint,
  catalogueFingerprint: dependency.catalogue_fingerprint,
});

const canonicalThemeDependency = (base: ApplicationSourceDocumentV2["body"]["theme"]["base"]) => ({
  kind: "platform_theme" as const,
  catalogueThemeId: base.catalogue_theme_id,
  releaseVersion: base.release_version,
  contentFingerprint: base.content_fingerprint,
  catalogueFingerprint: base.catalogue_fingerprint,
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

/** Refuses publication with a theme selection failure, located where the Theme engine put it. */
const rejectThemeFailure = (first: ThemeValidationFailure | undefined): never =>
  reject(
    first !== undefined && isDefinitionCompilerRefusalCode(first.ruleCode)
      ? first.ruleCode
      : "vortex.definition.application_block_settings",
    first?.family ?? "invalid_value",
    first?.location,
  );

/** Colour roles are declared by the platform theme release; overrides inherit them. */
const inheritColorRole = (
  inherited: Record<string, unknown> | undefined,
  override: Record<string, unknown>,
): Record<string, unknown> =>
  inherited?.kind === "color_pair" && inherited.role !== undefined
    ? { ...override, role: inherited.role }
    : override;

const rejectSettingFailures = (failures: readonly ComponentSettingFailure[]): void => {
  const first = failures[0];
  if (first !== undefined)
    reject("vortex.definition.application_block_settings", first.family);
};

/** Every theme token a canonical value names, including inside groups and lists, must resolve. */
const validateThemeTokenSettings = (
  value: BlockPropertyValueV2Contract,
  schema: BlockPropertySchemaV2Contract,
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
  value: BlockPropertyValueV2Contract,
  schema: BlockPropertySchemaV2Contract,
  theme: CanonicalTheme,
): void => {
  rejectSettingFailures(validateComponentSettingValue(value, schema));
  validateThemeTokenSettings(value, schema, theme);
};

const compilePropertyValue = (
  authored: SourceBlockPropertyValueV2Contract,
  schema: BlockPropertySchemaV2Contract,
  resolution: ApplicationCompositionResolutionV2,
  theme: CanonicalTheme,
): BlockPropertyValueV2Contract => {
  let compiled: unknown;
  switch (authored.kind) {
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
      compiled = { kind: authored.kind, queryId: resolution.identity("query", authored.query) };
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
  const parsed = blockPropertyValueV2Schema.safeParse(compiled);
  if (!parsed.success) reject("vortex.definition.application_block_settings", "invalid_value");
  const value = parsed.data!;
  validateCanonicalPropertyValue(value, schema, theme);
  return value;
};

const compileSettings = (
  authored: Record<string, SourceBlockPropertyValueV2Contract>,
  declarations: readonly BlockPropertySchemaV2Contract[],
  resolution: ApplicationCompositionResolutionV2,
  theme: CanonicalTheme,
): Record<string, BlockPropertyValueV2Contract> => {
  const result: Record<string, BlockPropertyValueV2Contract> = {};
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
        settings: inputType === undefined ? {} : { input_type: { kind: "choice", value: inputType } },
      };
    }
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
    case "choice":
      // The choice control keys its options by builder key; a field whose stored option values
      // are not builder keys cannot be offered exactly, so it is refused rather than rewritten.
      if (!field.choices.every((choice) => builderKeySchema.safeParse(choice.key).success))
        reject("vortex.definition.unsupported_field_type", "unsupported_choice");
      return {
        control: "choice",
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
  declaration: BlockPropertySchemaV2Contract | undefined,
): BlockPropertyValueV2Contract => {
  const parsed = blockPropertyValueV2Schema.safeParse(value);
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
  release: PlatformBlockReleaseV2,
  settings: Record<string, BlockPropertyValueV2Contract>,
  resolution: ApplicationCompositionResolutionV2,
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
  const declaration = (key: string): BlockPropertySchemaV2Contract | undefined =>
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
  settings: Readonly<Record<string, BlockPropertyValueV2Contract>>,
  release: PlatformBlockReleaseV2,
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
  release: PlatformBlockReleaseV2,
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
  authored: SourceSlot["order"],
  resolvePlacement: (alias: string) => string,
  responsiveOrderAllowed: boolean,
) => {
  const desktop = authored.desktop.map(resolvePlacement);
  const tablet = (authored.tablet ?? authored.desktop).map(resolvePlacement);
  const phone = (authored.phone ?? authored.tablet ?? authored.desktop).map(resolvePlacement);
  if (
    !responsiveOrderAllowed &&
    (canonicalJson(tablet) !== canonicalJson(desktop) ||
      canonicalJson(phone) !== canonicalJson(desktop))
  )
    reject("vortex.definition.application_layout_complete");
  return { desktop, tablet, phone };
};

/** Pure V2 composition materialisation; it does not activate any compiler or reader dispatch. */
export const materialiseApplicationCompositionV2 = (
  source: ApplicationSourceDocumentV2,
  snapshotInput: ApplicationCompositionCatalogueSnapshotV2,
  resolution: ApplicationCompositionResolutionV2,
): MaterialisedApplicationCompositionV2 => {
  const snapshot = applicationCompositionCatalogueSnapshotV2Schema.parse(snapshotInput);
  const { fingerprint, ...snapshotEvidence } = snapshot;
  if (fingerprintCanonicalValue(snapshotEvidence) !== fingerprint)
    reject("vortex.definition.application_dependency_manifest");

  const dependencies = source.body.platform_block_dependencies.map(canonicalDependency);
  const selectedDependencies = snapshot.platformBlocks.releases.map((release) => ({
    kind: "platform_block" as const,
    blockId: release.blockId,
    releaseVersion: release.releaseVersion,
    contentFingerprint: release.contentFingerprint,
    catalogueFingerprint: release.catalogueFingerprint,
  }));
  if (canonicalJson(dependencies) !== canonicalJson(selectedDependencies))
    reject("vortex.definition.application_dependency_manifest");
  if (
    canonicalJson(canonicalThemeDependency(source.body.theme.base)) !==
    canonicalJson({
      kind: "platform_theme",
      catalogueThemeId: snapshot.platformTheme.catalogueThemeId,
      releaseVersion: snapshot.platformTheme.releaseVersion,
      contentFingerprint: snapshot.platformTheme.contentFingerprint,
      catalogueFingerprint: snapshot.platformTheme.catalogueFingerprint,
    })
  )
    reject("vortex.definition.application_dependency_manifest");

  const canonicalOverrides: Record<string, ThemeTokenValueV2> = {};
  for (const [key, authored] of Object.entries(source.body.theme.token_overrides)) {
    canonicalOverrides[key] = canonicalThemeValue(
      authored as unknown as Record<string, unknown>,
    ) as ThemeTokenValueV2;
  }
  const selectionResolution = resolveThemeSelection({
    base: snapshot.platformTheme,
    baseTokens: snapshot.platformTheme.tokens,
    ...(source.body.theme.selection === undefined
      ? {}
      : { selection: canonicalApplicationThemeSelectionV2(source.body.theme.selection) }),
    overrides: canonicalOverrides,
    options: { documentKey: source.key },
  });
  const resolvedTheme = selectionResolution.valid
    ? selectionResolution.resolved
    : rejectThemeFailure(selectionResolution.failures[0]);
  const theme = applicationThemeV2Schema.parse({
    base: canonicalThemeDependency(source.body.theme.base),
    // A theme on the catalogue's base release always records its effective selection, including
    // the platform default when the authored theme named none, so a consumer reads the exact
    // style and dimensions. A theme on an earlier release records none and keeps its tokens.
    ...(resolvedTheme.selection === undefined ? {} : { selection: resolvedTheme.selection }),
    tokens: resolvedTheme.tokens,
  });

  // The exact pinned platform theme release is the trusted catalogue of approved,
  // public theme assets. An application may use only the assets that release ships.
  const catalogueAssetIds = new Set<PlatformId>();
  for (const token of Object.values(snapshot.platformTheme.tokens))
    if (token.kind === "asset") catalogueAssetIds.add(token.assetId);
  const themeValidationOptions: ThemeResolutionOptions = {
    approvedAssetIds: catalogueAssetIds,
    publicAssetIds: catalogueAssetIds,
  };
  validateTheme(theme, source.key, themeValidationOptions);

  const releaseByIdentity = new Map(
    snapshot.platformBlocks.releases.map((release) => [
      `${release.blockId}:${release.releaseVersion}`,
      release,
    ]),
  );
  const allPlacementIds = new Set<string>();
  const readModelPlacementIds = new Set<string>();
  let placementCount = 0;
  const shellPlacementTargets = new Map<
    string,
    { canonicalId: string; depth: number; release: PlatformBlockReleaseV2 }
  >();

  const compileSlot = (
    authored: SourceSlot,
    options: {
      depth: number;
      allowedCategories?: ReadonlySet<string>;
      responsiveOrderAllowed: boolean;
      publicSurface: boolean;
      reserved?: ReadonlySet<string>;
      captureShellPlacements?: boolean;
    },
  ): Record<string, unknown> => {
    const placementAliases = Object.keys(authored.placements);
    const resolvedByAlias = new Map(
      placementAliases.map((alias) => [
        alias,
        resolution.identity("block_placement", alias, "content"),
      ]),
    );
    const resolvePlacement = (alias: string): string =>
      requireValue(resolvedByAlias.get(alias), "vortex.definition.application_layout_complete");
    const placements: Record<string, unknown> = {};
    for (const alias of placementAliases) {
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
      const authoredPlacement = asSourcePlacement(authored.placements[alias]!);
      const release = requireValue(
        releaseByIdentity.get(
          `${authoredPlacement.block.block_id}:${authoredPlacement.block.release_version}`,
        ),
        "vortex.definition.application_block_references",
        "broken_reference",
      );
      if (
        options.allowedCategories !== undefined &&
        !options.allowedCategories.has(release.paletteGroup)
      )
        reject("vortex.definition.application_block_references", "incompatible_version");
      if (options.publicSurface && release.capabilities.publicSurface !== "allowed")
        reject("vortex.definition.application_public_surface");
      // A protected read model is live viewer-authorised data: never on a public surface, and a
      // placement reads either it or a query, never both.
      if (authoredPlacement.read_model !== undefined) {
        if (options.publicSurface) reject("vortex.definition.application_public_surface");
        if (authoredPlacement.query !== undefined)
          reject("vortex.definition.application_block_references", "scope_conflict");
        readModelPlacementIds.add(canonicalId);
      }

      // A repeatable declaration's own key names only its family, never a slot.
      const declaredSlots = new Set(
        release.slots.filter((slot) => slot.repeats === undefined).map((slot) => slot.key),
      );
      const repeatableSlots = new Map<string, (typeof release.slots)[number]>();
      for (const declaration of release.slots) {
        if (declaration.repeats === undefined) continue;
        const identities = repeatableSlotItemIdentitiesV2(
          declaration,
          authoredPlacement.settings,
        );
        if (new Set(identities).size !== identities.length)
          reject("vortex.definition.application_block_settings", "duplicate_key");
        for (const identity of identities) {
          if (!isRepeatableSlotIdentityV2(declaration.key, identity))
            reject("vortex.definition.application_block_settings", "invalid_value");
          repeatableSlots.set(repeatableSlotKeyV2(declaration.key, identity), declaration);
        }
      }
      if (
        Object.keys(authoredPlacement.slots).some(
          (key) => !declaredSlots.has(key) && !repeatableSlots.has(key),
        )
      )
        reject("vortex.definition.application_block_references", "unknown_property");
      const slots: Record<string, unknown> = {};
      const compileChildSlot = (
        declaration: (typeof release.slots)[number],
        slotKey: string,
      ): ReturnType<typeof compileSlot> =>
        compileSlot(authoredPlacement.slots[slotKey]!, {
          depth: options.depth + 1,
          allowedCategories: new Set(declaration.allowedChildCategories),
          responsiveOrderAllowed: release.capabilities.responsiveOrder,
          publicSurface: options.publicSurface,
          ...(options.reserved === undefined ? {} : { reserved: options.reserved }),
          ...(options.captureShellPlacements === undefined
            ? {}
            : { captureShellPlacements: options.captureShellPlacements }),
        });
      for (const declaration of release.slots) {
        if (declaration.repeats !== undefined) continue;
        const child = authoredPlacement.slots[declaration.key];
        const reserved = options.reserved?.has(`${alias}:${declaration.key}`) === true;
        if (child === undefined) {
          if (declaration.required && !reserved)
            reject("vortex.definition.application_block_references", "required_value");
          continue;
        }
        if (declaration.required && Object.keys(child.placements).length === 0 && !reserved)
          reject("vortex.definition.application_block_references", "required_value");
        slots[declaration.key] = compileChildSlot(declaration, declaration.key);
      }
      for (const [slotKey, declaration] of repeatableSlots)
        if (authoredPlacement.slots[slotKey] !== undefined)
          slots[slotKey] = compileChildSlot(declaration, slotKey);
      const responsive = materialiseResponsive(authoredPlacement.responsive, release);
      const themeOverrides: Record<string, unknown> = {};
      const effectiveOverrides: Record<string, unknown> = {};
      for (const [key, authoredValue] of Object.entries(authoredPlacement.theme_overrides)) {
        const inherited = theme.tokens[key] as Record<string, unknown> | undefined;
        const override = canonicalThemeValue(authoredValue as Record<string, unknown>) as Record<
          string,
          unknown
        >;
        if (inherited === undefined || inherited.kind !== override.kind)
          reject("vortex.definition.application_block_settings", "broken_reference");
        themeOverrides[key] = override;
        effectiveOverrides[key] = inheritColorRole(inherited, override);
      }
      if (Object.keys(effectiveOverrides).length > 0)
        validateTheme(
          applicationThemeV2Schema.parse({
            base: theme.base,
            ...(theme.selection === undefined ? {} : { selection: theme.selection }),
            tokens: { ...theme.tokens, ...effectiveOverrides },
          }),
          source.key,
          themeValidationOptions,
          [{ kind: "block", key: alias }],
        );
      rejectSettingFailures(
        validateComponentSettings(authoredPlacement.settings, release.properties),
      );
      const settings = compileSettings(
        authoredPlacement.settings,
        release.properties,
        resolution,
        theme,
      );
      applyFieldInputDerivation(release, settings, resolution);
      validateAccessibleName(settings, release);
      placements[canonicalId] = {
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
          : { queryId: resolution.identity("query", authoredPlacement.query) }),
        ...(authoredPlacement.read_model === undefined
          ? {}
          : { readModel: { key: authoredPlacement.read_model } }),
        settings,
        themeOverrides,
        responsive,
        slots,
      };
      if (options.captureShellPlacements)
        shellPlacementTargets.set(alias, { canonicalId, depth: options.depth, release });
    }
    return {
      placements,
      order: materialiseOrder(authored.order, resolvePlacement, options.responsiveOrderAllowed),
    };
  };

  type ShellInfo = {
    canonical: ApplicationShellV2;
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
  const shells: ApplicationShellV2[] = [];
  const shellByAlias = new Map<string, ShellInfo>();
  for (const shell of source.body.shells) {
    const reserved = new Set(
      shell.content_slots.map((slot) => `${slot.parent_placement}:${slot.parent_slot}`),
    );
    const beforeShellIds = new Set(allPlacementIds);
    const layout = compileSlot(asSourceSlot(shell.layout), {
      depth: 1,
      allowedCategories: new Set(["layout"]),
      responsiveOrderAllowed: true,
      publicSurface: false,
      reserved,
      captureShellPlacements: true,
    });
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
    const canonical = applicationShellV2Schema.parse({
      shellId: resolution.identity("shell", shell.id, "content"),
      key: shell.key,
      name: shell.name,
      layout,
      contentSlots: canonicalSlots,
    });
    const shellIds = [...allPlacementIds].filter((id) => !beforeShellIds.has(id));
    const publicSafe = shellIds.every((id) => {
      if (readModelPlacementIds.has(id)) return false;
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
    authoredContent: Record<string, SourceSlot>,
    publicSurface: boolean,
  ) => {
    const shell = requireValue(
      shellByAlias.get(shellAlias),
      "vortex.definition.application_block_references",
      "broken_reference",
    );
    if (publicSurface && !shell.publicSafe) reject("vortex.definition.application_public_surface");
    if (Object.keys(authoredContent).some((alias) => !shell.contentSlots.has(alias)))
      reject("vortex.definition.application_block_references", "unknown_property");
    const content: Record<string, unknown> = {};
    for (const [alias, slot] of shell.contentSlots) {
      const authored = authoredContent[alias];
      if (authored === undefined) {
        if (slot.required)
          reject("vortex.definition.application_block_references", "required_value");
        continue;
      }
      if (slot.required && Object.keys(authored.placements).length === 0)
        reject("vortex.definition.application_block_references", "required_value");
      content[slot.canonicalId] = compileSlot(authored, {
        depth: slot.depth,
        allowedCategories: slot.allowed,
        responsiveOrderAllowed: slot.responsiveOrderAllowed,
        publicSurface,
      });
    }
    return { shell, content };
  };

  const pages: Array<{ pageId: string; composition: CanonicalComposition }> = [];
  for (const page of source.body.pages) {
    const pageId = resolution.identity("page", page.id, "content");
    const publicSurface = page.type === "public";
    const composition = page.composition;
    let canonical: unknown;
    if (page.type === "guided_form") {
      if (!("step_content" in composition)) reject("vortex.definition.application_layout_complete");
      const guidedComposition = composition as Extract<
        typeof composition,
        { step_content: unknown }
      >;
      const stepContent: Record<string, unknown> = {};
      for (const step of page.steps) {
        const stepId = resolution.identity("guided_step", step.id, `page:${page.key}`);
        if (guidedComposition.shell_kind === "default")
          stepContent[stepId] = compileSlot(asSourceSlot(guidedComposition.step_content[step.id]), {
            depth: 1,
            responsiveOrderAllowed: true,
            publicSurface,
          });
        else {
          const result = compileApplicationShellContent(
            guidedComposition.shell,
            guidedComposition.step_content[step.id] as Record<string, SourceSlot>,
            publicSurface,
          );
          stepContent[stepId] = result.content;
        }
      }
      canonical =
        guidedComposition.shell_kind === "default"
          ? { shellKind: "default", stepContent }
          : {
              shellKind: "application",
              shellId: shellByAlias.get(guidedComposition.shell)?.canonical.shellId,
              stepContent,
            };
      canonical = guidedFormPageCompositionV2Schema.parse(canonical);
    } else if ("step_content" in composition)
      reject("vortex.definition.application_layout_complete");
    else if (composition.shell_kind === "default")
      canonical = pageCompositionV2Schema.parse({
        shellKind: "default",
        main: compileSlot(asSourceSlot(composition.main), {
          depth: 1,
          responsiveOrderAllowed: true,
          publicSurface,
        }),
      });
    else {
      const result = compileApplicationShellContent(
        composition.shell,
        composition.content as Record<string, SourceSlot>,
        publicSurface,
      );
      canonical = pageCompositionV2Schema.parse({
        shellKind: "application",
        shellId: result.shell.canonical.shellId,
        content: result.content,
      });
    }
    pages.push({ pageId, composition: canonical as CanonicalComposition });
  }

  return { platformBlockDependencies: dependencies, shells, pages, theme };
};
