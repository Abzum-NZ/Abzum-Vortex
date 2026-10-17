export const uiPackage = "@vortex/ui" as const;

// Shared notice component (#1607)
export {
  Notice,
  type NoticeContent,
  type NoticeContentPart,
  type NoticeProps,
  type NoticeSeverity,
} from "./components/notice";

// Platform Component Registry
export {
  assertRuntimeInputKeysArePlacements,
  createPayloadParser,
  EMPTY_RUNTIME_INPUTS,
  noRuntimeInputs,
  type PlatformBlockRenderProps,
  type PlatformBlockRuntimeInputs,
  type PlatformComponentPayloadParser,
  type PlatformComponentRegistration,
  type RegisteredPlatformComponent,
  type PlatformComponentRenderer,
  type PlatformComponentRegistry,
  type FieldInputControlReleaseMap,
  type RuntimeInputReader,
  type RuntimeInputsByPlacement,
} from "./registry";

// Definition & Render Errors
export {
  DefinitionRenderError,
  placementSettings,
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
  computeSlotOrderCss,
  LAYOUT_CLASS_NAMES,
  LAYOUT_ONLY_STYLES_CSS,
} from "./layout-styles";

// The one Puck component config: every definition block, for <Render>, <Puck> and the page runtime
export {
  createVortexPuckConfig,
  getVortexPuckConfig,
  type VortexPlacementMeta,
  type VortexPuckComponentProps,
  type VortexPuckMetadata,
} from "./puck-config";

// Page composition resolution and the single Puck page renderer
export {
  materialisedPageOf,
  renderedPageOf,
  selectRenderedLayout,
  type MaterialisedApplicationComposition,
  type RenderedPage,
} from "./page-composition";
export { PagePuckRenderer, type PagePuckRendererProps } from "./page-puck-renderer";

// Per-Block Display Payload & Event Contracts
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
  type ChartPayload,
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
  BrandLoader,
  DisplayCellView,
  DisplayStateContainer,
  ListDisplay,
  NoticeBlock,
  QueryNoticeDisplay,
  parseQueryNoticePayload,
  type QueryNoticeItem,
  type QueryNoticePayload,
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
export { DISPLAY_COMPONENT_REGISTRATIONS } from "./display";

