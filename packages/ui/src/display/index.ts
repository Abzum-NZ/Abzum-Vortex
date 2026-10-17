// Per-Block Payload & Event Contracts
export type { ChartPayload } from "./chart";
export {
  DISPLAY_EVENT_NAMES,
  parseBoardPayload,
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
  type BoardBucketPayload,
  type BoardColumnPayload,
  type BoardData,
  type BoardPage,
  type BoardPayload,
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
export { formatIsoDate } from "./date-format";
// Display State Container & Helpers
export {
  DisplayStateContainer,
  getAccessibleName,
  type DisplayStateContainerProps,
} from "./display-state-container";

// Shared Display Components
export { PlainTextDisplay } from "./text";
export { NoticeBlock } from "./notice";
export { RichTextDisplay } from "./rich-text-component";
export { ListDisplay } from "./list";
export { TableDisplay } from "./table";
export { RecordDetailDisplay } from "./record-detail";
export { SummaryValuesDisplay } from "./summary-values";

// Per-Block Render Props
export { type DisplayRenderProps } from "./context";

// Display Registrations & Registry
export { DISPLAY_COMPONENT_REGISTRATIONS } from "./registrations";

export {
  QueryNoticeDisplay,
  parseQueryNoticePayload,
  type QueryNoticeItem,
  type QueryNoticePayload,
} from "./query-notice";

// The platform loader for long waits (#2519)
export { BrandLoader } from "./brand-loader";
