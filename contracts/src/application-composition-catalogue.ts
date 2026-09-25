import {
  type PlatformBlockReleaseV2,
  platformBlockReleaseV2Schema,
  type ImmutablePlatformBlockCatalogueV2,
  immutablePlatformBlockCatalogueV2Schema,
} from "./application-composition-v2";
import { generatedReleaseFingerprints } from "./catalogue/generated-fingerprints";
import sources from "./catalogue/application-composition-catalogue.source.json";

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
};

/**
 * The registered platform block releases: the one source of block metadata for server
 * validation and for the renderer registrations that pair each release with its component. Each
 * release's content lives in catalogue/application-composition-catalogue.source.json and is
 * parsed through the release contract at module load and deep-frozen. Its fingerprints are the
 * canonical-JSON SHA-256 values that `pnpm catalogue:fingerprints` derives from that same
 * content into catalogue/catalogue-fingerprints.generated.json; they are merged in by block id
 * and release version and never written by hand.
 */
const release = (definition: { blockId: string; releaseVersion: string }): PlatformBlockReleaseV2 =>
  deepFreeze(
    platformBlockReleaseV2Schema.parse({
      ...definition,
      ...generatedReleaseFingerprints(
        "platformBlocks",
        `${definition.blockId}:${definition.releaseVersion}`,
      ),
    }),
  );

/** Exact immutable metadata release for the plain text display block. */
export const TEXT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.TEXT_BLOCK_RELEASE);

/** Exact immutable metadata release for the structured rich text display block. */
export const RICH_TEXT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.RICH_TEXT_BLOCK_RELEASE);

/** Exact immutable metadata release for the list display block. */
export const LIST_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.LIST_BLOCK_RELEASE);

/** Exact immutable metadata release for the table display block. */
export const TABLE_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.TABLE_BLOCK_RELEASE);

/** Exact immutable metadata release for the record detail display block. */
export const RECORD_DETAIL_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.RECORD_DETAIL_BLOCK_RELEASE);

/** Exact immutable metadata release for the grouped data display block. */
export const GROUPED_DATA_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.GROUPED_DATA_BLOCK_RELEASE);

/** Exact immutable metadata release for the summary values display block. */
export const SUMMARY_VALUES_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.SUMMARY_VALUES_BLOCK_RELEASE);

/**
 * Release 1.1.0 of each display block adds an optional authored `empty_message` shown in place of
 * the block family's fixed neutral empty text. The 1.0.0 releases stay published unchanged, so an
 * application pinned to them keeps its exact published behaviour.
 */
export const TEXT_BLOCK_RELEASE_1_1_0: PlatformBlockReleaseV2 = release(
  sources.TEXT_BLOCK_RELEASE_1_1_0,
);

export const RICH_TEXT_BLOCK_RELEASE_1_1_0: PlatformBlockReleaseV2 = release(
  sources.RICH_TEXT_BLOCK_RELEASE_1_1_0,
);

export const LIST_BLOCK_RELEASE_1_1_0: PlatformBlockReleaseV2 = release(
  sources.LIST_BLOCK_RELEASE_1_1_0,
);

export const TABLE_BLOCK_RELEASE_1_1_0: PlatformBlockReleaseV2 = release(
  sources.TABLE_BLOCK_RELEASE_1_1_0,
);

export const RECORD_DETAIL_BLOCK_RELEASE_1_1_0: PlatformBlockReleaseV2 = release(
  sources.RECORD_DETAIL_BLOCK_RELEASE_1_1_0,
);

export const GROUPED_DATA_BLOCK_RELEASE_1_1_0: PlatformBlockReleaseV2 = release(
  sources.GROUPED_DATA_BLOCK_RELEASE_1_1_0,
);

export const SUMMARY_VALUES_BLOCK_RELEASE_1_1_0: PlatformBlockReleaseV2 = release(
  sources.SUMMARY_VALUES_BLOCK_RELEASE_1_1_0,
);

/**
 * Release 1.2.0 of the table and record detail blocks declares their data contract as settings
 * (decision 5): the Records table maps columns, sorting, filtering, search, saved views, page size,
 * selection, query parameters and its refused and error messages to fields of its bound query; the
 * record detail maps its detail fields. Earlier releases stay published unchanged.
 */
export const TABLE_BLOCK_RELEASE_1_2_0: PlatformBlockReleaseV2 = release(
  sources.TABLE_BLOCK_RELEASE_1_2_0,
);

export const RECORD_DETAIL_BLOCK_RELEASE_1_2_0: PlatformBlockReleaseV2 = release(
  sources.RECORD_DETAIL_BLOCK_RELEASE_1_2_0,
);

/** Exact immutable metadata release for the text input block. */
export const TEXT_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.TEXT_INPUT_BLOCK_RELEASE);

/** Exact immutable metadata release for the number input block. */
export const NUMBER_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.NUMBER_INPUT_BLOCK_RELEASE);

/** Exact immutable metadata release for the boolean input block. */
export const BOOLEAN_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.BOOLEAN_INPUT_BLOCK_RELEASE);

/** Exact immutable metadata release for the date input block. */
export const DATE_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.DATE_INPUT_BLOCK_RELEASE);

/** Exact immutable metadata release for the choice input block. */
export const CHOICE_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.CHOICE_INPUT_BLOCK_RELEASE);

/** Exact immutable metadata release for the validation message block. */
export const VALIDATION_MESSAGE_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.VALIDATION_MESSAGE_BLOCK_RELEASE);

/** Exact immutable metadata release for the button block. */
export const BUTTON_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.BUTTON_BLOCK_RELEASE);

