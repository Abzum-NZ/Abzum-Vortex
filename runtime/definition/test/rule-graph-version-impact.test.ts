import { moduleDraftV2Schema, type ModuleDraftV2, type ModuleDraftV3 } from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { compileDefinition, compileDefinitionWithContext } from "../src/compiler";
import { compareDefinitionVersionImpact } from "../src/version-impact";
import { graphModuleRequests } from "./module-v3-fixtures";

const timestamp = "2026-09-09T00:00:00+00:00";
const publisherId = "10000000-0000-4000-8000-000000000002";

const compiledDraft = (): ModuleDraftV3 => {
  const requests = graphModuleRequests();
  const shared = compileDefinition(requests[0]!);
  return compileDefinitionWithContext(requests[1]!, {
    dependencyOutputs: [shared],
  }).canonical;
};

const historyEntry = (
  draft: ModuleDraftV2 | ModuleDraftV3,
  validationContractVersion: "2.0.0" | "3.0.0",
) => ({
  publication: {
    kind: "module" as const,
    rootId: draft.envelope.rootId,
    revision: 1,
    releaseVersion: "1.0.0",
    contentFingerprint: fingerprintCanonicalValue(draft.content),
    publishedAt: timestamp,
    publishedBy: publisherId,
    validationContractVersion,
  },
  content: structuredClone(draft.content),
  dependencyManifest: [],
  releaseNote: "Published graph definition.",
});

const nextDraft = (draft: ModuleDraftV3): ModuleDraftV3 => {
  const candidate = structuredClone(draft);
  candidate.envelope.draftRevision = 2;
  candidate.envelope.publishedRevision = 1;
  return candidate;
};

describe("Module V3 graph version impact", () => {
  it("assigns the initial Module V3 release", () => {
    expect(
      compareDefinitionVersionImpact({
        kind: "module",
        validationContractVersion: "3.0.0",
        history: [],
        candidate: compiledDraft(),
      }),
    ).toMatchObject({ outcome: "initial_release", assignedVersion: "1.0.0" });
  });

  it("treats V2 to V3 as an explicit major representation transition", () => {
    const v3 = compiledDraft();
    const v2 = moduleDraftV2Schema.parse({
      ...v3,
      content: { ...v3.content, rules: [] },
    });
    const candidate = nextDraft(v3);

    expect(
      compareDefinitionVersionImpact({
        kind: "module",
        validationContractVersion: "3.0.0",
        history: [historyEntry(v2, "2.0.0")],
        candidate,
      }),
    ).toMatchObject({
      outcome: "release_required",
      impact: "major",
      assignedVersion: "2.0.0",
      reasons: [{ impact: "major", code: "existing_behavior_changed" }],
    });
  });

  it("requires a major release for an existing graph behavior change", () => {
    const previous = compiledDraft();
    const candidate = nextDraft(previous);
    candidate.content.rules[0]!.priority += 1;

    expect(
      compareDefinitionVersionImpact({
        kind: "module",
        validationContractVersion: "3.0.0",
        history: [historyEntry(previous, "3.0.0")],
        candidate,
      }),
    ).toMatchObject({
      outcome: "release_required",
      impact: "major",
      assignedVersion: "2.0.0",
      reasons: [
        expect.objectContaining({
          impact: "major",
          code: "existing_behavior_changed",
          location: expect.objectContaining({ componentKind: "rule" }),
        }),
      ],
    });
  });

  it("keeps an unchanged canonical V3 graph at no change", () => {
    const previous = compiledDraft();
    expect(
      compareDefinitionVersionImpact({
        kind: "module",
        validationContractVersion: "3.0.0",
        history: [historyEntry(previous, "3.0.0")],
        candidate: nextDraft(previous),
      }),
    ).toMatchObject({ outcome: "no_change", currentVersion: "1.0.0", reasons: [] });
  });
});
