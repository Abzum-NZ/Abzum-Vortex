/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import {
  applicationSourceDocumentV1Schema,
  applicationSourceDocumentV2Schema,
  confirmApplicationDraftV2ConversionCommandSchema,
  prepareApplicationDraftV2ConversionCommandSchema,
  platformIdSchema,
  richTextDocumentV2Schema,
  sourcePlacementEntriesV2,
  type ApplicationSourceDocument,
  type ApplicationSourceDocumentV2,
  type ConfirmApplicationDraftV2ConversionCommand,
  type PlatformBlockReleaseV2,
  type PlatformThemeReleaseV2,
  type PrepareApplicationDraftV2ConversionCommand,
  type PreparedApplicationDraftV2Conversion,
  type SourceBlockPropertyValueV2Contract,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";
import { fingerprintCanonicalValue } from "./canonical-json";
import { createDefinitionStore } from "./definition-store";
import type {
  DefinitionPublicationCatalogue,
  DefinitionPublicationReader,
} from "./definition-publication";

export class ApplicationDraftConversionError extends Error {
  constructor(
    readonly code:
      "INVALID_CONVERSION_COMMAND" | "CONVERSION_REFUSED" | "CONVERSION_PREVIEW_CHANGED",
    readonly reason?:
      | "missing_mapping"
      | "duplicate_mapping"
      | "incompatible_property"
      | "incomplete_custom_shell"
      | "missing_catalogue_release"
      | "theme_mapping"
      | "stale_or_not_v1",
  ) {
    super(reason ? `${code}:${reason}` : code);
  }
}

type Selection = PrepareApplicationDraftV2ConversionCommand;
type Resolved = {
  blocks: Map<string, PlatformBlockReleaseV2>;
  listBlocks: Map<string, PlatformBlockReleaseV2>;
  shellBlocks: Map<string, PlatformBlockReleaseV2>;
  theme: PlatformThemeReleaseV2;
};
const refuse = (
  reason: ConstructorParameters<
    typeof ApplicationDraftConversionError
  >[1] = "incompatible_property",
): never => {
  throw new ApplicationDraftConversionError("CONVERSION_REFUSED", reason);
};
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const richTextKinds = (value: any): Set<string> => {
  const kinds = new Set<string>();
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (typeof node.kind === "string" && node.kind !== "text") kinds.add(node.kind);
    for (const child of Object.values(node)) if (Array.isArray(child)) child.flat().forEach(visit);
  };
  visit(value);
  return kinds;
};

const convertValue = (
  value: any,
  property: any,
  theme: PlatformThemeReleaseV2,
): SourceBlockPropertyValueV2Contract => {
  if (value.kind !== "literal") {
    const compatible: Record<string, string> = {
      field_reference: "field_reference",
      relationship_reference: "relationship_reference",
      action_reference: "action_reference",
      page_reference: "page_reference",
      query_reference: "query_reference",
      pipeline_reference: "pipeline_reference",
      record_type_reference: "record_type_reference",
      record_reference: "record_reference",
    };
    if (compatible[value.kind] !== property.kind) return refuse();
    return value;
  }
  const raw = value.value;
  switch (property.kind) {
    case "text":
      return typeof raw === "string" &&
        raw.length >= property.minLength &&
        raw.length <= property.maxLength
        ? { kind: "text", value: raw }
        : refuse();
    case "choice":
      return typeof raw === "string" && property.options.some((option: any) => option.key === raw)
        ? { kind: "choice", value: raw }
        : refuse();
    case "url":
      return typeof raw === "string" ? { kind: "url", value: raw } : refuse();
    case "icon":
      return typeof raw === "string" ? { kind: "icon", icon_key: raw } : refuse();
    case "asset_reference":
      return platformIdSchema.safeParse(raw).success
        ? ({ kind: "asset_reference", asset_id: raw } as SourceBlockPropertyValueV2Contract)
        : refuse();
    case "theme_token":
      return typeof raw === "string" && theme.tokens[raw]?.kind === property.tokenKind
        ? { kind: "theme_token", token: raw }
        : refuse();
    case "number":
      return typeof raw === "number" &&
        Number.isFinite(raw) &&
        (!property.integer || Number.isInteger(raw)) &&
        (property.minimum === undefined || raw >= property.minimum) &&
        (property.maximum === undefined || raw <= property.maximum)
        ? { kind: "number", value: raw }
        : refuse();
    case "boolean":
      return typeof raw === "boolean" ? { kind: "boolean", value: raw } : refuse();
    case "rich_text":
      if (!richTextDocumentV2Schema.safeParse(raw).success) return refuse();
      if ([...richTextKinds(raw)].some((kind) => !property.allowedElements.includes(kind)))
        return refuse();
      return { kind: "rich_text", value: raw } as SourceBlockPropertyValueV2Contract;
    case "group": {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return refuse();
      const properties = Object.fromEntries(
        property.properties.flatMap((child: any) =>
          child.key in raw
            ? [[child.key, convertValue({ kind: "literal", value: raw[child.key] }, child, theme)]]
            : child.required && child.defaultValue === undefined
              ? refuse()
              : [],
        ),
      );
      if (
        Object.keys(raw).some((key) => !property.properties.some((child: any) => child.key === key))
      )
        return refuse();
      return { kind: "group", properties };
    }
    case "list":
      return Array.isArray(raw) &&
        raw.length >= property.minimumItems &&
        raw.length <= property.maximumItems
        ? {
            kind: "list",
            items: raw.map((item) =>
              convertValue({ kind: "literal", value: item }, property.item, theme),
            ),
          }
        : refuse();
    default:
      return refuse();
  }
};

