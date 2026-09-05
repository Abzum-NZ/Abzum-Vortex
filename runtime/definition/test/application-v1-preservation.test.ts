import fs from "node:fs";
import path from "node:path";
import {
  applicationCompilationOutputV1Schema,
  applicationDefinitionConsumerReadResultV1Schema,
  applicationDraftSchema,
  applicationDraftV1Schema,
  applicationSourceDocumentSchema,
  applicationSourceDocumentV1Schema,
  definitionCompilationOutputSchema,
  definitionConsumerReadResultSchema,
  definitionReleaseHistoryResultSchema,
  definitionResolutionSnapshotSchema,
  publishedApplicationDefinitionSchema,
  publishedApplicationDefinitionV1Schema,
  storedDefinitionDraftSchema,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { canonicalJson, fingerprintCanonicalValue } from "../src/canonical-json";
import { compileDefinition } from "../src/compiler";

const fixtureRoot = path.resolve(import.meta.dirname, "../../../testing/fixtures");
const sourceCandidate = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, "applications/crm.json"), "utf8"),
) as unknown;
const resolution = definitionResolutionSnapshotSchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "definition-resolution-snapshot.json"), "utf8"),
  ),
);

const organizationId = "10000000-0000-4000-a000-000000000001";
const actorId = "10000000-0000-4000-a000-000000000002";
const correlationId = "50000000-0000-4000-8000-000000000001";
const timestamp = "2026-09-04T00:00:00.000Z";
const restoredAt = "2026-09-04T00:00:01.000Z";

const source = applicationSourceDocumentV1Schema.parse(sourceCandidate);
const output = compileDefinition({
  source,
  resolution,
  draftMetadata: {
    organizationId,
    draftRevision: 1,
    createdAt: timestamp,
    createdBy: actorId,
    updatedAt: timestamp,
    updatedBy: actorId,
  },
  savedConditionRevisions: [],
});
if (output.kind !== "application") throw new Error("Application preservation fixture required");

const sourceFingerprint = fingerprintCanonicalValue(source);
const contentFingerprint = fingerprintCanonicalValue(output.canonical.content);
const published = {
  publication: {
    kind: "application" as const,
    rootId: output.canonical.envelope.rootId,
    revision: 1,
    releaseVersion: "1.0.0",
    contentFingerprint,
    publishedAt: timestamp,
    publishedBy: actorId,
    validationContractVersion: "1.0.0",
  },
  content: output.canonical.content,
  dependencyManifest: [],
  releaseNote: "Application V1 preservation fixture",
};
const consumerResult = {
  kind: "application" as const,
  organizationId,
  definitionKey: output.canonical.envelope.key,
  rootId: output.canonical.envelope.rootId,
  releaseRevision: 1,
  releaseVersion: "1.0.0",
  validationContractVersion: "1.0.0",
  contentFingerprint,
  resolutionFingerprint: output.resolutionFingerprint,
  content: output.canonical.content,
  dependencyManifest: [],
  correlationId,
};
const storedDraft = {
  kind: "application" as const,
  rootId: output.canonical.envelope.rootId,
  organizationId,
  key: source.key,
  draftRevision: 2,
  publishedRevision: 1,
  source,
  sourceContractVersion: "1.0.0",
  sourceFingerprint,
  createdAt: timestamp,
  createdBy: actorId,
  updatedAt: restoredAt,
  updatedBy: actorId,
  restoredFromReleaseRevision: 1,
  restoredFromSourceFingerprint: sourceFingerprint,
  restoredBy: actorId,
  restoredAt,
  restoreCorrelationId: correlationId,
};
const historyResult = {
  kind: "application" as const,
  organizationId,
  definitionKey: source.key,
  rootId: output.canonical.envelope.rootId,
  currentReleaseRevision: 1,
  entries: [
    {
      releaseRevision: 1,
      releaseVersion: "1.0.0",
      sourceFingerprint,
      contentFingerprint,
      releaseNote: "Application V1 preservation fixture",
      publishedAt: timestamp,
      publishedBy: actorId,
      isCurrent: true,
    },
  ],
  correlationId,
};

