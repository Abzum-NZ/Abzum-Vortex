import {
  DISPLAY_BLOCK_RELEASES,
  GROUPED_DATA_BLOCK_RELEASE,
  GROUPED_DATA_BLOCK_RELEASE_1_1_0,
  LIST_BLOCK_RELEASE,
  LIST_BLOCK_RELEASE_1_1_0,
  RECORD_DETAIL_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE_1_1_0,
  RECORD_DETAIL_BLOCK_RELEASE_1_2_0,
  RICH_TEXT_BLOCK_RELEASE,
  RICH_TEXT_BLOCK_RELEASE_1_1_0,
  SUMMARY_VALUES_BLOCK_RELEASE,
  SUMMARY_VALUES_BLOCK_RELEASE_1_1_0,
  TABLE_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE_1_1_0,
  TABLE_BLOCK_RELEASE_1_2_0,
  TEXT_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE_1_1_0,
} from "@vortex/contracts";
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

/**
 * Release metadata is owned by the server-side platform block catalogue in @vortex/contracts;
 * these registrations only pair each registered release with its renderer, so a renderer
 * change cannot redefine or extend what authors may place.
 */
export {
  DISPLAY_BLOCK_RELEASES,
  GROUPED_DATA_BLOCK_RELEASE,
  LIST_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE,
  RICH_TEXT_BLOCK_RELEASE,
  SUMMARY_VALUES_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE,
};

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
    // Release 1.1.0 adds the optional authored empty message; the same renderer serves both.
    Object.freeze({ metadata: TEXT_BLOCK_RELEASE_1_1_0, render: PlainTextDisplay }),
    Object.freeze({ metadata: RICH_TEXT_BLOCK_RELEASE_1_1_0, render: RichTextDisplay }),
    Object.freeze({ metadata: LIST_BLOCK_RELEASE_1_1_0, render: ListDisplay }),
    Object.freeze({ metadata: TABLE_BLOCK_RELEASE_1_1_0, render: TableDisplay }),
    Object.freeze({ metadata: RECORD_DETAIL_BLOCK_RELEASE_1_1_0, render: RecordDetailDisplay }),
    Object.freeze({ metadata: GROUPED_DATA_BLOCK_RELEASE_1_1_0, render: GroupedDataDisplay }),
    Object.freeze({ metadata: SUMMARY_VALUES_BLOCK_RELEASE_1_1_0, render: SummaryValuesDisplay }),
    // Release 1.2.0 declares the data contract as settings; the same renderers read it.
    Object.freeze({ metadata: TABLE_BLOCK_RELEASE_1_2_0, render: TableDisplay }),
    Object.freeze({ metadata: RECORD_DETAIL_BLOCK_RELEASE_1_2_0, render: RecordDetailDisplay }),
  ]);

/** Creates an immutable PlatformComponentRegistry populated with every display block release. */
export function createDisplayComponentRegistry(): PlatformComponentRegistry {
  return createPlatformComponentRegistry(DISPLAY_COMPONENT_REGISTRATIONS);
}