const mappedSettings = (
  settings: Record<string, any>,
  mappings: Selection["blockMappings"][number]["propertyMappings"],
  release: PlatformBlockReleaseV2,
  theme: PlatformThemeReleaseV2,
) => {
  if (
    !unique(mappings.map((x) => x.sourceSettingKey)) ||
    !unique(mappings.map((x) => x.targetPropertyKey))
  )
    refuse("duplicate_mapping");
  if (Object.keys(settings).some((key) => !mappings.some((x) => x.sourceSettingKey === key)))
    refuse("missing_mapping");
  const result: Record<string, SourceBlockPropertyValueV2Contract> = {};
  for (const mapping of mappings) {
    const source = settings[mapping.sourceSettingKey];
    const property = release.properties.find((x) => x.key === mapping.targetPropertyKey);
    if (source === undefined || !property) refuse();
    result[mapping.targetPropertyKey] = convertValue(source, property, theme);
  }
  for (const property of release.properties)
    if (
      property.required &&
      result[property.key] === undefined &&
      property.defaultValue === undefined
    )
      refuse();
  if (release.slots.some((slot) => slot.required)) refuse();
  if (release.capabilities.accessibleName !== "not_applicable") {
    let values: any = result;
    let declarations: any[] = release.properties;
    for (const [index, key] of release.capabilities.accessibleNamePropertyPath.entries()) {
      const declaration = declarations.find((candidate) => candidate.key === key);
      const value = values[key] ?? declaration?.defaultValue;
      if (!declaration) refuse();
      if (value === undefined) {
        if (release.capabilities.accessibleName === "required") refuse();
        break;
      }
      if (index === release.capabilities.accessibleNamePropertyPath.length - 1) {
        if (value.kind !== "text" || typeof value.value !== "string" || value.value.trim() === "")
          refuse();
      } else {
        if (value.kind !== "group") refuse();
        values = value.properties;
        declarations = declaration.properties;
      }
    }
  }
  return result;
};

const placement = (
  input: any,
  mapping: Selection["blockMappings"][number],
  release: PlatformBlockReleaseV2,
  theme: PlatformThemeReleaseV2,
) => {
  if (
    !release.capabilities.gridWidth ||
    release.capabilities.height === "content" ||
    (input.phone.behaviour === "hide" && !release.capabilities.responsiveVisibility)
  )
    refuse();
  return {
    block: { block_id: release.blockId, release_version: release.releaseVersion },
    ...(input.view_permission === undefined ? {} : { view_permission: input.view_permission }),
    ...(input.use_permission === undefined ? {} : { use_permission: input.use_permission }),
    ...(input.visibility_condition === undefined
      ? {}
      : { visibility_condition: input.visibility_condition }),
    ...(input.query === undefined ? {} : { query: input.query }),
    settings: mappedSettings(input.settings, mapping.propertyMappings, release, theme),
    theme_overrides: {},
    responsive: {
      desktop: {
        visible: true,
        width: { kind: "grid", start_column: input.desktop.start_column, span: input.desktop.span },
        height: { kind: "bounded", units: input.desktop.height },
      },
      phone: {
        visible: input.phone.behaviour !== "hide",
        width: { kind: input.phone.behaviour === "full_width" ? "fill" : "content" },
        height: { kind: "bounded", units: input.desktop.height },
      },
    },
    slots: {},
  };
};

