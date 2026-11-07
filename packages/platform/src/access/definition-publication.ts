import "server-only";

import {
  applicationRootIdSchema,
  organizationIdSchema,
  timestampSchema,
} from "../catalogue/identifiers";
import {
  databaseCode,
  databaseTimestamp,
  describeFailure,
  sameId,
} from "../catalogue/runtime-primitives";
import { canonicalJson } from "../definition/canonical-json";
import {
  prepareDefinitionPublicationCommandSchema,
  prepareDefinitionPublicationResultSchema,
  publishDefinitionCommandSchema,
  publishDefinitionResultSchema,
  type PrepareDefinitionPublicationResult,
  type PublishDefinitionResult,
} from "../definition/definition-store-contracts";
import type { IdentitySession, SelectedOrganizationScope } from "./identity-access";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import { BuilderAuthorityError, requireBuilderAuthority } from "../definition/builder-authority";
import { readApplicationDefinitionDraft } from "../definition/definition-draft-read";
import { createDatabaseDefinitionPublicationService } from "../definition/definition-publication";
import { createDefinitionStore } from "../definition/definition-store";
import type { ImmutableDefinitionPublicationCatalogueDefinition } from "../definition/publication/read";
import {
  assertBeforeLiveDeadline,
  assertLivePermission,
  LiveContextRefused,
  platformOrganizationPermissionDeclaration,
  readLiveHumanContext,
  type LiveHumanContext,
} from "./live-context";
import {
  createBuilderAuthority,
  type BuilderTargetFactsReader,
  readBuilderApplicationOrigin,
} from "./builder-authority";
import type { PlatformPermissionSource } from "./platform-permissions";
import type { createHumanOrganizationRequestService } from "./human-organization-request";
import { classifyRequestFailure } from "./request-failure";
import { markRequestFailureLogged, requestFailureLogged } from "./request-failure-mark";
import { DefinitionCompilationError } from "../definition/compilation-error";
import { DefinitionError } from "../definition/definition-error";
import { isVersionImpactRefusal } from "../definition/version-impact-error";
import { definitionValidationMessage } from "../catalogue/validation-errors";

/** `reason` is the stable code logged on the server and mapped to a message for the person. */
type Failure = Readonly<{
  kind: "refused" | "conflict" | "dependency_unavailable" | "no_change" | "temporarily_unavailable";
  reason?: string;
  /** For a compilation refusal, the name of the block it is about, when it is about one. */
  blockAlias?: string;
  /** For a compilation refusal inside a flow, the flow, the step in it and the rule's family. */
  flowKey?: string;
  taskId?: string;
  family?: string;
  /** For a compilation refusal with its own business sentence, that sentence. */
  sentence?: string;
}>;
export type HumanDefinitionPublicationPreparationResult =
  Failure | Readonly<{ kind: "available"; preparation: PrepareDefinitionPublicationResult }>;
export type HumanDefinitionPublicationResult =
  Failure | Readonly<{ kind: "available"; publication: PublishDefinitionResult }>;
type HumanDefinitionPublisherDependencies = Readonly<{
  requests: ReturnType<typeof createHumanOrganizationRequestService>;
  catalogue: ImmutableDefinitionPublicationCatalogueDefinition;
}>;
class PublicationContextRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "PublicationContextRefused";
  }
}
/** Trusted refusal code consumed by the owning request after its transaction rolls back. */
class ExpectedBuilderPublicationRefusal extends Error {
  readonly code = "42501";
  constructor() {
    super("Definition publication authority refused");
    this.name = "ExpectedBuilderPublicationRefusal";
  }
}

/** Existing roots never acquire a default classification or a System fallback. */
const targetFacts: BuilderTargetFactsReader = async (transaction, _scope, rootId) => {
  if (rootId === undefined) throw new PublicationContextRefused("root_missing");
  const origin = await readBuilderApplicationOrigin(transaction, rootId);
  if (origin === undefined) throw new PublicationContextRefused("root_missing");
  return { isSystemApplication: origin === "platform_system_application" };
};

