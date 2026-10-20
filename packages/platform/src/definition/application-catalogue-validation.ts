import {
  builderKeySchema,
  readRecordDetailContract,
  readRecordsTableContract,
  readQueryBindings,
  recordsTableContractRefusal,
  readSourceItem,
  sourceItemChildSlots,
  sourcePageDataOf,
  sourcePageRootSlots,
  type ApplicationSourceDocument,
  type BlockPropertySchemaContract,
  type DefinitionRuleFailure,
  type DefinitionValidationErrorCode,
  type DefinitionValidationLocation,
  type PlatformBlockRelease,
  type ComponentSettingFailure,
  type SourceBlockPropertyValueContract,
  type SourceItem,
  type SourceItemVortex,
  type SourcePageData,
  type SourceSlotOrder,
} from "../schema";
import { applicationModuleKeys } from "./application-module-sources";
import { IMMUTABLE_PLATFORM_BLOCK_CATALOGUE } from "./application-composition-catalogue";

/**
 * Located catalogue validation for authored Application documents.
 *
 * A hand-authored document and a Studio-produced document are the same Application source
 * contract, so this one rule judges both: at draft save through validateDefinitionSource and again
 * before publication compiles. It admits only the exact releases registered in the server-owned
 * immutable platform block catalogue; a renderer registration cannot add to that allowlist.
 */

type Segment = DefinitionValidationLocation["segments"][number];
type Body = ApplicationSourceDocument["body"];
type SourceZone = Readonly<{ items: readonly SourceItem[]; order: SourceSlotOrder | undefined }>;
type SourceLayout = SourceItemVortex["responsive"]["desktop"];
type SourceValue = SourceBlockPropertyValueContract;

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

const effectiveLayouts = (responsive: SourceItemVortex["responsive"]): SourceLayout[] => {
  const tablet = responsive.tablet ?? responsive.desktop;
  return [responsive.desktop, tablet, responsive.phone ?? tablet];
};

