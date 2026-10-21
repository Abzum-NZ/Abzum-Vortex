import { sameCompositionValue as sameValue, sourceNames } from "./composition-references";
import {
  type ImmutablePlatformBlockCatalogue,
  applicationSourceDocumentSchema,
  plainSourceSettingValue,
  sourcePageShell,
  typedSourceSettingValue,
  repeatableSlotItemIdentities,
  repeatableSlotKey,
  isRepeatableSlotIdentity,
  type ComponentSettingFailure,
  type ApplicationSourceDocument,
  type PlatformBlockRelease,
  type BlockPropertySchemaContract,
  type SourceBlockPropertyValueContract,
  type SourceItem,
} from "@vortex/platform/schema";
import { studioStarterSlots } from "./composition-starters";
import { studioPageAreaLabel } from "./application-page-layout";
import { createStudioDiscoveryAdapter } from "./discovery-adapter";
import {
  STUDIO_ROW_ACTION_EVENT_SETTING,
  studioOwnsSetting,
  studioPaletteChoices,
  studioQueryOffered,
  studioRowActionEventId,
} from "./contextual-palette";
import {
  adjustedSlotOrder,
  freshBlockName,
  StoredCompositionRefusal,
  syncStoredBlockDependencies,
  validateStoredApplicationOutlets,
} from "./stored-composition";
import type {
  StudioCompositionContext,
  StudioCompositionAddTarget,
  StudioCompositionAddTargetsModel,
  StudioCompositionOwner,
  StudioCompositionCommandResult,
} from "./application-composition-model";
import {
  type Region,
  type SlotStep,
  toolsFor,
  refuse,
  isObject,
  object,
  validContext,
  regions,
  releaseFor,
  itemSlots,
  closedPlain,
  parseDestination,
  parseOwner,
  sameDestination,
  workingCopy,
  zoneHandle,
  workingItem,
  commitWorking,
  plainSource,
  plainSettings,
} from "./application-composition-regions";

/** One place on a page or layout where a new block can go, as the palette and the add command know it. */
export type AddPlace = {
  target: StudioCompositionAddTarget;
  region: Region;
  steps: readonly SlotStep[];
  /** The outlet label when the slot holds page content: a layout never takes blocks there. */
  outlet?: string;
};

/** The area key of a layout's blocks among its places; a page's places use its slot address key. */
export const LAYOUT_AREA = "layout";

/**
 * Every place on one page or layout a new block can go: the top of each content area (a layout's
 * top level), and each fixed slot of every block in it, at any depth. Each place lists the one
 * release of every block the catalogue admits there. A public page, a guided form and a page an
 * experience shows are not offered: their surface rules are not checked here. A layout slot that
 * holds a page's content outlet is listed without choices: that slot holds page content.
 */
