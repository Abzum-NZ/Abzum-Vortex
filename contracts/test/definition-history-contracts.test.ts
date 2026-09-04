import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applicationRootIdSchema,
  type DefinitionReleaseHistoryCommand,
  definitionReleaseHistoryCommandSchema,
  definitionReleaseHistoryResultSchema,
  definitionReleaseMetadataCommandSchema,
  definitionReleaseMetadataResultSchema,
  moduleRootIdSchema,
  restoreDefinitionDraftCommandSchema,
  storedDefinitionDraftSchema,
} from "../src";

const ids = {
  moduleRoot: "10000000-0000-4000-8000-000000000001",
  applicationRoot: "20000000-0000-4000-8000-000000000001",
  organization: "30000000-0000-4000-8000-000000000001",
  actor: "40000000-0000-4000-8000-000000000001",
  correlation: "50000000-0000-4000-8000-000000000001",
} as const;
const fingerprint = `sha256:${"a".repeat(64)}`;

const metadata = {
  releaseRevision: 2,
  releaseVersion: "1.0.1",
  sourceFingerprint: fingerprint,
  contentFingerprint: fingerprint,
  releaseNote: "Corrected generic configuration.",
  publishedAt: "2026-09-04T00:00:00Z",
  publishedBy: ids.actor,
  isCurrent: true,
} as const;

const historyResult = {
  kind: "module",
  rootId: ids.moduleRoot,
  organizationId: ids.organization,
  definitionKey: "example.generic_module",
  currentReleaseRevision: 2,
  entries: [
    metadata,
    { ...metadata, releaseRevision: 1, releaseVersion: "1.0.0", isCurrent: false },
  ],
  correlationId: ids.correlation,
} as const;

const moduleFixtureDirectory = path.resolve(import.meta.dirname, "../../testing/fixtures/modules");
const moduleSource = JSON.parse(
  fs.readFileSync(
    path.join(moduleFixtureDirectory, fs.readdirSync(moduleFixtureDirectory).sort()[0]!),
    "utf8",
  ),
);

const typeCheckedModuleCommand: DefinitionReleaseHistoryCommand = {
  kind: "module",
  rootId: moduleRootIdSchema.parse(ids.moduleRoot),
  pageSize: 1,
};
void typeCheckedModuleCommand;
// @ts-expect-error A branded Application root cannot be supplied to a Module command.
const wrongBrandedRoot: DefinitionReleaseHistoryCommand = {
  kind: "module",
  rootId: applicationRootIdSchema.parse(ids.applicationRoot),
  pageSize: 1,
};
void wrongBrandedRoot;

