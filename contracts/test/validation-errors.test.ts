import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  correlationIdSchema,
  definitionValidationCatalogueSchema,
  definitionValidationCatalogueVersion,
  definitionDocumentKindSchema,
  definitionLocationSegmentKindSchema,
  definitionRuleFailureFamilySchema,
  definitionValidationErrorCatalogue,
  definitionValidationErrorCodes,
  definitionValidationResultSchema,
  publicDefinitionValidationErrorSchema,
  translateDefinitionRuleFailures,
  translateDefinitionSchemaError,
} from "../src";
import { connectionTypeSourceDocumentSchema } from "./support/definition-fixture-schemas";

const correlationId = correlationIdSchema.parse("00000000-0000-4000-8000-000000000013");
const rootLocation = {
  documentKind: "module" as const,
  documentKey: "example.definition",
  segments: [],
};
const mappedLocation = {
  ...rootLocation,
  segments: [{ kind: "field" as const, key: "example_value" }],
};
const context = {
  correlationId,
  rootLocation,
  pathMap: [{ sourcePath: ["body", "values", 0], location: mappedLocation }],
  requiredPaths: [["body", "required_value"]],
};
const validSourceDefinition = {
  schema_version: "2.0.0",
  kind: "connection_type" as const,
  root_id: "example_connection",
  key: "example.connection",
  version: "1.0.0",
  revision: 1,
  state: "published" as const,
  content_fingerprint: "fixture:example.connection:1.0.0",
  body: {
    name: "Example connection",
    purpose: "Submit a typed request to an approved example provider.",
    provider: "Example provider",
    authentication: {
      kind: "signed_secret" as const,
      secret_fields: ["signing_secret"],
      algorithm: "hmac_sha256" as const,
    },
    allowed_hosts: ["api.example.test"],
    allow_redirects: false,
    shapes: [
      { key: "request", fields: [{ key: "value", type: "text" as const, required: true }] },
      { key: "receipt", fields: [{ key: "accepted", type: "boolean" as const, required: true }] },
    ],
    operations: [
      {
        key: "submit",
        method: "POST" as const,
        path: "/submit",
        input: "request",
        output: "receipt",
        timeout_seconds: 10,
        max_attempts: 2,
        maximum_response_bytes: 1_000_000,
      },
    ],
    incoming_messages: [],
  },
};
type BrokenSourceDefinitionCase = Readonly<{
  name: string;
  mutate: (value: Record<string, unknown>) => void;
  expectedCode: (typeof definitionValidationErrorCodes)[number];
  requiredPaths?: (string | number)[][];
}>;
const bodyOf = (value: Record<string, unknown>) => value.body as Record<string, unknown>;
const authenticationOf = (value: Record<string, unknown>) =>
  bodyOf(value).authentication as Record<string, unknown>;
const firstOperationOf = (value: Record<string, unknown>) =>
  (bodyOf(value).operations as Record<string, unknown>[])[0] as Record<string, unknown>;
const brokenSourceDefinitionCases: BrokenSourceDefinitionCase[] = [
  {
    name: "missing required key",
    mutate: (value) => {
      delete value.key;
    },
    expectedCode: "definition_required_value",
    requiredPaths: [["key"]],
  },
  {
    name: "malformed root alias",
    mutate: (value) => {
      value.root_id = "Not Allowed";
    },
    expectedCode: "definition_invalid_value",
  },
  {
    name: "unknown top-level property",
    mutate: (value) => {
      value.unexpected = true;
    },
    expectedCode: "definition_unknown_property",
  },
  {
    name: "malformed release version",
    mutate: (value) => {
      value.version = "first";
    },
    expectedCode: "definition_invalid_value",
  },
  {
    name: "non-positive revision",
    mutate: (value) => {
      value.revision = 0;
    },
    expectedCode: "definition_invalid_value",
  },
  {
    name: "empty display name",
    mutate: (value) => {
      bodyOf(value).name = "";
    },
    expectedCode: "definition_invalid_value",
  },
  {
    name: "unsupported authentication algorithm",
    mutate: (value) => {
      authenticationOf(value).algorithm = "unsupported";
    },
    expectedCode: "definition_unsupported_choice",
  },
  {
    name: "no secret fields",
    mutate: (value) => {
      authenticationOf(value).secret_fields = [];
    },
    expectedCode: "definition_too_few_items",
  },
  {
    name: "no allowed hosts",
    mutate: (value) => {
      bodyOf(value).allowed_hosts = [];
    },
    expectedCode: "definition_too_few_items",
  },
  {
    name: "malformed allowed host",
    mutate: (value) => {
      bodyOf(value).allowed_hosts = ["HTTPS://EXAMPLE"];
    },
    expectedCode: "definition_invalid_value",
  },
  {
    name: "no operations",
    mutate: (value) => {
      bodyOf(value).operations = [];
    },
    expectedCode: "definition_too_few_items",
  },
  {
    name: "unsupported operation method",
    mutate: (value) => {
      firstOperationOf(value).method = "CONNECT";
    },
    expectedCode: "definition_unsupported_choice",
  },
  {
    name: "non-positive operation timeout",
    mutate: (value) => {
      firstOperationOf(value).timeout_seconds = 0;
    },
    expectedCode: "definition_invalid_value",
  },
  {
    name: "operation retry count above its limit",
    mutate: (value) => {
      firstOperationOf(value).max_attempts = 11;
    },
    expectedCode: "definition_invalid_value",
  },
];

