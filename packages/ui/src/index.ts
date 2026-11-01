// The public surface of @vortex/ui: only the names applications and other packages import.
// Everything else is internal to this package and imported by its own files directly.

// Per-block payload and event contracts the page runtime reads.
export type {
  BoardPayload,
  ChoiceOption,
  DisplayRow,
  DisplayTableBulkRun,
  DisplayTableExportRun,
  DisplayTableExportScope,
  DisplayTablePayload,
  DisplayTableSelectionScope,
  FormFlowFeedback,
  LauncherRowsPayload,
  RecordChoicePage,
  VortexIconName,
} from "@vortex/platform/schema";
export type {
  DisplayBatchEditAnswer,
  DisplayInlineEditResult,
  DisplaySemanticEvent,
} from "./display/display-events";
export type { ControlSemanticEvent } from "./controls/projected-data";

// Display components and values.
export { FormattedTime } from "./display/date-format-context";
export { getAccessibleName } from "./display/display-state-container";

// Display, control and page behaviour used by the running application.
export { continueFlowEventCycle } from "./flow-runtime/flow-cycle";
export type { FlowEventCycle } from "./flow-runtime/flow-cycle";
export { useFlowIntentHost } from "./flow-runtime/flow-intent-host";
export {
  createFlowRuntime,
  createFlowRuntimeState,
  scopeFlowRuntimeForms,
} from "./flow-runtime/flow-runtime";
export type {
  FlowDispatchResult,
  FlowRuntimeState,
  PlacementFlowBinding,
} from "./flow-runtime/flow-runtime";
export { createFormBlockRuntime } from "./flow-runtime/form-block-runtime";
export type { FormBlockRuntime } from "./flow-runtime/form-block-runtime";
export type {
  FlowFormAnswer,
  FlowFormIntent,
  FlowIntentHost,
  FlowMessageIntent,
} from "./flow-runtime/intents";
export { createFlowInvokeClient } from "./flow-runtime/lazy-flow-client";
export type { PageMessageDraft } from "./flow-runtime/messages";
export type { FlowInvokeClient, ServerFlowResponse } from "./flow-runtime/server-flow-client";
export { pageAgentTools, runPageAgentTool } from "./agent/page-tools";
export type { PageAgentTool } from "./agent/page-tools";

// Form controls.
export { equalFormValue } from "./controls/form-context";
export {
  RECORD_CHOICE_SEARCH_DELAY_MS,
  RECORD_CHOICE_SEARCH_LIMIT,
  useRecordChoicePager,
  type RecordChoicePager,
  type RecordChoicePagerPage,
} from "./controls/use-record-choice-pager";
export {
  UnsavedWorkProvider,
  useUnsavedWorkGuard,
  useUnsavedWorkRegistry,
} from "./controls/unsaved-work";

// Launcher, navigation and page composition.
export {
  parsePermittedApplicationsLauncherProjection,
  permittedApplicationsToListValues,
} from "./launcher/bindings";
export type { LinkNavigationEnvironment, UnsavedWorkGuard } from "./launcher/link-navigation";
export {
  ApplicationAccountActionsBlock,
  ApplicationAccountActionsProvider,
} from "./navigation/account-actions";
export type { ApplicationAccount, ApplicationAccountActions } from "./navigation/account-actions";
export { WebMcpStatus } from "./navigation/application-shell";
export type {
  ApplicationShellRuntime,
  ApplicationSwitcherData,
  ApplicationWebMcpRuntime,
} from "./navigation/application-shell";
export { ContentTransition, usePagePresence } from "./navigation/content-transition";
export { PageNavigationBusyContext } from "./navigation/navigation";
export { renderedPageOf } from "./page-composition";
export type { RenderedPage } from "./page-composition";
export { PagePuckRenderer } from "./page-puck-renderer";
export type { PagePuckRendererProps } from "./page-puck-renderer";

// Registry, definition errors and theme.
export { createPlatformComponentRegistryForReleases } from "./combined-registry";
export { placementSettings } from "./definition-error";
export type { FieldInputControlReleaseMap } from "./registry";
export { createThemeRootProps } from "./theme/theme-variables";
export type { PlatformThemeTokens } from "./theme/theme-variables";
export { VORTEX_STYLES, createVortexStyleRootProps } from "./theme/vortex-style";

// Icon rendering.
export { Icon, IconLibraryProvider } from "./icons/icon";
