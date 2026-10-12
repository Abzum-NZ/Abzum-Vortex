export const applicationSourceContractVersion = "2.0.0" as const;
export const applicationValidationContractVersion = "2.0.0" as const;

export const applicationContractVersionErrorCodes = [
  "UNKNOWN_APPLICATION_SOURCE_CONTRACT_VERSION",
  "UNKNOWN_APPLICATION_VALIDATION_CONTRACT_VERSION",
  "APPLICATION_SOURCE_METADATA_MISMATCH",
] as const;

export type ApplicationContractVersionErrorCode =
  (typeof applicationContractVersionErrorCodes)[number];

export class ApplicationContractVersionError extends Error {
  readonly code: ApplicationContractVersionErrorCode;

  constructor(code: ApplicationContractVersionErrorCode) {
    super(code);
    this.name = "ApplicationContractVersionError";
    this.code = code;
  }
}

export const applicationContractPair = {
  schema: "v2",
  sourceContractVersion: applicationSourceContractVersion,
  validationContractVersion: applicationValidationContractVersion,
} as const;

export type ApplicationContractPair = typeof applicationContractPair;

export const selectApplicationContractPair = (
  sourceContractVersion: string,
  validationContractVersion: string,
): ApplicationContractPair => {
  if (sourceContractVersion !== applicationSourceContractVersion)
    throw new ApplicationContractVersionError("UNKNOWN_APPLICATION_SOURCE_CONTRACT_VERSION");
  if (validationContractVersion !== applicationValidationContractVersion)
    throw new ApplicationContractVersionError("UNKNOWN_APPLICATION_VALIDATION_CONTRACT_VERSION");
  return applicationContractPair;
};

export const selectStoredApplicationSourceContract = (
  sourceContractVersion: string,
  intrinsicSourceContractVersion: string,
): "v2" => {
  if (sourceContractVersion !== intrinsicSourceContractVersion)
    throw new ApplicationContractVersionError("APPLICATION_SOURCE_METADATA_MISMATCH");
  if (sourceContractVersion !== applicationSourceContractVersion)
    throw new ApplicationContractVersionError("UNKNOWN_APPLICATION_SOURCE_CONTRACT_VERSION");
  return "v2";
};
