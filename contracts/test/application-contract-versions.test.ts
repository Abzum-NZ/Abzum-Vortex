import fs from "node:fs";
import path from "node:path";
import {
  applicationContractPairV1,
  applicationContractPairV2,
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

  it("accepts the shared saved-condition scope shape and keeps it closed", () => {
    const scoped = structuredClone(applicationSourceDocumentV1Schema.parse(applicationSource));
    const permission = scoped.body.permissions.find(
      (entry) => entry.key === "application.crm.shared_cases.read",
    );
    if (!permission) throw new Error("Application permission fixture required");
    permission.record_type = "vortex.service_desk.cases:case";
    permission.action_kind = "read";
    delete permission.named_action;
    permission.record_scope = {
      routes: [{ kind: "all_records" }],
      saved_condition: {
        condition: "matching_priority",
        parameter_bindings: [{ key: "allowed_priority", source: "literal", value: "high" }],
      },
    };

    expect(applicationSourceDocumentV1Schema.parse(scoped)).toEqual(scoped);
    expect(
      applicationSourceDocumentV1Schema.safeParse({
        ...scoped,
        body: {
          ...scoped.body,
          permissions: scoped.body.permissions.map((entry) =>
            entry.key === permission.key
              ? {
                  ...entry,
                  record_scope: {
                    ...entry.record_scope,
                    saved_condition: {
                      ...entry.record_scope?.saved_condition,
                      untrusted: true,
                    },
                  },
                }
              : entry,
          ),
        },
      }).success,
    ).toBe(false);
  });

  it("selects only the exact implemented V1 and V2 source, validation and pairs", () => {
    expect(selectApplicationSourceContract("1.0.0")).toBe("v1");
    expect(selectApplicationValidationContract("1.0.0")).toBe("v1");
    expect(selectApplicationContractPair("1.0.0", "1.0.0")).toBe(applicationContractPairV1);
    expect(selectApplicationSourceContract("2.0.0")).toBe("v2");
    expect(selectApplicationValidationContract("2.0.0")).toBe("v2");
    expect(selectApplicationContractPair("2.0.0", "2.0.0")).toBe(applicationContractPairV2);
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

  it("rejects unsupported mixed contract pairs", () => {
    expectVersionError(
      () => selectApplicationContractPair("1.0.0", "2.0.0"),
      "UNSUPPORTED_APPLICATION_CONTRACT_VERSION_PAIR",
    );
    expectVersionError(
      () => selectApplicationContractPair("2.0.0", "1.0.0"),
      "UNSUPPORTED_APPLICATION_CONTRACT_VERSION_PAIR",
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