/** Exact registered releases keyed by permanent block identity and release version. */
const registeredReleasesOf = (
  additionalReleases: readonly PlatformBlockRelease[],
): ReadonlyMap<string, PlatformBlockRelease> =>
  new Map(
    [...IMMUTABLE_PLATFORM_BLOCK_CATALOGUE.releases, ...additionalReleases].map((release) => [
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
  shellPlacements?: Map<string, Readonly<{ depth: number; release: PlatformBlockRelease }>>;
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
  source: ApplicationSourceDocument,
  /**
   * Custom component releases the publishing path resolved for this application: its own and the
   * exact releases of the modules it binds. Draft save passes none, so only the platform catalogue
   * is available then; publication passes the resolved custom component releases so a release that
   * carries a custom component validates against its own catalogue.
   */
  customComponentReleases: readonly PlatformBlockRelease[] = [],
): DefinitionRuleFailure[] {
  const catalogue = IMMUTABLE_PLATFORM_BLOCK_CATALOGUE;
  const registeredReleases = registeredReleasesOf(customComponentReleases);
  const failures: DefinitionRuleFailure[] = [];
  const report = (
    ruleCode: CatalogueRuleCode,
    family: DefinitionRuleFailure["family"],
    segments: readonly Segment[] = [],
    code?: DefinitionValidationErrorCode,
  ): void => {
    const located: Segment[] = [{ kind: "application", key: source.key }, ...segments];
    failures.push({
      ruleCode,
      family,
      ...(code === undefined ? {} : { code }),
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
    const release = registeredReleases.get(`${dependency.block_id}:${dependency.release_version}`);
    if (release === undefined)
      report("vortex.definition.application_dependency_manifest", "broken_reference");
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
   * fields are selected by that query runs in the compiled application validation. Every refusal here names the placement and the setting that
   * carries the field.
   */
  const validateDataContract = (
    placement: SourceItemVortex,
    placementAlias: string,
    settings: Readonly<Record<string, SourceValue>>,
    location: readonly Segment[],
    blockKey: string,
  ): void => {
    const table = readRecordsTableContract(settings);
    const detail = table === undefined ? readRecordDetailContract(settings) : undefined;
    if (
      blockKey === "platform.display.record_detail" &&
      settings.detail_fields !== undefined &&
      detail === undefined
    ) {
      report("vortex.definition.application_block_settings", "required_value", [
        ...location,
        ...keySegment("setting", "heading_field"),
      ]);
      return;
    }
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
        if (seen.has(field))
          report("vortex.definition.application_block_settings", "duplicate_key", at(key));
        seen.add(field);
        if (!mapped(field))
          report("vortex.definition.application_block_settings", "broken_reference", at(key));
        else if (!allowed(field))
          report("vortex.definition.application_block_settings", unallowedFamily, at(key));
      }
    };
    const orders = (): boolean => true;

    if (table !== undefined) {
      checkFields(
        "columns",
        table.columns.map((column) => column.field),
        () => true,
        "invalid_value",
      );
      // A table always shows at least one column before a person chooses other columns.
      if (!table.columns.some((column) => column.visible))
        report("vortex.definition.application_block_settings", "required_value", at("columns"));
      // A page that mounts only its visible window (more than 100 rows) scrolls in its own area;
      // publication reports the refusal's own business sentence, not only the family.
      const refusal = recordsTableContractRefusal(table);
      if (refusal !== undefined)
        report(
          "vortex.definition.application_block_settings",
          "unsupported_choice",
          at(refusal === "definition_records_table_row_action_limit" ? "row_actions" : "viewport"),
          refusal,
        );
      // The default order is a sort a person could choose: each key is a declared sortable field.
      const sortable = new Set(table.sortableFields.map((field) => field.toLowerCase()));
      checkFields(
        "default_sort",
        table.defaultSort.map((key) => key.field),
        (field) => sortable.has(field.toLowerCase()),
        "unsupported_choice",
      );
      checkFields("sortable_fields", table.sortableFields, orders, "unsupported_choice");
      const features = table.features;
      if (features.columnFilters.enabled)
        checkFields("features", features.columnFilters.fields, orders, "unsupported_choice");
      // A feature that is off holds nothing but its switch, so it compiles to nothing.
      const featureGroups = settings.features;
      if (featureGroups?.kind === "group")
        for (const feature of Object.values(featureGroups.properties))
          if (
            feature.kind === "group" &&
            feature.properties.enabled?.kind === "boolean" &&
            !feature.properties.enabled.value &&
            Object.keys(feature.properties).some((key) => key !== "enabled")
          )
            report("vortex.definition.application_block_settings", "invalid_value", at("features"));
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
        if (!accepts)
          report("vortex.definition.application_block_settings", "invalid_value", at(key));
      };
      const behaviours = table.rowBehaviours;
      if (behaviours.rowClick !== undefined && !behaviours.rowClick.selectsRecord)
        checkRowBehaviour(
          "row_click",
          behaviours.rowClick.eventId,
          "row_clicked",
          "record_reference",
        );
      for (const action of behaviours.rowActions)
        checkRowBehaviour("row_actions", action.eventId, "row_action", "record_reference");
      const rowActionIds = new Set(behaviours.rowActions.map((action) => action.eventId));
      for (const binding of source.body.flow_bindings)
        if (
          binding.control === placementAlias &&
          binding.event === "row_action" &&
          !rowActionIds.has(binding.event_id)
        )
          report(
            "vortex.definition.application_block_references",
            "broken_reference",
            at("row_actions"),
          );
      // A bulk action runs a named action of the bound record type, never a flow binding, so no
      // flow binds the table's bulk action event.
      for (const binding of source.body.flow_bindings)
        if (binding.control === placementAlias && binding.event === "bulk_action")
          report("vortex.definition.application_block_settings", "invalid_value", at("features"));
      // An enabled inline-edit feature binds its commit to a flow; a feature that is off binds
      // nothing, and the compiler drops any flow binding left for it.
      // A draft may hold a feature that is not possible yet; publication refuses it with the
      // feature's own sentence (an inline edit without its commit binding, for one).
      if (features.inlineEdit.enabled) {
        if (features.inlineEdit.eventId !== undefined)
          checkRowBehaviour(
            "features",
            features.inlineEdit.eventId,
            "inline_edit",
            "record_reference",
          );
        // An editable field must be one the bound query selects and one of the declared columns;
        // a field that is never shown could never be edited in place.
        const columnFields = new Set(table.columns.map((column) => column.field));
        checkFields(
          "features",
          features.inlineEdit.fields,
          (field) => columnFields.has(field),
          "invalid_value",
        );
      }
      if (features.rowEdit.enabled) {
        if (features.rowEdit.eventId !== undefined)
          checkRowBehaviour("features", features.rowEdit.eventId, "row_edit", "record_reference");
        // An editable field must be one the bound query selects and one of the declared columns;
        // a field that is never shown could never be edited in place.
        const columnFields = new Set(table.columns.map((column) => column.field));
        checkFields(
          "features",
          features.rowEdit.fields,
          (field) => columnFields.has(field),
          "invalid_value",
        );
      }
    } else if (detail !== undefined) {
      checkFields(
        "detail_fields",
        detail.fields.map((entry) => entry.field),
        () => true,
        "invalid_value",
      );
      if (detail.headingField !== undefined)
        checkFields("heading_field", [detail.headingField], () => true, "invalid_value");
    }
  };

  /**
   * The structure of a block's query bindings: each item names an input once and carries its
   * source's part. The bound query lives in a Module release this source-only check cannot read, so
   * whether each input exists, is bound and gets a value of its type is the binding check that
   * Studio shows and publication runs on the compiled release.
   */
  const validateQueryBindingStructure = (
    settings: Readonly<Record<string, SourceValue>>,
    location: readonly Segment[],
  ): void => {
    if (settings.query_parameters === undefined) return;
    const at = [...location, ...keySegment("setting", "query_parameters")];
    const read = readQueryBindings(settings);
    if (read.kind === "malformed") {
      report("vortex.definition.application_block_settings", "required_value", at);
      return;
    }
    const inputs = new Set<string>();
    for (const binding of read.bindings) {
      if (inputs.has(binding.input))
        report("vortex.definition.application_block_settings", "duplicate_key", at);
      inputs.add(binding.input);
    }
  };

  const settingPathSegments = (path: readonly (string | number)[]): Segment[] =>
    path.flatMap((part) => (typeof part === "string" ? keySegment("setting", part) : []));

  const reportSettingFailures = (
    settingFailures: readonly ComponentSettingFailure[],
    location: readonly Segment[],
  ): void => {
    for (const failure of settingFailures)
      report("vortex.definition.application_block_settings", failure.family, [
        ...location,
        ...settingPathSegments(failure.path),
      ]);
  };

  /** A required accessible name must exist after defaults; a supplied name must be real text. */
  const validateAccessibleName = (
    settings: Readonly<Record<string, SourceValue>>,
    release: PlatformBlockRelease,
    location: readonly Segment[],
  ): void => {
    if (release.capabilities.accessibleName === "not_applicable") return;
    const path = release.capabilities.accessibleNamePropertyPath;
    let declarations: readonly BlockPropertySchemaContract[] = release.properties;
    let values: Readonly<Record<string, SourceValue>> = settings;
    let nameLocation = location;
    let name: SourceValue | BlockPropertySchemaContract["defaultValue"] = undefined;
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
    placement: SourceItemVortex,
    release: PlatformBlockRelease,
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
    zone: SourceZone,
    options: SlotOptions,
    parent: readonly Segment[],
  ): void => {
    if (!options.responsiveOrderAllowed) {
      const desktop = zone.items.map((item) => item.props.id);
      const tablet = (zone.order?.tablet ?? desktop).join("\0");
      const phone = (zone.order?.phone ?? zone.order?.tablet ?? desktop).join("\0");
      if (tablet !== desktop.join("\0") || phone !== desktop.join("\0"))
        report("vortex.definition.application_layout_complete", "invalid_value", parent);
    }
    for (const item of zone.items) {
      const alias = item.props.id;
      const placement = item.props.vortex;
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
        for (const [slotKey, children] of sourceItemChildSlots(item))
          validateSlot(
            { items: children, order: placement.slot_orders?.[slotKey] },
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
      if (item.type !== release.rendererKey)
        report("vortex.definition.application_block_references", "invalid_value", location);
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
            : !applicationModuleKeys(source).includes(customOwner.definitionKey)
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

      const reading = readSourceItem(item, release);
      reportSettingFailures(reading.settingFailures, location);
      validateDataContract(placement, alias, reading.settings, location, release.key);
      validateQueryBindingStructure(reading.settings, location);
      validateAccessibleName(reading.settings, release, location);
      validateResponsive(placement, release, location);

      for (const failure of reading.repeatableFailures)
        report("vortex.definition.application_block_settings", failure.family, [
          ...location,
          ...keySegment("setting", failure.declaration.repeats?.items ?? ""),
        ]);
      if (reading.unknownKeys.length > 0)
        report("vortex.definition.application_block_references", "unknown_property", location);
      if (reading.malformedSlots.length > 0)
        report("vortex.definition.application_block_references", "invalid_value", location);
      if (
        Object.keys(placement.slot_orders ?? {}).some(
          (slotKey) => reading.slots.get(slotKey)?.items === undefined,
        )
      )
        report("vortex.definition.application_layout_complete", "invalid_value", location);
      for (const [slotKey, { declaration, items }] of reading.slots) {
        const reserved = options.reserved?.has(`${alias}:${slotKey}`) === true;
        if (
          declaration.repeats === undefined &&
          declaration.required &&
          !reserved &&
          (items === undefined || items.length === 0)
        )
          report("vortex.definition.application_block_references", "required_value", location);
        if (items === undefined) continue;
        validateSlot(
          { items, order: placement.slot_orders?.[slotKey] },
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
      Readonly<{ depth: number; release: PlatformBlockRelease }>
    >();
    validateSlot(
      { items: shell.layout.content, order: shell.layout.root.props.vortex.slot_orders.content },
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
    data: SourcePageData,
    publicSurface: boolean,
    scope: readonly Segment[],
  ): void => {
    // The source contract already refuses an unresolved shell or undeclared content slot.
    const shell = shells.get(shellAlias);
    if (shell === undefined) return;
    if (publicSurface && !shell.publicSafe)
      report("vortex.definition.application_public_surface", "unsafe_content", scope);
    for (const [alias, items] of sourcePageRootSlots(data)) {
      const declaration = shell.contentSlots.get(alias);
      if (declaration === undefined) continue;
      validateSlot(
        { items, order: data.root.props.vortex.slot_orders[alias] },
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
    for (const data of sourcePageDataOf(page.composition)) {
      const shellAlias = data.root.props.vortex.shell;
      if (shellAlias === null)
        validateSlot(
          { items: data.content, order: data.root.props.vortex.slot_orders.content },
          { scope, depth: 1, pageLevel: true, responsiveOrderAllowed: true, publicSurface },
          scope,
        );
      else validateShellContent(shellAlias, data, publicSurface, scope);
    }
  }

  return failures;
}
