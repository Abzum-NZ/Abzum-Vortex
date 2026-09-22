import type { PlatformBlockReleaseV2 } from "@vortex/contracts";
import {
  createPlatformComponentRegistry,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "../registry";
import { PlainTextDisplay } from "./text";
import { RichTextDisplay } from "./rich-text-component";
import { ListDisplay } from "./list";
import { TableDisplay } from "./table";
import { RecordDetailDisplay } from "./record-detail";
import { GroupedDataDisplay } from "./grouped-data";
import { SummaryValuesDisplay } from "./summary-values";

/** Exact immutable metadata release for the plain text display block. */
export const TEXT_BLOCK_RELEASE: PlatformBlockReleaseV2 = Object.freeze({
  blockId: "10000000-0000-0000-0000-000000000001",
  key: "platform.display.text",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:0100000000000000000000000000000000000000000000000000000000000001",
  catalogueFingerprint: "sha256:0100000000000000000000000000000000000000000000000000000000000001",
  name: "Plain Text",
  icon: "type",
  paletteGroup: "content",
  rendererKey: "platform.renderer.text",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "text",
      key: "text",
      label: "Text",
      required: false,
      minLength: 0,
      maxLength: 5000,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the structured rich text display block. */
export const RICH_TEXT_BLOCK_RELEASE: PlatformBlockReleaseV2 = Object.freeze({
  blockId: "10000000-0000-0000-0000-000000000002",
  key: "platform.display.rich_text",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:0100000000000000000000000000000000000000000000000000000000000002",
  catalogueFingerprint: "sha256:0100000000000000000000000000000000000000000000000000000000000002",
  name: "Rich Text",
  icon: "file-text",
  paletteGroup: "content",
  rendererKey: "platform.renderer.rich_text",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the list display block. */
export const LIST_BLOCK_RELEASE: PlatformBlockReleaseV2 = Object.freeze({
  blockId: "10000000-0000-0000-0000-000000000003",
  key: "platform.display.list",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:0100000000000000000000000000000000000000000000000000000000000003",
  catalogueFingerprint: "sha256:0100000000000000000000000000000000000000000000000000000000000003",
  name: "List",
  icon: "list",
  paletteGroup: "data",
  rendererKey: "platform.renderer.list",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the table display block. */
export const TABLE_BLOCK_RELEASE: PlatformBlockReleaseV2 = Object.freeze({
  blockId: "10000000-0000-0000-0000-000000000004",
  key: "platform.display.table",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:0100000000000000000000000000000000000000000000000000000000000004",
  catalogueFingerprint: "sha256:0100000000000000000000000000000000000000000000000000000000000004",
  name: "Table",
  icon: "table",
  paletteGroup: "data",
  rendererKey: "platform.renderer.table",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the record detail display block. */
export const RECORD_DETAIL_BLOCK_RELEASE: PlatformBlockReleaseV2 = Object.freeze({
  blockId: "10000000-0000-0000-0000-000000000005",
  key: "platform.display.record_detail",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:0100000000000000000000000000000000000000000000000000000000000005",
  catalogueFingerprint: "sha256:0100000000000000000000000000000000000000000000000000000000000005",
  name: "Record Detail",
  icon: "file",
  paletteGroup: "record",
  rendererKey: "platform.renderer.record_detail",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the grouped data display block. */
export const GROUPED_DATA_BLOCK_RELEASE: PlatformBlockReleaseV2 = Object.freeze({
  blockId: "10000000-0000-0000-0000-000000000006",
  key: "platform.display.grouped_data",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:0100000000000000000000000000000000000000000000000000000000000006",
  catalogueFingerprint: "sha256:0100000000000000000000000000000000000000000000000000000000000006",
  name: "Grouped Data",
  icon: "layers",
  paletteGroup: "data",
  rendererKey: "platform.renderer.grouped_data",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** Exact immutable metadata release for the summary values display block. */
export const SUMMARY_VALUES_BLOCK_RELEASE: PlatformBlockReleaseV2 = Object.freeze({
  blockId: "10000000-0000-0000-0000-000000000007",
  key: "platform.display.summary_values",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:0100000000000000000000000000000000000000000000000000000000000007",
  catalogueFingerprint: "sha256:0100000000000000000000000000000000000000000000000000000000000007",
  name: "Summary Values",
  icon: "hash",
  paletteGroup: "figures",
  rendererKey: "platform.renderer.summary_values",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
  ],
  slots: [],
  capabilities: {
    responsiveVisibility: true,
    responsiveOrder: true,
    gridWidth: true,
    height: "content_or_bounded",
    publicSurface: "allowed",
    accessibleName: "optional",
    accessibleNamePropertyPath: ["title"],
  },
});

/** All 7 immutable display block releases. */
export const DISPLAY_BLOCK_RELEASES: readonly PlatformBlockReleaseV2[] = Object.freeze([
  TEXT_BLOCK_RELEASE,
  RICH_TEXT_BLOCK_RELEASE,
  LIST_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE,
  GROUPED_DATA_BLOCK_RELEASE,
  SUMMARY_VALUES_BLOCK_RELEASE,
]);

/** Exact registrations pairing each display block release with its React renderer. */
export const DISPLAY_COMPONENT_REGISTRATIONS: readonly PlatformComponentRegistration[] =
  Object.freeze([
    Object.freeze({ metadata: TEXT_BLOCK_RELEASE, render: PlainTextDisplay }),
    Object.freeze({ metadata: RICH_TEXT_BLOCK_RELEASE, render: RichTextDisplay }),
    Object.freeze({ metadata: LIST_BLOCK_RELEASE, render: ListDisplay }),
    Object.freeze({ metadata: TABLE_BLOCK_RELEASE, render: TableDisplay }),
    Object.freeze({ metadata: RECORD_DETAIL_BLOCK_RELEASE, render: RecordDetailDisplay }),
    Object.freeze({ metadata: GROUPED_DATA_BLOCK_RELEASE, render: GroupedDataDisplay }),
    Object.freeze({ metadata: SUMMARY_VALUES_BLOCK_RELEASE, render: SummaryValuesDisplay }),
  ]);

/**
 * Creates an immutable PlatformComponentRegistry populated with all 7 display components.
 */
export function createDisplayComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(DISPLAY_COMPONENT_REGISTRATIONS);
}