/** Recheck exact decisions after compilation/append and all returned-row verification. */
const assertLiveCompletion = async (
  permissions: PlatformPermissionSource,
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: LiveHumanContext,
  rootId: string,
  publishedAt?: string,
): Promise<void> => {
  const facts = await targetFacts(transaction, scope, rootId);
  let deadline = Date.parse(context.expiresAt);
  for (const key of [
    "platform.organization.definition_releases.manage",
    ...(facts.isSystemApplication ? ["platform.organization.system_applications.manage"] : []),
  ]) {
    const decision = await assertLivePermission(
      transaction,
      platformOrganizationPermissionDeclaration(permissions, key),
      context,
    );
    deadline = Math.min(deadline, decision.validUntil);
  }
  const now = await assertBeforeLiveDeadline(transaction, deadline);
  if (publishedAt !== undefined && Date.parse(publishedAt) > now)
    throw new LiveContextRefused("request_deadline_passed");
};

const dependencyCodes = [
  "DEFINITION_DEPENDENCY_MISSING",
  "DEFINITION_DEPENDENCY_PRERELEASE_ONLY",
  "DEFINITION_DEPENDENCY_INCOMPATIBLE",
  "DEFINITION_DEPENDENCY_AMBIGUOUS",
  "DEFINITION_DEPENDENCY_SUBSTITUTED",
  "DEFINITION_DEPENDENCY_CYCLE",
];

/** The compilation refusal an error is or wraps: compilation refusals reach the person located. */
const compilationRefusal = (error: unknown): DefinitionCompilationError | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof DefinitionCompilationError) return current;
    current = current.cause;
  }
  return undefined;
};

/** The located sentence of a database refusal of a protected-surface change, when the failure is one. */
const databaseSurfaceRefusal = (error: unknown): string | undefined => {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if ((current as { readonly hint?: unknown }).hint === "system_surface_changed")
      return current.message;
    current = current.cause;
  }
  return undefined;
};

/** Whether the database refused for a stale sign-in (V3150), as the error or one of its causes. */
const databaseRecentSignInRefusal = (error: unknown): boolean => {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (databaseCode(current) === "V3150") return true;
    current = current.cause;
  }
  return false;
};

