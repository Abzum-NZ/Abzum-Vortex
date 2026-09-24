export const uiPackage = "@vortex/ui" as const;

// Platform Component Registry
export {
  createPlatformComponentRegistry,
  type PlatformBlockRenderProps,
  type PlatformComponentRegistration,
  type PlatformComponentRenderer,
  type PlatformComponentRegistry,
} from "./registry";

// Definition & Render Errors
export {
  DefinitionRenderError,
  validateAccessibleName,
  validatePlacementSlots,
  validatePlacementTree,
  validateSlotOrder,
  type Breakpoint,
  type DefinitionRenderErrorCode,
  type DefinitionRenderErrorLocation,
} from "./definition-error";

// Layout-only Styles
export {
  computePlacementClassName,
  computePlacementStyle,
  computeSlotContainerStyle,
  LAYOUT_CLASS_NAMES,
  LAYOUT_ONLY_STYLES_CSS,
} from "./layout-styles";

// Layout Renderer & Recursive Traversal
export {
  PageLayoutRenderer,
  PlacementRenderer,
  PlacementSlotRenderer,
  renderPageLayout,
  resolveRootPlacementSlot,
  resolveShellLayout,
  type GuidedFormCompositionV2,
  type MaterialisedApplicationCompositionV2,
  type PageLayoutRendererProps,
  type PlacementRendererProps,
  type PlacementSlotRendererProps,
  type PlacementSlotV2,
  type ProjectedPlacementAvailability,
  type ProjectedPlacementSlot,
  type ProjectedPageCapability,
} from "./layout-renderer";

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
} from "./display";

// Display Components & Views
export {
  DisplayCellView,
  DisplayStateContainer,
  GroupedDataDisplay,
  ListDisplay,
  PlainTextDisplay,
  RecordDetailDisplay,
  RichTextDisplay,
  RichTextDocumentView,
  SummaryValuesDisplay,
  TableDisplay,
  cellValueToText,
  formatIsoDate,
  getAccessibleName,
  richTextToPlainText,
  type DisplayStateContainerProps,
} from "./display";

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
} from "./display";

// Control Projected Data & Events Contracts
export {
  assertControlProjectionKeysArePlacements,
  CONTROL_EVENT_NAMES,
  parseControlEventHandlers,
  parseControlEventsByPlacement,
  parseProjectedControlData,
  parseProjectedControlDataByPlacement,
  type ChoiceOption,
  type ControlEventHandler,
  type ControlEventHandlers,
  type ControlEventsByPlacement,
  type ControlSemanticEvent,
  type ControlSemanticEventName,
  type ProjectedControlData,
  type ProjectedControlDataByPlacement,
  type ProjectedControlValueKind,
  type ProjectedControlValues,
  type TypedFieldValue,
  type TypedRecordReference,
  type TypedRichTextDocument,
} from "./controls";

// Form & Action Control Components
export {
  BooleanInput,
  Button,
  ChoiceInput,
  DateInput,
  Dialog,
  Drawer,
  FormContainer,
  LinkInput,
  NumberInput,
  RichTextInput,
  Tabs,
  TextInput,
  ValidationMessage,
  type BooleanInputProps,
  type ButtonProps,
  type ChoiceInputProps,
  type DateInputProps,
  type DialogProps,
  type DrawerProps,
  type FormContainerProps,
  type LinkInputProps,
  type NumberInputProps,
  type RichTextInputProps,
  type TabsProps,
  type TextInputProps,
  type ValidationMessageProps,
} from "./controls";

// Control Registrations & Registry
export {
  BOOLEAN_INPUT_BLOCK_RELEASE,
  BUTTON_BLOCK_RELEASE,
  CHOICE_INPUT_BLOCK_RELEASE,
  CONTROL_BLOCK_RELEASES,
  CONTROL_COMPONENT_REGISTRATIONS,
  createControlComponentRegistry,
  DATE_INPUT_BLOCK_RELEASE,
  DIALOG_BLOCK_RELEASE,
  DRAWER_BLOCK_RELEASE,
  FORM_CONTAINER_BLOCK_RELEASE,
  LINK_INPUT_BLOCK_RELEASE,
  NUMBER_INPUT_BLOCK_RELEASE,
  RICH_TEXT_INPUT_BLOCK_RELEASE,
  TABS_BLOCK_RELEASE,
  TEXT_INPUT_BLOCK_RELEASE,
  VALIDATION_MESSAGE_BLOCK_RELEASE,
} from "./controls";

// Full Platform Component Registry (Display + Controls)
export {
  ALL_PLATFORM_COMPONENT_REGISTRATIONS,
  createFullPlatformComponentRegistry,
} from "./combined-registry";

// Theme variables and shared component styles
export {
  ALL_UI_STYLES_CSS,
  createThemeRootProps,
  type ThemeMode,
  type ThemeRootProps,
} from "./theme";
