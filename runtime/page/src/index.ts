import "server-only";

import {
  resolvePageTheme,
  resolvePlacementThemeTokens,
} from "./page-theme-resolution";

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
  createStoredPageCapabilityService,
  type StoredPageCapabilityDependencies,
  type StoredPageCapabilitySelection,
  type StoredPageReadModelValue,
} from "./stored-page-capability";
export {
  collectNavigationPermissionKeys,
  createAuthenticatedNavigationProjectionService,
  createStoredNavigationProjectionService,
  projectNavigation,
  type AuthenticatedNavigationProjectionDependencies,
  type FixedAuthenticatedNavigationProjection,
  type FixedAuthenticatedNavigationProjectionAdapter,
  type NavigationPermissionBinding,
  type NavigationPermissionDecisions,
  type ProjectedNavigation,
  type ProjectedNavigationItem,
  type StoredNavigationProjectionDependencies,
} from "./navigation-projection";
export {
  createProtectedReadModelResolver,
  type ProtectedReadModelReaders,
  type ProtectedReadModelRequestContext,
  type ProtectedReadModelResolution,
} from "./protected-read-model-resolution";
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
} from "./form-drafts";
export {
  abandonPrivateFormDraft,
  createPrivateFormDraft,
  createPrivateFormDraftService,
  expirePrivateFormDrafts,
  readPrivateFormDraft,
  updatePrivateFormDraft,
  type PrivateFormDraftAuthority,
  type PrivateFormDraftAuthorityAdapter,
  type PrivateFormDraftServiceDependencies,
} from "./form-drafts-repository";
export {
  resolvePageTheme,
  resolvePlacementThemeTokens,
  type PlacementThemeResolutionContext,
} from "./page-theme-resolution";

export const PageService = Object.freeze({
  key: "page",
  boundary: "@vortex/page",
  resolvePageTheme,
  resolvePlacementThemeTokens,
});
