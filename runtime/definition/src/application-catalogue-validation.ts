import {
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
  builderKeySchema,
  readRecordDetailContract,
  readRecordsTableContract,
  validateComponentSettings,
  type ApplicationSourceDocumentV2,
  type BlockPropertySchemaV2Contract,
  type DefinitionRuleFailure,
  type DefinitionValidationLocation,
  type PlatformBlockReleaseV2,
  type SourceBlockPropertyValueV2Contract,
} from "@vortex/contracts";

/**
 * Located catalogue validation for authored Application documents.
 *
 * A hand-authored document and a Studio-produced document are the same Application source
 * contract, so this one rule judges both: at draft save through validateDefinitionSource and again
 * before publication compiles. It admits only the exact releases registered in the server-owned
 * immutable platform block catalogue; a renderer registration cannot add to that allowlist.
 */

type Segment = DefinitionValidationLocation["segments"][number];
type Body = ApplicationSourceDocumentV2["body"];
type SourceSlot = Body["shells"][number]["layout"];
type SourcePlacement = SourceSlot["placements"][string];
type SourceLayout = SourcePlacement["responsive"]["desktop"];
type SourceValue = SourceBlockPropertyValueV2Contract;

export const applicationCatalogueRuleCodes = [
  "vortex.definition.application_dependency_manifest",
  "vortex.definition.application_block_references",
  "vortex.definition.application_block_settings",
  "vortex.definition.application_public_surface",
  "vortex.definition.application_layout_complete",
] as const;

type CatalogueRuleCode = (typeof applicationCatalogueRuleCodes)[number];

const maximumLocationSegments = 12;

const keySegment = (kind: Segment["kind"], key: string): Segment[] =>
  builderKeySchema.safeParse(key).success ? [{ kind, key }] : [];

const effectiveLayouts = (responsive: SourcePlacement["responsive"]): SourceLayout[] => {
  const tablet = responsive.tablet ?? responsive.desktop;
  return [responsive.desktop, tablet, responsive.phone ?? tablet];
};

/** Exact registered releases keyed by permanent block identity and release version. */
const registeredReleases: ReadonlyMap<string, PlatformBlockReleaseV2> = new Map(
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2.releases.map((release) => [
    `${release.blockId}:${release.releaseVersion}`,
    release,
  ]),
);

type SlotOptions = Readonly<{
  scope: readonly Segment[];
  depth: number;
  allowedCategories?: ReadonlySet<string>;
  responsiveOrderAllowed: boolean;
  publicSurface: boolean;
  reserved?: ReadonlySet<string>;
  shellPlacements?: Map<string, Readonly<{ depth: number; release: PlatformBlockReleaseV2 }>>;
}>;

type ShellContentSlot = Readonly<{
  required: boolean;
  allowed: ReadonlySet<string>;
  depth: number;
  responsiveOrderAllowed: boolean;
}>;

/**
 * Validates one authored Application source against the registered platform block catalogue.
 * Every refusal names the placement, and where relevant the setting, that caused it.
 */
