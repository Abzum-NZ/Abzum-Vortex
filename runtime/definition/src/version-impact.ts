import {
  applicationContentSchema,
  applicationContentV2Schema,
  applicationVersionImpactPolicyVersionV2,
  applicationVersionImpactRequestV2Schema,
  moduleContentSchema,
  moduleContentV2Schema,
  moduleVersionImpactPolicyVersionV2,
  moduleVersionImpactRequestV2Schema,
  unresolvedRecordTypeReferencePaths,
  definitionVersionConfirmationSchema,
  definitionVersionImpactRequestSchema,
  definitionVersionImpactResultSchema,
  stableDefinitionReleaseVersionSchema,
  versionImpactPolicyVersion,
  type DefinitionVersionConfirmation,
  type DefinitionVersionImpactRequest,
  type DefinitionVersionImpactResult,
  type DefinitionVersionSubject,
  type ApplicationVersionImpactRequestV2,
  type ModuleVersionImpactRequestV2,
  type PublishedApplicationDefinition,
  type VersionImpact,
} from "@vortex/contracts";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json";
import {
  assertUnambiguousApplicationContent,
  assertUnambiguousApplicationContentV2,
  assertUnambiguousModuleContent,
  compareApplicationContents,
  compareApplicationContentsV2,
  compareModuleContents,
  normaliseApplicationContent,
  normaliseApplicationContentV2,
  normaliseModuleContent,
} from "./comparison-policy";
import { assignNextDefinitionVersion, compareStableVersions } from "./semantic-version";
import { refuseVersionImpact } from "./version-impact-error";

type SupportedVersionImpactRequest =
  DefinitionVersionImpactRequest | ApplicationVersionImpactRequestV2 | ModuleVersionImpactRequestV2;

const isApplicationV2Request = (
  request: SupportedVersionImpactRequest,
): request is ApplicationVersionImpactRequestV2 =>
  request.kind === "application" &&
  "validationContractVersion" in request &&
  request.validationContractVersion === "2.0.0";

const isModuleV2Request = (
  request: SupportedVersionImpactRequest,
): request is ModuleVersionImpactRequestV2 =>
  request.kind === "module" &&
  "validationContractVersion" in request &&
  request.validationContractVersion === "2.0.0";

const isApplicationV2Release = (
  release: PublishedApplicationDefinition,
): release is Extract<
  PublishedApplicationDefinition,
  { publication: { validationContractVersion: "2.0.0" } }
> => release.publication.validationContractVersion === "2.0.0";

const isModuleV2Release = (release: {
  publication: { validationContractVersion: string };
}): boolean => release.publication.validationContractVersion === "2.0.0";

const subjectOf = (request: SupportedVersionImpactRequest): DefinitionVersionSubject =>
  request.kind === "module"
    ? { definitionKind: "module", rootId: request.candidate.envelope.rootId }
    : { definitionKind: "application", rootId: request.candidate.envelope.rootId };

const highestImpact = (reasons: DefinitionVersionImpactResult["reasons"]): VersionImpact => {
  const ranks = { patch: 0, minor: 1, major: 2 } as const;
  return reasons.reduce(
    (highest, reason) => (ranks[reason.impact] > ranks[highest] ? reason.impact : highest),
    "patch" as VersionImpact,
  );
};

const assertHistory = (request: SupportedVersionImpactRequest): void => {
  const rootId = request.candidate.envelope.rootId;
  const history = request.history;
  for (const [index, release] of history.entries()) {
    if (release.publication.rootId !== rootId) refuseVersionImpact("root_mismatch");
    if (release.publication.kind !== request.kind) refuseVersionImpact("invalid_history");
    if (!stableDefinitionReleaseVersionSchema.safeParse(release.publication.releaseVersion).success)
      refuseVersionImpact("invalid_history");
    if (index === 0 && release.publication.releaseVersion !== "1.0.0")
      refuseVersionImpact("invalid_history");
    if (release.publication.contentFingerprint !== fingerprintCanonicalValue(release.content))
      refuseVersionImpact("content_fingerprint_mismatch");
    if (request.kind === "module") {
      const releaseV2 = isModuleV2Release(release);
      if (
        unresolvedRecordTypeReferencePaths(
          releaseV2 ? moduleContentV2Schema : moduleContentSchema,
          release.content,
        ).length > 0
      )
        refuseVersionImpact("invalid_history");
      assertUnambiguousModuleContent(release.content);
    } else {
      const applicationRelease = release as PublishedApplicationDefinition;
      const v2 = isApplicationV2Release(applicationRelease);
      if (
        unresolvedRecordTypeReferencePaths(
          v2 ? applicationContentV2Schema : applicationContentSchema,
          applicationRelease.content,
        ).length > 0
      )
        refuseVersionImpact("invalid_history");
      if (v2) assertUnambiguousApplicationContentV2(applicationRelease.content);
      else assertUnambiguousApplicationContent(applicationRelease.content);
    }
    const previous = history[index - 1];
    if (
      previous &&
      (release.publication.revision <= previous.publication.revision ||
        compareStableVersions(
          release.publication.releaseVersion,
          previous.publication.releaseVersion,
        ) <= 0)
    )
      refuseVersionImpact("invalid_history");
  }

  const latest = history.at(-1);
  if (latest === undefined) {
    if (request.candidate.envelope.publishedRevision !== undefined)
      refuseVersionImpact("invalid_history");
    return;
  }
  if (
    request.candidate.envelope.publishedRevision !== latest.publication.revision ||
    request.candidate.envelope.draftRevision <= latest.publication.revision
  )
    refuseVersionImpact("invalid_history");
};

