// Per-Block Payload & Event Contracts
export {
  DISPLAY_EVENT_NAMES,
  parseDisplayData,
  parseDisplayEventHandlers,
  parseGroupedPayload,
  parseListPayload,
  parseRecordDetailPayload,
  parseRichTextPayload,
  parseSummaryPayload,
  parseTablePayload,
  parseTextPayload,
  type DisplayCellValue,
  type DisplayColumn,
  type DisplayDataState,
  type DisplayEventHandler,
  type DisplayEventHandlers,
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
  type GroupedData,
  type GroupedPayload,
  type ListData,
  type ListPayload,
  type RecordDetailData,
  type RecordDetailPayload,
  type RichTextData,
  type RichTextPayload,
  type SummaryData,
  type SummaryPayload,
  type TableData,
  type TablePayload,
  type TextData,
  type TextPayload,
} from "./projected-data";

// Rich Text Rendering
export { RichTextDocumentView, richTextToPlainText } from "./rich-text";

// Cell Formatting & Display
export { DisplayCellView, cellValueToText } from "./cell";
export { formatIsoDate, type DateFormatOptions } from "./date-format";
export { DateFormatProvider } from "./date-format-context";

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

// Per-Block Render Props
export { type DisplayRenderProps } from "./context";

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
