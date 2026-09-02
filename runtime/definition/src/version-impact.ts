import {
  definitionVersionConfirmationSchema,
  definitionVersionImpactRequestSchema,
  definitionVersionImpactResultSchema,
  stableDefinitionReleaseVersionSchema,
  versionImpactPolicyVersion,
  type DefinitionVersionConfirmation,
  type DefinitionVersionImpactRequest,
  type DefinitionVersionImpactResult,
  type DefinitionVersionSubject,
  type VersionImpact,
} from "@vortex/contracts";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json";
import {
  assertUnambiguousApplicationContent,
  assertUnambiguousModuleContent,
  compareApplicationContents,
  compareModuleContents,
  normaliseApplicationContent,
  normaliseModuleContent,
} from "./comparison-policy";
import { assignNextDefinitionVersion, compareStableVersions } from "./semantic-version";
import { refuseVersionImpact } from "./version-impact-error";

const containsUnresolvedReference = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsUnresolvedReference);
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.state === "unresolved" && typeof record.qualifiedKey === "string") return true;
  return Object.values(record).some(containsUnresolvedReference);
};

const subjectOf = (request: DefinitionVersionImpactRequest): DefinitionVersionSubject =>
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

const assertHistory = (request: DefinitionVersionImpactRequest): void => {
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
    if (request.kind === "module") assertUnambiguousModuleContent(release.content);
    else assertUnambiguousApplicationContent(release.content);
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
  latest: DefinitionVersionImpactRequest["history"][number] | undefined,
  exactCandidateContentFingerprint: `sha256:${string}`,
  resultWithoutFingerprint: unknown,
): `sha256:${string}` =>
  fingerprintCanonicalValue({
    policyVersion: versionImpactPolicyVersion,
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
  const parsed = definitionVersionImpactRequestSchema.safeParse(input);
  if (!parsed.success) {
    const duplicateIdentity = parsed.error.issues.some(
      (issue) => issue.message.includes("duplicated") || issue.message.includes("must be unique"),
    );
    return refuseVersionImpact(
      duplicateIdentity ? "ambiguous_component_identity" : "invalid_request",
    );
  }
  const request = parsed.data;
  if (containsUnresolvedReference(request.candidate.content))
    refuseVersionImpact("unresolved_candidate");
  assertHistory(request);

  const subject = subjectOf(request);
  const latest = request.history.at(-1);
  const exactCandidateContentFingerprint = fingerprintCanonicalValue(request.candidate.content);
  if (request.kind === "module") assertUnambiguousModuleContent(request.candidate.content);
  else assertUnambiguousApplicationContent(request.candidate.content);

  const normalisedCandidate =
    request.kind === "module"
      ? normaliseModuleContent(request.candidate.content)
      : normaliseApplicationContent(request.candidate.content);

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
      ),
    });
  }

  let normalisedPrevious: unknown;
  let reasons: DefinitionVersionImpactResult["reasons"];
  if (request.kind === "module") {
    const latestModule = request.history.at(-1)!;
    normalisedPrevious = normaliseModuleContent(latestModule.content);
    assertUnambiguousModuleContent(latestModule.content);
    reasons = compareModuleContents(
      normalisedPrevious as ReturnType<typeof normaliseModuleContent>,
      normalisedCandidate as ReturnType<typeof normaliseModuleContent>,
    );
  } else {
    const latestApplication = request.history.at(-1)!;
    normalisedPrevious = normaliseApplicationContent(latestApplication.content);
    assertUnambiguousApplicationContent(latestApplication.content);
    reasons = compareApplicationContents(
      normalisedPrevious as ReturnType<typeof normaliseApplicationContent>,
      normalisedCandidate as ReturnType<typeof normaliseApplicationContent>,
    );
  }
  if (canonicalJson(normalisedPrevious) === canonicalJson(normalisedCandidate)) {
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
