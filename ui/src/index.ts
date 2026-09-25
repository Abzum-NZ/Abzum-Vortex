export const uiPackage = "@vortex/ui" as const;

// Platform Component Registry
export {
  assertRuntimeInputKeysArePlacements,
  createPayloadParser,
  createPlatformComponentRegistry,
  EMPTY_RUNTIME_INPUTS,
  noRuntimeInputs,
  type PlatformBlockRenderProps,
  type PlatformBlockRuntimeInputs,
  type PlatformComponentPayloadParser,
  type PlatformComponentRegistration,
  type PlatformComponentRenderer,
  type PlatformComponentRegistry,
  type RuntimeInputReader,
  type RuntimeInputsByPlacement,
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

// Per-Block Display Payload & Event Contracts
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
  type DisplayRenderProps,
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

// Per-Block Control Payload & Event Contracts
export {
  CONTROL_EVENT_NAMES,
  parseBooleanInputPayload,
  parseButtonPayload,
  parseChoiceInputPayload,
  parseControlData,
  parseControlEventHandlers,
  parseDateInputPayload,
  parseDialogPayload,
  parseDrawerPayload,
  parseFormPayload,
  parseLinkInputPayload,
  parseNumberInputPayload,
  parseRichTextInputPayload,
  parseTabsPayload,
  parseTextInputPayload,
  parseTypedFieldValue,
  parseValidationPayload,
  type BooleanInputData,
  type BooleanInputPayload,
  type ButtonData,
  type ButtonPayload,
  type ChoiceInputData,
  type ChoiceInputPayload,
  type ChoiceOption,
  type ControlDataState,
  type ControlEventHandler,
  type ControlEventHandlers,
  type ControlRenderProps,
  type ControlSemanticEvent,
  type ControlSemanticEventName,
  type DateInputData,
  type DateInputPayload,
  type DialogData,
  type DialogPayload,
  type DrawerData,
  type DrawerPayload,
  type FormData,
  type FormPayload,
  type LinkInputData,
  type LinkInputPayload,
  type NumberInputData,
  type NumberInputPayload,
  type RichTextInputData,
  type RichTextInputPayload,
  type TabsData,
  type TabsPayload,
  type TextInputData,
  type TextInputPayload,
  type TypedFieldValue,
  type TypedRecordReference,
  type TypedRichTextDocument,
  type ValidationData,
  type ValidationPayload,
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

// Form Draft Feedback
export {
  FieldDraftFeedback,
  FormDraftFeedbackRegion,
  useFieldFeedback,
  type FormDraftFeedback,
  type FormDraftFeedbackFieldState,
  type FormDraftFeedbackMessage,
  type FormDraftFeedbackSummary,
  type FormDraftFeedbackSupply,
  type FormFieldDraftFeedback,
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

// Launcher List Payload & Binding Contracts
export {
  linkTilesToListValues,
  parsePermittedApplicationsLauncherProjection,
  permittedApplicationsToListValues,
  readLauncherSettings,
  resolveLauncherListContext,
  type LauncherListContext,
  type LauncherRenderProps,
  type LauncherSettings,
  type LinkTileRow,
  type LinkTilesQueryBinding,
  type PermittedApplicationMetadata,
  type PermittedApplicationsLauncherProjection,
} from "./launcher";

// Launcher, Link-Tile & View-Filter Components
export {
  ApplicationLauncher,
  LinkTiles,
  ViewFilter,
} from "./launcher";

// Launcher Registrations & Registry
export {
  APPLICATION_LAUNCHER_BLOCK_RELEASE,
  LAUNCHER_COMPONENT_REGISTRATIONS,
  LINK_TILES_BLOCK_RELEASE,
  VIEW_FILTER_BLOCK_RELEASE,
  createLauncherComponentRegistry,
} from "./launcher";

// General Layout Components (#1008)
export { Container, Heading, type ContainerProps, type HeadingProps } from "./layout";

// General Layout Registrations & Registry
export {
  CONTAINER_BLOCK_RELEASE,
  HEADING_BLOCK_RELEASE,
  LAYOUT_BLOCK_RELEASES,
  LAYOUT_COMPONENT_REGISTRATIONS,
  createLayoutComponentRegistry,
} from "./layout";

// Application Navigation (#861)
export {
  ApplicationNavigation,
  ApplicationNavigationBlock,
  NAVIGATION_STYLES_CSS,
  type ApplicationNavigationProps,
  type ProjectedNavigation,
  type ProjectedNavigationItem,
} from "./navigation";

// Application Navigation Registrations & Registry (#1009)
export {
  APPLICATION_NAVIGATION_BLOCK_RELEASE,
  NAVIGATION_BLOCK_RELEASES,
  NAVIGATION_COMPONENT_REGISTRATIONS,
  createNavigationComponentRegistry,
} from "./navigation";

// Full Platform Component Registry (Display + Controls + Launcher + Layout + Navigation)
export {
  ALL_PLATFORM_COMPONENT_REGISTRATIONS,
  createFullPlatformComponentRegistry,
} from "./combined-registry";

// Exact-draft Application Preview (#597)
export {
  ApplicationPreview,
  parseApplicationPreviewArtifact,
  type ApplicationPreviewArtifact,
  type ApplicationPreviewBreakpoint,
  type ApplicationPreviewFlowNodeSimulation,
  type ApplicationPreviewInteraction,
  type ApplicationPreviewOutcome,
  type ApplicationPreviewProps,
  type ApplicationPreviewSimulatedEffect,
} from "./application-preview";

// Theme variables and shared component styles
export {
  ALL_UI_STYLES_CSS,
  createThemeRootProps,
  type ThemeMode,
  type ThemeRootProps,
} from "./theme";