function schemaError(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("The test input was expected to fail schema validation");
  return result.error;
}

describe("safe definition validation errors", () => {
  test("keeps test-only scenarios and storage evidence out of the public location contract", () => {
    expect(definitionDocumentKindSchema.safeParse("module").success).toBe(true);
    expect(definitionDocumentKindSchema.safeParse("acceptance_scenario").success).toBe(false);
    expect(definitionDocumentKindSchema.safeParse("storage_layout").success).toBe(false);
    expect(definitionLocationSegmentKindSchema.safeParse("record_type").success).toBe(true);
    expect(definitionLocationSegmentKindSchema.safeParse("scenario").success).toBe(false);
    expect(definitionLocationSegmentKindSchema.safeParse("storage").success).toBe(false);
  });

  test("publishes one immutable catalogue entry for every approved code", () => {
    expect(Object.keys(definitionValidationErrorCatalogue)).toEqual([
      ...definitionValidationErrorCodes,
    ]);
    expect(new Set(definitionValidationErrorCodes).size).toBe(15);
    expect(
      definitionValidationCatalogueSchema.safeParse(definitionValidationErrorCatalogue).success,
    ).toBe(true);
    expect(
      definitionValidationCatalogueSchema.safeParse({
        ...definitionValidationErrorCatalogue,
        definition_unapproved_code: {
          order: 2_000,
          message: "Unapproved.",
          guidance: "Unapproved.",
        },
      }).success,
    ).toBe(false);
    const incompleteCatalogue: Record<string, unknown> = {
      ...definitionValidationErrorCatalogue,
    };
    delete incompleteCatalogue.definition_validation_failed;
    expect(definitionValidationCatalogueSchema.safeParse(incompleteCatalogue).success).toBe(false);
    expect(Object.isFrozen(definitionValidationErrorCatalogue)).toBe(true);
    for (const entry of Object.values(definitionValidationErrorCatalogue)) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  test("locks version 1.0.0 public wording independently of the implementation", () => {
    expect(definitionValidationCatalogueVersion).toBe("1.0.0");
    expect(definitionValidationErrorCatalogue).toEqual({
      definition_required_value: {
        order: 10,
        message: "A required value is missing.",
        guidance: "Provide the required value and validate the definition again.",
      },
      definition_invalid_value: {
        order: 20,
        message: "A value is not valid for this definition.",
        guidance: "Check the value type and format, then validate the definition again.",
      },
      definition_unsupported_choice: {
        order: 30,
        message: "A selected value is not supported.",
        guidance: "Choose one of the values supported by the current contract version.",
      },
      definition_unknown_property: {
        order: 40,
        message: "The definition contains an unknown property.",
        guidance: "Remove the property or use one supported by the current contract version.",
      },
      definition_too_few_items: {
        order: 50,
        message: "The definition does not contain enough items.",
        guidance: "Add the required number of items and validate the definition again.",
      },
      definition_too_many_items: {
        order: 60,
        message: "The definition contains too many items.",
        guidance: "Remove excess items and validate the definition again.",
      },
      definition_duplicate_key: {
        order: 70,
        message: "A key is used more than once in the same scope.",
        guidance: "Give every item in that scope a unique key.",
      },
      definition_broken_reference: {
        order: 80,
        message: "A reference does not match its target.",
        guidance: "Update the reference so it points to a compatible target.",
      },
      definition_unresolved_reference: {
        order: 90,
        message: "A referenced definition could not be found.",
        guidance: "Add the referenced definition or correct the referenced key.",
      },
      definition_scope_conflict: {
        order: 100,
        message: "A definition is used outside its allowed scope.",
        guidance: "Move the definition or reference into a compatible scope.",
      },
      definition_incompatible_version: {
        order: 110,
        message: "A referenced version is not compatible.",
        guidance: "Use a compatible version or update the dependent definition.",
      },
      definition_dependency_cycle: {
        order: 120,
        message: "The definition contains a dependency cycle.",
        guidance: "Remove one dependency so the definitions can be evaluated in order.",
      },
      definition_unsafe_content: {
        order: 130,
        message: "The definition contains content that cannot be published safely.",
        guidance: "Remove the unsafe content and use an approved reference where required.",
      },
      definition_incompatible_change: {
        order: 140,
        message: "The definition change is not compatible with its published contract.",
        guidance: "Make a compatible change or publish it through the required version process.",
      },
      definition_validation_failed: {
        order: 1_000,
        message: "The definition could not be validated.",
        guidance: "Review the definition and use the correlation identifier if support is needed.",
      },
    });
  });

  test.each([
    ["required_value", "definition_required_value"],
    ["invalid_value", "definition_invalid_value"],
    ["unsupported_choice", "definition_unsupported_choice"],
    ["unknown_property", "definition_unknown_property"],
    ["too_few_items", "definition_too_few_items"],
    ["too_many_items", "definition_too_many_items"],
    ["duplicate_key", "definition_duplicate_key"],
    ["broken_reference", "definition_broken_reference"],
    ["unresolved_reference", "definition_unresolved_reference"],
    ["scope_conflict", "definition_scope_conflict"],
    ["incompatible_version", "definition_incompatible_version"],
    ["dependency_cycle", "definition_dependency_cycle"],
    ["unsafe_content", "definition_unsafe_content"],
    ["incompatible_change", "definition_incompatible_change"],
  ] as const)("translates the %s rule family", (family, expectedCode) => {
    expect(definitionRuleFailureFamilySchema.safeParse(family).success).toBe(true);
    const result = translateDefinitionRuleFailures(
      [{ ruleCode: `definition.${family}`, family }],
      context,
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe(expectedCode);
    expect(result.errors[0]?.message).toBe(
      definitionValidationErrorCatalogue[expectedCode].message,
    );
    expect(result.errors[0]?.guidance).toBe(
      definitionValidationErrorCatalogue[expectedCode].guidance,
    );
    expect(definitionValidationResultSchema.safeParse(result).success).toBe(true);
  });

  test.each(brokenSourceDefinitionCases)(
    "translates a real broken source definition: $name",
    ({ mutate, expectedCode, requiredPaths = [] }) => {
      const definition = structuredClone(validSourceDefinition) as Record<string, unknown>;
      mutate(definition);
      const result = translateDefinitionSchemaError(
        schemaError(connectionTypeSourceDocumentSchema, definition),
        {
          ...context,
          requiredPaths,
        },
      );
      expect(result.errors.some((error) => error.code === expectedCode)).toBe(true);
    },
  );

  test("translates structured schema issues without using their messages", () => {
    const schema = z
      .object({
        body: z
          .object({
            required_value: z.string(),
            values: z
              .array(z.enum(["first", "second"]))
              .min(2)
              .max(3),
          })
          .strict(),
      })
      .strict();
    const result = translateDefinitionSchemaError(
      schemaError(schema, {
        body: { values: ["not_supported"], ignored_private_name: "do not expose" },
      }),
      context,
    );
    expect(new Set(result.errors.map((error) => error.code))).toEqual(
      new Set([
        "definition_required_value",
        "definition_unsupported_choice",
        "definition_too_few_items",
        "definition_unknown_property",
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("ignored_private_name");
    expect(JSON.stringify(result)).not.toContain("not_supported");
  });

  test("uses only an explicit safe location map and otherwise returns the document root", () => {
    const schema = z.object({ body: z.object({ values: z.array(z.string()) }) });
    const mapped = translateDefinitionSchemaError(
      schemaError(schema, { body: { values: [12] } }),
      context,
    );
    expect(mapped.errors[0]?.location).toEqual(mappedLocation);

    const unmapped = translateDefinitionSchemaError(
      schemaError(z.object({ hidden_internal_path: z.string() }), { hidden_internal_path: 12 }),
      context,
    );
    expect(unmapped.errors[0]?.location).toEqual(rootLocation);
    expect(JSON.stringify(unmapped)).not.toContain("hidden_internal_path");
  });

  test("produces deterministic, de-duplicated output independent of input order", () => {
    const failures = [
      { ruleCode: "definition.second", family: "dependency_cycle" as const },
      { ruleCode: "definition.first", family: "duplicate_key" as const },
      { ruleCode: "definition.repeated", family: "duplicate_key" as const },
    ];
    const forward = translateDefinitionRuleFailures(failures, context);
    const reverse = translateDefinitionRuleFailures([...failures].reverse(), context);
    expect(forward).toEqual(reverse);
    expect(forward.errors.map((error) => error.code)).toEqual([
      "definition_duplicate_key",
      "definition_dependency_cycle",
    ]);
  });

  test("uses a safe fallback for a future schema issue kind", () => {
    const futureError = new z.ZodError([
      { code: "future_issue", path: ["private", "path"], message: "private detail" } as never,
    ]);
    const result = translateDefinitionSchemaError(futureError, context);
    expect(result.errors[0]?.code).toBe("definition_validation_failed");
    expect(JSON.stringify(result)).not.toContain("private detail");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  test("keeps every adversarial diagnostic detail behind the optional protected sink", () => {
    const details: unknown[] = [];
    const unsafeDetail = [
      "credential=private-value",
      "SELECT protected_column FROM internal_table",
      "Error: private stack at internal.ts:12",
      "raw.path.0",
      "private submitted value",
      "00000000-0000-4000-8000-000000000099",
      "ZodError",
      "another organisation exists",
    ].join(" | ");
    const error = schemaError(
      z.string().superRefine((_value, issueContext) => {
        issueContext.addIssue({ code: "custom", message: unsafeDetail });
      }),
      "value",
    );
    const diagnostics: unknown[] = [];
    const result = translateDefinitionSchemaError(error, context, (diagnostic) => {
      diagnostics.push(diagnostic);
      details.push(diagnostic.detail);
    });
    expect(JSON.stringify(details)).toContain(unsafeDetail);
    expect(diagnostics).toMatchObject([{ correlationId, source: "schema" }]);
    for (const unsafePart of unsafeDetail.split(" | ")) {
      expect(JSON.stringify(result)).not.toContain(unsafePart);
    }
  });

  test("returns the same stable result for different raw wording", () => {
    const errorWith = (message: string) =>
      new z.ZodError([{ code: "custom", path: ["body"], message }]);
    const first = translateDefinitionSchemaError(errorWith("first internal wording"), context);
    const second = translateDefinitionSchemaError(errorWith("changed internal wording"), context);
    expect(first).toEqual(second);
  });

  test("does not let a diagnostic sink failure change public validation", () => {
    const result = translateDefinitionRuleFailures(
      [{ ruleCode: "definition.value", family: "invalid_value" }],
      context,
      () => {
        throw new Error("diagnostic destination unavailable");
      },
    );
    expect(result.errors[0]?.code).toBe("definition_invalid_value");
  });

  test("rejects caller-written public messages and hidden identifiers", () => {
    const valid = translateDefinitionRuleFailures(
      [{ ruleCode: "definition.value", family: "invalid_value" }],
      context,
    ).errors[0];
    expect(valid).toBeDefined();
    expect(
      publicDefinitionValidationErrorSchema.safeParse({
        ...valid,
        message: "Internal table 00000000-0000-4000-8000-000000000099 failed",
      }).success,
    ).toBe(false);
    expect(
      publicDefinitionValidationErrorSchema.safeParse({
        ...valid,
        internalPath: ["private", "table"],
      }).success,
    ).toBe(false);
  });

  test("returns the fallback when a rule producer violates its handoff contract", () => {
    const result = translateDefinitionRuleFailures(
      [{ ruleCode: "invalid rule code", family: "invalid_value" }] as never,
      context,
    );
    expect(result.errors.map((error) => error.code)).toEqual(["definition_validation_failed"]);
  });

  test("returns the fallback when a schema producer violates its handoff contract", () => {
    const result = translateDefinitionSchemaError({ issues: null } as never, context);
    expect(result.errors.map((error) => error.code)).toEqual(["definition_validation_failed"]);
    expect(result.correlationId).toBe(correlationId);
  });

  test("returns the fallback when location context violates its handoff contract", () => {
    const error = schemaError(z.object({ value: z.string() }), { value: 1 });
    const invalidContext = { ...context, rootLocation: { privateIdentifier: "hidden" } };
    const schemaResult = translateDefinitionSchemaError(error, invalidContext as never);
    const ruleResult = translateDefinitionRuleFailures(
      [{ ruleCode: "definition.value", family: "invalid_value" }],
      invalidContext as never,
    );
    for (const result of [schemaResult, ruleResult]) {
      expect(result.correlationId).toBe(correlationId);
      expect(result.errors.map((item) => item.code)).toEqual(["definition_validation_failed"]);
      expect(JSON.stringify(result)).not.toContain("hidden");
    }
  });

  test("keeps the author guide's invalid, public-result, and corrected examples executable", async () => {
    const guide = await readFile(resolve(process.cwd(), "contracts/VALIDATION_ERRORS.md"), "utf8");
    const jsonBlocks = [...guide.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((match) =>
      JSON.parse(match[1] as string),
    );
    expect(jsonBlocks).toHaveLength(3);
    expect(connectionTypeSourceDocumentSchema.safeParse(jsonBlocks[0]).success).toBe(false);
    expect(definitionValidationResultSchema.safeParse(jsonBlocks[1]).success).toBe(true);
    expect(connectionTypeSourceDocumentSchema.safeParse(jsonBlocks[2]).success).toBe(true);
  });

  test("keeps every runtime translator and public default independent of shipped examples", async () => {
    const fixtureRoot = resolve(process.cwd(), "testing/fixtures");
    const manifest = JSON.parse(
      await readFile(resolve(fixtureRoot, "fixture-set.json"), "utf8"),
    ) as { files: string[] };
    const documents = await Promise.all(
      manifest.files.map(async (file) =>
        JSON.parse(await readFile(resolve(fixtureRoot, file), "utf8")),
      ),
    );
    const runtimeSource = (
      await readFile(resolve(process.cwd(), "contracts/src/validation-errors.ts"), "utf8")
    ).toLowerCase();
    const publicGuidance = (
      await Promise.all(
        ["contracts/VALIDATION_ERRORS.md", "contracts/README.md"].map((file) =>
          readFile(resolve(process.cwd(), file), "utf8"),
        ),
      )
    )
      .join("\n")
      .toLowerCase();

    for (const document of documents as { key?: unknown; body?: { name?: unknown } }[]) {
      if (typeof document.key === "string") {
        expect(runtimeSource).not.toContain(document.key.toLowerCase());
        expect(publicGuidance).not.toContain(document.key.toLowerCase());
      }
      if (typeof document.body?.name === "string") {
        expect(runtimeSource).not.toContain(document.body.name.toLowerCase());
        expect(publicGuidance).not.toContain(document.body.name.toLowerCase());
      }
    }

    const runtimeTokens = new Set(runtimeSource.match(/[a-z0-9_]+/g) ?? []);
    const permittedGenericTokens = new Set([
      "a",
      "an",
      "application",
      "connection",
      "detail",
      "interface",
      "new",
      "pipeline",
      "public",
      "publish",
      "published",
      "record",
      "review",
      "role",
      "scenario",
      "source",
      "storage",
      "value",
    ]);
    const authoredKeys = new Set<string>();
    const collectKeys = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(collectKeys);
      if (typeof value !== "object" || value === null) return;
      for (const [property, child] of Object.entries(value)) {
        if ((property === "key" || property.endsWith("_key")) && typeof child === "string") {
          for (const token of child.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
            if (!permittedGenericTokens.has(token)) authoredKeys.add(token);
          }
        }
        collectKeys(child);
      }
    };
    documents.forEach(collectKeys);
    for (const authoredKey of authoredKeys) expect(runtimeTokens).not.toContain(authoredKey);
  });
});
