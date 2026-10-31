import "server-only";
export { searchConfiguredApplication, type ApplicationSearchResult } from "./application-search";
export {
  searchInstalledApplication,
  sealApplicationSearchCursor,
  openApplicationSearchCursor,
} from "./installed-application-search";

export {
  buildSearchDocument,
  searchableFieldConfigurationFor,
  searchDocumentStoreCommand,
  searchPriorityWeights,
  type SearchableFieldPolicy,
  type SearchDocumentRefusalCode,
  type SearchDocumentStoreCommand,
  type SearchDocumentStoreOutcome,
  type SearchRecordSnapshot,
} from "./document-store";

export { searchIndexFieldDiscloses } from "./sensitivity-policy";

export { matchesLiteralSearchText } from "./literal-search";

export { splitSearchFilters } from "./search-filters";

export {
  createSearchEventConsumer,
  type SearchIndexOccurrenceDependencies,
  type SearchIndexRecordType,
} from "./event-consumer";

export { createSearchIndexDependencies } from "./index-dependencies";
