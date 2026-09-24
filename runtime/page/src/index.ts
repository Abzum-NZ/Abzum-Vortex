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
} from "./stored-page-capability";
export {
  createProtectedReadModelResolver,
  type ProtectedReadModelReaders,
  type ProtectedReadModelRequestContext,
  type ProtectedReadModelResolution,
} from "./protected-read-model-resolution";
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
