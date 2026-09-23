import "server-only";

export const SearchService = Object.freeze({
  key: "search",
  boundary: "@vortex/search",
});

export {
  buildSearchDocument,
  searchableFieldConfigurationFor,
  searchDocumentLimits,
  searchDocumentSchemaVersion,
  searchPriorityWeights,
  type BuildSearchDocumentResult,
  type SearchableFieldConfiguration,
  type SearchableFieldConfigurationEntry,
  type SearchableFieldPolicy,
  type SearchDocument,
  type SearchDocumentDeletion,
  type SearchDocumentEntry,
  type SearchDocumentRefusalCode,
  type SearchRecordSnapshot,
} from "./document-store";
