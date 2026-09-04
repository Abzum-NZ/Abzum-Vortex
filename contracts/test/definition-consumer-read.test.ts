import { describe, expect, it } from "vitest";
import { definitionConsumerReadCommandSchema, definitionConsumerReadResultSchema } from "../src";

const ids = {
  root: "10000000-0000-4000-8000-000000000001",
  organization: "20000000-0000-4000-8000-000000000001",
  recordType: "30000000-0000-4000-8000-000000000001",
  field: "40000000-0000-4000-8000-000000000001",
  storageContract: "50000000-0000-4000-8000-000000000001",
  correlation: "60000000-0000-4000-8000-000000000001",
  dependency: "70000000-0000-4000-8000-000000000001",
} as const;
const fingerprint = `sha256:${"a".repeat(64)}`;

const moduleContent = {
  name: "Reusable definition",
  description: "A generic canonical module used only to exercise the public contract.",
  dependencies: [],
  recordTypes: [
    {
      recordTypeId: ids.recordType,
      key: "item",
      singularLabel: "Item",
      pluralLabel: "Items",
      titleFieldId: ids.field,
      storageContractId: ids.storageContract,
      storageScope: "organization_shared",
      ownershipMode: "none",
      fields: [
        {
          fieldId: ids.field,
          key: "title",
          label: "Title",
          required: true,
          unique: false,
          filterable: true,
          sortable: true,
          personalData: "none",
          publicDisplay: "refused",
          type: "text",
          settings: { maxLength: 120 },
        },
      ],
      relationships: [],
      standardActions: ["create", "read"],
      customActionIds: [],
    },
  ],
  permissions: [],
  actions: [],
  events: [],
  rules: [],
  sharingConditions: [],
  extensionPoints: [],
} as const;

const moduleResult = {
  kind: "module",
  rootId: ids.root,
  organizationId: ids.organization,
  definitionKey: "example.definition",
  releaseRevision: 1,
  releaseVersion: "1.0.0",
  validationContractVersion: "1.0.0",
  contentFingerprint: fingerprint,
  resolutionFingerprint: fingerprint,
  content: moduleContent,
  dependencyManifest: [
    {
      kind: "module",
      key: "example.dependency",
      rootId: ids.dependency,
      releaseRevision: 1,
      releaseVersion: "1.0.0",
      contentFingerprint: fingerprint,
      resolutionFingerprint: fingerprint,
    },
  ],
  correlationId: ids.correlation,
} as const;

describe("definition consumer read contracts", () => {
  it("requires a kind-matched root and one explicit current or exact revision selector", () => {
    expect(
      definitionConsumerReadCommandSchema.safeParse({
        kind: "module",
        rootId: ids.root,
        selector: { selection: "current" },
      }).success,
    ).toBe(true);
    expect(
      definitionConsumerReadCommandSchema.safeParse({
        kind: "application",
        rootId: ids.root,
        selector: { selection: "revision", releaseRevision: 1 },
      }).success,
    ).toBe(true);
    expect(
      definitionConsumerReadCommandSchema.safeParse({
        kind: "module",
        rootId: ids.root,
      }).success,
    ).toBe(false);
    expect(
      definitionConsumerReadCommandSchema.safeParse({
        kind: "module",
        rootId: ids.root,
        selector: { selection: "revision", releaseRevision: Number.MAX_SAFE_INTEGER + 1 },
      }).success,
    ).toBe(false);
  });

  it("returns only a complete exact canonical release projection", () => {
    expect(definitionConsumerReadResultSchema.parse(moduleResult)).toEqual(moduleResult);
    expect(
      definitionConsumerReadResultSchema.safeParse({
        ...moduleResult,
        authoredSource: {},
      }).success,
    ).toBe(false);
    expect(
      definitionConsumerReadResultSchema.safeParse({
        ...moduleResult,
        cacheMetadata: { state: "fresh" },
      }).success,
    ).toBe(false);
    expect(
      definitionConsumerReadResultSchema.safeParse({
        ...moduleResult,
        publication: { publishedAt: "2026-09-04T00:00:00Z" },
      }).success,
    ).toBe(false);
  });

  it("requires a complete manifest in deterministic subject order", () => {
    expect(
      definitionConsumerReadResultSchema.safeParse({
        ...moduleResult,
        dependencyManifest: [
          moduleResult.dependencyManifest[0],
          {
            ...moduleResult.dependencyManifest[0],
            key: "example.additional",
            rootId: "80000000-0000-4000-8000-000000000001",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      definitionConsumerReadResultSchema.safeParse({
        ...moduleResult,
        dependencyManifest: [
          moduleResult.dependencyManifest[0],
          { ...moduleResult.dependencyManifest[0] },
        ],
      }).success,
    ).toBe(false);
  });
});