const classifyFailure = (error: unknown): Failure => {
  if (error instanceof DefinitionError && error.code === "DEFINITION_IDENTITY_RETIRED")
    return {
      kind: "refused",
      reason: "identity_retired",
      ...(error.sentence === undefined ? {} : { sentence: error.sentence }),
    };
  if (error instanceof DefinitionError && error.code === "DEFINITION_SYSTEM_SURFACE_CHANGED")
    return {
      kind: "refused",
      reason: "system_surface_changed",
      ...(error.sentence === undefined ? {} : { sentence: error.sentence }),
    };
  // The database refuses the same change when the release it follows moved after the plan was made.
  const surfaceRefusal = databaseSurfaceRefusal(error);
  if (surfaceRefusal !== undefined)
    return { kind: "refused", reason: "system_surface_changed", sentence: surfaceRefusal };
  if (error instanceof DefinitionError && error.code === "DEFINITION_NO_CHANGE")
    return { kind: "no_change", reason: "no_change" };
  if (error instanceof DefinitionError && dependencyCodes.includes(error.code))
    return {
      kind: "dependency_unavailable",
      reason: error.code.slice("DEFINITION_".length).toLowerCase(),
    };
  if (error instanceof DefinitionError && error.code === "DEFINITION_DRAFT_STALE_OR_MISSING")
    return { kind: "conflict", reason: "draft_stale_or_missing" };
  if (error instanceof DefinitionError && error.code === "DEFINITION_CONFIRMATION_MISMATCH")
    return { kind: "conflict", reason: "confirmation_mismatch" };
  if (error instanceof PublicationContextRefused || error instanceof LiveContextRefused)
    return { kind: "refused", reason: error.reason };
  if (error instanceof BuilderAuthorityError)
    return {
      kind: "refused",
      reason:
        error.code === "BUILDER_PERMISSION_REFUSED"
          ? "release_permission_missing"
          : "recent_authentication_required",
    };
  // The database asks for the same recent sign-in, so a request that skipped the check above is refused alike.
  if (databaseRecentSignInRefusal(error))
    return { kind: "refused", reason: "recent_authentication_required" };
  const compilation = compilationRefusal(error);
  if (compilation !== undefined) {
    const block = compilation.location?.segments.find((segment) => segment.kind === "block");
    const flow = compilation.location?.segments.find((segment) => segment.kind === "flow");
    const task = compilation.location?.segments.find((segment) => segment.kind === "flow_node");
    return {
      kind: "refused",
      reason: `compilation_${compilation.ruleCode.toLowerCase()}`,
      ...(block === undefined ? {} : { blockAlias: block.key }),
      ...(flow === undefined
        ? {}
        : {
            flowKey: flow.key,
            family: compilation.family,
            ...(task === undefined ? {} : { taskId: task.key }),
          }),
      ...(compilation.sentence !== undefined
        ? { sentence: compilation.sentence }
        : compilation.code === undefined
          ? {}
          : { sentence: definitionValidationMessage(compilation.code) }),
    };
  }
  if (isVersionImpactRefusal(error)) return { kind: "refused", reason: "version_impact_refused" };
  if (error instanceof DefinitionError && error.code !== "DEFINITION_PUBLICATION_FAILED")
    return { kind: "refused", reason: error.code.replace(/^DEFINITION_/, "").toLowerCase() };
  return { kind: "temporarily_unavailable", reason: "unexpected_failure" };
};

/**
 * Classifies a failure and logs one line with its stable reason code and cause chain: an expected
 * refusal, conflict or no-change answer at information, only a platform fault at error.
 */
const safeFailure = (error: unknown, operation: string): Failure => {
  const failure = classifyFailure(error);
  // The place that raised it logged it once already (the publication repository, a compiler
  // refusal): no second line.
  if (requestFailureLogged(error)) return failure;
  const line = `[publication] ${operation} ${failure.kind} reason=${failure.reason ?? "none"} cause=${describeFailure(error)}`;
  // Only an unexpected failure is classified by its cause: a database refusal or a race is still
  // information, any other cause is a platform fault.
  if (
    failure.kind === "temporarily_unavailable" &&
    classifyRequestFailure(error, { addressed: false }).level === "error"
  )
    console.error(line);
  else console.info(line);
  // The request runner that catches this error next adds no second line.
  markRequestFailureLogged(error);
  return failure;
};

