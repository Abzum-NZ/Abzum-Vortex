import fs from "node:fs";
import path from "node:path";
import {
  applicationContractPairV1,
  applicationSourceDocumentSchema,
  applicationSourceDocumentV1Schema,
  selectApplicationContractPair,
  selectApplicationSourceContract,
  selectApplicationValidationContract,
  selectStoredApplicationSourceContract,
} from "../src";
import { describe, expect, it } from "vitest";

const applicationSource = JSON.parse(
  fs.readFileSync(
    path.resolve(import.meta.dirname, "../../testing/fixtures/applications/crm.json"),
    "utf8",
  ),
) as unknown;

const expectVersionError = (operation: () => unknown, code: string) => {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected Application contract version error ${code}`);
};

describe("Application contract version selection", () => {
  it("keeps the legacy source schema as an exact V1 alias without changing bytes", () => {
    const legacy = applicationSourceDocumentSchema.parse(applicationSource);
    const explicitV1 = applicationSourceDocumentV1Schema.parse(applicationSource);

    expect(explicitV1).toEqual(applicationSource);
    expect(JSON.stringify(explicitV1)).toBe(JSON.stringify(legacy));
  });

  it("selects only the exact implemented V1 source, validation and pair", () => {
    expect(selectApplicationSourceContract("1.0.0")).toBe("v1");
    expect(selectApplicationValidationContract("1.0.0")).toBe("v1");
    expect(selectApplicationContractPair("1.0.0", "1.0.0")).toBe(applicationContractPairV1);
  });

  it("rejects unknown versions rather than inferring from shape or semantic-version major", () => {
    expectVersionError(
      () => selectApplicationSourceContract("1.0.1"),
      "UNKNOWN_APPLICATION_SOURCE_CONTRACT_VERSION",
    );
    expectVersionError(
      () => selectApplicationValidationContract("3.0.0"),
      "UNKNOWN_APPLICATION_VALIDATION_CONTRACT_VERSION",
    );
  });

  it("distinguishes unsupported pairs from the reserved but unimplemented V2 pair", () => {
    expectVersionError(
      () => selectApplicationContractPair("1.0.0", "2.0.0"),
      "UNSUPPORTED_APPLICATION_CONTRACT_VERSION_PAIR",
    );
    expectVersionError(
      () => selectApplicationContractPair("2.0.0", "1.0.0"),
      "UNSUPPORTED_APPLICATION_CONTRACT_VERSION_PAIR",
    );
    expectVersionError(
      () => selectApplicationContractPair("2.0.0", "2.0.0"),
      "APPLICATION_CONTRACT_DECODER_NOT_IMPLEMENTED",
    );
  });

  it("rejects persisted source metadata disagreement before selecting a decoder", () => {
    expect(selectStoredApplicationSourceContract("1.0.0", "1.0.0")).toBe("v1");
    expectVersionError(
      () => selectStoredApplicationSourceContract("1.0.0", "2.0.0"),
      "APPLICATION_SOURCE_METADATA_MISMATCH",
    );
  });
});