describe("definition history and restore contracts", () => {
  it("requires kind-matched Module or Application history, metadata and restore commands", () => {
    expect(
      definitionReleaseHistoryCommandSchema.safeParse({
        kind: "module",
        rootId: ids.moduleRoot,
        pageSize: 1,
      }).success,
    ).toBe(true);
    expect(
      definitionReleaseMetadataCommandSchema.safeParse({
        kind: "application",
        rootId: ids.applicationRoot,
        releaseRevision: 1,
      }).success,
    ).toBe(true);
    expect(
      restoreDefinitionDraftCommandSchema.safeParse({
        kind: "application",
        rootId: ids.applicationRoot,
        targetReleaseRevision: 1,
        expectedDraftRevision: 1,
      }).success,
    ).toBe(true);
  });

  it("bounds pages and refuses unsafe immutable revisions", () => {
    for (const pageSize of [0, 101, 1.5])
      expect(
        definitionReleaseHistoryCommandSchema.safeParse({
          kind: "module",
          rootId: ids.moduleRoot,
          pageSize,
        }).success,
      ).toBe(false);

    for (const revision of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        definitionReleaseHistoryCommandSchema.safeParse({
          kind: "module",
          rootId: ids.moduleRoot,
          pageSize: 1,
          beforeReleaseRevision: revision,
        }).success,
      ).toBe(false);
      expect(
        definitionReleaseMetadataCommandSchema.safeParse({
          kind: "module",
          rootId: ids.moduleRoot,
          releaseRevision: revision,
        }).success,
      ).toBe(false);
      expect(
        restoreDefinitionDraftCommandSchema.safeParse({
          kind: "module",
          rootId: ids.moduleRoot,
          targetReleaseRevision: revision,
          expectedDraftRevision: 1,
        }).success,
      ).toBe(false);
    }
  });

  it("refuses caller-supplied source or server-owned restore evidence", () => {
    expect(
      restoreDefinitionDraftCommandSchema.safeParse({
        kind: "module",
        rootId: ids.moduleRoot,
        targetReleaseRevision: 1,
        expectedDraftRevision: 1,
        source: moduleSource,
      }).success,
    ).toBe(false);
    expect(
      restoreDefinitionDraftCommandSchema.safeParse({
        kind: "module",
        rootId: ids.moduleRoot,
        targetReleaseRevision: 1,
        expectedDraftRevision: 1,
        restoredBy: ids.actor,
      }).success,
    ).toBe(false);
  });

  it("returns only ordered safe metadata with a structurally valid continuation", () => {
    expect(definitionReleaseHistoryResultSchema.parse(historyResult)).toEqual(historyResult);
    expect(
      definitionReleaseHistoryResultSchema.safeParse({
        ...historyResult,
        entries: [...historyResult.entries].reverse(),
      }).success,
    ).toBe(false);
    expect(
      definitionReleaseHistoryResultSchema.safeParse({
        ...historyResult,
        nextBeforeReleaseRevision: 2,
      }).success,
    ).toBe(false);
    expect(
      definitionReleaseHistoryResultSchema.safeParse({
        ...historyResult,
        entries: [{ ...metadata, isCurrent: false }],
      }).success,
    ).toBe(false);
    expect(
      definitionReleaseHistoryResultSchema.safeParse({
        ...historyResult,
        authoredSource: moduleSource,
      }).success,
    ).toBe(false);
    expect(
      definitionReleaseHistoryResultSchema.safeParse({
        ...historyResult,
        entries: [{ ...metadata, compilationOutput: {} }],
      }).success,
    ).toBe(false);
  });

  it("keeps exact metadata projection strict and pointer-consistent", () => {
    const exactResult = { ...historyResult, metadata, entries: undefined };
    expect(definitionReleaseMetadataResultSchema.safeParse(exactResult).success).toBe(false);
    expect(
      definitionReleaseMetadataResultSchema.safeParse({
        kind: "module",
        rootId: ids.moduleRoot,
        organizationId: ids.organization,
        definitionKey: "example.generic_module",
        currentReleaseRevision: 2,
        metadata,
        correlationId: ids.correlation,
      }).success,
    ).toBe(true);
    expect(
      definitionReleaseMetadataResultSchema.safeParse({
        kind: "module",
        rootId: ids.moduleRoot,
        organizationId: ids.organization,
        definitionKey: "example.generic_module",
        currentReleaseRevision: 1,
        metadata,
        correlationId: ids.correlation,
      }).success,
    ).toBe(false);
    expect(
      definitionReleaseMetadataResultSchema.safeParse({
        kind: "module",
        rootId: ids.moduleRoot,
        organizationId: ids.organization,
        definitionKey: "example.generic_module",
        currentReleaseRevision: 2,
        metadata: { ...metadata, isCurrent: false },
        correlationId: ids.correlation,
      }).success,
    ).toBe(false);
  });

  it("requires restore provenance to be wholly present or wholly absent", () => {
    const draft = {
      kind: "module",
      rootId: ids.moduleRoot,
      organizationId: ids.organization,
      key: "example.generic_module",
      draftRevision: 3,
      source: moduleSource,
      sourceContractVersion: "1.0.0",
      sourceFingerprint: fingerprint,
      createdAt: "2026-09-04T00:00:00Z",
      createdBy: ids.actor,
      updatedAt: "2026-09-04T00:00:00Z",
      updatedBy: ids.actor,
    } as const;
    expect(storedDefinitionDraftSchema.safeParse(draft).success).toBe(true);
    expect(
      storedDefinitionDraftSchema.safeParse({
        ...draft,
        restoredFromReleaseRevision: 2,
      }).success,
    ).toBe(false);
    expect(
      storedDefinitionDraftSchema.safeParse({
        ...draft,
        restoredFromReleaseRevision: 2,
        restoredFromSourceFingerprint: fingerprint,
        restoredBy: ids.actor,
        restoredAt: "2026-09-04T00:00:00Z",
        restoreCorrelationId: ids.correlation,
      }).success,
    ).toBe(true);
    expect(
      storedDefinitionDraftSchema.safeParse({
        ...draft,
        restoredFromReleaseRevision: 2,
        restoredFromSourceFingerprint: fingerprint,
        restoredBy: "60000000-0000-4000-8000-000000000001",
        restoredAt: "2026-09-04T00:00:00Z",
        restoreCorrelationId: ids.correlation,
      }).success,
    ).toBe(false);
  });
});
