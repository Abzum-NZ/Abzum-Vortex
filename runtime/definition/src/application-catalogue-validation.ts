import {
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
  builderKeySchema,
  readRecordDetailContract,
  readRecordsTableContract,
  isRepeatableSlotIdentityV2,
  repeatableSlotItemIdentitiesV2,
  repeatableSlotKeyV2,
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
const registeredReleasesOf = (
  additionalReleases: readonly PlatformBlockReleaseV2[],
): ReadonlyMap<string, PlatformBlockReleaseV2> =>
  new Map(
    [...IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2.releases, ...additionalReleases].map((release) => [
      `${release.blockId}:${release.releaseVersion}`,
      release,
    ]),
  );

type SlotOptions = Readonly<{
  scope: readonly Segment[];
  depth: number;
  /** True for a page's own content slots, the only place a custom component may be placed. */
  pageLevel?: boolean;
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
  /**
   * Custom component releases the publishing path resolved for this application: its own and the
   * exact releases of the modules it binds. Draft save passes none, so only the platform catalogue
   * is available then; publication passes the resolved custom component releases so a release that
   * carries a custom component validates against its own catalogue.
   */
  customComponentReleases: readonly PlatformBlockReleaseV2[] = [],
): DefinitionRuleFailure[] {
  const catalogue = IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2;
  const registeredReleases = registeredReleasesOf(customComponentReleases);
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
    manifest.set(`${dependency.block_id}@${dependency.release_version}`, dependency);
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

  // The data source of a Records table or Record detail is its placement's bound query. A
  // placement names a query a bound Module exposes; that query lives in the Module's own release,
  // so this source-only check cannot read its fields. The compiler resolves the reference against
  // the exact bound Module release and refuses an unknown one.
  let pageRecordType: string | undefined;

  // Flow bindings are matched by the placement alias and the event identity the setting declares,
  // exactly as the compiler keys them; a flow is resolved by either its alias or its key.
  const flowByReference = new Map<string, Body["flows"][number]>();
  for (const flow of source.body.flows) {
    flowByReference.set(flow.id, flow);
    flowByReference.set(flow.key, flow);
  }
  const flowBindingByControlEvent = new Map<string, Body["flow_bindings"][number]>();
  for (const binding of source.body.flow_bindings)
    flowBindingByControlEvent.set(`${binding.control}\u0000${binding.event_id}`, binding);

  /**
   * A Records table or Record detail may map only fields of its page's record type. Its bound
   * Module query lives in another document, so the check that mapped columns, sort and filter
   * fields are selected by that query, and that the default sort is its leading sort, runs in the
   * compiled application validation. Every refusal here names the placement and the setting that
   * carries the field.
   */
  const validateDataContract = (
    placement: SourcePlacement,
    placementAlias: string,
    settings: Readonly<Record<string, SourceValue>>,
    location: readonly Segment[],
  ): void => {
    const table = readRecordsTableContract(settings);
    const detail = table === undefined ? readRecordDetailContract(settings) : undefined;
    if (table === undefined && detail === undefined) return;
    const at = (key: string): Segment[] => [...location, ...keySegment("setting", key)];
    if (table !== undefined && placement.query === undefined)
      report("vortex.definition.application_block_references", "required_value", location);

    // With a bound Module query the mapped fields are the query's own record's, which this
    // source-only check cannot read and the Query engine enforces; without one they must belong
    // to the page's record type.
    const mapped = (field: string): boolean =>
      placement.query !== undefined ||
      (pageRecordType !== undefined && field.startsWith(`${pageRecordType}.`));

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
    const orders = (): boolean => true;

    if (table !== undefined) {
      checkFields("columns", table.columns.map((column) => column.field), () => true, "invalid_value");
      if (table.defaultSort !== undefined) {
        checkFields("default_sort", [table.defaultSort.field], orders, "unsupported_choice");
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

      /**
       * Every configured row behaviour must bind a flow: the placement and the behaviour's event
       * identity must resolve to exactly one flow binding of the expected kind, and the bound flow
       * must declare an input that accepts the context the surface supplies — the clicked row as a
       * record reference, or the selected set as a record-reference list. No behaviour may share an
       * event identity with another, because one control event can have only one flow binding.
       */
      const boundEventIds = new Map<string, string>();
      const checkRowBehaviour = (
        key: string,
        eventId: string,
        expectedEvent: string,
        requiredInputType: "record_reference" | "record_reference_list",
      ): void => {
        const previous = boundEventIds.get(eventId);
        if (previous !== undefined) {
          report("vortex.definition.application_block_settings", "duplicate_key", at(key));
          return;
        }
        boundEventIds.set(eventId, key);
        const binding = flowBindingByControlEvent.get(`${placementAlias}\u0000${eventId}`);
        if (binding === undefined) {
          report("vortex.definition.application_block_references", "broken_reference", at(key));
          return;
        }
        if (binding.event !== expectedEvent) {
          report("vortex.definition.application_block_settings", "invalid_value", at(key));
          return;
        }
        const flow = flowByReference.get(binding.flow);
        if (flow === undefined) {
          report("vortex.definition.application_block_references", "broken_reference", at(key));
          return;
        }
        const accepts = Object.values(flow.inputs).some(
          (input) => input.type === requiredInputType,
        );
        if (!accepts) report("vortex.definition.application_block_settings", "invalid_value", at(key));
      };
      const behaviours = table.rowBehaviours;
      if (behaviours.rowClick !== undefined)
        checkRowBehaviour("row_click", behaviours.rowClick.eventId, "row_clicked", "record_reference");
      for (const action of behaviours.rowActions)
        checkRowBehaviour("row_actions", action.eventId, "row_action", "record_reference");
      for (const action of behaviours.bulkActions)
        checkRowBehaviour("bulk_actions", action.eventId, "bulk_action", "record_reference_list");
      if (behaviours.inlineEdit !== undefined) {
        checkRowBehaviour("inline_edit", behaviours.inlineEdit.eventId, "inline_edit", "record_reference");
        // An editable field must be one the bound query selects and one of the declared columns;
        // a field that is never shown could never be edited in place.
        const columnFields = new Set(table.columns.map((column) => column.field));
        checkFields(
          "inline_edit",
          behaviours.inlineEdit.fields,
          (field) => columnFields.has(field),
          "invalid_value",
        );
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
      const dependency = manifest.get(
        `${placement.block.block_id}@${placement.block.release_version}`,
      );
      if (dependency === undefined)
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
      // A custom component is placeable only by its owning application or by an application that
      // binds the owning module (publication resolution also requires the exact owning module
      // release); an unrelated application is refused here even when the release is present in
      // the resolved catalogue. It is a page-level block, never placed in a shell or inside
      // another component.
      const customOwner = release.customComponent?.owner;
      if (customOwner !== undefined) {
        if (
          customOwner.kind === "application"
            ? customOwner.definitionKey !== source.key
            : !source.body.module_bindings.some(
                (binding) => binding.module === customOwner.definitionKey,
              )
        )
          report("vortex.definition.application_block_references", "scope_conflict", location);
        if (options.pageLevel !== true)
          report("vortex.definition.application_block_references", "unsupported_choice", location);
      }
      if (
        options.allowedCategories !== undefined &&
        !options.allowedCategories.has(release.paletteGroup)
      )
        report("vortex.definition.application_block_references", "unsupported_choice", location);
      if (options.publicSurface && release.capabilities.publicSurface !== "allowed")
        report("vortex.definition.application_public_surface", "unsafe_content", location);

      validateSettings(placement.settings, release.properties, location);
      validateDataContract(placement, alias, placement.settings, location);
      validateAccessibleName(placement.settings, release, location);
      validateResponsive(placement, release, location);

      // A repeatable declaration's own key names only its family, never a slot.
      const declaredSlots = new Set(
        release.slots
          .filter((declaration) => declaration.repeats === undefined)
          .map((declaration) => declaration.key),
      );
      const repeatableSlots = new Map<string, (typeof release.slots)[number]>();
      for (const declaration of release.slots) {
        if (declaration.repeats === undefined) continue;
        const identities = repeatableSlotItemIdentitiesV2(declaration, placement.settings);
        if (new Set(identities).size !== identities.length)
          report(
            "vortex.definition.application_block_settings",
            "duplicate_key",
            [...location, ...keySegment("setting", declaration.repeats.items)],
          );
        for (const identity of identities) {
          if (!isRepeatableSlotIdentityV2(declaration.key, identity))
            report(
              "vortex.definition.application_block_settings",
              "invalid_value",
              [...location, ...keySegment("setting", declaration.repeats.items)],
            );
          else repeatableSlots.set(repeatableSlotKeyV2(declaration.key, identity), declaration);
        }
      }
      if (
        Object.keys(placement.slots).some(
          (key) => !declaredSlots.has(key) && !repeatableSlots.has(key),
        )
      )
        report("vortex.definition.application_block_references", "unknown_property", location);
      const validateChild = (
        declaration: (typeof release.slots)[number],
        slotKey: string,
      ): void => {
        const child = placement.slots[slotKey];
        if (child === undefined) return;
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
      };
      for (const declaration of release.slots) {
        if (declaration.repeats !== undefined) continue;
        const child = placement.slots[declaration.key];
        const reserved = options.reserved?.has(`${alias}:${declaration.key}`) === true;
        if (
          declaration.required &&
          !reserved &&
          (child === undefined || Object.keys(child.placements).length === 0)
        )
          report("vortex.definition.application_block_references", "required_value", location);
        validateChild(declaration, declaration.key);
      }
      for (const [slotKey, declaration] of repeatableSlots) validateChild(declaration, slotKey);
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
          pageLevel: true,
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
      validateSlot(
        slot,
        { scope, depth: 1, pageLevel: true, responsiveOrderAllowed: true, publicSurface },
        scope,
      );
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