// Per-Block Control Payload & Event Contracts
export {
  CONTROL_EVENT_NAMES,
  equalFormValue,
  parseBooleanInputPayload,
  parseButtonPayload,
  parseChoiceInputPayload,
  parseControlData,
  parseControlEventHandlers,
  parseDateInputPayload,
  parseDialogPayload,
  parseDrawerPayload,
  parseFieldInputPayload,
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
  type FieldInputData,
  type FieldInputPayload,
  type FormContainerData,
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
  FieldInput,
  FormContainer,
  LinkInput,
  NumberInput,
  RichTextInput,
  Tabs,
  TextInput,
  UnsavedWorkProvider,
  ValidationMessage,
  useUnsavedWorkGuard,
  useUnsavedWorkRegistry,
  type BooleanInputProps,
  type ButtonProps,
  type ChoiceInputProps,
  type DateInputProps,
  type DialogProps,
  type DrawerProps,
  type FieldInputProps,
  type FormContainerProps,
  type FormFlowFeedback,
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
export { CONTROL_COMPONENT_REGISTRATIONS } from "./controls";

// Launcher List Payload & Binding Contracts
export {
  applicationLauncherQueryRowsToListValues,
  linkTilesToListValues,
  parsePermittedApplicationsLauncherProjection,
  permittedApplicationsToListValues,
  readLauncherSettings,
  resolveLauncherListContext,
  type ApplicationLauncherQueryRow,
  type LauncherListContext,
  type LauncherRenderProps,
  type LauncherSettings,
  type LinkTileRow,
  type LinkTilesQueryBinding,
  type PermittedApplicationMetadata,
  type PermittedApplicationsLauncherProjection,
} from "./launcher";

// Launcher, Link-Tile & View-Filter Components
export { ApplicationLauncher, LinkTiles, ViewFilter } from "./launcher";

// Launcher Registrations & Registry
export { LAUNCHER_COMPONENT_REGISTRATIONS } from "./launcher";

// General Layout Components (#1008)
export { Container, Heading, type ContainerProps, type HeadingProps } from "./layout";

// General Layout Registrations & Registry
export { LAYOUT_COMPONENT_REGISTRATIONS } from "./layout";

// Application Navigation (#861)
export {
  ApplicationNavigation,
  ApplicationNavigationBlock,
  PageNavigationBusyContext,
  type ApplicationNavigationProps,
  type ProjectedNavigation,
  type ProjectedNavigationItem,
} from "./navigation";

// Application Navigation Registrations & Registry (#1009)
export {
  ApplicationAccountActionsBlock,
  ApplicationAccountActionsProvider,
  type ApplicationAccount,
  type ApplicationAccountActions,
  type ApplicationShellRuntime,
  type ApplicationWebMcpRuntime,
  ContentTransition,
  isClientPageChange,
  observeSettled,
  pageHoldFor,
  primaryStreamedPlacement,
  settledValue,
  type PageHoldOutcome,
  usePagePresence,
  NAVIGATION_COMPONENT_REGISTRATIONS,
  WebMcpStatus,
} from "./navigation";

// Full Platform Component Registry (Display + Controls + Launcher + Layout + Navigation)
export {
  ALL_PLATFORM_COMPONENT_REGISTRATIONS,
  createPlatformComponentRegistryForReleases,
} from "./combined-registry";

export { AppearanceProvider, AppearanceToggle } from "./navigation/appearance-toggle";

// Theme variables and shared component styles
export {
  ALL_UI_STYLES_CSS,
  APPEARANCE_COOKIE,
  createAppearanceRootProps,
  createThemeRootProps,
  parseThemeMode,
  createVortexStyleRootProps,
  DEFAULT_VORTEX_MENU_ACCENT,
  DEFAULT_VORTEX_MENU_COLOR,
  DEFAULT_VORTEX_STYLE,
  resolveVortexMenuAccent,
  resolveVortexMenuColor,
  resolveVortexStyle,
  resolveVortexStyleSelection,
  VORTEX_MENU_ACCENTS,
  VORTEX_MENU_COLORS,
  VORTEX_STYLES,
  type AppearanceRootProps,
  type ThemeMode,
  type ThemeRootProps,
  type PlatformThemeTokens,
  type VortexMenuAccent,
  type VortexMenuColor,
  type VortexStyle,
  type VortexStyleRootProps,
  type VortexStyleSelection,
} from "./theme";

// Semantic icons drawn by the selected shadcn/create icon library (#1278)
export {
  Icon,
  IconLibraryProvider,
  loadIconAdapter,
  VORTEX_ICON_LIBRARIES,
  VORTEX_ICON_NAMES,
  type VortexIconAdapter,
  type VortexIconName,
  type VortexIconProps,
} from "./icons";

// Browser Flow Runtime (#1013)
export {
  FLOW_INTENT_KINDS,
  createFlowInvokeClient,
  createFlowRuntime,
  createFormBlockRuntime,
  driveServerFlow,
  flowRunsOnlyInBrowser,
  isFlowIntent,
  parseServerFlowResponse,
  performPresentationIntent,
  readConfirmIntent,
  readFormIntent,
  readMessageIntent,
  runBrowserFlow,
  useFlowIntentHost,
  type BrowserFlowRequest,
  type BrowserFlowResult,
  type FlowApplicationAddress,
  type FlowBindingReference,
  type FlowConfirmIntent,
  type FlowDispatchResult,
  type FormBlockRuntime,
  type FormFieldAnswers,
  type FlowFormAnswer,
  type FlowFormIntent,
  type FlowInstallationContext,
  type FlowSubjectContext,
  type FlowIntent,
  type FlowIntentHost,
  type FlowIntentHostOptions,
  type FlowIntentKind,
  type FlowInvokeClient,
  type FlowInvokeClientOptions,
  type FlowMessageIntent,
  type FlowResumeEvidence,
  type FlowRuntime,
  type FlowRuntimeOptions,
  type ServerDrivenResult,
  type ServerFlowResponse,
} from "./flow-runtime";

// Link Navigation and the Navigate task (#1013)
export {
  activateLinkTarget,
  externalLinkActivation,
  linkTargetForNavigateIntent,
  navigateIntentForPage,
  performNavigateTask,
  type LinkNavigationEnvironment,
  type LinkOpenBehavior,
  type LinkTarget,
  type NavigateTaskIntent,
  type UnsavedWorkGuard,
} from "./launcher";

// Sandboxed custom component host (#1143)
export {
  COMPONENT_BOOTSTRAP_QUERY_PARAMETERS,
  COMPONENT_BOOTSTRAP_SERVING_PATH,
  CustomComponentHost,
  componentBundleContentAddressFromIntegrity,
  createCustomComponentPayloadParser,
  createCustomComponentRegistration,
  createCustomComponentRegistrations,
  customComponentBootstrapUrl,
  validateCustomComponentEventPayload,
  type CustomComponentBootstrapTarget,
  type CustomComponentEvent,
  type CustomComponentEventBinding,
  type CustomComponentEventBindings,
  type CustomComponentEventDeclaration,
  type CustomComponentEventPayload,
  type CustomComponentHostProps,
} from "./custom-component";
