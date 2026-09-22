// Projected Data & Events Contracts
export {
  assertProjectionKeysArePlacements,
  parseDisplayEventHandlers,
  parseDisplayEventsByPlacement,
  parseProjectedDataByPlacement,
  parseProjectedDisplayData,
  type DisplayCellValue,
  type DisplayColumn,
  type DisplayEventHandler,
  type DisplayEventHandlers,
  type DisplayEventsByPlacement,
  type DisplayField,
  type DisplayGroup,
  type DisplayRefusalReason,
  type DisplayRichTextBlock,
  type DisplayRichTextDocument,
  type DisplayRichTextInline,
  type DisplayRow,
  type DisplaySemanticEvent,
  type DisplaySemanticEventName,
  type DisplaySummaryValue,
  type ProjectedDataByPlacement,
  type ProjectedDisplayData,
  type ProjectedDisplayValueKind,
  type ProjectedDisplayValues,
} from "./projected-data";

// Rich Text Rendering
export { RichTextDocumentView, richTextToPlainText } from "./rich-text";

// Cell Formatting & Display
export { DisplayCellView, cellValueToText, formatIsoDate } from "./cell";

// Display State Container & Helpers
export {
  DisplayStateContainer,
  getAccessibleName,
  type DisplayStateContainerProps,
} from "./display-state-container";

// Shared Display Components
export { PlainTextDisplay } from "./text";
export { RichTextDisplay } from "./rich-text-component";
export { ListDisplay } from "./list";
export { TableDisplay } from "./table";
export { RecordDetailDisplay } from "./record-detail";
export { GroupedDataDisplay } from "./grouped-data";
export { SummaryValuesDisplay } from "./summary-values";

// Display Registrations & Registry
export {
  DISPLAY_BLOCK_RELEASES,
  DISPLAY_COMPONENT_REGISTRATIONS,
  GROUPED_DATA_BLOCK_RELEASE,
  LIST_BLOCK_RELEASE,
  RECORD_DETAIL_BLOCK_RELEASE,
  RICH_TEXT_BLOCK_RELEASE,
  SUMMARY_VALUES_BLOCK_RELEASE,
  TABLE_BLOCK_RELEASE,
  TEXT_BLOCK_RELEASE,
  createDisplayComponentRegistry,
} from "./registrations";