export function validateApplicationSourceCatalogue(
  source: ApplicationSourceDocumentV2,
): DefinitionRuleFailure[] {
  const catalogue = IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2;
  const failures: DefinitionRuleFailure[] = [];
  const report = (
    ruleCode: CatalogueRuleCode,
    family: DefinitionRuleFailure["family"],
    segments: readonly Segment[] = [],
  ): void => {
    const located: Segment[] = [{ kind: "application", key: source.key }, ...segments];
    failures.push({
      ruleCode,
      family,
      location: {
        documentKind: "application",
        documentKey: source.key,
        segments: located.slice(0, maximumLocationSegments),
      },
    });
  };

  const manifest = new Map<string, Body["platform_block_dependencies"][number]>();
  for (const dependency of source.body.platform_block_dependencies) {
    manifest.set(String(dependency.block_id), dependency);
    const release = registeredReleases.get(
      `${dependency.block_id}:${dependency.release_version}`,
    );
    if (release === undefined)
      report("vortex.definition.application_dependency_manifest", "broken_reference");
    else if (
      release.contentFingerprint !== dependency.content_fingerprint ||
      release.catalogueFingerprint !== dependency.catalogue_fingerprint
    )
      report("vortex.definition.application_dependency_manifest", "incompatible_version");
  }

  // The data source of a Records table or Record detail is its placement's bound query, matched
  // by the query's authored id exactly as the compiler resolves it.
  const queriesById = new Map(source.body.queries.map((query) => [query.id, query]));
  let pageRecordType: string | undefined;

  /**
   * A Records table or Record detail may map only fields its bound data source allows. Mapped
   * columns and detail fields must be selected by the bound query (or, for a detail with no query,
   * belong to its page's record type); default sort, sortable and filterable fields must also be
   * orderable: a grouped or aggregating query exposes only its grouping fields. A default sort
   * must be the bound query's leading sort, the order the Query engine actually applies. Every
   * refusal names the placement and the setting that carries the field.
   */
  const validateDataContract = (
    placement: SourcePlacement,
    settings: Readonly<Record<string, SourceValue>>,
    location: readonly Segment[],
  ): void => {
    const table = readRecordsTableContract(settings);
    const detail = table === undefined ? readRecordDetailContract(settings) : undefined;
    if (table === undefined && detail === undefined) return;
    const at = (key: string): Segment[] => [...location, ...keySegment("setting", key)];
    const query = placement.query === undefined ? undefined : queriesById.get(placement.query);
    if (placement.query !== undefined && query === undefined) return; // refused by the source contract
    if (table !== undefined && query === undefined)
      report("vortex.definition.application_block_references", "required_value", location);

    let readable: ReadonlySet<string> | undefined;
    let orderable: ReadonlySet<string> | undefined;
    if (query !== undefined) {
      const qualified = (alias: string): string => `${query.record_type}.${alias}`;
      readable = new Set(query.select.map(qualified));
      orderable =
        query.group_by.length > 0 || query.aggregates.length > 0
          ? new Set(query.group_by.map(qualified))
          : readable;
    }
    const mapped = (field: string): boolean =>
      readable !== undefined
        ? readable.has(field)
        : pageRecordType !== undefined && field.startsWith(`${pageRecordType}.`);

    const checkFields = (
      key: string,
      fields: readonly string[],
      allowed: (field: string) => boolean,
      unallowedFamily: DefinitionRuleFailure["family"],
    ): void => {
      const seen = new Set<string>();
      for (const field of fields) {
        if (seen.has(field)) report("vortex.definition.application_block_settings", "duplicate_key", at(key));
        seen.add(field);
        if (!mapped(field))
          report("vortex.definition.application_block_settings", "broken_reference", at(key));
        else if (!allowed(field))
          report("vortex.definition.application_block_settings", unallowedFamily, at(key));
      }
    };
    const orders = (field: string): boolean => orderable?.has(field) ?? true;

    if (table !== undefined) {
      checkFields("columns", table.columns.map((column) => column.field), () => true, "invalid_value");
      if (table.defaultSort !== undefined) {
        checkFields("default_sort", [table.defaultSort.field], orders, "unsupported_choice");
        // The Query engine applies the bound query's declared sort and takes no sort input, so a
        // default sort other than the query's leading sort would be declared yet never applied.
        const leading = query?.sort[0];
        if (
          query !== undefined &&
          leading !== undefined &&
          (`${query.record_type}.${leading.field}` !== table.defaultSort.field ||
            leading.direction !== table.defaultSort.direction)
        )
          report("vortex.definition.application_block_settings", "unsupported_choice", at("default_sort"));
      }
      checkFields("sortable_fields", table.sortableFields, orders, "unsupported_choice");
      checkFields("filterable_fields", table.filterableFields, orders, "unsupported_choice");
      const inputs = new Set<string>();
      for (const parameter of table.parameters) {
        // An Application query declares no inputs, so no input name can be bound to it.
        report("vortex.definition.application_block_settings", "unknown_property", at("query_parameters"));
        if (inputs.has(parameter.input))
          report("vortex.definition.application_block_settings", "duplicate_key", at("query_parameters"));
        inputs.add(parameter.input);
        if (
          (parameter.source === "fixed" && parameter.fixedValue === undefined) ||
          (parameter.source === "page" && parameter.pageParameter === undefined)
        )
          report("vortex.definition.application_block_settings", "required_value", at("query_parameters"));
      }
    } else if (detail !== undefined)
      checkFields("detail_fields", detail.fields.map((entry) => entry.field), () => true, "invalid_value");
  };

  const settingPathSegments = (path: readonly (string | number)[]): Segment[] =>
    path.flatMap((part) => (typeof part === "string" ? keySegment("setting", part) : []));

  const validateSettings = (
    authored: Readonly<Record<string, SourceValue>>,
    declarations: readonly BlockPropertySchemaV2Contract[],
    location: readonly Segment[],
  ): void => {
    for (const failure of validateComponentSettings(authored, declarations))
      report(
        "vortex.definition.application_block_settings",
        failure.family,
        [...location, ...settingPathSegments(failure.path)],
      );
  };

  /** A required accessible name must exist after defaults; a supplied name must be real text. */
  const validateAccessibleName = (
    settings: Readonly<Record<string, SourceValue>>,
    release: PlatformBlockReleaseV2,
    location: readonly Segment[],
  ): void => {
    if (release.capabilities.accessibleName === "not_applicable") return;
    const path = release.capabilities.accessibleNamePropertyPath;
    let declarations: readonly BlockPropertySchemaV2Contract[] = release.properties;
    let values: Readonly<Record<string, SourceValue>> = settings;
    let nameLocation = location;
    let name: SourceValue | BlockPropertySchemaV2Contract["defaultValue"] = undefined;
    for (const [index, key] of path.entries()) {
      const declaration = declarations.find((candidate) => candidate.key === key);
      nameLocation = [...nameLocation, ...keySegment("setting", key)];
      name = values[key] ?? declaration?.defaultValue;
      if (name === undefined || index === path.length - 1) break;
      if (name.kind !== "group") {
        report("vortex.definition.application_block_settings", "invalid_value", nameLocation);
        return;
      }
      values = name.properties as Readonly<Record<string, SourceValue>>;
      declarations = declaration?.kind === "group" ? declaration.properties : [];
    }
    if (name === undefined) {
      if (release.capabilities.accessibleName === "required")
        report("vortex.definition.application_block_settings", "required_value", nameLocation);
      return;
    }
    if (name.kind !== "text" || name.value.trim().length === 0)
      report("vortex.definition.application_block_settings", "invalid_value", nameLocation);
  };

  const validateResponsive = (
    placement: SourcePlacement,
    release: PlatformBlockReleaseV2,
    location: readonly Segment[],
  ): void => {
    const layouts = effectiveLayouts(placement.responsive);
    const desktop = layouts[0]!;
    if (
      (!release.capabilities.responsiveVisibility &&
        layouts.some((layout) => layout.visible !== desktop.visible)) ||
      layouts.some(
        (layout) =>
          (!release.capabilities.gridWidth && layout.width.kind === "grid") ||
          (release.capabilities.height === "content" && layout.height.kind !== "content"),
      )
    )
      report("vortex.definition.application_layout_complete", "invalid_value", location);
  };

  let placementCount = 0;
  let limitReported = false;

  const validateSlot = (
    slot: SourceSlot,
    options: SlotOptions,
    parent: readonly Segment[],
  ): void => {
    if (!options.responsiveOrderAllowed) {
      const desktop = slot.order.desktop.join("\0");
      const tablet = (slot.order.tablet ?? slot.order.desktop).join("\0");
      const phone = (slot.order.phone ?? slot.order.tablet ?? slot.order.desktop).join("\0");
      if (tablet !== desktop || phone !== desktop)
        report("vortex.definition.application_layout_complete", "invalid_value", parent);
    }
    for (const [alias, placement] of Object.entries(slot.placements)) {
      const location = [...options.scope, ...keySegment("block", alias)];
      placementCount += 1;
      if (
        !limitReported &&
        (placementCount > catalogue.compositionPolicy.maximumPlacements ||
          options.depth > catalogue.compositionPolicy.maximumDepth)
      ) {
        limitReported = true;
        report("vortex.definition.application_layout_complete", "too_many_items", location);
      }

      const blockId = String(placement.block.block_id);
      const dependency = manifest.get(blockId);
      if (
        dependency === undefined ||
        dependency.release_version !== placement.block.release_version
      )
        report("vortex.definition.application_dependency_manifest", "broken_reference", location);
      const release = registeredReleases.get(`${blockId}:${placement.block.release_version}`);
      if (release === undefined) {
        report("vortex.definition.application_block_references", "broken_reference", location);
        // Nested content is still judged, without the unknown parent's slot restrictions.
        for (const child of Object.values(placement.slots))
          validateSlot(
            child,
            {
              scope: options.scope,
              depth: options.depth + 1,
              responsiveOrderAllowed: true,
              publicSurface: options.publicSurface,
            },
            location,
          );
        continue;
      }
      options.shellPlacements?.set(alias, { depth: options.depth, release });
      if (
        options.allowedCategories !== undefined &&
        !options.allowedCategories.has(release.paletteGroup)
      )
        report("vortex.definition.application_block_references", "unsupported_choice", location);
      if (options.publicSurface && release.capabilities.publicSurface !== "allowed")
        report("vortex.definition.application_public_surface", "unsafe_content", location);

      validateSettings(placement.settings, release.properties, location);
      validateDataContract(placement, placement.settings, location);
      validateAccessibleName(placement.settings, release, location);
      validateResponsive(placement, release, location);

      const declaredSlots = new Map(
        release.slots.map((declaration) => [declaration.key, declaration]),
      );
      if (Object.keys(placement.slots).some((key) => !declaredSlots.has(key)))
        report("vortex.definition.application_block_references", "unknown_property", location);
      for (const declaration of release.slots) {
        const child = placement.slots[declaration.key];
        const reserved = options.reserved?.has(`${alias}:${declaration.key}`) === true;
        if (
          declaration.required &&
          !reserved &&
          (child === undefined || Object.keys(child.placements).length === 0)
        )
          report("vortex.definition.application_block_references", "required_value", location);
        if (child === undefined) continue;
        validateSlot(
          child,
          {
            scope: options.scope,
            depth: options.depth + 1,
            allowedCategories: new Set(declaration.allowedChildCategories),
            responsiveOrderAllowed: release.capabilities.responsiveOrder,
            publicSurface: options.publicSurface,
            ...(options.reserved === undefined ? {} : { reserved: options.reserved }),
            ...(options.shellPlacements === undefined
              ? {}
              : { shellPlacements: options.shellPlacements }),
          },
          location,
        );
      }
    }
  };

  const shells = new Map<
    string,
    Readonly<{ contentSlots: ReadonlyMap<string, ShellContentSlot>; publicSafe: boolean }>
  >();
  for (const shell of source.body.shells) {
    const shellPlacements = new Map<
      string,
      Readonly<{ depth: number; release: PlatformBlockReleaseV2 }>
    >();
    validateSlot(
      shell.layout,
      {
        scope: [],
        depth: 1,
        allowedCategories: new Set(["layout"]),
        responsiveOrderAllowed: true,
        publicSurface: false,
        reserved: new Set(
          shell.content_slots.map((slot) => `${slot.parent_placement}:${slot.parent_slot}`),
        ),
        shellPlacements,
      },
      [],
    );
    const contentSlots = new Map<string, ShellContentSlot>();
    for (const slot of shell.content_slots) {
      const parent = shellPlacements.get(slot.parent_placement);
      // An unregistered parent block was already refused where it is placed.
      if (parent === undefined) continue;
      const declaration = parent.release.slots.find((entry) => entry.key === slot.parent_slot);
      if (
        declaration === undefined ||
        (declaration.required && !slot.required) ||
        slot.allowed_child_categories.some(
          (category) => !declaration.allowedChildCategories.includes(category),
        )
      )
        report(
          "vortex.definition.application_block_references",
          "broken_reference",
          keySegment("block", slot.parent_placement),
        );
      contentSlots.set(slot.id, {
        required: slot.required,
        allowed: new Set(slot.allowed_child_categories),
        depth: parent.depth + 1,
        responsiveOrderAllowed: parent.release.capabilities.responsiveOrder,
      });
    }
    shells.set(shell.id, {
      contentSlots,
      publicSafe: [...shellPlacements.values()].every(
        (placement) => placement.release.capabilities.publicSurface === "allowed",
      ),
    });
  }

  const validateShellContent = (
    shellAlias: string,
    content: Readonly<Record<string, SourceSlot>>,
    publicSurface: boolean,
    scope: readonly Segment[],
  ): void => {
    // The source contract already refuses an unresolved shell or undeclared content slot.
    const shell = shells.get(shellAlias);
    if (shell === undefined) return;
    if (publicSurface && !shell.publicSafe)
      report("vortex.definition.application_public_surface", "unsafe_content", scope);
    for (const [alias, slot] of Object.entries(content)) {
      const declaration = shell.contentSlots.get(alias);
      if (declaration === undefined) continue;
      validateSlot(
        slot,
        {
          scope,
          depth: declaration.depth,
          allowedCategories: declaration.allowed,
          responsiveOrderAllowed: declaration.responsiveOrderAllowed,
          publicSurface,
        },
        scope,
      );
    }
  };

  for (const page of source.body.pages) {
    pageRecordType = "record_type" in page ? page.record_type : undefined;
    const scope = keySegment("page", page.key);
    const publicSurface = page.type === "public";
    const pageSlot = (slot: SourceSlot) =>
      validateSlot(slot, { scope, depth: 1, responsiveOrderAllowed: true, publicSurface }, scope);
    if (page.type === "guided_form") {
      const composition = page.composition;
      for (const step of page.steps) {
        if (composition.shell_kind === "default") {
          const slot = composition.step_content[step.id];
          if (slot !== undefined) pageSlot(slot);
        } else {
          const content = composition.step_content[step.id];
          if (content !== undefined)
            validateShellContent(composition.shell, content, publicSurface, scope);
        }
      }
    } else if (page.composition.shell_kind === "default") pageSlot(page.composition.main);
    else
      validateShellContent(
        page.composition.shell,
        page.composition.content,
        publicSurface,
        scope,
      );
  }

  return failures;
}