const comparisonFingerprint = (
  subject: DefinitionVersionSubject,
  latest: SupportedVersionImpactRequest["history"][number] | undefined,
  exactCandidateContentFingerprint: `sha256:${string}`,
  resultWithoutFingerprint: unknown,
  policyVersion:
    | typeof versionImpactPolicyVersion
    | typeof applicationVersionImpactPolicyVersionV2 = versionImpactPolicyVersion,
): `sha256:${string}` =>
  fingerprintCanonicalValue({
    policyVersion,
    subject,
    previousRelease:
      latest === undefined
        ? null
        : {
            revision: latest.publication.revision,
            releaseVersion: latest.publication.releaseVersion,
            contentFingerprint: latest.publication.contentFingerprint,
          },
    candidateContentFingerprint: exactCandidateContentFingerprint,
    result: resultWithoutFingerprint,
  });

/**
 * Computes the minimum compatible release without reading state or publishing.
 * All refusals use a closed safe code through DefinitionVersionImpactError.
 */
export const compareDefinitionVersionImpact = (input: unknown): DefinitionVersionImpactResult => {
  const explicitKind =
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.prototype.hasOwnProperty.call(input, "validationContractVersion")
      ? (input as { kind?: unknown }).kind
      : undefined;
  const parsed =
    explicitKind === "module"
      ? moduleVersionImpactRequestV2Schema.safeParse(input)
      : explicitKind === "application"
        ? applicationVersionImpactRequestV2Schema.safeParse(input)
        : definitionVersionImpactRequestSchema.safeParse(input);
  if (!parsed.success) {
    const duplicateIdentity = parsed.error.issues.some(
      (issue) => issue.message.includes("duplicated") || issue.message.includes("must be unique"),
    );
    return refuseVersionImpact(
      duplicateIdentity ? "ambiguous_component_identity" : "invalid_request",
    );
  }
  const request: SupportedVersionImpactRequest = parsed.data;
  if (
    unresolvedRecordTypeReferencePaths(
      request.kind === "module"
        ? isModuleV2Request(request)
          ? moduleContentV2Schema
          : moduleContentSchema
        : isApplicationV2Request(request)
          ? applicationContentV2Schema
          : applicationContentSchema,
      request.candidate.content,
    ).length > 0
  )
    refuseVersionImpact("unresolved_candidate");
  assertHistory(request);

  const subject = subjectOf(request);
  const latest = request.history.at(-1);
  const exactCandidateContentFingerprint = fingerprintCanonicalValue(request.candidate.content);
  if (request.kind === "module") assertUnambiguousModuleContent(request.candidate.content);
  else if (isApplicationV2Request(request))
    assertUnambiguousApplicationContentV2(request.candidate.content);
  else assertUnambiguousApplicationContent(request.candidate.content);

  const normalisedCandidate =
    request.kind === "module"
      ? normaliseModuleContent(request.candidate.content as never)
      : isApplicationV2Request(request)
        ? normaliseApplicationContentV2(request.candidate.content)
        : normaliseApplicationContent(request.candidate.content);
  const policyVersion = isApplicationV2Request(request)
    ? applicationVersionImpactPolicyVersionV2
    : isModuleV2Request(request)
      ? moduleVersionImpactPolicyVersionV2
      : versionImpactPolicyVersion;

  if (latest === undefined) {
    const resultWithoutFingerprint = {
      subject,
      outcome: "initial_release" as const,
      assignedVersion: "1.0.0" as const,
      reasons: [],
    };
    return definitionVersionImpactResultSchema.parse({
      ...resultWithoutFingerprint,
      comparisonFingerprint: comparisonFingerprint(
        subject,
        latest,
        exactCandidateContentFingerprint,
        resultWithoutFingerprint,
        policyVersion,
      ),
    });
  }

  let normalisedPrevious: unknown;
  let reasons: DefinitionVersionImpactResult["reasons"];
  let representationChanged = false;
  if (request.kind === "module") {
    const latestModule = request.history.at(-1)!;
    const candidateV2 = isModuleV2Request(request);
    const latestV2 = isModuleV2Release(latestModule);
    representationChanged = candidateV2 !== latestV2;
    if (representationChanged) {
      normalisedPrevious = latestModule.content;
      reasons = [
        {
          impact: "major",
          code: "existing_behavior_changed",
          location: { componentKind: "module", property: "configuration" },
        },
      ];
    } else {
      normalisedPrevious = normaliseModuleContent(latestModule.content as never);
      assertUnambiguousModuleContent(latestModule.content);
      reasons = compareModuleContents(
        normalisedPrevious as ReturnType<typeof normaliseModuleContent>,
        normalisedCandidate as ReturnType<typeof normaliseModuleContent>,
      );
    }
  } else {
    const latestApplication = request.history.at(-1)! as PublishedApplicationDefinition;
    const candidateV2 = isApplicationV2Request(request);
    const latestV2 = isApplicationV2Release(latestApplication);
    representationChanged = candidateV2 !== latestV2;
    if (representationChanged) {
      normalisedPrevious = latestApplication.content;
      reasons = [
        {
          impact: "major",
          code: "existing_behavior_changed",
          location: {
            componentKind: "application",
            property: "configuration",
          },
        },
      ];
    } else if (candidateV2 && latestV2) {
      normalisedPrevious = normaliseApplicationContentV2(latestApplication.content);
      assertUnambiguousApplicationContentV2(latestApplication.content);
      reasons = compareApplicationContentsV2(
        normalisedPrevious as ReturnType<typeof normaliseApplicationContentV2>,
        normalisedCandidate as ReturnType<typeof normaliseApplicationContentV2>,
      );
    } else if (!candidateV2 && !latestV2) {
      normalisedPrevious = normaliseApplicationContent(latestApplication.content);
      assertUnambiguousApplicationContent(latestApplication.content);
      reasons = compareApplicationContents(
        normalisedPrevious as ReturnType<typeof normaliseApplicationContent>,
        normalisedCandidate as ReturnType<typeof normaliseApplicationContent>,
      );
    } else return refuseVersionImpact("invalid_history");
  }
  if (
    !representationChanged &&
    canonicalJson(normalisedPrevious) === canonicalJson(normalisedCandidate)
  ) {
    const resultWithoutFingerprint = {
      subject,
      outcome: "no_change" as const,
      currentVersion: latest.publication.releaseVersion,
      reasons: [],
    };
    return definitionVersionImpactResultSchema.parse({
      ...resultWithoutFingerprint,
      comparisonFingerprint: comparisonFingerprint(
        subject,
        latest,
        exactCandidateContentFingerprint,
        resultWithoutFingerprint,
        policyVersion,
      ),
    });
  }

  if (reasons.length === 0) refuseVersionImpact("invalid_request");
  const impact = highestImpact(reasons);
  const resultWithoutFingerprint = {
    subject,
    outcome: "release_required" as const,
    currentVersion: latest.publication.releaseVersion,
    impact,
    assignedVersion: assignNextDefinitionVersion(latest.publication.releaseVersion, impact),
    reasons,
  };
  return definitionVersionImpactResultSchema.parse({
    ...resultWithoutFingerprint,
    comparisonFingerprint: comparisonFingerprint(
      subject,
      latest,
      exactCandidateContentFingerprint,
      resultWithoutFingerprint,
      policyVersion,
    ),
  });
};

