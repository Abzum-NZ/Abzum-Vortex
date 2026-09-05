import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDefinitionRootCommandSchema,
  saveDefinitionDraftCommandSchema,
  storedDefinitionDraftSchema,
} from "../src";

const moduleSource = JSON.parse(
  fs.readFileSync(
    path.resolve(import.meta.dirname, "../../testing/fixtures/modules/crm.tags.json"),
    "utf8",
  ),
);
const applicationSource = JSON.parse(
  fs.readFileSync(
    path.resolve(import.meta.dirname, "../../testing/fixtures/applications/crm.json"),
    "utf8",
  ),
);

describe("definition-store contracts", () => {
  it("accepts authored Module source without a caller-supplied permanent root", () => {
    expect(createDefinitionRootCommandSchema.parse({ source: moduleSource })).toEqual({
      source: moduleSource,
    });
    expect(
      createDefinitionRootCommandSchema.safeParse({
        rootId: "10000000-0000-4000-8000-000000000001",
        source: moduleSource,
      }).success,
    ).toBe(false);
  });

  it("binds saves to a permanent root and expected JavaScript-safe positive revision", () => {
    expect(
      saveDefinitionDraftCommandSchema.safeParse({
        rootId: "10000000-0000-4000-8000-000000000001",
        expectedDraftRevision: 1,
        source: moduleSource,
      }).success,
    ).toBe(true);
    expect(
      saveDefinitionDraftCommandSchema.safeParse({
        rootId: "10000000-0000-4000-8000-000000000001",
        expectedDraftRevision: 0,
        source: moduleSource,
      }).success,
    ).toBe(false);
  });

  it("refuses stored evidence whose source does not match its root kind", () => {
    expect(
      storedDefinitionDraftSchema.safeParse({
        kind: "application",
        rootId: "10000000-0000-4000-8000-000000000001",
        organizationId: "20000000-0000-4000-8000-000000000001",
        key: "example.module",
        draftRevision: 1,
        sourceContractVersion: "1.0.0",
        sourceFingerprint: `sha256:${"a".repeat(64)}`,
        source: moduleSource,
        createdAt: "2026-09-04T00:00:00Z",
        createdBy: "30000000-0000-4000-8000-000000000001",
        updatedAt: "2026-09-04T00:00:00Z",
        updatedBy: "30000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
  });

  it("refuses Application source metadata that disagrees with the authored source", () => {
    expect(
      storedDefinitionDraftSchema.safeParse({
        kind: "application",
        rootId: "10000000-0000-4000-8000-000000000001",
        organizationId: "20000000-0000-4000-8000-000000000001",
        key: applicationSource.key,
        draftRevision: 1,
        sourceContractVersion: "1.0.1",
        sourceFingerprint: `sha256:${"a".repeat(64)}`,
        source: applicationSource,
        createdAt: "2026-09-04T00:00:00Z",
        createdBy: "30000000-0000-4000-8000-000000000001",
        updatedAt: "2026-09-04T00:00:00Z",
        updatedBy: "30000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
  });
});
