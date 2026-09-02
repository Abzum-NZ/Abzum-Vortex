import type { DefinitionVersionImpactFailureCode } from "@vortex/contracts";

const safeMessageByCode = {
  invalid_request: "The version-impact request is invalid.",
  invalid_history: "The published definition history is invalid.",
  root_mismatch: "The definition root does not match its published history.",
  content_fingerprint_mismatch: "A published content fingerprint does not match its content.",
  unresolved_candidate: "The candidate contains an unresolved definition reference.",
  ambiguous_component_identity: "A component identity is duplicated within its owner.",
  no_release_to_confirm: "The comparison does not require a release.",
  confirmation_mismatch: "The confirmation no longer matches the comparison.",
} as const satisfies Record<DefinitionVersionImpactFailureCode, string>;

export class DefinitionVersionImpactError extends Error {
  readonly code: DefinitionVersionImpactFailureCode;

  constructor(code: DefinitionVersionImpactFailureCode) {
    super(safeMessageByCode[code]);
    this.name = "DefinitionVersionImpactError";
    this.code = code;
  }
}

export const refuseVersionImpact = (code: DefinitionVersionImpactFailureCode): never => {
  throw new DefinitionVersionImpactError(code);
};
