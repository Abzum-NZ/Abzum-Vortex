import "server-only";
export {
  projectRowActionAvailability,
  type RowActionInstallation,
} from "./records-table-features/row-actions";

export {
  readRecordsTableNamedActionAvailability,
  projectNamedActionAvailability,
} from "./records-table-features/named-action-availability";

export {
  organizationChooserEmptyPage,
  organizationChooserPage,
  organizationChooserPlacementId,
  organizationChooserShell,
} from "./organization-chooser-page";
export {
  organizationLauncherPage,
  organizationLauncherPlacementId,
  organizationLauncherShell,
} from "./organization-launcher-page";

export {
  createAuthenticatedPageCapabilityService,
  type AuthenticatedPageCapabilityDependencies,
  type FixedAuthenticatedPageCapability,
  type FixedAuthenticatedPageCapabilityAdapter,
} from "./authenticated-page-capability";
export {
  projectPageCapability,
  type PageCapabilityState,
  type PlacementCapabilityState,
  type ProjectedPageCapability,
} from "./page-capability-projection";
export {
  discardAndReprojectPageContent,
  isRefusedPageContentRevision,
  pageContentRevisionRelation,
  projectPageContent,
  readPageContentRevisions,
  type PageContentDiscardOutcome,
  type PageContentProjection,
  type PageContentReprojection,
  type PageContentRevisionRelation,
  type PageContentRevisions,
} from "./page-content-discard";
export {
  createStoredPageCapabilityService,
  type StoredPageCapabilityDependencies,
  type StoredPageCapabilitySelection,
} from "./stored-page-capability";
export {
  createAuthenticatedNavigationProjectionService,
  createStoredNavigationProjectionService,
  type AuthenticatedNavigationProjectionDependencies,
  type FixedAuthenticatedNavigationProjection,
  type FixedAuthenticatedNavigationProjectionAdapter,
  type NavigationPermissionBinding,
  type StoredNavigationProjectionDependencies,
} from "./navigation-projection";
export { recordLinkLabelKey } from "../definition/app-index";
export {
  projectRecordDetailData,
  projectRecordsTableData,
  collectRecordLinks,
  collectRecordLinkValues,
  recordLinkPlainText,
  type ComponentDataProjectionInput,
  type LinkFieldType,
  type ProjectedCellValue,
  type ProjectedComponentData,
  type ProjectedRecordDetailValues,
  type ProjectedRecordLink,
  type ProjectedRecordLinks,
  type RecordLinkResolver,
  type TableFieldColumn,
  type ProjectedTableGroup,
  type ProjectedTableGroups,
  type ProjectedTableRow,
  type ProjectedTableValues,
} from "./component-data-projection";
export {
  buildRecordsTableQueryCommand,
  createRecordsTableQueryResolver,
  type RecordsTableQueryRequest,
  type RecordsTableQueryResolution,
  type RecordsTableQueryRunner,
} from "./records-table-query";
export {
  logRecordsTableRequestRefusal,
  personalFormattingAllowed,
  projectRecordsTableFeatures,
  type RecordsTableRequestPart,
  type RecordsTableRequestRefusal,
} from "./records-table-features";
export {
  isGroupingTablePlacement,
  isTreeTablePlacement,
  readRecordsTableGroupMembers,
  readRecordsTableTreeLevel,
  type GroupMembersResult,
  type TreeLevelResult,
} from "./placement-read";
export {
  createRecordsTableBulkService,
  type RecordsTableBulkAddress,
  type RecordsTableBulkDependencies,
} from "./records-table-features/bulk-run";
export {
  createRecordsRangeSummaryService,
  type RecordsRangeSummaryDependencies,
} from "./records-table-features/range-summary";
export {
  createRecordsTableExportService,
  type RecordsTableExportDependencies,
} from "./records-table-features/export";
export {
  decideRecordTypeExport,
  decideRecordTypeFieldIds,
} from "./records-table-features/record-type-access";
export {
  readNamedActionEligibility,
  type NamedActionEligibilityTarget,
  type NamedActionRecordEligibility,
} from "./records-table-features/named-action-eligibility";
export {
  createRecordsSelectionSealer,
  type RecordsSelectionSealer,
} from "./records-selection-seal";
export {
  readRecordsTableRowDetail,
  type RowDetailRequest,
  type RowDetailResult,
  type RowDetailRow,
} from "./records-table-features/master-detail";
export {
  readRecordsTablePivot,
  type PivotCell,
  type PivotDrill,
  type PivotRequest,
  type PivotResult,
  type PivotRow,
  type RecordsTablePivotQueryRunner,
} from "./records-table-features/pivot";
export { readPageSubjectInTransaction } from "./page-subject-read";
export {
  createPageSubjectReader,
  pageSubjectFieldIds,
  type PageSubjectReader,
  type PageSubjectReadResult,
} from "./page-subject-read";
export {
  projectReadOnlyAttachmentList,
  type ReadOnlyAttachmentDecision,
  type ReadOnlyAttachmentFileEvidence,
  type ReadOnlyAttachmentFileMetadata,
  type ReadOnlyAttachmentListProjection,
  type ReadOnlyAttachmentOwner,
} from "./search-attachment-capabilities";
export {
  abandonPrivateFormDraftCommandSchema,
  createPrivateFormDraftCommandSchema,
  PrivateFormDraftError,
  privateFormDraftErrorCodes,
  privateFormDraftFieldValidationSchema,
  privateFormDraftInputKeySchema,
  privateFormDraftLimits,
  privateFormDraftProjectionSchema,
  privateFormDraftRetentionDays,
  privateFormDraftSchema,
  privateFormDraftScopeSchema,
  privateFormDraftValidationSchema,
  projectPrivateFormDraft,
  readPrivateFormDraftCommandSchema,
  restrictPrivateFormDraftInput,
  updatePrivateFormDraftCommandSchema,
  type AbandonPrivateFormDraftCommand,
  type CreatePrivateFormDraftCommand,
  type PrivateFormDraft,
  type PrivateFormDraftAbandonResult,
  type PrivateFormDraftCreateResult,
  type PrivateFormDraftErrorCode,
  type PrivateFormDraftFieldValidation,
  type PrivateFormDraftProjection,
  type PrivateFormDraftReadResult,
  type PrivateFormDraftScope,
  type PrivateFormDraftUpdateResult,
  type ReadPrivateFormDraftCommand,
  type UpdatePrivateFormDraftCommand,
  createPrivateFormDraftService,
  type PrivateFormDraftAuthority,
  type PrivateFormDraftAuthorityAdapter,
  type PrivateFormDraftServiceDependencies,
} from "./form-drafts";
export {
  createPrivateFormContinuationAdapter,
  type PrivateFormContinuationAdapter,
  type PrivateFormContinuationDependencies,
  type PrivateFormContinuationDraft,
  type PrivateFormContinuationDraftDisposition,
  type PrivateFormContinuationDraftPort,
  type PrivateFormContinuationInput,
  type PrivateFormContinuationResult,
} from "./form-continuation";
export {
  createPageFormRequestAdapter,
  createPrivateFormSubmitAdapter,
  readPrivateFormSubmission,
  type PageFormRequestAdapter,
  type PageFormRequestDependencies,
  type PrivateFormSubmission,
  type PrivateFormSubmitAdapter,
} from "./form-request";
export {
  buildQueryNoticeQueryBinding,
  createQueryNoticeQueryResolver,
  type ProjectedQueryNotice,
  type ProjectedQueryNoticePage,
  type QueryNoticeQueryBinding,
  type QueryNoticeResolution,
  type QueryNoticeSeverity,
} from "./notice-query-projection";
export {
  buildLinkTilesQueryBinding,
  createLinkTilesQueryResolver,
  type LinkTilesQueryBinding,
  type LinkTilesQueryResolution,
} from "./link-tiles-query";
export {
  projectCalendarPlacement,
  readCalendarPlacementContract,
  type CalendarPlacementContract,
  type CalendarPlacementFailureCause,
  type CalendarPlacementProjection,
  type CalendarPlacementProjectionInput,
  type CalendarPlacementValues,
  type CalendarQueryRunner,
} from "./calendar-query";
export type { CalendarView } from "./calendar-date";
export {
  projectBoardPlacement,
  type BoardPlacementFailureCause,
  type BoardPlacementProjection,
  type BoardPlacementValues,
} from "./board-query";
export {
  computeGuidedFormStepId,
  createGuidedFormDraftService,
  earlierGuidedStepId,
  getGuidedFormControlIds,
  getGuidedFormFlowId,
  getGuidedFormRecordType,
  getGuidedFormStepFields,
  getGuidedFormVisiblePlacementIds,
  guidedFormConfirmationKey,
  guidedFormConfirmationReference,
  guidedFormDraftScope,
  guidedFormInitialValues,
  guidedFormInputData,
  issueGuidedFormConfirmation,
  loadGuidedFormAuthorityForSession,
  openGuidedFormDraft,
  resolveGuidedFormAuthority,
  validateGuidedFormStep,
  verifiesGuidedFormConfirmation,
  visibleGuidedFormValidation,
  visibleGuidedFormValues,
  type GuidedFormAbandonRequest,
  type GuidedFormConfirmRequest,
  type GuidedFormConfirmResult,
  type GuidedFormDependencies,
  type GuidedFormPageAddress,
  type GuidedFormStepActionResult,
  type GuidedFormStepField,
  type GuidedFormStepFields,
  type GuidedFormStepRequest,
} from "./guided-form-steps";
export {
  addressedGridView,
  deleteGridView,
  gridViewPlacement,
  listGridViewShareTargets,
  readGridViews,
  resetGridView,
  saveGridView,
  shareGridView,
  writeGridView,
  type GridViewConflict,
  type GridViewOperationOutcome,
  type GridViewResetOutcome,
  type GridViewWriteOutcome,
  type StoredGridView,
  type StoredGridViews,
  type StoredNamedGridView,
} from "./grid-views";
export {
  resolveQueryBindings,
  type QueryBindingContext,
  type QueryBindingRecordRead,
  type QueryBindingResolution,
} from "./query-binding-resolver";
export {
  isStreamableQueryPlacement,
  readQueryPlacement,
  pageQueryBindingContext,
  placementParameterDependencies,
  findModuleQuery,
  isApplicationLauncherPlacement,
  isBoardPlacement,
  logPlacementFailure,
  projectedUseAvailability,
  resolvedQueryRecordTypeId,
  type LauncherQueryRow,
  type PageDataState,
  type PageSubjectType,
  type PlacementFailureReason,
  type PlacementGridLayouts,
  type PlacementLogPlace,
  type PlacementReadEntry,
  type PlacementReadInput,
  type PlacementReadServices,
} from "./placement-read/index";