/** Exact immutable metadata release for the tabs block. */
export const TABS_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.TABS_BLOCK_RELEASE);

/** Exact immutable metadata release for the dialog block. */
export const DIALOG_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.DIALOG_BLOCK_RELEASE);

/** Exact immutable metadata release for the drawer block. */
export const DRAWER_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.DRAWER_BLOCK_RELEASE);

/** Exact immutable metadata release for the general container block. */
export const CONTAINER_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.CONTAINER_BLOCK_RELEASE);

/** Exact immutable metadata release for the heading block. */
export const HEADING_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.HEADING_BLOCK_RELEASE);

/**
 * Exact immutable metadata release for the application navigation block. Its renderer draws the
 * viewer's permission-filtered projected menu; the release refuses the public surface because the
 * menu is per-person, so a public page never carries it.
 */
export const APPLICATION_NAVIGATION_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(
  sources.APPLICATION_NAVIGATION_BLOCK_RELEASE,
);

/** Exact immutable metadata release for the form container block. */
export const FORM_CONTAINER_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.FORM_CONTAINER_BLOCK_RELEASE);

/** Exact immutable metadata release for the link input block. */
export const LINK_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.LINK_INPUT_BLOCK_RELEASE);

/** Exact immutable metadata release for the structured rich text input block. */
export const RICH_TEXT_INPUT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.RICH_TEXT_INPUT_BLOCK_RELEASE);

/** Exact immutable metadata release for the application launcher block. */
export const APPLICATION_LAUNCHER_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.APPLICATION_LAUNCHER_BLOCK_RELEASE);

/** Exact immutable metadata release for the link tiles block. */
export const LINK_TILES_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.LINK_TILES_BLOCK_RELEASE);

/** Exact immutable metadata release for the view filter block. */
export const VIEW_FILTER_BLOCK_RELEASE: PlatformBlockReleaseV2 = release(sources.VIEW_FILTER_BLOCK_RELEASE);

/** All sixteen immutable display block releases: the seven 1.0.0 releases, their 1.1.0 successors and the two 1.2.0 data-contract releases. */
export const DISPLAY_BLOCK_RELEASES: readonly PlatformBlockReleaseV2[] = Object.freeze([
  TEXT_BLOCK_RELEASE,
  RICH_TEXT_BLOCK_RELEASE,
  LIST_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE,
  GROUPED_DATA_BLOCK_RELEASE,
  SUMMARY_VALUES_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE_1_1_0,
  RICH_TEXT_BLOCK_RELEASE_1_1_0,
  LIST_BLOCK_RELEASE_1_1_0,
  TABLE_BLOCK_RELEASE_1_1_0,
  RECORD_DETAIL_BLOCK_RELEASE_1_1_0,
  GROUPED_DATA_BLOCK_RELEASE_1_1_0,
  SUMMARY_VALUES_BLOCK_RELEASE_1_1_0,
  TABLE_BLOCK_RELEASE_1_2_0,
  RECORD_DETAIL_BLOCK_RELEASE_1_2_0,
]);

/** All thirteen immutable form, layout and action block releases. */
export const CONTROL_BLOCK_RELEASES: readonly PlatformBlockReleaseV2[] = Object.freeze([
  TEXT_INPUT_BLOCK_RELEASE,
  LINK_INPUT_BLOCK_RELEASE,
  RICH_TEXT_INPUT_BLOCK_RELEASE,
  NUMBER_INPUT_BLOCK_RELEASE,
  BOOLEAN_INPUT_BLOCK_RELEASE,
  DATE_INPUT_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  VALIDATION_MESSAGE_BLOCK_RELEASE,
  BUTTON_BLOCK_RELEASE,
  TABS_BLOCK_RELEASE,
  DIALOG_BLOCK_RELEASE,
  DRAWER_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
]);

/** All three immutable launcher, tile and view-filter block releases. */
export const LAUNCHER_BLOCK_RELEASES: readonly PlatformBlockReleaseV2[] = Object.freeze([
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  LINK_TILES_BLOCK_RELEASE,
  VIEW_FILTER_BLOCK_RELEASE,
]);

/** All two immutable general layout block releases. */
export const LAYOUT_BLOCK_RELEASES: readonly PlatformBlockReleaseV2[] = Object.freeze([
  CONTAINER_BLOCK_RELEASE,
  HEADING_BLOCK_RELEASE,
]);

/** The one immutable application navigation block release, placed in a shell's layout. */
export const NAVIGATION_BLOCK_RELEASES: readonly PlatformBlockReleaseV2[] = Object.freeze([
  APPLICATION_NAVIGATION_BLOCK_RELEASE,
]);

/** All thirty-five immutable platform block releases registered for the page builder. */
export const PLATFORM_BLOCK_RELEASES: readonly PlatformBlockReleaseV2[] = Object.freeze([
  ...DISPLAY_BLOCK_RELEASES,
  ...CONTROL_BLOCK_RELEASES,
  ...LAUNCHER_BLOCK_RELEASES,
  ...LAYOUT_BLOCK_RELEASES,
  ...NAVIGATION_BLOCK_RELEASES,
]);

/**
 * Closed immutable platform block catalogue for pure V2 composition validation and materialisation.
 * Server-owned; client-side renderer changes cannot alter or expand this allowlist.
 */
export const IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2: ImmutablePlatformBlockCatalogueV2 =
  deepFreeze(
    immutablePlatformBlockCatalogueV2Schema.parse({
      compositionPolicy: {
        maximumDepth: 32,
        maximumPlacements: 512,
      },
      releases: PLATFORM_BLOCK_RELEASES,
    }),
  );
