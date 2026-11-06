import {
  createApplicationStoreService,
  createHumanOrganizationRequestService,
  createOrganizationAccessAdministrationService,
  DefinitionError,
  listOrganizationBuilderRoots,
  type HumanOrganizationRequestResult,
  type OrganizationBuilderRoot,
} from "@vortex/platform/server";
import { organizationSelectionCandidateSchema } from "@vortex/platform/schema";
import { z } from "zod";
import {
  installedReleaseCatalogue,
  releaseSetContainsCustomComponents,
} from "../../app/_lib/definition-catalogue";
import { platformPermissionSource } from "../../app/_lib/platform-permission-source";
import {
  publishConvertedStudioDraft,
  publishStudioDraft,
  readReleaseSourceFingerprint,
  readStudioDraft,
  restoreStudioRelease,
  saveStudioDraft,
  type StudioDraftState,
} from "./definitions";
import { nominatedOwnerSession, type SystemContextFacts } from "./development-authority";
import { queryLocalDatabaseAsOwner } from "./guards";
import {
  readActiveReleaseRevision,
  releaseStaleness,
  switchActiveRelease,
  type InstallFacts,
} from "./install";
import { readRefreshRecord, removeRefreshRecord, writeRefreshRecord } from "./state";

/**
 * The platform refresh: the catalogue is code, so a platform step (a catalogue content change, or
 * a contract step with its draft-converting migration) is applied here, in the same update as the
 * code. Every application built in Studio, in every organisation, whose latest release or active
 * installation pins content the platform no longer holds is re-released from that release's own
 * source and its installation moves to the re-release. A person's unpublished draft is never
 * published by a catalogue step: it is remembered in a record beside the setup state, put back on
 * top of the re-release and, if a run is interrupted, put back by the next one. An application
 * whose release source no longer compiles is deleted after both its sources are exported.
 */

const releaseNote =
  "Re-released by the platform: a platform block, connection type or service operation it uses changed. Your draft is unchanged.";

/** The closed list of publication refusals that mean the source no longer compiles. */
const compileRefusals: ReadonlySet<string> = new Set([
  "DEFINITION_DEPENDENCY_MISSING",
  "DEFINITION_DEPENDENCY_PRERELEASE_ONLY",
  "DEFINITION_DEPENDENCY_INCOMPATIBLE",
  "DEFINITION_DEPENDENCY_AMBIGUOUS",
  "DEFINITION_DEPENDENCY_SUBSTITUTED",
  "DEFINITION_DEPENDENCY_CYCLE",
  "DEFINITION_COMPILATION_REFUSED",
]);

const isDefinitionError = (error: unknown, code: string): boolean =>
  error instanceof DefinitionError && error.code === code;

type Facts = Omit<InstallFacts, "releases">;
type Log = (message: string) => void;

const pendingSchema = z
  .object({
    rootId: z.uuid(),
    key: z.string().min(1),
    source: z.unknown(),
    sourceFingerprint: z.string().min(1),
  })
  .strict();
type Pending = z.infer<typeof pendingSchema>;

const pendingName = (rootId: string): string => `refresh-pending-${rootId}.json`;

const readPending = (rootId: string): Pending | undefined => {
  const record = readRefreshRecord(pendingName(rootId));
  return record === undefined ? undefined : pendingSchema.parse(record);
};

/** The organisation's own applications that have a release, as the nominated owner sees them. */
const rootsOf = async (facts: Facts): Promise<readonly OrganizationBuilderRoot[]> => {
  const roots: OrganizationBuilderRoot[] = [];
  let cursor: string | null = null;
  do {
    const after: string | null = cursor;
    const page: HumanOrganizationRequestResult<
      Awaited<ReturnType<typeof listOrganizationBuilderRoots>>
    > = await createHumanOrganizationRequestService({
      identityAuthorityId: facts.identityAuthorityId,
    }).run(
      nominatedOwnerSession(facts.stewardIdentityId),
      organizationSelectionCandidateSchema.parse({ organizationId: facts.system.organizationId }),
      (transaction) => listOrganizationBuilderRoots(transaction, after),
    );
    if (page.kind !== "available")
      throw new Error(
        `Applications could not be listed (${page.kind}): the nominated owner cannot act in this organisation`,
        { cause: page },
      );
    roots.push(...page.value.roots);
    cursor = page.value.nextCursor;
  } while (cursor !== null);
  // Shipped and system applications are rebuilt from shipped source by the shipped refresh.
  return roots.filter(
    (root) =>
      !root.isSystemApplication &&
      !(facts.manifest.applicationKeys as readonly string[]).includes(root.key) &&
      root.currentReleaseRevision !== null,
  );
};

const moduleEdgesSchema = z
  .object({
    body: z.object({
      modules: z.array(z.object({ key: z.string() })),
      uses: z.array(z.object({ module: z.string() })),
    }),
  })
  .loose();