export const addPlaces = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  owner: StudioCompositionOwner,
): AddPlace[] | "invalid" | "unsupported" => {
  // Both owners are nonpublic and authenticated; the surface grants no authority.
  const discovery = createStudioDiscoveryAdapter({ catalogue, surface: { kind: "authenticated" } });
  type Area = {
    region: Region;
    area: string;
    label: string;
    admitted: () => ReturnType<typeof discovery.getPlacementChoices>;
  };
  const areas: Area[] = [];
  let outlets: ReadonlyMap<string, string> = new Map();
  if (owner.kind === "layout") {
    const shells = source.body.shells.filter((candidate) => candidate.id === owner.shellAlias);
    const shell = shells.length === 1 ? shells[0]! : undefined;
    if (shell === undefined) return "invalid";
    const region = regions(source).find((candidate) => candidate.shell === shell) ?? refuse();
    areas.push({
      region,
      area: LAYOUT_AREA,
      label: "Layout",
      admitted: () => discovery.getPlacementChoices({ kind: "shell_layout" }),
    });
    outlets = new Map(
      shell.content_slots.map((slot) => [
        `${slot.parent_placement}|${slot.parent_slot}`,
        slot.label,
      ]),
    );
  } else {
    const pages = source.body.pages.filter((page) => page.id === owner.pageAlias);
    const page = pages.length === 1 ? pages[0]! : undefined;
    if (page === undefined) return "invalid";
    if (
      page.type === "public" ||
      page.type === "guided_form" ||
      source.body.public_addresses.some((address) => address.page === page.id) ||
      source.body.experiences?.some((experience) => experience.page === page.key)
    )
      return "unsupported";
    const shellAlias = sourcePageShell(page.composition);
    const shell = source.body.shells.find((candidate) => candidate.id === shellAlias);
    const pageRegions = regions(source).filter(
      (region) => region.page === page && region.address !== undefined,
    );
    for (const region of pageRegions) {
      const address = region.address!;
      areas.push({
        region,
        area: address.key,
        label:
          pageRegions.length > 1
            ? `Page content: ${studioPageAreaLabel(source, page, address)}`
            : "Page content",
        admitted: () => {
          if (region.parent === undefined) return discovery.getPlacementChoices({ kind: "page" });
          const binding = shell?.content_slots.find((candidate) => candidate.id === address.slot);
          const declared =
            releaseFor(catalogue, region.parent)?.slots.find(
              (slot) => slot.key === binding?.parent_slot,
            )?.allowedChildCategories ?? [];
          return discovery.getPlacementChoices({
            kind: "shell_content",
            allowedChildCategories: (binding?.allowed_child_categories ?? []).filter((group) =>
              declared.includes(group),
            ),
          });
        },
      });
    }
  }
  const places: AddPlace[] = [];
  for (const { region, area, label, admitted } of areas) {
    places.push({
      region,
      steps: [],
      target: Object.freeze<StudioCompositionAddTarget>({
        id: `${area}|`,
        area,
        destination: { kind: "root" },
        label,
        depth: 0,
        choices: studioPaletteChoices(catalogue, admitted()),
      }),
    });
    const visit = (items: readonly SourceItem[], steps: readonly SlotStep[]): void => {
      for (const item of items) {
        const release = releaseFor(catalogue, item);
        if (release === undefined) continue;
        const slots = itemSlots(catalogue, item);
        for (const declaration of release.slots) {
          if (declaration.repeats !== undefined) continue;
          const parentAlias = item.props.id;
          const childSteps = [...steps, { parentAlias, slotKey: declaration.key }];
          const outlet = outlets.get(`${parentAlias}|${declaration.key}`);
          places.push({
            region,
            steps: childSteps,
            ...(outlet === undefined ? {} : { outlet }),
            target: Object.freeze<StudioCompositionAddTarget>({
              id: `${area}|${parentAlias}|${declaration.key}`,
              area,
              destination: { kind: "child", parentAlias, slotKey: declaration.key },
              label: `${release.name} ${parentAlias}: ${declaration.label}${outlet === undefined ? "" : ` (page content: ${outlet})`}`,
              depth: childSteps.length,
              choices:
                outlet === undefined
                  ? studioPaletteChoices(
                      catalogue,
                      discovery.getPlacementChoices({
                        kind: "slot",
                        parent: {
                          blockId: release.blockId,
                          releaseVersion: release.releaseVersion,
                        },
                        slotKey: declaration.key,
                      }),
                    )
                  : [],
            }),
          });
          const child = slots.get(declaration.key);
          if (child !== undefined) visit(child.items, childSteps);
        }
      }
    };
    visit(region.zone.items, []);
  }
  return places;
};

/** The places on one page or layout a new block can go, for the palette and its keyboard add. */
export const describeStudioCompositionAddTargets = (
  context: StudioCompositionContext,
  owner: StudioCompositionOwner,
): StudioCompositionAddTargetsModel => {
  try {
    plainSource(context.source);
    if (!validContext(context)) return { kind: "invalid" };
    const places = addPlaces(
      context.catalogue,
      applicationSourceDocumentSchema.parse(context.source),
      owner,
    );
    return typeof places === "string"
      ? { kind: places }
      : { kind: "available", targets: Object.freeze(places.map((place) => place.target)) };
  } catch (error) {
    console.error("[studio] the places for a new block could not be read", error);
    return { kind: "invalid" };
  }
};

