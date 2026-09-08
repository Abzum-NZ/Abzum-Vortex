import {
  applicationCompositionCatalogueSnapshotV2Schema,
  applicationShellV2Schema,
  applicationThemeV2Schema,
  blockPropertyValueV2Schema,
  guidedFormPageCompositionV2Schema,
  pageCompositionV2Schema,
  type ApplicationCompositionCatalogueSnapshotV2,
  type ApplicationContentV2,
  type ApplicationShellV2,
  type ApplicationSourceDocumentV2,
  type BlockPropertySchemaV2Contract,
  type BlockPropertyValueV2Contract,
  type PlatformBlockReleaseV2,
  type SourceBlockPropertyValueV2Contract,
} from "@vortex/contracts";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json";
import {
  DefinitionCompilationError,
  type DefinitionCompilerRefusalCode,
} from "./compilation-error";
import type { ApplicationCompositionResolutionV2 } from "./application-v2-resolution";

type SourceSlot = {
  placements: Record<string, SourcePlacement>;
  order: { desktop: string[]; tablet?: string[]; phone?: string[] };
};
type SourcePlacement = {
  block: { block_id: string; release_version: string };
  view_permission?: string;
  use_permission?: string;
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
): never => {
  throw new DefinitionCompilationError(ruleCode, family);
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

const richTextKinds = (value: Extract<BlockPropertyValueV2Contract, { kind: "rich_text" }>) => {
  const kinds = new Set<string>();
  const visitInline = (inline: { kind: string; children?: unknown[] }) => {
    if (inline.kind !== "text") kinds.add(inline.kind);
    for (const child of inline.children ?? []) visitInline(child as typeof inline);
  };
  for (const block of value.value.blocks) {
    kinds.add(block.kind);
    const children = "children" in block ? block.children : block.items.flat();
    for (const child of children) visitInline(child);
  }
  return kinds;
};

const validateScalarProperty = (
  value: BlockPropertyValueV2Contract,
  schema: BlockPropertySchemaV2Contract,
): void => {
  if (value.kind !== schema.kind)
    reject("vortex.definition.application_block_settings", "invalid_value");
  if (schema.kind === "text" && value.kind === "text") {
    if (value.value.length < schema.minLength || value.value.length > schema.maxLength)
      reject("vortex.definition.application_block_settings");
  } else if (schema.kind === "number" && value.kind === "number") {
    if (
      (schema.integer && !Number.isInteger(value.value)) ||
      (schema.minimum !== undefined && value.value < schema.minimum) ||
      (schema.maximum !== undefined && value.value > schema.maximum)
    )
      reject("vortex.definition.application_block_settings");
  } else if (schema.kind === "choice" && value.kind === "choice") {
    if (!schema.options.some((option) => option.key === value.value))
      reject("vortex.definition.application_block_settings");
  } else if (schema.kind === "rich_text" && value.kind === "rich_text") {
    const allowed = new Set(schema.allowedElements);
    if ([...richTextKinds(value)].some((kind) => !allowed.has(kind as never)))
      reject("vortex.definition.application_block_settings");
  }
};

const validateCanonicalPropertyValue = (
  value: BlockPropertyValueV2Contract,
  schema: BlockPropertySchemaV2Contract,
  theme: CanonicalTheme,
): void => {
  validateScalarProperty(value, schema);
  if (schema.kind === "theme_token" && value.kind === "theme_token") {
    const token = theme.tokens[value.tokenKey];
    if (token === undefined || token.kind !== schema.tokenKind)
      reject("vortex.definition.application_block_settings", "broken_reference");
  } else if (schema.kind === "group" && value.kind === "group") {
    const declarations = new Map(schema.properties.map((property) => [property.key, property]));
    if (Object.keys(value.properties).some((key) => !declarations.has(key)))
      reject("vortex.definition.application_block_settings", "unknown_property");
    for (const [key, nested] of Object.entries(value.properties))
      validateCanonicalPropertyValue(
        nested,
        requireValue(
          declarations.get(key),
          "vortex.definition.application_block_settings",
          "unknown_property",
        ),
        theme,
      );
  } else if (schema.kind === "list" && value.kind === "list") {
    if (value.items.length < schema.minimumItems || value.items.length > schema.maximumItems)
      reject("vortex.definition.application_block_settings", "invalid_value");
    for (const item of value.items) validateCanonicalPropertyValue(item, schema.item, theme);
  }
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
      const declarations = new Map(
        groupSchema.properties.map((property) => [property.key, property]),
      );
      if (Object.keys(authored.properties).some((key) => !declarations.has(key)))
        reject("vortex.definition.application_block_settings", "unknown_property");
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
      if (
        authored.items.length < listSchema.minimumItems ||
        authored.items.length > listSchema.maximumItems
      )
        reject("vortex.definition.application_block_settings");
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
  const byKey = new Map(declarations.map((declaration) => [declaration.key, declaration]));
  if (Object.keys(authored).some((key) => !byKey.has(key)))
    reject("vortex.definition.application_block_settings", "unknown_property");
  const result: Record<string, BlockPropertyValueV2Contract> = {};
  for (const declaration of declarations) {
    const value = authored[declaration.key];
    if (value !== undefined)
      result[declaration.key] = compilePropertyValue(value, declaration, resolution, theme);
    else if (declaration.defaultValue !== undefined) {
      validateCanonicalPropertyValue(declaration.defaultValue, declaration, theme);
      result[declaration.key] = declaration.defaultValue;
    } else if (declaration.required)
      reject("vortex.definition.application_block_settings", "required_value");
  }
  return result;
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

  const tokens: Record<string, unknown> = { ...snapshot.platformTheme.tokens };
  for (const [key, authored] of Object.entries(source.body.theme.token_overrides)) {
    const existing = tokens[key] as Record<string, unknown> | undefined;
    const compiled = canonicalThemeValue(authored as unknown as Record<string, unknown>) as Record<
      string,
      unknown
    >;
    if (existing === undefined || existing.kind !== compiled.kind)
      reject("vortex.definition.application_block_settings", "broken_reference");
    tokens[key] = compiled;
  }
  const theme = applicationThemeV2Schema.parse({
    base: canonicalThemeDependency(source.body.theme.base),
    tokens,
  });
  validateThemeTokenReferences(theme.tokens);

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

      const declaredSlots = new Map(release.slots.map((slot) => [slot.key, slot]));
      if (Object.keys(authoredPlacement.slots).some((key) => !declaredSlots.has(key)))
        reject("vortex.definition.application_block_references", "unknown_property");
      const slots: Record<string, unknown> = {};
      for (const declaration of release.slots) {
        const child = authoredPlacement.slots[declaration.key];
        const reserved = options.reserved?.has(`${alias}:${declaration.key}`) === true;
        if (child === undefined) {
          if (declaration.required && !reserved)
            reject("vortex.definition.application_block_references", "required_value");
          continue;
        }
        if (declaration.required && Object.keys(child.placements).length === 0 && !reserved)
          reject("vortex.definition.application_block_references", "required_value");
        const childOptions: Parameters<typeof compileSlot>[1] = {
          depth: options.depth + 1,
          allowedCategories: new Set(declaration.allowedChildCategories),
          responsiveOrderAllowed: release.capabilities.responsiveOrder,
          publicSurface: options.publicSurface,
          ...(options.reserved === undefined ? {} : { reserved: options.reserved }),
          ...(options.captureShellPlacements === undefined
            ? {}
            : { captureShellPlacements: options.captureShellPlacements }),
        };
        slots[declaration.key] = compileSlot(child, childOptions);
      }
      const responsive = materialiseResponsive(authoredPlacement.responsive, release);
      const themeOverrides: Record<string, unknown> = {};
      for (const [key, authoredValue] of Object.entries(authoredPlacement.theme_overrides)) {
        const inherited = theme.tokens[key] as Record<string, unknown> | undefined;
        const override = canonicalThemeValue(authoredValue as Record<string, unknown>) as Record<
          string,
          unknown
        >;
        if (inherited === undefined || inherited.kind !== override.kind)
          reject("vortex.definition.application_block_settings", "broken_reference");
        themeOverrides[key] = override;
      }
      const effectiveTheme = applicationThemeV2Schema.parse({
        base: theme.base,
        tokens: { ...theme.tokens, ...themeOverrides },
      });
      validateThemeTokenReferences(effectiveTheme.tokens);
      const settings = compileSettings(
        authoredPlacement.settings,
        release.properties,
        resolution,
        theme,
      );
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
