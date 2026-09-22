import {
  applicationContentV2Schema,
  applicationVersionImpactPolicyVersionV2,
  applicationVersionImpactRequestV2Schema,
  definitionPublicationHistoryEvidenceSchema,
  moduleContentV3Schema,
  moduleVersionImpactPolicyVersionV3,
  moduleVersionImpactRequestV3Schema,
  publishedDefinitionHistorySchema,
  unresolvedRecordTypeReferencePaths,
  definitionVersionConfirmationSchema,
  definitionVersionImpactRequestSchema,
  definitionVersionImpactResultSchema,
  stableDefinitionReleaseVersionSchema,
  type DefinitionVersionConfirmation,
  type DefinitionPublicationHistoryEvidence,
  type DefinitionVersionImpactRequest,
  type DefinitionVersionImpactResult,
  type DefinitionVersionSubject,
  type ApplicationVersionImpactRequestV2,
  type ModuleVersionImpactRequestV3,
  type PublishedApplicationDefinition,
  type PublishedDefinitionHistory,
  type SavedConditionRevisionAssignment,
  type VersionImpact,
} from "@vortex/contracts";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json";
import {
  assertUnambiguousApplicationContentV2,
  assertUnambiguousModuleContent,
  compareApplicationContentsV2,
  compareModuleContents,
  normaliseApplicationContentV2,
  normaliseModuleContent,
} from "./comparison-policy";
import { assignNextDefinitionVersion, compareStableVersions } from "./semantic-version";
import { refuseVersionImpact } from "./version-impact-error";
import {
  createSavedConditionRevisionFold,
  deriveSavedConditionRevisions,
  foldSavedConditionRelease,
  type SavedConditionLike,
  type SavedConditionRevisionFold,
} from "./saved-condition-revisions";

type SupportedVersionImpactRequest =
  | DefinitionVersionImpactRequest
  | ApplicationVersionImpactRequestV2
  | ModuleVersionImpactRequestV3;

type HistoryRelease = SupportedVersionImpactRequest["history"][number];

export type DefinitionPublicationHistoryFold = {
  readonly kind: "module" | "application";
  readonly definitionKey: string;
  readonly rootId: string;
  readonly anchorReleaseRevision: number | null;
  previousRelease: HistoryRelease | undefined;
  releaseCount: number;
  validationContractVersions: Set<string>;
  savedConditionFold: SavedConditionRevisionFold | undefined;
};

const activeHistoryFolds = new WeakSet<object>();
const verifiedHistoryEvidence = new WeakSet<object>();
const savedConditionEvidence = new WeakMap<object, SavedConditionRevisionFold>();

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

const assertHistoryRelease = (
  kind: "module" | "application",
  rootId: string,
  release: HistoryRelease,
  index: number,
  previous: HistoryRelease | undefined,
): void => {
  if (release.publication.rootId !== rootId) refuseVersionImpact("root_mismatch");
  if (release.publication.kind !== kind) refuseVersionImpact("invalid_history");
  if (!stableDefinitionReleaseVersionSchema.safeParse(release.publication.releaseVersion).success)
    refuseVersionImpact("invalid_history");
  if (index === 0 && release.publication.releaseVersion !== "1.0.0")
    refuseVersionImpact("invalid_history");
  if (release.publication.contentFingerprint !== fingerprintCanonicalValue(release.content))
    refuseVersionImpact("content_fingerprint_mismatch");
  if (kind === "module") {
    if (unresolvedRecordTypeReferencePaths(moduleContentV3Schema, release.content).length > 0)
      refuseVersionImpact("invalid_history");
    assertUnambiguousModuleContent(release.content);
  } else {
    const applicationRelease = release as PublishedApplicationDefinition;
    if (
      unresolvedRecordTypeReferencePaths(applicationContentV2Schema, applicationRelease.content)
        .length > 0
    )
      refuseVersionImpact("invalid_history");
    assertUnambiguousApplicationContentV2(applicationRelease.content);
  }
  if (
    previous &&
    (release.publication.revision <= previous.publication.revision ||
      compareStableVersions(
        release.publication.releaseVersion,
        previous.publication.releaseVersion,
      ) <= 0)
  )
    refuseVersionImpact("invalid_history");
};