export const groupsTaken = (target: StudioCompositionAddTarget): string => {
  const labels = [...new Set(target.choices.map((choice) => choice.groupLabel.toLowerCase()))];
  if (labels.length === 0) return "it takes no new blocks";
  const listed =
    labels.length === 1 ? labels[0]! : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)!}`;
  return `it takes ${listed} blocks`;
};

/**
 * A new block of one release: a fresh block name, the catalogue's defaults for every setting not
 * given, an empty list for every fixed slot and the default layout.
 */
export const newBlockItem = (
  catalogue: ImmutablePlatformBlockCatalogue,
  source: ApplicationSourceDocument,
  release: PlatformBlockRelease,
  settings: Readonly<Record<string, SourceBlockPropertyValueContract>>,
  query: string | null,
): { alias: string; item: SourceItem } => {
  const taken = sourceNames(source);
  const alias = freshBlockName(release.key.split(".").at(-1) ?? "block", taken);
  taken.add(alias);
  const item = {
    type: release.rendererKey,
    props: {
      id: alias,
      ...plainSettings(settings),
      // A block with one row action names that action's event from its own block name.
      ...(release.properties.some((property) => property.key === STUDIO_ROW_ACTION_EVENT_SETTING)
        ? { [STUDIO_ROW_ACTION_EVENT_SETTING]: studioRowActionEventId(alias) }
        : {}),
      ...Object.fromEntries(
        release.slots.filter((slot) => slot.repeats === undefined).map((slot) => [slot.key, []]),
      ),
      ...Object.fromEntries(
        release.slots.flatMap((slot) =>
          repeatableSlotItemIdentities(slot, settings)
            .filter((identity) => isRepeatableSlotIdentity(slot.key, identity))
            .map((identity) => [repeatableSlotKey(slot.key, identity), []]),
        ),
      ),
      ...studioStarterSlots(catalogue, release, taken),
      vortex: {
        block: { block_id: release.blockId, release_version: release.releaseVersion },
        ...(query === null ? {} : { query }),
        responsive: {
          desktop: { visible: true, width: { kind: "fill" }, height: { kind: "content" } },
        },
      },
    },
  } as unknown as SourceItem;
  return { alias, item };
};

/**
 * Adds one new block at one place on a page: a fresh block name, the settings Studio owns, the
 * catalogue's defaults for every setting the person does not give, an empty list for every fixed slot and the default
 * layout. The required settings the catalogue has no default for, and the query of a data block,
 * come with the command. The edited slot is judged as stored data, and a block release the source
 * does not depend on yet becomes a dependency.
 */
export const applyAdd = (
  current: StudioCompositionContext,
  command: unknown,
): StudioCompositionCommandResult => {
  const input = closedPlain(command, [
    "kind",
    "owner",
    "area",
    "destination",
    "index",
    "blockId",
    "releaseVersion",
    "settings",
    "query",
  ]);
  if (
    input.kind !== "add" ||
    typeof input.area !== "string" ||
    typeof input.blockId !== "string" ||
    typeof input.releaseVersion !== "string" ||
    typeof input.index !== "number" ||
    !Number.isSafeInteger(input.index) ||
    input.index < 0 ||
    (input.query !== null && typeof input.query !== "string")
  )
    return { kind: "invalid" };
  plainSource(current.source);
  if (!validContext(current)) return { kind: "invalid" };
  const catalogue = current.catalogue;
  const source = applicationSourceDocumentSchema.parse(current.source);
  const destination = parseDestination(input.destination);
  const places = addPlaces(catalogue, source, parseOwner(input.owner));
  if (typeof places === "string") return { kind: places };
  const place = places.find(
    (candidate) =>
      candidate.target.area === input.area &&
      sameDestination(candidate.target.destination, destination),
  );
  const release = toolsFor(catalogue).releases.get(`${input.blockId}:${input.releaseVersion}`);
  if (place === undefined)
    return { kind: "refused", reason: "This place does not take new blocks." };
  if (place.outlet !== undefined)
    return {
      kind: "refused",
      reason: `This slot holds the page content of the layout's "${place.outlet}" outlet, so it takes no blocks of the layout. Add the block to a page instead.`,
    };
  const choice = place.target.choices.find(
    (candidate) =>
      candidate.blockId === input.blockId && candidate.releaseVersion === input.releaseVersion,
  );
  if (release === undefined || choice === undefined)
    return {
      kind: "refused",
      reason: `${release?.name ?? "This block"} can't go into ${place.target.label}: ${groupsTaken(place.target)}.`,
    };
  if (choice.unavailable !== undefined)
    return { kind: "refused", reason: `${choice.name} can't be added yet. ${choice.unavailable}` };

  // The settings the person gave (the setup asks for each required one without a default), each
  // of its declared kind; every other setting takes its catalogue default.
  const settings = commandSettings(input.settings, release.properties);
  // Studio owns some settings and writes them itself, so a command never supplies them.
  if (Object.keys(settings).some(studioOwnsSetting)) return { kind: "invalid" };
  const query = input.query;
  if (
    choice.needsQuery !== (query !== null) ||
    (query !== null && !studioQueryOffered(source, current.borrowed, query))
  )
    return { kind: "invalid" };

  const { alias, item } = newBlockItem(catalogue, source, release, settings, query);
  try {
    const working = workingCopy(place.region);
    const last = place.steps.at(-1);
    if (last !== undefined) {
      // A fixed slot the stored block leaves out starts as an empty list.
      const parent = workingItem(working, place.steps.slice(0, -1), last.parentAlias);
      if (!Array.isArray(parent.props[last.slotKey])) parent.props[last.slotKey] = [];
    }
    const zone = zoneHandle(working, place.steps);
    const items = [...zone.items];
    items.splice(Math.min(input.index, items.length), 0, item);
    // Each declared tablet and phone order takes the new block at its desktop position.
    zone.set(
      items,
      adjustedSlotOrder(
        zone.order,
        items.map((entry) => entry.props.id),
      ),
    );
    commitWorking(catalogue, place.region, working);
    validateStoredApplicationOutlets(catalogue, source);
  } catch (error) {
    if (error instanceof StoredCompositionRefusal) {
      console.error("[studio] composition add refused", {
        part: error.location,
        reason: error.reason,
      });
      return {
        kind: "refused",
        reason: `${choice.name} can't go into ${place.target.label}. ${error.message}.`,
      };
    }
    throw error;
  }
  syncStoredBlockDependencies(source);
  return {
    kind: "applied",
    source: applicationSourceDocumentSchema.parse(source),
    placementAlias: alias,
  };
};

/**
 * The settings a command supplies, each a typed authored value of the declared kind of its key.
 * A value is accepted only when its plain stored form reads back as exactly that value.
 */
export const commandSettings = (
  value: unknown,
  properties: readonly BlockPropertySchemaContract[],
): Record<string, SourceBlockPropertyValueContract> => {
  plainSource(value);
  const raw = object(value);
  const result: Record<string, SourceBlockPropertyValueContract> = {};
  for (const key of Object.keys(raw)) {
    const declaration = properties.find((property) => property.key === key) ?? refuse();
    const supplied = raw[key];
    if (!isObject(supplied) || supplied.kind !== declaration.kind) return refuse();
    const failures: ComponentSettingFailure[] = [];
    const typed = typedSourceSettingValue(
      plainSourceSettingValue(supplied as SourceBlockPropertyValueContract),
      declaration,
      [key],
      failures,
    );
    if (typed === undefined || failures.length > 0 || !sameValue(typed, supplied)) return refuse();
    result[key] = typed;
  }
  return result;
};
