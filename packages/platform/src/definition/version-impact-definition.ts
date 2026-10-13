import {
  applicationContentSchema,
  applicationVersionImpactRequestSchema,
  moduleContentSchema,
  moduleVersionImpactRequestSchema,
  unresolvedRecordTypeReferencePaths,
  definitionVersionImpactRequestSchema,
  definitionVersionImpactResultSchema,
  stableDefinitionReleaseVersionSchema,
  type DefinitionPublicationHistoryEvidence,
  type DefinitionVersionImpactRequest,
  type DefinitionVersionImpactResult,
  type DefinitionVersionSubject,
  type ApplicationVersionImpactRequest,
  type ModuleVersionImpactRequest,
  type PublishedApplicationDefinition,
  type VersionImpact,
} from "../schema";
import { canonicalJson, fingerprintCanonicalValue } from "./canonical-json-definition";
import {
  assertUnambiguousApplicationContent,
  compareApplicationContents,
  normaliseApplicationContent,
} from "./comparison-policy/application-contents";
import { compareModuleContents } from "./comparison-policy/module-contents";
import {
  assertUnambiguousModuleContent,
  normaliseModuleContent,
} from "./comparison-policy/normalisation";
import { assignNextDefinitionVersion, compareStableVersions } from "./semantic-version";
import { refuseVersionImpact } from "./version-impact-error";

type SupportedVersionImpactRequest =
  DefinitionVersionImpactRequest | ApplicationVersionImpactRequest | ModuleVersionImpactRequest;

type HistoryRelease = SupportedVersionImpactRequest["history"][number];

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
    if (unresolvedRecordTypeReferencePaths(moduleContentSchema, release.content).length > 0)
      refuseVersionImpact("invalid_history");
    assertUnambiguousModuleContent(release.content);
  } else {
    const applicationRelease = release as PublishedApplicationDefinition;
    if (
      unresolvedRecordTypeReferencePaths(applicationContentSchema, applicationRelease.content)
        .length > 0
    )
      refuseVersionImpact("invalid_history");
    assertUnambiguousApplicationContent(applicationRelease.content);
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
      ? moduleVersionImpactRequestSchema.safeParse(input)
      : explicitKind === "application"
        ? applicationVersionImpactRequestSchema.safeParse(input)
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
  const allowed = request.kind === "module" ? "3.0.0" : "2.0.0";
  if (
    evidence.latestRelease !== null &&
    evidence.latestRelease.publication.validationContractVersion !== allowed
  )
    refuseVersionImpact("invalid_request");
};

const compareParsedDefinitionVersionImpact = (
  request: SupportedVersionImpactRequest,
  latest: HistoryRelease | undefined,
  evidence?: DefinitionPublicationHistoryEvidence,
): DefinitionVersionImpactResult => {
  if (
    unresolvedRecordTypeReferencePaths(
      request.kind === "module" ? moduleContentSchema : applicationContentSchema,
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
  if (request.kind === "module") assertUnambiguousModuleContent(request.candidate.content);
  else assertUnambiguousApplicationContent(request.candidate.content);

  const normalisedCandidate =
    request.kind === "module"
      ? normaliseModuleContent(request.candidate.content)
      : normaliseApplicationContent(request.candidate.content);
  if (latest === undefined) {
    const result = {
      subject,
      outcome: "initial_release" as const,
      assignedVersion: "1.0.0" as const,
      reasons: [],
    };
    return definitionVersionImpactResultSchema.parse(result);
  }

  let normalisedPrevious: unknown;
  let reasons: DefinitionVersionImpactResult["reasons"];
  if (request.kind === "module") {
    const latestModule = latest!;
    const latestContent = moduleContentSchema.parse(latestModule.content);
    const comparablePrevious = normaliseModuleContent(latestContent);
    const comparableCandidate = normaliseModuleContent(request.candidate.content);
    normalisedPrevious = comparablePrevious;
    assertUnambiguousModuleContent(latestModule.content);
    reasons = compareModuleContents(comparablePrevious, comparableCandidate);
  } else {
    const latestApplication = latest! as PublishedApplicationDefinition;
    const latestApplicationContent = latestApplication.content as Parameters<
      typeof normaliseApplicationContent
    >[0];
    normalisedPrevious = normaliseApplicationContent(latestApplicationContent);
    assertUnambiguousApplicationContent(latestApplication.content);
    reasons = compareApplicationContents(
      normalisedPrevious as ReturnType<typeof normaliseApplicationContent>,
      normalisedCandidate as ReturnType<typeof normaliseApplicationContent>,
    );
  }
  if (canonicalJson(normalisedPrevious) === canonicalJson(normalisedCandidate)) {
    const result = {
      subject,
      outcome: "no_change" as const,
      currentVersion: latest.publication.releaseVersion,
      reasons: [],
    };
    return definitionVersionImpactResultSchema.parse(result);
  }

  if (reasons.length === 0) refuseVersionImpact("invalid_request");
  const impact = highestImpact(reasons);
  const result = {
    subject,
    outcome: "release_required" as const,
    currentVersion: latest.publication.releaseVersion,
    impact,
    assignedVersion: assignNextDefinitionVersion(latest.publication.releaseVersion, impact),
    reasons,
  };
  return definitionVersionImpactResultSchema.parse(result);
};

/**
 * Computes the minimum compatible release without reading state or publishing.
 * The public array contract remains bounded at 10,000 entries.
 */
export const compareDefinitionVersionImpact = (input: unknown): DefinitionVersionImpactResult => {
  const request = parseVersionImpactRequest(input);
  return compareParsedDefinitionVersionImpact(request, request.history.at(-1));
};

/** Publication-only comparator over the latest release the database anchors as current. */
export const compareDefinitionVersionImpactWithEvidence = (
  input: Readonly<{
    kind: "module" | "application";
    validationContractVersion: "2.0.0" | "3.0.0";
    historyEvidence: DefinitionPublicationHistoryEvidence;
    candidate: unknown;
  }>,
): DefinitionVersionImpactResult => {
  const request = parseVersionImpactRequest({
    kind: input.kind,
    validationContractVersion: input.validationContractVersion,
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