const assertCandidateHistoryBinding = (
  request: SupportedVersionImpactRequest,
  latest: HistoryRelease | undefined,
): void => {
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

const assertHistory = (request: SupportedVersionImpactRequest): void => {
  const rootId = request.candidate.envelope.rootId;
  const history = request.history;
  for (const [index, release] of history.entries())
    assertHistoryRelease(request.kind, rootId, release, index, history[index - 1]);
  assertCandidateHistoryBinding(request, history.at(-1));
};

/** Starts one bounded-memory audit over an immutable publication history. */
export const createDefinitionPublicationHistoryFold = (
  input: Readonly<{
    kind: "module" | "application";
    definitionKey: string;
    rootId: string;
    anchorReleaseRevision: number | null;
  }>,
): DefinitionPublicationHistoryFold => {
  if (input.anchorReleaseRevision !== null && !Number.isSafeInteger(input.anchorReleaseRevision))
    refuseVersionImpact("invalid_history");
  const fold: DefinitionPublicationHistoryFold = {
    ...input,
    previousRelease: undefined,
    releaseCount: 0,
    validationContractVersions: new Set(),
    savedConditionFold:
      input.kind === "module" ? createSavedConditionRevisionFold(input.rootId) : undefined,
  };
  activeHistoryFolds.add(fold);
  return fold;
};

/** Audits one release and retains only the prior ordering facts and latest release. */
export const foldDefinitionPublicationHistoryRelease = (
  fold: DefinitionPublicationHistoryFold,
  entry: Readonly<{
    previousReleaseRevision: number | null;
    release: HistoryRelease;
  }>,
): void => {
  if (!activeHistoryFolds.has(fold)) refuseVersionImpact("invalid_history");
  const expectedPrevious = fold.previousRelease?.publication.revision ?? null;
  if (entry.previousReleaseRevision !== expectedPrevious) refuseVersionImpact("invalid_history");
  assertHistoryRelease(
    fold.kind,
    fold.rootId,
    entry.release,
    fold.releaseCount,
    fold.previousRelease,
  );
  if (fold.savedConditionFold !== undefined) {
    if (entry.release.publication.kind !== "module") refuseVersionImpact("invalid_history");
    foldSavedConditionRelease(
      fold.savedConditionFold,
      entry.release as Parameters<typeof foldSavedConditionRelease>[1],
    );
  }
  fold.validationContractVersions.add(entry.release.publication.validationContractVersion);
  fold.previousRelease = entry.release;
  fold.releaseCount += 1;
};

const evidenceDigests = new WeakMap<object, string>();

/** Completes an audit only when its anchored count and latest pointer were fully observed. */
export const completeDefinitionPublicationHistoryFold = (
  fold: DefinitionPublicationHistoryFold,
): DefinitionPublicationHistoryEvidence => {
  if (!activeHistoryFolds.delete(fold)) refuseVersionImpact("invalid_history");
  const latestRelease = fold.previousRelease;
  if (
    (latestRelease?.publication.revision ?? null) !== fold.anchorReleaseRevision ||
    (fold.releaseCount === 0) !== (fold.anchorReleaseRevision === null)
  )
    refuseVersionImpact("invalid_history");
  const parsed = definitionPublicationHistoryEvidenceSchema.safeParse({
    kind: fold.kind,
    definitionKey: fold.definitionKey,
    rootId: fold.rootId,
    releaseCount: fold.releaseCount,
    anchorReleaseRevision: fold.anchorReleaseRevision,
    validationContractVersions: [...fold.validationContractVersions].sort(),
    latestRelease: latestRelease ?? null,
  });
  if (!parsed.success) refuseVersionImpact("invalid_history");
  const evidence = parsed.data as DefinitionPublicationHistoryEvidence;
  verifiedHistoryEvidence.add(evidence);
  evidenceDigests.set(evidence, fingerprintCanonicalValue(evidence));
  if (fold.savedConditionFold !== undefined)
    savedConditionEvidence.set(evidence, fold.savedConditionFold);
  return evidence;
};

export const isVerifiedDefinitionPublicationHistoryEvidence = (
  evidence: unknown,
): evidence is DefinitionPublicationHistoryEvidence =>
  typeof evidence === "object" &&
  evidence !== null &&
  verifiedHistoryEvidence.has(evidence) &&
  evidenceDigests.get(evidence) === fingerprintCanonicalValue(evidence);

export const deriveSavedConditionRevisionsFromHistoryEvidence = (
  evidence: DefinitionPublicationHistoryEvidence,
  rootId: string,
  conditions: readonly SavedConditionLike[],
): SavedConditionRevisionAssignment[] => {
  if (
    !isVerifiedDefinitionPublicationHistoryEvidence(evidence) ||
    evidence.kind !== "module" ||
    evidence.rootId !== rootId
  )
    refuseVersionImpact(evidence.rootId !== rootId ? "root_mismatch" : "invalid_history");
  const fold = savedConditionEvidence.get(evidence);
  if (fold === undefined) refuseVersionImpact("invalid_history");
  return deriveSavedConditionRevisions({ rootId, conditions, history: [], fold });
};

/** Converts the existing bounded public array contract into the same verified fold. */
export const verifyPublishedDefinitionHistory = (
  history: PublishedDefinitionHistory,
  rootId: string,
  anchorReleaseRevision: number | null,
): DefinitionPublicationHistoryEvidence => {
  const parsed = publishedDefinitionHistorySchema.safeParse(history);
  if (!parsed.success) return refuseVersionImpact("invalid_history");
  const fold = createDefinitionPublicationHistoryFold({
    kind: parsed.data.kind,
    definitionKey: parsed.data.definitionKey,
    rootId,
    anchorReleaseRevision,
  });
  let previousReleaseRevision: number | null = null;
  for (const release of parsed.data.history) {
    foldDefinitionPublicationHistoryRelease(fold, { previousReleaseRevision, release });
    previousReleaseRevision = release.publication.revision;
  }
  return completeDefinitionPublicationHistoryFold(fold);
};

const comparisonFingerprint = (
  subject: DefinitionVersionSubject,
  latest: SupportedVersionImpactRequest["history"][number] | undefined,
  exactCandidateContentFingerprint: `sha256:${string}`,
  resultWithoutFingerprint: unknown,
  policyVersion:
    | typeof applicationVersionImpactPolicyVersionV2
    | typeof moduleVersionImpactPolicyVersionV3,
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

const parseVersionImpactRequest = (input: unknown): SupportedVersionImpactRequest => {
  const explicitKind =
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.prototype.hasOwnProperty.call(input, "validationContractVersion")
      ? (input as { kind?: unknown }).kind
      : undefined;
  const parsed =
    explicitKind === "module"
      ? moduleVersionImpactRequestV3Schema.safeParse(input)
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
  return parsed.data;
};

const assertEvidenceContractVersions = (
  request: SupportedVersionImpactRequest,
  evidence: DefinitionPublicationHistoryEvidence,
): void => {
  const allowed = request.kind === "module" ? new Set(["3.0.0"]) : new Set(["2.0.0"]);
  if (evidence.validationContractVersions.some((version) => !allowed.has(version)))
    refuseVersionImpact("invalid_request");
};

const compareParsedDefinitionVersionImpact = (
  request: SupportedVersionImpactRequest,
  latest: HistoryRelease | undefined,
  evidence?: DefinitionPublicationHistoryEvidence,
): DefinitionVersionImpactResult => {
  if (
    unresolvedRecordTypeReferencePaths(
      request.kind === "module" ? moduleContentV3Schema : applicationContentV2Schema,
      request.candidate.content,
    ).length > 0
  )
    refuseVersionImpact("unresolved_candidate");
  if (evidence === undefined) assertHistory(request);
  else {
    assertEvidenceContractVersions(request, evidence);
    assertCandidateHistoryBinding(request, latest);
  }

  const subject = subjectOf(request);
  const exactCandidateContentFingerprint = fingerprintCanonicalValue(request.candidate.content);
  if (request.kind === "module") assertUnambiguousModuleContent(request.candidate.content);
  else assertUnambiguousApplicationContentV2(request.candidate.content);

  const normalisedCandidate =
    request.kind === "module"
      ? normaliseModuleContent(request.candidate.content)
      : normaliseApplicationContentV2(request.candidate.content);
  const policyVersion =
    request.kind === "module"
      ? moduleVersionImpactPolicyVersionV3
      : applicationVersionImpactPolicyVersionV2;

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
  if (request.kind === "module") {
    const latestModule = latest!;
    const latestContent = moduleContentV3Schema.parse(latestModule.content);
    const comparablePrevious = normaliseModuleContent(latestContent);
    const comparableCandidate = normaliseModuleContent(request.candidate.content);
    normalisedPrevious = comparablePrevious;
    assertUnambiguousModuleContent(latestModule.content);
    reasons = compareModuleContents(comparablePrevious, comparableCandidate);
  } else {
    const latestApplication = latest! as PublishedApplicationDefinition;
    normalisedPrevious = normaliseApplicationContentV2(latestApplication.content);
    assertUnambiguousApplicationContentV2(latestApplication.content);
    reasons = compareApplicationContentsV2(
      normalisedPrevious as ReturnType<typeof normaliseApplicationContentV2>,
      normalisedCandidate as ReturnType<typeof normaliseApplicationContentV2>,
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

/**
 * Computes the minimum compatible release without reading state or publishing.
 * The public array contract remains bounded at 10,000 entries.
 */
export const compareDefinitionVersionImpact = (input: unknown): DefinitionVersionImpactResult => {
  const request = parseVersionImpactRequest(input);
  return compareParsedDefinitionVersionImpact(request, request.history.at(-1));
};

/** Publication-only comparator over repository-authenticated streamed evidence. */
export const compareDefinitionVersionImpactWithEvidence = (
  input: Readonly<{
    kind: "module" | "application";
    validationContractVersion?: "2.0.0" | "3.0.0";
    historyEvidence: DefinitionPublicationHistoryEvidence;
    candidate: unknown;
  }>,
): DefinitionVersionImpactResult => {
  if (!isVerifiedDefinitionPublicationHistoryEvidence(input.historyEvidence))
    refuseVersionImpact("invalid_history");
  const request = parseVersionImpactRequest({
    kind: input.kind,
    ...(input.validationContractVersion === undefined
      ? {}
      : { validationContractVersion: input.validationContractVersion }),
    history: [],
    candidate: input.candidate,
  });
  const evidence = input.historyEvidence;
  if (
    evidence.kind !== request.kind ||
    evidence.rootId !== request.candidate.envelope.rootId ||
    evidence.definitionKey !== request.candidate.envelope.key
  )
    refuseVersionImpact(
      evidence.rootId !== request.candidate.envelope.rootId ? "root_mismatch" : "invalid_history",
    );
  return compareParsedDefinitionVersionImpact(
    request,
    evidence.latestRelease ?? undefined,
    evidence,
  );
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
