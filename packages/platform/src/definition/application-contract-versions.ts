import { DefinitionError } from "./definition-error";
export const applicationSourceContractVersion = "3.0.0" as const;
export const applicationValidationContractVersion = "3.0.0" as const;

export const applicationContractVersionErrorCodes = [
  "UNKNOWN_APPLICATION_SOURCE_CONTRACT_VERSION",
  "UNKNOWN_APPLICATION_VALIDATION_CONTRACT_VERSION",
  "APPLICATION_SOURCE_METADATA_MISMATCH",
] as const;

export type ApplicationContractVersionErrorCode =
  (typeof applicationContractVersionErrorCodes)[number];

export const applicationContractPair = {
  sourceContractVersion: applicationSourceContractVersion,
  validationContractVersion: applicationValidationContractVersion,
} as const;

export type ApplicationContractPair = typeof applicationContractPair;

export const selectApplicationContractPair = (
  sourceContractVersion: string,
  validationContractVersion: string,
): ApplicationContractPair => {
  if (sourceContractVersion !== applicationSourceContractVersion)
    throw new DefinitionError("UNKNOWN_APPLICATION_SOURCE_CONTRACT_VERSION");
  if (validationContractVersion !== applicationValidationContractVersion)
    throw new DefinitionError("UNKNOWN_APPLICATION_VALIDATION_CONTRACT_VERSION");
  return applicationContractPair;
};

export const selectStoredApplicationSourceContract = (
  sourceContractVersion: string,
  intrinsicSourceContractVersion: string,
): void => {
  if (sourceContractVersion !== intrinsicSourceContractVersion)
    throw new DefinitionError("APPLICATION_SOURCE_METADATA_MISMATCH");
  if (sourceContractVersion !== applicationSourceContractVersion)
    throw new DefinitionError("UNKNOWN_APPLICATION_SOURCE_CONTRACT_VERSION");
};