describe("Application V1 preservation", () => {
  it("keeps legacy and explicit V1 schemas byte-identical across existing boundaries", () => {
    expect(canonicalJson(applicationSourceDocumentV1Schema.parse(sourceCandidate))).toBe(
      canonicalJson(applicationSourceDocumentSchema.parse(sourceCandidate)),
    );
    expect(canonicalJson(applicationDraftV1Schema.parse(output.canonical))).toBe(
      canonicalJson(applicationDraftSchema.parse(output.canonical)),
    );
    expect(canonicalJson(applicationCompilationOutputV1Schema.parse(output))).toBe(
      canonicalJson(definitionCompilationOutputSchema.parse(output)),
    );
    expect(canonicalJson(publishedApplicationDefinitionV1Schema.parse(published))).toBe(
      canonicalJson(publishedApplicationDefinitionSchema.parse(published)),
    );
    expect(
      canonicalJson(applicationDefinitionConsumerReadResultV1Schema.parse(consumerResult)),
    ).toBe(canonicalJson(definitionConsumerReadResultSchema.parse(consumerResult)));
  });

  it("pins canonical bytes through authoritative SHA-256 fingerprints", () => {
    const actual = {
      source: fingerprintCanonicalValue(applicationSourceDocumentV1Schema.parse(sourceCandidate)),
      canonicalDraft: fingerprintCanonicalValue(applicationDraftV1Schema.parse(output.canonical)),
      canonicalContent: contentFingerprint,
      compilationOutput: fingerprintCanonicalValue(
        applicationCompilationOutputV1Schema.parse(output),
      ),
      published: fingerprintCanonicalValue(publishedApplicationDefinitionV1Schema.parse(published)),
      consumer: fingerprintCanonicalValue(
        applicationDefinitionConsumerReadResultV1Schema.parse(consumerResult),
      ),
      history: fingerprintCanonicalValue(definitionReleaseHistoryResultSchema.parse(historyResult)),
      restoredDraft: fingerprintCanonicalValue(storedDefinitionDraftSchema.parse(storedDraft)),
    };

    expect(actual).toEqual({
      source: "sha256:8882dd5f9d1b1ae949a0201637ae06ba14768bcdbdfa142564274e1acb601240",
      canonicalDraft: "sha256:1464d170e43273365fc7334009fd6043ab7b558c9f1de709cd66852bf003febc",
      canonicalContent: "sha256:65dd697f69b4bd9e29e19e1b531f1433cbef52f795a2abe693810dd7a9de9b3d",
      compilationOutput: "sha256:879f40cf9438c191550f3db8105f0eb99756766220f9b2fefbc56c68fbd77ab8",
      published: "sha256:2c32e11017e486746a42f8467ffcfffcb516560796dd7e98138c7908a8ad24b3",
      consumer: "sha256:d44fc695e175a54b9bb9b64d56a868fa21f06c13fdd5745db4e32ac45855757c",
      history: "sha256:d02626b9b9776cdcd809d6bea95a288d6cc9b433214374a0cf115736a3b0171d",
      restoredDraft: "sha256:f04309a3307f17973f2014d0ab8b80fc8a1613435d75c4c80c0ac045f5dc736a",
    });
  });

  it("does not inject version tags or defaults into existing V1 payloads", () => {
    expect(applicationSourceDocumentV1Schema.parse(sourceCandidate)).toEqual(sourceCandidate);
    expect(applicationDraftV1Schema.parse(output.canonical)).toEqual(output.canonical);
    expect(applicationCompilationOutputV1Schema.parse(output)).toEqual(output);
    expect(publishedApplicationDefinitionV1Schema.parse(published)).toEqual(published);
    expect(applicationDefinitionConsumerReadResultV1Schema.parse(consumerResult)).toEqual(
      consumerResult,
    );
    expect(definitionReleaseHistoryResultSchema.parse(historyResult)).toEqual(historyResult);
    expect(storedDefinitionDraftSchema.parse(storedDraft)).toEqual(storedDraft);
  });
});