/** Lenders before borrowers: an application that uses another's Module follows its owner. */
const inLenderFirstOrder = async (
  facts: Facts,
  roots: readonly OrganizationBuilderRoot[],
): Promise<readonly OrganizationBuilderRoot[]> => {
  const edges = new Map<string, { owns: string[]; uses: string[] }>();
  for (const root of roots) {
    const parsed = moduleEdgesSchema.safeParse(
      (await readStudioDraft(facts.system, root.rootId))?.source,
    );
    edges.set(root.rootId, {
      owns: parsed.success ? parsed.data.body.modules.map(({ key }) => key) : [],
      uses: parsed.success ? parsed.data.body.uses.map(({ module }) => module) : [],
    });
  }
  const ordered: OrganizationBuilderRoot[] = [];
  const remaining = [...roots];
  while (remaining.length > 0) {
    const index = remaining.findIndex((root) =>
      edges.get(root.rootId)!.uses.every((module) => {
        const owner = remaining.find((other) => edges.get(other.rootId)!.owns.includes(module));
        return owner === undefined || owner === root;
      }),
    );
    // A cycle between applications has no lender-first order; publication names the refusal.
    ordered.push(...remaining.splice(index === -1 ? 0 : index, 1));
  }
  return ordered;
};

/**
 * Remembers the person's draft before the release's own source replaces it. A draft that already
 * is the release's source (a run restored it) or the remembered draft is left as recorded.
 */
const rememberDraft = (
  root: OrganizationBuilderRoot,
  releaseFingerprint: string,
  draft: StudioDraftState,
): void => {
  const pending = readPending(root.rootId);
  if (
    draft.sourceFingerprint === releaseFingerprint ||
    draft.sourceFingerprint === pending?.sourceFingerprint
  )
    return;
  writeRefreshRecord(pendingName(root.rootId), {
    rootId: root.rootId,
    key: root.key,
    source: draft.source,
    sourceFingerprint: draft.sourceFingerprint,
  } satisfies Pending);
};

/** Puts the remembered draft back on top of the release, unless a person has saved another since. */
const restoreRememberedDraft = async (
  facts: Facts,
  root: OrganizationBuilderRoot,
  releaseRevision: number,
  log: Log,
): Promise<void> => {
  const pending = readPending(root.rootId);
  if (pending === undefined) return;
  const draft = await readStudioDraft(facts.system, root.rootId);
  if (draft === undefined) throw new Error(`Studio draft is missing for ${root.key}`);
  const releaseFingerprint = await readReleaseSourceFingerprint(
    facts.system,
    root.rootId,
    releaseRevision,
  );
  if (draft.sourceFingerprint === releaseFingerprint) {
    await saveStudioDraft(facts.system, root.rootId, draft.draftRevision, pending.source);
    log(`${root.key}: the unpublished draft is the draft again`);
  } else if (draft.sourceFingerprint !== pending.sourceFingerprint)
    log(`${root.key}: kept the draft a person saved while the refresh ran`);
  removeRefreshRecord(pendingName(root.rootId));
};

const exportName = (root: OrganizationBuilderRoot, which: "draft" | "release"): string =>
  `deleted-${root.key}-${root.rootId}.${which}.json`;

/** Deletes an application whose release source no longer compiles, after exporting its sources. */
const deleteUncompilable = async (
  facts: Facts,
  root: OrganizationBuilderRoot,
  code: string,
  log: Log,
): Promise<void> => {
  const draft = await readStudioDraft(facts.system, root.rootId);
  if (draft === undefined) throw new Error(`Studio draft is missing for ${root.key}`);
  // The draft is the release's own source after the restore; the remembered draft is the person's.
  writeRefreshRecord(exportName(root, "release"), draft.source);
  writeRefreshRecord(exportName(root, "draft"), readPending(root.rootId)?.source ?? draft.source);
  const result = await createApplicationStoreService({
    catalogue: installedReleaseCatalogue,
    permissions: platformPermissionSource,
    containsCustomComponents: releaseSetContainsCustomComponents,
    requests: createHumanOrganizationRequestService({
      identityAuthorityId: facts.identityAuthorityId,
    }),
    accessAdministration: createOrganizationAccessAdministrationService({
      identityAuthorityId: facts.identityAuthorityId,
    }),
    bindAccessAdministration: (boundRequest) =>
      createOrganizationAccessAdministrationService({
        identityAuthorityId: facts.identityAuthorityId,
        boundRequest,
      }),
  }).purge(
    nominatedOwnerSession(facts.stewardIdentityId),
    organizationSelectionCandidateSchema.parse({ organizationId: facts.system.organizationId }),
    { application_root_id: root.rootId, confirm_name: root.name },
  );
  if (typeof result === "string" || result.kind !== "available")
    throw new Error(
      `deleting it (${code}) was not completed (${typeof result === "string" ? result : result.kind}); its sources are in ${exportName(root, "release")} and ${exportName(root, "draft")}`,
    );
  removeRefreshRecord(pendingName(root.rootId));
  log(
    `deleted ${root.key}: its release source no longer compiles (${code}); sources exported to ${exportName(root, "release")} and ${exportName(root, "draft")}`,
  );
};

