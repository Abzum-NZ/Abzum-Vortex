// Per-Block Payload & Event Contracts
export { parseBoardPayload } from "./board-payload";
export type { ChartPayload } from "./chart";
export {
  DISPLAY_EVENT_NAMES,
  parseDisplayData,
  parseDisplayEventHandlers,
  parseLauncherRowsPayload,
  parseRecordDetailPayload,
  parseRichTextPayload,
  parseSummaryPayload,
  parseTablePayload,
  parseTextPayload,
  type DisplayDetailCell,
  type DisplayColumn,
  type DisplayDataState,
  type DisplayEventHandler,
  type DisplayInlineEditResult,
  type DisplayEventHandlers,
  type DisplayDetailField,
  type DisplayRefusalReason,
  type DisplayRichTextBlock,
  type DisplayRichTextDocument,
  type DisplayRichTextInline,
  type DisplayRow,
  type DisplayBatchEditAnswer,
  type DisplaySemanticEvent,
  type DisplaySemanticEventName,
  type BoardBucketPayload,
  type BoardColumnPayload,
  type BoardData,
  type BoardPage,
  type BoardPayload,
  type LauncherRowsData,
  type LauncherRowsPayload,
  type RecordDetailData,
  type RecordDetailPayload,
  type RichTextData,
  type RichTextPayload,
  type SummaryData,
  type SummaryPayload,
  type TableData,
  type DisplayTablePayload,
  type TextData,
  type TextPayload,
} from "./projected-data";
export type {
  DisplayTableBulkRun,
  DisplayTableExportRun,
  DisplayTableExportScope,
  DisplayTableSelectionScope,
} from "./projected-data";

// Rich Text Rendering
export { RichTextDocumentView, richTextToPlainText } from "./rich-text";

// Cell Formatting & Display
export { DisplayCellView, cellValueToText } from "./cell";
export { formatIsoDate } from "./date-format";
export { FormattedTime } from "./date-format-context";
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

// The platform loader for long waits
export { BrandLoader, type LoaderMark } from "./brand-loader";
