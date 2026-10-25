import { DefinitionError } from "./definition-error";
import type { DefinitionVersionImpactFailureCode } from "./version-impact";

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

export const refuseVersionImpact = (code: DefinitionVersionImpactFailureCode): never => {
  throw new DefinitionError(code, { detail: safeMessageByCode[code] });
};

/** True for a refusal raised by the version-impact policy (a definition problem, not a failure). */
export const isVersionImpactRefusal = (
  error: unknown,
): error is DefinitionError<DefinitionVersionImpactFailureCode> =>
  error instanceof DefinitionError && Object.hasOwn(safeMessageByCode, error.code);
