import "server-only";

export const DefinitionService = Object.freeze({
  key: "definition",
  boundary: "@vortex/definition",
});

export * from "./canonical-json";
export * from "./semantic-version";
export * from "./version-impact";
export * from "./version-impact-error";
export * from "./compilation-error";
export * from "./compiler";
export * from "./validation";
export * from "./definition-store";
export * from "./source-identities";
export * from "./saved-condition-revisions";
export * from "./definition-publication";
export * from "./definition-publication-repository";
export * from "./definition-publication-catalogue";
export * from "./definition-publication-composition";
export {
  createDefinitionConsumerReadService,
  DefinitionConsumerReadError,
  definitionConsumerReadErrorCodes,
  type DefinitionConsumerReadErrorCode,
} from "./definition-consumer-read";
export { createDatabaseDefinitionConsumerReadService } from "./definition-consumer-read-composition";
export {
  createDefinitionHistoryService,
  DefinitionHistoryError,
  definitionHistoryErrorCodes,
  type DefinitionHistoryErrorCode,
} from "./definition-history";
export { createDatabaseDefinitionHistoryService } from "./definition-history-composition";