const slotFor = (blocks: any[], page: any, selection: Selection, resolved: Resolved) => {
  const placements = Object.fromEntries(
    blocks.map((block) => {
      const mapping = selection.blockMappings.find((x) => x.legacyRegistrationId === block.block);
      const release = mapping && resolved.blocks.get(mapping.legacyRegistrationId);
      if (!mapping || !release || block.block_release_version === undefined) return refuse();
      if (page.type === "public" && release.capabilities.publicSurface !== "allowed")
        return refuse();
      return [block.id, placement(block, mapping, release, resolved.theme)];
    }),
  );
  const ids = new Set(blocks.map((x) => x.id));
  const order = (kind: "desktop" | "phone") =>
    page.layout[kind].component_order.filter((id: string) => ids.has(id));
  if (order("desktop").length !== blocks.length || order("phone").length !== blocks.length)
    refuse("missing_mapping");
  return { placements, order: { desktop: order("desktop"), phone: order("phone") } };
};

export const convertApplicationSourceV1ToV2 = (
  sourceInput: ApplicationSourceDocument,
  selection: Selection,
  resolved: Resolved,
): ApplicationSourceDocumentV2 => {
  const source = applicationSourceDocumentV1Schema.parse(sourceInput);
  const { pages, block_registrations: _registrations, theme: legacyTheme, ...shared } = source.body;
  if (
    !unique(selection.blockMappings.map((x) => x.legacyRegistrationId)) ||
    !unique(selection.listPageMappings.map((x) => x.pageId))
  )
    refuse("duplicate_mapping");
  const registrations = new Set(source.body.block_registrations.map((entry) => entry.id));
  if (selection.blockMappings.some((mapping) => !registrations.has(mapping.legacyRegistrationId)))
    refuse("missing_mapping");
  const usedRegistrations = new Set(
    pages.flatMap((page: any) =>
      page.type === "list"
        ? []
        : page.type === "guided_form"
          ? page.steps.flatMap((step: any) => step.blocks.map((block: any) => block.block))
          : page.blocks.map((block: any) => block.block),
    ),
  );
  if (
    selection.blockMappings.length !== usedRegistrations.size ||
    selection.blockMappings.some(
      (mapping) => !usedRegistrations.has(mapping.legacyRegistrationId),
    ) ||
    selection.listPageMappings.length !== pages.filter((page) => page.type === "list").length
  )
    refuse("missing_mapping");
  let convertedPages = pages.map((page: any) => {
    const { layout: _layout, blocks: _blocks, steps: _steps, ...fields } = page;
    if (page.type === "list") {
      const mapping = selection.listPageMappings.find((x) => x.pageId === page.id);
      const release = mapping && resolved.listBlocks.get(mapping.pageId);
      if (!mapping || !release || release.slots.some((x) => x.required))
        return refuse("missing_mapping");
      if (page.type === "public" && release.capabilities.publicSurface !== "allowed")
        return refuse();
      const fake = {
        settings: { query: { kind: "query_reference", query: page.query } },
        desktop: { start_column: 1, span: 12, height: 1 },
        phone: { behaviour: "full_width" },
      };
      return {
        ...fields,
        composition: {
          shell_kind: "default",
          main: {
            placements: {
              [mapping.placementId]: placement(
                fake,
                { ...mapping, legacyRegistrationId: "" },
                release,
                resolved.theme,
              ),
            },
            order: { desktop: [mapping.placementId], phone: [mapping.placementId] },
          },
        },
      };
    }
    if (page.type === "guided_form")
      return {
        ...fields,
        steps: page.steps.map(({ blocks: _b, ...step }: any) => step),
        composition: {
          shell_kind: "default",
          step_content: Object.fromEntries(
            page.steps.map((step: any) => [
              step.id,
              slotFor(step.blocks, page, selection, resolved),
            ]),
          ),
        },
      };
    return {
      ...fields,
      composition: { shell_kind: "default", main: slotFor(page.blocks, page, selection, resolved) },
    };
  });
  const customSelections = selection.customShells ?? [];
  if (!unique(customSelections.map((entry) => entry.pageId))) refuse("duplicate_mapping");
  const shellsByAlias = new Map<string, (typeof customSelections)[number]["shell"]>();
  for (const selected of customSelections) {
    const existing = shellsByAlias.get(selected.shell.id);
    if (
      existing !== undefined &&
      fingerprintCanonicalValue(existing) !== fingerprintCanonicalValue(selected.shell)
    )
      refuse("duplicate_mapping");
    shellsByAlias.set(selected.shell.id, selected.shell);
  }
  const releasesById = new Map<string, PlatformBlockReleaseV2>();
  for (const release of [
    ...resolved.blocks.values(),
    ...resolved.listBlocks.values(),
    ...resolved.shellBlocks.values(),
  ]) {
    const existing = releasesById.get(String(release.blockId));
    if (existing && fingerprintCanonicalValue(existing) !== fingerprintCanonicalValue(release))
      refuse("duplicate_mapping");
    releasesById.set(String(release.blockId), release);
  }
  convertedPages = convertedPages.map((page: any) => {
    const selected = customSelections.find((entry) => entry.pageId === page.id);
    if (!selected) return page;
    if (
      page.type === "public" &&
      sourcePlacementEntriesV2(selected.shell.layout).some(([, placement]) => {
        const release = resolved.shellBlocks.get(
          `${placement.block.block_id}:${placement.block.release_version}`,
        );
        return release?.capabilities.publicSurface !== "allowed";
      })
    )
      refuse();
    const declared = new Map(selected.shell.content_slots.map((slot) => [slot.id, slot]));
    const distribute = (sourceSlot: any, bindings: Record<string, string>) => {
      const placementIds = Object.keys(sourceSlot.placements);
      if (
        !unique(Object.keys(bindings)) ||
        placementIds.some((id) => !bindings[id]) ||
        Object.keys(bindings).some((id) => !placementIds.includes(id)) ||
        Object.values(bindings).some((slot) => !declared.has(slot))
      )
        refuse("incomplete_custom_shell");
      const content: Record<string, unknown> = {};
      for (const slot of selected.shell.content_slots) {
        const ids = placementIds.filter((id) => bindings[id] === slot.id);
        if (slot.required && ids.length === 0) refuse("incomplete_custom_shell");
        if (
          ids.some((id) => {
            const blockId = String(sourceSlot.placements[id].block.block_id);
            const release = [
              ...resolved.blocks.values(),
              ...resolved.listBlocks.values(),
              ...resolved.shellBlocks.values(),
            ].find((candidate) => String(candidate.blockId) === blockId);
            return !release || !slot.allowed_child_categories.includes(release.paletteGroup);
          })
        )
          refuse("incomplete_custom_shell");
        if (ids.length)
          content[slot.id] = {
            placements: Object.fromEntries(ids.map((id) => [id, sourceSlot.placements[id]])),
            order: {
              desktop: sourceSlot.order.desktop.filter((id: string) => ids.includes(id)),
              phone: sourceSlot.order.phone.filter((id: string) => ids.includes(id)),
            },
          };
      }
      return content;
    };
    if (page.type === "guided_form") {
      if (
        !selected.stepContentSlots ||
        Object.keys(selected.stepContentSlots).length !== page.steps.length
      )
        refuse("incomplete_custom_shell");
      return {
        ...page,
        composition: {
          shell_kind: "application",
          shell: selected.shell.id,
          step_content: Object.fromEntries(
            page.steps.map((step: any) => [
              step.id,
              distribute(
                page.composition.step_content[step.id],
                selected.stepContentSlots![step.id] ?? refuse("incomplete_custom_shell"),
              ),
            ]),
          ),
        },
      };
    }
    if (selected.stepContentSlots) refuse("incomplete_custom_shell");
    return {
      ...page,
      composition: {
        shell_kind: "application",
        shell: selected.shell.id,
        content: distribute(page.composition.main, selected.contentSlots),
      },
    };
  });
  if (customSelections.some((entry) => !pages.some((page) => page.id === entry.pageId)))
    refuse("incomplete_custom_shell");
  if (legacyTheme.mode === "application" && !selection.theme.legacyThemeHandling)
    refuse("theme_mapping");
  if (
    legacyTheme.mode === "platform" &&
    (legacyTheme.catalogue_theme_id !== selection.theme.catalogueThemeId ||
      legacyTheme.version !== selection.theme.releaseVersion)
  )
    refuse("theme_mapping");
  for (const [key, override] of Object.entries(selection.theme.tokenOverrides)) {
    const base = resolved.theme.tokens[key];
    if (!base || base.kind !== override.kind) refuse("theme_mapping");
  }
  if (selection.theme.legacyThemeHandling)
    for (const handling of Object.values(selection.theme.legacyThemeHandling))
      if (
        handling.representedBy === "overrides" &&
        handling.targetTokens.some((key) => selection.theme.tokenOverrides[key] === undefined)
      )
        refuse("theme_mapping");
  const prepared = {
    source_contract_version: "2.0.0",
    root_alias: source.root_alias,
    key: source.key,
    kind: "application",
    body: {
      ...shared,
      platform_block_dependencies: [
        ...new Map(
          [...releasesById.values()].map((release) => [String(release.blockId), release]),
        ).values(),
      ]
        .sort((a, b) => String(a.blockId).localeCompare(String(b.blockId)))
        .map((release) => ({
          kind: "platform_block",
          block_id: release.blockId,
          release_version: release.releaseVersion,
          content_fingerprint: release.contentFingerprint,
          catalogue_fingerprint: release.catalogueFingerprint,
        })),
      shells: [...shellsByAlias.values()],
      pages: convertedPages,
      theme: {
        base: {
          kind: "platform_theme",
          catalogue_theme_id: resolved.theme.catalogueThemeId,
          release_version: resolved.theme.releaseVersion,
          content_fingerprint: resolved.theme.contentFingerprint,
          catalogue_fingerprint: resolved.theme.catalogueFingerprint,
        },
        token_overrides: selection.theme.tokenOverrides,
      },
    },
  };
  return applicationSourceDocumentV2Schema.parse(prepared);
};