/**
 * One root. Returns true when it wrote anything. Every write carries the observed draft revision,
 * so a racing change refuses and the caller retries the root once from the start.
 */
const refreshRoot = async (
  facts: Facts,
  root: OrganizationBuilderRoot,
  log: Log,
): Promise<boolean> => {
  const latest = root.currentReleaseRevision;
  if (latest === null) return false;
  const active = await readActiveReleaseRevision(facts, root.key, root.rootId);
  const latestState = await releaseStaleness(facts.system, root.rootId, latest);
  const activeStale =
    active !== null &&
    (active === latest
      ? latestState
      : await releaseStaleness(facts.system, root.rootId, active)) !== "current";
  if (latestState === "current" && !activeStale && readPending(root.rootId) === undefined)
    return false;

  let target = latest;
  if (latestState === "contract") {
    target = (await publishConvertedStudioDraft(facts.system, root, log)).releaseRevision;
  } else if (latestState === "catalogue") {
    const draft = await readStudioDraft(facts.system, root.rootId);
    if (draft === undefined) throw new Error(`Studio draft is missing for ${root.key}`);
    rememberDraft(
      root,
      await readReleaseSourceFingerprint(facts.system, root.rootId, latest),
      draft,
    );
    const restored = await restoreStudioRelease(
      facts.system,
      root.rootId,
      latest,
      draft.draftRevision,
    );
    try {
      const published = await publishStudioDraft(
        facts.system,
        root.rootId,
        restored.draftRevision,
        releaseNote,
      );
      target = published.releaseRevision;
      log(
        `re-released ${root.key} ${published.releaseVersion} (revision ${published.releaseRevision}) from its own source`,
      );
    } catch (error) {
      if (error instanceof DefinitionError && compileRefusals.has(error.code)) {
        await deleteUncompilable(facts, root, error.code, log);
        return true;
      }
      if (isDefinitionError(error, "DEFINITION_NO_CHANGE"))
        throw new Error(
          `release ${latest} is superseded but its own source publishes no change: the detector and the compiler disagree`,
          { cause: error },
        );
      throw error;
    }
  }
  await restoreRememberedDraft(facts, root, target, log);
  if (active !== null && activeStale && active !== target)
    await switchActiveRelease(
      facts,
      root.key,
      { rootId: root.rootId, releaseRevision: target },
      active,
      log,
    );
  return true;
};

const refreshRootOnce = async (
  facts: Facts,
  root: OrganizationBuilderRoot,
  log: Log,
): Promise<boolean> => {
  try {
    return await refreshRoot(facts, root, log);
  } catch (error) {
    if (!isDefinitionError(error, "DEFINITION_DRAFT_STALE_OR_MISSING")) throw error;
    log(`${root.key}: the draft changed while the refresh ran; trying once more`);
    const current = (await rootsOf(facts)).find((candidate) => candidate.rootId === root.rootId);
    return current === undefined ? false : refreshRoot(facts, current, log);
  }
};

const organisationRowsSchema = z.array(
  z.object({
    organization_id: z.uuid(),
    tenant_id: z.uuid(),
    access_version: z.string().regex(/^\d+$/),
  }),
);

/** Every organisation on the instance, with what a system context for it needs. */
const listOrganisations = (facts: Facts): readonly SystemContextFacts[] =>
  organisationRowsSchema
    .parse(
      queryLocalDatabaseAsOwner(
        `select o.organization_id::text as organization_id, o.tenant_id::text as tenant_id, v.current_version::text as access_version
         from vortex_identity.organizations as o
         join vortex_access.organization_access_versions as v on v.organization_id = o.organization_id
         order by o.organization_id`,
        "Unable to list the organisations of this instance",
      ),
    )
    .map((row) => ({
      tenantId: row.tenant_id,
      organizationId: row.organization_id,
      systemActorId: facts.system.systemActorId,
      accessVersion: Number(row.access_version),
    }));

/**
 * The one refresh of `pnpm demo:setup` after the shipped applications: nothing superseded stays
 * superseded, in any organisation, and a second run writes nothing. A failure stops the setup
 * naming the organisation and the root; nothing is skipped silently.
 */
export const refreshStudioApplications = async (facts: Facts, log: Log): Promise<void> => {
  let refreshed = 0;
  for (const system of listOrganisations(facts)) {
    const organisation: Facts = { ...facts, system };
    const roots = await rootsOf(organisation)
      .then((listed) => inLenderFirstOrder(organisation, listed))
      .catch((error: unknown) => {
        throw new Error(
          `Platform refresh stopped in organisation ${system.organizationId}: ${error instanceof Error ? error.message : "failed"}`,
          { cause: error },
        );
      });
    for (const root of roots) {
      try {
        if (await refreshRootOnce(organisation, root, log)) refreshed += 1;
      } catch (error) {
        throw new Error(
          `Platform refresh stopped at ${root.key} (${root.rootId}) in organisation ${system.organizationId}: ${error instanceof Error ? error.message : "failed"}`,
          { cause: error },
        );
      }
    }
  }
  if (refreshed === 0) log("platform refresh: nothing superseded");
};
