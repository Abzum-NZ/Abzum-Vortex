import { definitionSourceContractVersion } from "./definition-source-common";

export const applicationSourceContractVersionV1 = definitionSourceContractVersion;
export const applicationValidationContractVersionV1 = "1.0.0" as const;

/** V2 schemas exist, but the pair remains unavailable until compiler/runtime support is complete. */
export const applicationSourceContractVersionV2 = "2.0.0" as const;
export const applicationValidationContractVersionV2 = "2.0.0" as const;
export const plannedApplicationSourceContractVersionV2 = applicationSourceContractVersionV2;
export const plannedApplicationValidationContractVersionV2 = applicationValidationContractVersionV2;

export const applicationContractVersionErrorCodes = [
  "UNKNOWN_APPLICATION_SOURCE_CONTRACT_VERSION",
  "UNKNOWN_APPLICATION_VALIDATION_CONTRACT_VERSION",
  "UNSUPPORTED_APPLICATION_CONTRACT_VERSION_PAIR",
  "APPLICATION_CONTRACT_DECODER_NOT_IMPLEMENTED",
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

export const applicationContractPairV1 = {
  schema: "v1",
  sourceContractVersion: applicationSourceContractVersionV1,
  validationContractVersion: applicationValidationContractVersionV1,
} as const;

export type ApplicationContractPair = typeof applicationContractPairV1;

const knownSourceVersions = new Set<string>([
  applicationSourceContractVersionV1,
  plannedApplicationSourceContractVersionV2,
]);
const knownValidationVersions = new Set<string>([
  applicationValidationContractVersionV1,
  plannedApplicationValidationContractVersionV2,
]);

export const selectApplicationSourceContract = (sourceContractVersion: string): "v1" => {
  if (!knownSourceVersions.has(sourceContractVersion))
    throw new ApplicationContractVersionError("UNKNOWN_APPLICATION_SOURCE_CONTRACT_VERSION");
  if (sourceContractVersion === plannedApplicationSourceContractVersionV2)
    throw new ApplicationContractVersionError("APPLICATION_CONTRACT_DECODER_NOT_IMPLEMENTED");
  return "v1";
};

export const selectApplicationValidationContract = (validationContractVersion: string): "v1" => {
  if (!knownValidationVersions.has(validationContractVersion))
    throw new ApplicationContractVersionError("UNKNOWN_APPLICATION_VALIDATION_CONTRACT_VERSION");
  if (validationContractVersion === plannedApplicationValidationContractVersionV2)
    throw new ApplicationContractVersionError("APPLICATION_CONTRACT_DECODER_NOT_IMPLEMENTED");
  return "v1";
};

export const selectApplicationContractPair = (
  sourceContractVersion: string,
  validationContractVersion: string,
): ApplicationContractPair => {
  if (!knownSourceVersions.has(sourceContractVersion))
    throw new ApplicationContractVersionError("UNKNOWN_APPLICATION_SOURCE_CONTRACT_VERSION");
  if (!knownValidationVersions.has(validationContractVersion))
    throw new ApplicationContractVersionError("UNKNOWN_APPLICATION_VALIDATION_CONTRACT_VERSION");
  if (
    sourceContractVersion === applicationSourceContractVersionV1 &&
    validationContractVersion === applicationValidationContractVersionV1
  )
    return applicationContractPairV1;
  if (
    sourceContractVersion === plannedApplicationSourceContractVersionV2 &&
    validationContractVersion === plannedApplicationValidationContractVersionV2
  )
    throw new ApplicationContractVersionError("APPLICATION_CONTRACT_DECODER_NOT_IMPLEMENTED");
  throw new ApplicationContractVersionError("UNSUPPORTED_APPLICATION_CONTRACT_VERSION_PAIR");
};

export const selectStoredApplicationSourceContract = (
  sourceContractVersion: string,
  intrinsicSourceContractVersion: string,
): "v1" => {
  if (sourceContractVersion !== intrinsicSourceContractVersion)
    throw new ApplicationContractVersionError("APPLICATION_SOURCE_METADATA_MISMATCH");
  return selectApplicationSourceContract(sourceContractVersion);
};