type ConversionTransaction = RequestDatabaseTransaction & DefinitionPublicationReader;
const resolve = async (
  selection: Selection,
  catalogue: DefinitionPublicationCatalogue,
): Promise<Resolved> => {
  const blocks = new Map<string, PlatformBlockReleaseV2>();
  for (const mapping of selection.blockMappings) {
    const release = await catalogue.readPlatformBlockReleaseV2(
      mapping.platformBlockId,
      mapping.platformReleaseVersion,
    );
    if (
      !release ||
      release.blockId !== mapping.platformBlockId ||
      release.releaseVersion !== mapping.platformReleaseVersion
    )
      return refuse("missing_catalogue_release");
    blocks.set(mapping.legacyRegistrationId, release);
  }
  const listBlocks = new Map<string, PlatformBlockReleaseV2>();
  for (const mapping of selection.listPageMappings) {
    const release = await catalogue.readPlatformBlockReleaseV2(
      mapping.platformBlockId,
      mapping.platformReleaseVersion,
    );
    if (
      !release ||
      release.blockId !== mapping.platformBlockId ||
      release.releaseVersion !== mapping.platformReleaseVersion
    )
      return refuse("missing_catalogue_release");
    listBlocks.set(mapping.pageId, release);
  }
  const shellBlocks = new Map<string, PlatformBlockReleaseV2>();
  for (const selected of selection.customShells ?? [])
    for (const [, placement] of sourcePlacementEntriesV2(selected.shell.layout)) {
      const key = `${placement.block.block_id}:${placement.block.release_version}`;
      if (shellBlocks.has(key)) continue;
      const release = await catalogue.readPlatformBlockReleaseV2(
        placement.block.block_id,
        placement.block.release_version,
      );
      if (
        !release ||
        release.blockId !== placement.block.block_id ||
        release.releaseVersion !== placement.block.release_version
      )
        return refuse("missing_catalogue_release");
      shellBlocks.set(key, release);
    }
  const theme = await catalogue.readPlatformThemeReleaseV2(
    selection.theme.catalogueThemeId,
    selection.theme.releaseVersion,
  );
  if (
    !theme ||
    theme.catalogueThemeId !== selection.theme.catalogueThemeId ||
    theme.releaseVersion !== selection.theme.releaseVersion
  )
    return refuse("missing_catalogue_release");
  return { blocks, listBlocks, shellBlocks, theme };
};
const prepare = async (
  transaction: ConversionTransaction,
  command: Selection,
  catalogue: DefinitionPublicationCatalogue,
): Promise<PreparedApplicationDraftV2Conversion> => {
  const candidate = await transaction.readCandidate(command.rootId);
  if (
    !candidate ||
    candidate.draft.kind !== "application" ||
    String(candidate.draft.rootId) !== String(command.rootId) ||
    candidate.draft.draftRevision !== command.expectedDraftRevision ||
    candidate.draft.sourceContractVersion !== "1.0.0"
  )
    return refuse("stale_or_not_v1");
  if (fingerprintCanonicalValue(candidate.draft.source) !== candidate.draft.sourceFingerprint)
    return refuse("stale_or_not_v1");
  const resolved = await resolve(command, catalogue);
  const preparedSource = convertApplicationSourceV1ToV2(
    candidate.draft.source as ApplicationSourceDocument,
    command,
    resolved,
  );
  return {
    rootId: command.rootId,
    expectedDraftRevision: command.expectedDraftRevision,
    sourceFingerprint: candidate.draft.sourceFingerprint,
    preparedSource,
    preparedSourceFingerprint: fingerprintCanonicalValue(preparedSource),
    resolvedBlocks: [
      ...command.blockMappings.map((mapping) => {
        const release = resolved.blocks.get(mapping.legacyRegistrationId)!;
        return {
          legacyRegistrationId: mapping.legacyRegistrationId,
          blockId: release.blockId,
          releaseVersion: release.releaseVersion,
          contentFingerprint: release.contentFingerprint,
          catalogueFingerprint: release.catalogueFingerprint,
        };
      }),
      ...command.listPageMappings.map((mapping) => {
        const release = resolved.listBlocks.get(mapping.pageId)!;
        return {
          pageId: mapping.pageId,
          blockId: release.blockId,
          releaseVersion: release.releaseVersion,
          contentFingerprint: release.contentFingerprint,
          catalogueFingerprint: release.catalogueFingerprint,
        };
      }),
      ...[...resolved.shellBlocks.values()].map((release) => ({
        blockId: release.blockId,
        releaseVersion: release.releaseVersion,
        contentFingerprint: release.contentFingerprint,
        catalogueFingerprint: release.catalogueFingerprint,
      })),
    ],
    resolvedTheme: {
      catalogueThemeId: resolved.theme.catalogueThemeId,
      releaseVersion: resolved.theme.releaseVersion,
      contentFingerprint: resolved.theme.contentFingerprint,
      catalogueFingerprint: resolved.theme.catalogueFingerprint,
    },
    diagnostics: [],
  };
};
export const prepareApplicationDraftV2Conversion = async (
  transaction: ConversionTransaction,
  input: PrepareApplicationDraftV2ConversionCommand,
  catalogue: DefinitionPublicationCatalogue,
) => {
  const parsed = prepareApplicationDraftV2ConversionCommandSchema.safeParse(input);
  if (!parsed.success) throw new ApplicationDraftConversionError("INVALID_CONVERSION_COMMAND");
  return prepare(transaction, parsed.data, catalogue);
};
export const confirmApplicationDraftV2Conversion = async (
  transaction: ConversionTransaction,
  input: ConfirmApplicationDraftV2ConversionCommand,
  catalogue: DefinitionPublicationCatalogue,
) => {
  const parsed = confirmApplicationDraftV2ConversionCommandSchema.safeParse(input);
  if (!parsed.success) throw new ApplicationDraftConversionError("INVALID_CONVERSION_COMMAND");
  const preview = await prepare(transaction, parsed.data, catalogue);
  if (preview.preparedSourceFingerprint !== parsed.data.preparedSourceFingerprint)
    throw new ApplicationDraftConversionError("CONVERSION_PREVIEW_CHANGED");
  return createDefinitionStore(transaction).saveDraft({
    rootId: parsed.data.rootId,
    expectedDraftRevision: parsed.data.expectedDraftRevision,
    source: preview.preparedSource,
  });
};
