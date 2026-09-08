import "server-only";

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
  createStoredV1PageCapabilityService,
  type StoredV1PageCapabilityDependencies,
  type StoredV1PageCapabilitySelection,
} from "./stored-v1-page-capability";

export const PageService = Object.freeze({
  key: "page",
  boundary: "@vortex/page",
});
