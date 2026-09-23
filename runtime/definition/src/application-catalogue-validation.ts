import {
  IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
  builderKeySchema,
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
type RichTextDocument = Extract<SourceValue, { kind: "rich_text" }>["value"];
type RichTextInline = Extract<
  RichTextDocument["blocks"][number],
  { kind: "paragraph" }
>["children"][number];

export const applicationCatalogueRuleCodes = [
  "vortex.definition.application_dependency_manifest",
  "vortex.definition.application_block_references",
  "vortex.definition.application_block_settings",
  "vortex.definition.application_public_surface",
  "vortex.definition.application_layout_complete",
] as const;

type CatalogueRuleCode = (typeof applicationCatalogueRuleCodes)[number];

const maximumLocationSegments = 12;

/**
 * Undeclared setting names that would carry markup, script, styling, data access or component
 * code. Any undeclared setting is refused; these are refused as unsafe content rather than as a
 * merely unknown property.
 */
const executableSettingKeys: ReadonlySet<string> = new Set([
  "class",
  "class_name",
  "classes",
  "code",
  "component",
  "component_code",
  "css",
  "dangerously_set_inner_html",
  "handler",
  "html",
  "inner_html",
  "jsx",
  "markup",
  "raw_html",
  "rpc",
  "script",
  "source_code",
  "sql",
  "style",
  "styles",
  "tsx",
]);

const executableSettingKey = (key: string): boolean =>
  executableSettingKeys.has(key) || /^on_[a-z]/.test(key);

/**
 * Syntax that marks authored text as markup, script, styling or a data-access statement rather
 * than prose. Each pattern needs structural syntax, so ordinary sentences such as "Select a
 * department from the list" or "Delete from list" remain valid text.
 */
const unsafeTextPatterns: readonly RegExp[] = Object.freeze([
  // Raw HTML, XML or JSX: an element, closing tag, comment or declaration opener.
  /<[/!?]?[a-z]/i,
  /&(?:lt|#0*60|#x0*3c);\s*[/!?]?[a-z]/i,
  // Script-bearing addresses and inline handlers.
  /\b(?:javascript|vbscript|livescript)\s*:/i,
  /\bdata\s*:\s*(?:text\/html|[a-z]+\/[a-z.+-]*script)/i,
  /\bon[a-z]+\s*=\s*["'`{]/i,
  // Script execution and JSX escape hatches.
  /\b(?:eval|setTimeout|setInterval)\(/,
  /\bnew Function\(/,
  /\b(?:document|window)\.(?:cookie|write|writeln|location|open|eval)\b/,
  /\([\w\s,]*\)\s*=>\s*\{/,
  /\bdangerouslySetInnerHTML\b/i,
  // Arbitrary CSS and class names.
  /\b(?:style|class|className)\s*=\s*["'{]/i,
  /@(?:import\s+(?:url\s*\(|["'])|media\s*(?:\(|screen\b|print\b)|font-face\s*\{|keyframes\s+[\w-]+\s*\{)/i,
  /:\s*expression\s*\(/i,
  /\{\s*[a-z-]+\s*:\s*[^;{}]+;/i,
  // SQL statements.
  /\bunion\s+(?:all\s+)?select\b/i,
  /'\s*(?:or|and)\s+(?:'[^']*'|\d+)\s*=\s*(?:'[^']*'|\d+)/i,
  /\bselect\s+(?:\*|[\w."]+(?:\s*,\s*[\w."]+)+)\s+from\s+[\w."]+/i,
  /\binsert\s+into\s+[\w."]+\s*(?:\([\w\s,."]+\)\s*)?(?:values\s*\(|select\b)/i,
  /\bupdate\s+[\w."]+\s+set\s+[\w."]+\s*=/i,
  /\bdelete\s+from\s+[\w."]+\s*(?:;|where\s+[\w."]+\s*(?:[=<>!]|\b(?:in|is|like)\b))/i,
  /\b(?:drop|truncate)\s+table\s+(?:if\s+exists\s+)?[\w."]+\s*(?:;|--|\bcascade\b|\brestrict\b)/i,
  /\balter\s+table\s+[\w."]+\s+(?:add|drop|alter|rename|enable|disable|owner)\b/i,
  /\bcreate\s+(?:or\s+replace\s+)?(?:table\s+[\w."]+\s*\(\s*[\w"]+\s+[\w"]+|(?:function|procedure)\s+[\w."]+\s*\([^)]*\)\s*(?:returns|language|as)\b|view\s+[\w."]+\s+as\s+select\b)/i,
  /\bexec(?:ute)?\s+(?:procedure\s+[\w."]+|immediate\s+["'])/i,
  /\bpg_(?:sleep|read_file|ls_dir|read_binary_file)\s*\(/i,
  // Remote procedure calls outside the governed operation model.
  /\/rpc\//i,
  /\.\s*rpc\s*\(/i,
  /\bjson-?rpc\b/i,
  /\bgrpcs?:\/\//i,
]);

const unsafeText = (text: string): boolean =>
  unsafeTextPatterns.some((pattern) => pattern.test(text));

const keySegment = (kind: Segment["kind"], key: string): Segment[] =>
  builderKeySchema.safeParse(key).success ? [{ kind, key }] : [];

const effectiveLayouts = (responsive: SourcePlacement["responsive"]): SourceLayout[] => {
  const tablet = responsive.tablet ?? responsive.desktop;
  return [responsive.desktop, tablet, responsive.phone ?? tablet];
};

const richTextViolations = (
  document: RichTextDocument,
): Readonly<{ kinds: ReadonlySet<string>; unsafe: boolean }> => {
  const kinds = new Set<string>();
  let unsafe = false;
  const visit = (inline: RichTextInline): void => {
    if (inline.kind === "text") {
      if (unsafeText(inline.text)) unsafe = true;
      return;
    }
    kinds.add(inline.kind);
    if (inline.kind === "link" && unsafeText(inline.address)) unsafe = true;
    for (const child of inline.children) visit(child);
  };
  for (const block of document.blocks) {
    kinds.add(block.kind);
    const children = "children" in block ? block.children : block.items.flat();
    for (const child of children) visit(child);
  }
  return { kinds, unsafe };
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

  const validateValue = (
    value: SourceValue,
    schema: BlockPropertySchemaV2Contract,
    location: readonly Segment[],
  ): void => {
    if (value.kind !== schema.kind) {
      report("vortex.definition.application_block_settings", "invalid_value", location);
      return;
    }
    if (value.kind === "text" && schema.kind === "text") {
      if (value.value.length < schema.minLength || value.value.length > schema.maxLength)
        report("vortex.definition.application_block_settings", "invalid_value", location);
      if (unsafeText(value.value))
        report("vortex.definition.application_block_settings", "unsafe_content", location);
    } else if (value.kind === "number" && schema.kind === "number") {
      if (
        (schema.integer && !Number.isInteger(value.value)) ||
        (schema.minimum !== undefined && value.value < schema.minimum) ||
        (schema.maximum !== undefined && value.value > schema.maximum)
      )
        report("vortex.definition.application_block_settings", "invalid_value", location);
    } else if (value.kind === "choice" && schema.kind === "choice") {
      if (!schema.options.some((option) => option.key === value.value))
        report("vortex.definition.application_block_settings", "unsupported_choice", location);
    } else if (value.kind === "rich_text" && schema.kind === "rich_text") {
      const allowed = new Set<string>(schema.allowedElements);
      const used = richTextViolations(value.value);
      if ([...used.kinds].some((kind) => !allowed.has(kind)))
        report("vortex.definition.application_block_settings", "unsupported_choice", location);
      if (used.unsafe)
        report("vortex.definition.application_block_settings", "unsafe_content", location);
    } else if (value.kind === "url") {
      if (unsafeText(value.value))
        report("vortex.definition.application_block_settings", "unsafe_content", location);
    } else if (value.kind === "group" && schema.kind === "group") {
      validateSettings(value.properties, schema.properties, location);
    } else if (value.kind === "list" && schema.kind === "list") {
      if (value.items.length < schema.minimumItems)
        report("vortex.definition.application_block_settings", "too_few_items", location);
      if (value.items.length > schema.maximumItems)
        report("vortex.definition.application_block_settings", "too_many_items", location);
      for (const item of value.items) validateValue(item, schema.item, location);
    }
  };

  const validateSettings = (
    authored: Readonly<Record<string, SourceValue>>,
    declarations: readonly BlockPropertySchemaV2Contract[],
    location: readonly Segment[],
  ): void => {
    const byKey = new Map(declarations.map((declaration) => [declaration.key, declaration]));
    for (const key of Object.keys(authored))
      if (!byKey.has(key))
        report(
          "vortex.definition.application_block_settings",
          executableSettingKey(key) ? "unsafe_content" : "unknown_property",
          [...location, ...keySegment("setting", key)],
        );
    for (const declaration of declarations) {
      const settingLocation = [...location, ...keySegment("setting", declaration.key)];
      const value = authored[declaration.key];
      if (value !== undefined) validateValue(value, declaration, settingLocation);
      else if (declaration.required && declaration.defaultValue === undefined)
        report("vortex.definition.application_block_settings", "required_value", settingLocation);
    }
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
