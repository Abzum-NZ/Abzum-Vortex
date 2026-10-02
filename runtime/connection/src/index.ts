import "server-only";

export const ConnectionService = Object.freeze({
  key: "connection",
  boundary: "@vortex/connection",
});

export * from "./connection-instance-state";
export * from "./connection-readiness";
export * from "./administration";
export * from "./connection-instance-reader";
export * from "./outbound-target-policy";
export {
  resolveOutboundOperationDeclaration,
} from "./outbound-operation-declaration";
export type {
  OutboundOperationDeclaration,
  OutboundOperationDeclarationResult,
  OutboundOperationShape,
  ResolveOutboundOperationDeclarationInput,
} from "./outbound-operation-declaration";