/** Both operations resolve their own human scope; no caller-supplied source, actor or history. */
export const createHumanDefinitionPublisher = (
  dependencies: HumanDefinitionPublisherDependencies,
) => {
  type Value =
    | Readonly<{ kind: "prepared"; preparation: PrepareDefinitionPublicationResult }>
    | Readonly<{ kind: "published"; publication: PublishDefinitionResult }>;
  const execute = async (
    session: IdentitySession,
    candidateOrganizationId: string,
    candidate: unknown,
    mode: "prepare" | "publish",
  ): Promise<Failure | Readonly<{ kind: "available"; value: Value }>> => {
    const organization = organizationIdSchema.safeParse(candidateOrganizationId);
    const prepare =
      mode === "prepare"
        ? prepareDefinitionPublicationCommandSchema.safeParse(candidate)
        : undefined;
    const publish =
      mode === "publish" ? publishDefinitionCommandSchema.safeParse(candidate) : undefined;
    const supplied = prepare?.success
      ? prepare.data
      : publish?.success
        ? {
            rootId: publish.data.confirmation.rootId,
            expectedDraftRevision: publish.data.confirmation.expectedDraftRevision,
          }
        : undefined;
    // Only an Application is published; its inline Modules are released inside its publication.
    const root = applicationRootIdSchema.safeParse(supplied?.rootId);
    if (!organization.success || supplied === undefined || !root.success) {
      console.info(`[publication] ${mode} refused reason=command_invalid cause=schema/none`);
      return { kind: "refused", reason: "command_invalid" };
    }
    let command = { rootId: root.data, expectedDraftRevision: supplied.expectedDraftRevision };
    let failure: Failure | undefined;
    const operation = async (
      transaction: RequestDatabaseTransaction,
      scope: SelectedOrganizationScope,
      issuedAt: string,
    ): Promise<Value> => {
      try {
        if (!sameId(scope.organizationId, organization.data))
          throw new PublicationContextRefused("organization_mismatch");
        const context = await readLiveHumanContext(transaction, { scope, session, issuedAt });
        const authority = createBuilderAuthority({
          transaction,
          scope,
          targetFacts,
          permissions: dependencies.catalogue.permissions,
        });
        await requireBuilderAuthority(authority, {
          kind: "publication",
          rootId: command.rootId,
          stepUp: true,
        });
        const readDraftAtRevision = () =>
          readApplicationDefinitionDraft(transaction, scope, {
            rootId: root.data,
            expectedDraftRevision: command.expectedDraftRevision,
          });
        let initial = await readDraftAtRevision();
        if (initial.kind !== "application")
          throw new PublicationContextRefused("draft_kind_mismatch");
        const clocks =
          await transaction.query<DatabaseRow>`select pg_catalog.clock_timestamp() as started_at`;
        const started = timestampSchema.safeParse(databaseTimestamp(clocks[0]?.started_at));
        if (clocks.length !== 1 || !started.success)
          throw new PublicationContextRefused("database_clock_invalid");
        const service = createDatabaseDefinitionPublicationService(
          dependencies.catalogue,
          transaction,
          authority,
        );
        // A draft not saved since the last release is published only when the platform has moved on.
        // A release takes the draft's revision, so the unchanged draft is saved once more, in this
        // transaction, to get a newer one, and prepared on it: preparing compares what it compiles to
        // with the latest release and refuses with DEFINITION_NO_CHANGE when they are the same,
        // which rolls the extra save back with everything else.
        if (
          initial.publishedRevision !== undefined &&
          initial.publishedRevision !== null &&
          initial.draftRevision <= initial.publishedRevision
        ) {
          if (mode !== "prepare") throw new DefinitionError("DEFINITION_NO_CHANGE");
          const saved = await createDefinitionStore(
            transaction,
            authority,
            dependencies.catalogue.permissions,
          ).saveDraft({
            rootId: command.rootId,
            expectedDraftRevision: initial.draftRevision,
            source: initial.source,
          });
          command = { rootId: command.rootId, expectedDraftRevision: saved.draftRevision };
          initial = await readDraftAtRevision();
          if (initial.kind !== "application")
            throw new PublicationContextRefused("draft_kind_mismatch");
        }
        let value: Value;
        if (mode === "prepare") {
          const preparation = prepareDefinitionPublicationResultSchema.parse(
            await service.prepare(context, command),
          );
          if (
            !sameId(preparation.confirmation.rootId, initial.rootId) ||
            preparation.confirmation.expectedDraftRevision !== initial.draftRevision ||
            preparation.confirmation.sourceFingerprint !== initial.sourceFingerprint
          )
            throw new DefinitionError("DEFINITION_SOURCE_EVIDENCE_MISMATCH");
          value = { kind: "prepared", preparation };
        } else {
          if (!publish?.success) throw new PublicationContextRefused("publish_command_invalid");
          const publication = publishDefinitionResultSchema.parse(
            await service.publish(context, publish.data),
          );
          const expected = publish.data.confirmation;
          if (
            !sameId(publication.rootId, initial.rootId) ||
            publication.releaseRevision !== initial.draftRevision ||
            publication.releaseVersion !== expected.assignedVersion ||
            publication.contentFingerprint !== expected.contentFingerprint ||
            publication.resolutionFingerprint !== expected.resolutionFingerprint ||
            canonicalJson(publication.dependencyManifest) !==
              canonicalJson(expected.dependencyManifest) ||
            !sameId(publication.publishedBy, scope.organizationAccountId) ||
            Date.parse(publication.publishedAt) < Date.parse(started.data)
          )
            throw new DefinitionError("DEFINITION_PUBLICATION_FAILED");
          value = { kind: "published", publication };
        }
        const final = await readDraftAtRevision();
        if (
          final.kind !== "application" ||
          !sameId(final.rootId, initial.rootId) ||
          !sameId(final.organizationId, initial.organizationId) ||
          final.key !== initial.key ||
          final.draftRevision !== initial.draftRevision ||
          final.sourceFingerprint !== initial.sourceFingerprint ||
          canonicalJson(final.source) !== canonicalJson(initial.source) ||
          final.createdAt !== initial.createdAt ||
          !sameId(final.createdBy, initial.createdBy) ||
          final.updatedAt !== initial.updatedAt ||
          !sameId(final.updatedBy, initial.updatedBy) ||
          final.publishedRevision !==
            (value.kind === "published"
              ? value.publication.releaseRevision
              : initial.publishedRevision)
        )
          throw new DefinitionError("DEFINITION_SOURCE_EVIDENCE_MISMATCH");
        await targetFacts(transaction, scope, command.rootId);
        const completion = await readLiveHumanContext(transaction, { scope, session, issuedAt });
        if (canonicalJson(completion) !== canonicalJson(context))
          throw new PublicationContextRefused("session_context_changed");
        await assertLiveCompletion(
          dependencies.catalogue.permissions,
          transaction,
          scope,
          completion,
          command.rootId,
          value.kind === "published" ? value.publication.publishedAt : undefined,
        );
        return value;
      } catch (error) {
        failure = safeFailure(error, mode);
        if (
          (error instanceof BuilderAuthorityError &&
            (error.code === "BUILDER_PERMISSION_REFUSED" ||
              error.code === "BUILDER_RECENT_AUTHENTICATION_REQUIRED")) ||
          databaseRecentSignInRefusal(error)
        )
          throw markRequestFailureLogged(new ExpectedBuilderPublicationRefusal());
        // Throw through runChange: even a post-append result mismatch must roll back.
        throw error;
      }
    };
    // Preparation writes the inline Modules' internal drafts, so it is a change as well.
    const result = await dependencies.requests.runChange(
      session,
      { organizationId: organization.data },
      operation,
    );
    if (result.kind === "available") return { kind: "available", value: result.value };
    if (failure !== undefined) return failure;
    // The request runner logged this answer once.
    const reason = result.kind === "unavailable" ? "organization_unavailable" : "request_failed";
    return result.kind === "unavailable"
      ? { kind: "refused", reason }
      : { kind: "temporarily_unavailable", reason };
  };
  return Object.freeze({
    prepare: async (
      session: IdentitySession,
      organizationId: string,
      candidate: unknown,
    ): Promise<HumanDefinitionPublicationPreparationResult> => {
      const result = await execute(session, organizationId, candidate, "prepare");
      return result.kind !== "available"
        ? result
        : result.value.kind === "prepared"
          ? { kind: "available", preparation: result.value.preparation }
          : { kind: "temporarily_unavailable" };
    },
    publish: async (
      session: IdentitySession,
      organizationId: string,
      candidate: unknown,
    ): Promise<HumanDefinitionPublicationResult> => {
      const result = await execute(session, organizationId, candidate, "publish");
      return result.kind !== "available"
        ? result
        : result.value.kind === "published"
          ? { kind: "available", publication: result.value.publication }
          : { kind: "temporarily_unavailable" };
    },
  });
};