/** Recomputes the decision so a stale or altered confirmation cannot be used. */
export const confirmDefinitionVersionImpact = (
  input: unknown,
  confirmationInput: unknown,
): ConfirmableDefinitionVersionImpactResult => {
  const confirmation = definitionVersionConfirmationSchema.safeParse(confirmationInput);
  if (!confirmation.success) return refuseVersionImpact("confirmation_mismatch");
  const result = compareDefinitionVersionImpact(input);
  if (result.outcome === "no_change") return refuseVersionImpact("no_release_to_confirm");
  const confirmable = result as ConfirmableDefinitionVersionImpactResult;
  assertConfirmationMatches(confirmable, confirmation.data);
  return confirmable;
};

type ConfirmableDefinitionVersionImpactResult = Extract<
  DefinitionVersionImpactResult,
  { outcome: "initial_release" | "release_required" }
>;

const assertConfirmationMatches = (
  result: ConfirmableDefinitionVersionImpactResult,
  confirmation: DefinitionVersionConfirmation,
): void => {
  if (
    !sameSubject(result.subject, confirmation.subject) ||
    result.comparisonFingerprint !== confirmation.comparisonFingerprint ||
    result.assignedVersion !== confirmation.assignedVersion
  )
    refuseVersionImpact("confirmation_mismatch");
};

const sameSubject = (left: DefinitionVersionSubject, right: DefinitionVersionSubject): boolean =>
  left.definitionKind === right.definitionKind && left.rootId === right.rootId;
