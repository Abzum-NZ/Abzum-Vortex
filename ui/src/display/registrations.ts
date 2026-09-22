import { platformBlockReleaseV2Schema, type PlatformBlockReleaseV2 } from "@vortex/contracts";
import {
  createPlatformComponentRegistry,
  type PlatformComponentRegistration,
  type PlatformComponentRegistry,
} from "../registry";
import { GroupedDataDisplay } from "./grouped-data";
import { ListDisplay } from "./list";
import { RecordDetailDisplay } from "./record-detail";
import { RichTextDisplay } from "./rich-text-component";
import { SummaryValuesDisplay } from "./summary-values";
import { TableDisplay } from "./table";
import { PlainTextDisplay } from "./text";

const deepFreeze = <Value>(value: Value): Value => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
};

/**
 * Parses one release through the same contract the registry and renderer validate, so an
 * invalid identity or declaration fails at module load. Fingerprints are the canonical-JSON
 * SHA-256 values the publication catalogue derives from the same content.
 */
const release = (definition: unknown): PlatformBlockReleaseV2 =>
  deepFreeze(platformBlockReleaseV2Schema.parse(definition));

/** Exact immutable metadata release for the plain text display block. */
export const TEXT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "addfad00-1b11-4674-83fa-913667f87e79",
  key: "platform.display.text",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:a8964d4a351d02ed6b5b6c2a18960722c0f71ba7661e105e214f717edb9ac292",
  catalogueFingerprint: "sha256:57be52ee0755ca927565e5148f5393fc3fe57c72a4027b8bf55d0c40249b71a0",
  name: "Plain text",
  icon: "type",
  paletteGroup: "content",
  rendererKey: "platform.renderer.text",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name shown as the block heading",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "text",
      key: "text",
      label: "Text",
      help: "Literal text shown when no projected value is supplied",
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
export const RICH_TEXT_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "148f420f-f7db-4145-80f4-3d3fa036096b",
  key: "platform.display.rich_text",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:85347b7eb5855b0565b3bd05d2e6d802d6909fee09b1ff4b09dda224d818993a",
  catalogueFingerprint: "sha256:c8566e88a84f229ab8acca5b780efb648c5965188bd4148a254dc90bfd187626",
  name: "Rich text",
  icon: "file-text",
  paletteGroup: "content",
  rendererKey: "platform.renderer.rich_text",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name shown as the block heading",
      required: false,
      minLength: 1,
      maxLength: 120,
    },
    {
      kind: "rich_text",
      key: "document",
      label: "Content",
      help: "Structured content shown when no projected value is supplied",
      required: false,
      allowedElements: ["paragraph", "heading", "bulleted_list", "numbered_list", "emphasis", "link"],
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
export const LIST_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "4881c816-e4ce-4c39-b0b7-20958b947748",
  key: "platform.display.list",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:57de3de8146aff7b144287013212a56a1776931b0ccd64ec2dd33fbb2302410c",
  catalogueFingerprint: "sha256:1f85bfc0817bb2f01cc67dfe14d408f9305e12b892863e2ec8bc5b3f2d767837",
  name: "List",
  icon: "list",
  paletteGroup: "data",
  rendererKey: "platform.renderer.list",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name shown as the block heading",
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
export const TABLE_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "39ab6f28-c166-47cf-91a7-f0b864ded4ff",
  key: "platform.display.table",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:ddf3237b66a623d0d9bab1c843395b3991b132d14e60275219b200911b82dd69",
  catalogueFingerprint: "sha256:d3ce60391d8610678e37474d649c7ec50afc67a8489ef999bab17a68379fd990",
  name: "Table",
  icon: "table",
  paletteGroup: "data",
  rendererKey: "platform.renderer.table",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name shown as the block heading",
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
export const RECORD_DETAIL_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "e2569df0-2f10-4b20-b41d-177b66cd136c",
  key: "platform.display.record_detail",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:ed4b64a50a6aa5d1e42795ac073173b481e4e69be12ca959938ccb8aa079af5d",
  catalogueFingerprint: "sha256:8efdda07e305a445b29e4e0d69dcb513a61daaaf5840e591b54c9cc164f064ba",
  name: "Record detail",
  icon: "file",
  paletteGroup: "record",
  rendererKey: "platform.renderer.record_detail",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name shown as the block heading",
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
export const GROUPED_DATA_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "6c27a0c2-ad91-4a5a-ab1d-54d337bebe36",
  key: "platform.display.grouped_data",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:88a63161fb47527b9849d79c692a2cfb1a7d7ad0e8eefa6526c8b96b211c1e51",
  catalogueFingerprint: "sha256:c257f534817c1d175774ce78e1efd8e50cafe9caa8fc854818323f49025ead3f",
  name: "Grouped data",
  icon: "layers",
  paletteGroup: "data",
  rendererKey: "platform.renderer.grouped_data",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name shown as the block heading",
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
export const SUMMARY_VALUES_BLOCK_RELEASE: PlatformBlockReleaseV2 = release({
  blockId: "b00f7a0f-9094-4186-b8c4-066b1df6c395",
  key: "platform.display.summary_values",
  releaseVersion: "1.0.0",
  contentFingerprint: "sha256:9ab8233005907928f32818ae8e0b89107942498c003dc84c05833624885e81b8",
  catalogueFingerprint: "sha256:f477dd3f15ea3408a743f2fb30817bee4f897d7bb76481b86eac0537298b24c6",
  name: "Summary values",
  icon: "hash",
  paletteGroup: "figures",
  rendererKey: "platform.renderer.summary_values",
  properties: [
    {
      kind: "text",
      key: "title",
      label: "Title",
      help: "Accessible name shown as the block heading",
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

/** All seven immutable display block releases. */
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

/** Creates an immutable PlatformComponentRegistry populated with the seven display components. */
export function createDisplayComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(DISPLAY_COMPONENT_REGISTRATIONS);
}
