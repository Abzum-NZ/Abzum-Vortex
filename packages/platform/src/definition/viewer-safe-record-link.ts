import type { PlatformPermissionSource } from "../access/platform-permissions";
import "server-only";

import {
  describeFailure,
  recordIdSchema,
  sameId,
  type RecordId,
  organizationSelectionCandidateSchema,
  viewerSafeRecordLinkIdentitySchema,
  viewerSafeRecordLinkResultSchema,
  viewerSafeRecordPinSelectorSchema,
  viewerSafeRecordPinAcquisitionResultSchema,
  type IdentitySession,
  type OrganizationAccessDeclaration,
  type OrganizationSelectionCandidate,
  type PageDefinition,
  type PermissionDeclaration,
  type SelectedOrganizationScope,
  type ViewerSafeRecordLinkResult,
  type ViewerSafeRecordPinAcquisitionResult,
} from "../schema";
import {
  createHumanOrganizationRequestService,
  runOrganizationAccessOperation,
  type HumanOrganizationRequestDependencies,
} from "../access/index";
import type { RequestDatabaseTransaction } from "../db/index";
import type { ViewerSafeRecordLinkTitle } from "../schema";
import {
  createViewerSafeRecordLinkReadService,
  viewerSafeRecordLinkTitleRecordLimit,
  viewerSafeRecordLinkTitleTypeLimit,
  type ViewerSafeRecordLinkTitleReadResult,
} from "../queries/index";
import {
  requireInstalledRuntimeContext,
  type InstalledRuntimeContext,
  type InstalledRuntimeContextLoader,
} from "./installed-runtime-context";

type ViewerSafeRecordLinkInstalledContextLoaderFactory = (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
) => InstalledRuntimeContextLoader;

type ViewerSafeRecordLinkServiceDependencies = HumanOrganizationRequestDependencies &
  Readonly<{
    /** Compose the existing human installed-context loader for this request transaction and scope. */
    createInstalledContextLoader: ViewerSafeRecordLinkInstalledContextLoaderFactory;
    /** The shipped platform permission catalogue a detail page requirement may name. */
    permissions: PlatformPermissionSource;
    /** Server-composed addressed target lookup; absence never permits a guessed target root. */
    resolveTargetApplication?: (
      session: IdentitySession,
      sourceSelection: OrganizationSelectionCandidate,
      applicationKey: string,
    ) => Promise<OrganizationSelectionCandidate | undefined>;
  }>;

/** One linked record as a stored link value names it. */
export type RecordLinkReference = Readonly<{ recordTypeId: string; recordId: string }>;

/**
 * What the viewer may see of one linked record: its display label and, when the viewer may open the
 * target's detail page, where that page is. A record the viewer may not read is only `restricted`.
 */
export type RecordLinkLabel =
  | Readonly<{
      outcome: "available";
      label: string;
      detail?: Readonly<{ applicationKey: string; pageKey: string; recordId: string }>;
    }>
  | Readonly<{ outcome: "restricted" }>;

export type RecordLinkLabelsResult =
  | Readonly<{ outcome: "read"; labels: ReadonlyMap<string, RecordLinkLabel> }>
  | Readonly<{ outcome: "unavailable" }>;

/**
 * The display names of the requested people the current viewer may see, keyed by lowercase
 * organisation-account id. A person the viewer may not see is absent: callers show the restricted
 * wording, never the id.
 */
export const readVisiblePersonLabels = async (
  transaction: RequestDatabaseTransaction,
  personIds: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  const rows = await transaction.query<{ record_id: string; display_name: string }>`
    select record_id::text, display_name
    from vortex_access.list_visible_person_link_labels(
      array(select pg_catalog.jsonb_array_elements_text(${JSON.stringify(personIds)}::text::jsonb)::uuid)
    )
  `;
  return new Map(rows.map((row) => [row.record_id.toLowerCase(), row.display_name]));
};

/** Group labels use the same fixed group-directory permission as the protected group projection. */
const readVisibleGroupLabels = async (
  transaction: RequestDatabaseTransaction,
  groupIds: readonly string[],
): Promise<ReadonlyMap<string, string>> => {
  const rows = await transaction.query<{ record_id: string; display_name: string }>`
    select record_id::text, display_name
    from vortex_access.list_visible_group_link_labels(
      array(select pg_catalog.jsonb_array_elements_text(${JSON.stringify(groupIds)}::text::jsonb)::uuid)
    )
  `;
  return new Map(rows.map((row) => [row.record_id.toLowerCase(), row.display_name]));
};

/** The key a link's label is held under in a `RecordLinkLabelsResult`. */
export const recordLinkLabelKey = (link: RecordLinkReference): string =>
  `${link.recordTypeId.toLowerCase()}:${link.recordId.toLowerCase()}`;

const MAXIMUM_LABEL_LENGTH = 200;

/** The installed module and record type a stored link value's record type identity names. */
const locateLinkTarget = (context: InstalledRuntimeContext, recordTypeId: string) => {
  for (const module of context.releaseSet.modules) {
    const recordType = module.content.recordTypes.find((candidate) =>
      sameId(candidate.recordTypeId, recordTypeId),
    );
    if (recordType !== undefined) return { module, recordType };
  }
  return undefined;
};

/** The identity of a located link target within the installed context, without a record. */
const linkTargetIdentity = (
  context: InstalledRuntimeContext,
  module: NonNullable<ReturnType<typeof locateLinkTarget>>["module"],
  recordType: NonNullable<ReturnType<typeof locateLinkTarget>>["recordType"],
) => ({
  organizationId: context.organizationId,
  applicationRootId: context.applicationRootId,
  moduleRootId: module.rootId,
  moduleReleaseRevision: module.releaseRevision,
  recordTypeId: recordType.recordTypeId,
  storageContractId: recordType.storageContractId,
});

const labelText = (title: ViewerSafeRecordLinkTitle): string | undefined => {
  const text = (typeof title === "string" ? title : JSON.stringify(title))?.trim();
  if (text === undefined || text.length === 0) return undefined;
  return text.length > MAXIMUM_LABEL_LENGTH ? `${text.slice(0, MAXIMUM_LABEL_LENGTH - 1)}…` : text;
};

const labelsUnavailable: RecordLinkLabelsResult = { outcome: "unavailable" };

const unavailable: ViewerSafeRecordLinkResult = { outcome: "unavailable" };
const pinUnavailable: ViewerSafeRecordPinAcquisitionResult = { outcome: "unavailable" };

const matchingRecordType = (
  context: InstalledRuntimeContext,
  identity: ReturnType<typeof viewerSafeRecordLinkIdentitySchema.parse>,
) => {
  const modules = context.releaseSet.modules.filter(
    (module) =>
      sameId(module.rootId, identity.moduleRootId) &&
      module.releaseRevision === identity.moduleReleaseRevision,
  );
  if (modules.length !== 1 || modules[0] === undefined) return undefined;
  const recordTypes = modules[0].content.recordTypes.filter(
    (recordType) =>
      sameId(recordType.recordTypeId, identity.recordTypeId) &&
      sameId(recordType.storageContractId, identity.storageContractId),
  );
  return recordTypes.length === 1 ? recordTypes[0] : undefined;
};

const matchingDetailPage = (
  context: InstalledRuntimeContext,
  identity: ReturnType<typeof viewerSafeRecordLinkIdentitySchema.parse>,
) => {
  const pages = context.releaseSet.application.content.pages.filter(
    (page) =>
      page.type === "detail" &&
      page.recordType.state === "resolved" &&
      sameId(page.recordType.moduleRootId, identity.moduleRootId) &&
      sameId(page.recordType.recordTypeId, identity.recordTypeId),
  );
  return pages.length === 1 ? pages[0] : undefined;
};

const currentContextMatches = (
  context: InstalledRuntimeContext,
  identity: ReturnType<typeof viewerSafeRecordLinkIdentitySchema.parse>,
): boolean =>
  sameId(context.organizationId, identity.organizationId) &&
  sameId(context.applicationRootId, identity.applicationRootId) &&
  sameId(context.installation.organizationId, identity.organizationId) &&
  sameId(context.installation.applicationRootId, identity.applicationRootId) &&
  context.applicationReleaseRevision === context.installation.applicationReleaseRevision;

const permissionAction = (permission: PermissionDeclaration) => ({
  actionKind: permission.actionKind,
  ...(permission.namedAction === undefined ? {} : { namedAction: permission.namedAction }),
});

/** Check the detail page's own required permission under this viewer's resolved request. */
const canOpenDetailPage = async (
  permissions: PlatformPermissionSource,
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  context: InstalledRuntimeContext,
  page: PageDefinition,
): Promise<boolean> => {
  const platform = permissions.forKey(page.accessPermissionKey);
  let declaration: OrganizationAccessDeclaration;
  if (platform !== undefined) {
    declaration = {
      operationKey: "application.page.discover",
      action: permissionAction(platform),
      target: { kind: "organization" },
      requiredPermission: {
        ownerKind: "platform",
        ownerId: permissions.ownerId,
        permissionId: platform.permissionId,
      },
      recentAuthentication: { kind: "none" },
      authority: { kind: "permission" },
    };
  } else {
    const entries = context.permissionRegistration.entries.filter(
      (entry) => entry.permission.key === page.accessPermissionKey,
    );
    if (entries.length !== 1 || entries[0] === undefined) return false;
    const entry = entries[0];
    declaration = {
      operationKey: "application.page.discover",
      action: permissionAction(entry.permission),
      target: { kind: "application", applicationRootId: context.applicationRootId },
      requiredPermission: {
        applicationRootId: entry.applicationRootId,
        ownerKind: entry.ownerKind,
        ownerId: entry.ownerId,
        permissionId: entry.permission.permissionId,
      },
      recentAuthentication: { kind: "none" },
      authority: { kind: "permission" },
    };
  }
  const result = await runOrganizationAccessOperation(
    transaction,
    scope,
    declaration,
    async () => true,
  );
  // Labels may be read in a later request than the installed context. The current access
  // operation authorises this page; those independent requests need not share a correlation id.
  return result.outcome === "completed" && result.value;
};

const completeRead = (
  context: InstalledRuntimeContext,
  identity: ReturnType<typeof viewerSafeRecordLinkIdentitySchema.parse>,
  page: NonNullable<ReturnType<typeof matchingDetailPage>>,
  readTitle: ViewerSafeRecordLinkTitleReadResult,
): ViewerSafeRecordLinkResult => {
  if (readTitle.outcome !== "read") return unavailable;
  return viewerSafeRecordLinkResultSchema.parse({
    outcome: "available",
    title: readTitle.title,
    detailAddress: {
      applicationRootId: context.applicationRootId,
      applicationKey: context.releaseSet.application.definitionKey,
      pageId: page.pageId,
      pageKey: page.key,
      recordId: identity.recordId,
    },
  });
};

/**
 * Resolves one exact installed target record for the current human viewer. The identity tuple only
 * selects the target context: App verifies the active installation and exact bound releases, then
 * Query obtains the title through the current protected Record read. The detail page's own access
 * requirement is checked here and again by its destination when opened.
 */
export const createViewerSafeRecordLinkService = (
  dependencies: ViewerSafeRecordLinkServiceDependencies,
) => {
  const requests = createHumanOrganizationRequestService(dependencies);
  const records = createViewerSafeRecordLinkReadService();

  return Object.freeze({
    async acquireIdentity(
      session: IdentitySession,
      sourceSelectionCandidate: unknown,
      selectorCandidate: unknown,
    ): Promise<ViewerSafeRecordPinAcquisitionResult> {
      const source = organizationSelectionCandidateSchema.safeParse(sourceSelectionCandidate);
      const selector = viewerSafeRecordPinSelectorSchema.safeParse(selectorCandidate);
      if (
        !source.success ||
        source.data.applicationRootId === undefined ||
        !selector.success ||
        dependencies.resolveTargetApplication === undefined
      )
        return pinUnavailable;
      const sourceRoot = source.data.applicationRootId;

      try {
        // Verify the source human request before resolving a target in that same organisation.
        const verifiedSource = await requests.run(
          session,
          source.data,
          async (_transaction, scope) =>
            sameId(scope.organizationId, source.data.organizationId) &&
            scope.applicationRootId !== undefined &&
            sameId(scope.applicationRootId, sourceRoot),
        );
        if (verifiedSource.kind !== "available" || !verifiedSource.value) return pinUnavailable;
        const target = organizationSelectionCandidateSchema.safeParse(
          await dependencies.resolveTargetApplication(
            session,
            source.data,
            selector.data.applicationKey,
          ),
        );
        if (
          !target.success ||
          target.data.applicationRootId === undefined ||
          !sameId(target.data.organizationId, source.data.organizationId)
        )
          return pinUnavailable;
        const targetRoot = target.data.applicationRootId;
        const [moduleKey, recordTypeKey] = selector.data.recordTypeKey.split(":");
        const request = await requests.run(
          session,
          target.data,
          async (transaction, scope): Promise<ViewerSafeRecordPinAcquisitionResult> => {
            if (
              !sameId(scope.organizationId, source.data.organizationId) ||
              scope.applicationRootId === undefined ||
              !sameId(scope.applicationRootId, targetRoot)
            )
              return pinUnavailable;
            const context = requireInstalledRuntimeContext(
              await dependencies.createInstalledContextLoader(transaction, scope).load(),
            );
            if (context.releaseSet.application.definitionKey !== selector.data.applicationKey)
              return pinUnavailable;
            const modules = context.releaseSet.modules.filter(
              (module) => module.definitionKey === moduleKey,
            );
            const module = modules[0];
            if (modules.length !== 1 || module === undefined) return pinUnavailable;
            const recordTypes = module.content.recordTypes.filter(
              (record) => record.key === recordTypeKey,
            );
            const recordType = recordTypes[0];
            if (recordTypes.length !== 1 || recordType === undefined) return pinUnavailable;
            const identity = viewerSafeRecordLinkIdentitySchema.parse({
              organizationId: scope.organizationId,
              applicationRootId: targetRoot,
              moduleRootId: module.rootId,
              moduleReleaseRevision: module.releaseRevision,
              recordTypeId: recordType.recordTypeId,
              storageContractId: recordType.storageContractId,
              recordId: selector.data.recordId,
            });
            if (!currentContextMatches(context, identity)) return pinUnavailable;
            const page = matchingDetailPage(context, identity);
            if (
              page === undefined ||
              !(await canOpenDetailPage(
                dependencies.permissions,
                transaction,
                scope,
                context,
                page,
              ))
            )
              return pinUnavailable;
            const titleRead = await records.read(transaction, scope, {
              identity,
              applicationReleaseRevision: context.applicationReleaseRevision,
              titleFieldId: recordType.titleFieldId,
            });
            // The protected read proves the record is available. Its display value never leaves here.
            return titleRead.outcome === "read"
              ? viewerSafeRecordPinAcquisitionResultSchema.parse({ outcome: "available", identity })
              : pinUnavailable;
          },
        );
        return request.kind === "available"
          ? viewerSafeRecordPinAcquisitionResultSchema.parse(request.value)
          : pinUnavailable;
      } catch {
        return pinUnavailable;
      }
    },
    /**
     * Reads the display label of every linked record a page shows, in one set read per target
     * record type under the viewer's own authority. The installed context is the one this page
     * request already resolved; the read checks it against the live installation again. A target
     * the viewer may not read is `restricted` and carries nothing of the record, and the detail
     * address is given only when the viewer may open the target's detail page.
     */
    async readLabels(
      session: IdentitySession,
      selection: OrganizationSelectionCandidate,
      context: InstalledRuntimeContext,
      links: readonly RecordLinkReference[],
    ): Promise<RecordLinkLabelsResult> {
      const labels = new Map<string, RecordLinkLabel>();
      if (links.length === 0) return { outcome: "read", labels };
      try {
        const byType = new Map<string, Map<string, RecordId>>();
        for (const link of links) {
          const typeKey = link.recordTypeId.toLowerCase();
          const ids = byType.get(typeKey) ?? new Map<string, RecordId>();
          ids.set(link.recordId.toLowerCase(), recordIdSchema.parse(link.recordId));
          byType.set(typeKey, ids);
        }
        const request = await requests.run(
          session,
          selection,
          async (transaction, scope): Promise<RecordLinkLabelsResult> => {
            if (
              !sameId(scope.organizationId, context.organizationId) ||
              scope.applicationRootId === undefined ||
              !sameId(scope.applicationRootId, context.applicationRootId)
            )
              throw new Error("RECORD_LINK_SCOPE_MISMATCH");
            type LinkTypeRead = {
              readonly typeKey: string;
              readonly identity: ReturnType<typeof linkTargetIdentity>;
              readonly titleFieldId: string;
              readonly recordIds: readonly RecordId[];
              readonly protectedGroups: boolean;
              readonly titleIsGroupName: boolean;
              readonly page: PageDefinition | undefined;
              readonly openable: boolean;
            };
            const typeReads: LinkTypeRead[] = [];
            for (const [typeKey, ids] of byType) {
              const target = locateLinkTarget(context, typeKey);
              if (target === undefined) {
                console.error(
                  "[page] record link target is not installed: RECORD_LINK_TARGET_NOT_INSTALLED",
                );
                for (const id of ids.keys())
                  labels.set(`${typeKey}:${id}`, { outcome: "restricted" });
                continue;
              }
              const { module, recordType } = target;
              const recordIds = [...ids.values()];
              const identity = linkTargetIdentity(context, module, recordType);
              const page = matchingDetailPage(context, { ...identity, recordId: recordIds[0]! });
              const openable =
                page !== undefined &&
                (await canOpenDetailPage(
                  dependencies.permissions,
                  transaction,
                  scope,
                  context,
                  page,
                ));
              typeReads.push({
                typeKey,
                identity,
                titleFieldId: recordType.titleFieldId,
                recordIds,
                protectedGroups: recordType.systemProjection?.protectedView === "groups",
                titleIsGroupName: recordType.fields.some(
                  (field) =>
                    sameId(field.fieldId, recordType.titleFieldId) && field.key === "label",
                ),
                page,
                openable,
              });
            }

            // The titles of every target type are read together: one database call (one access
            // plan resolution) per set of at most the database's type and record limits.
            const titles = new Map<string, ViewerSafeRecordLinkTitle>();
            let pending: {
              identity: LinkTypeRead["identity"];
              titleFieldId: string;
              recordIds: RecordId[];
            }[] = [];
            let pendingRecords = 0;
            const flushTitles = async () => {
              if (pending.length === 0) return;
              const read = await records.readTitles(transaction, scope, {
                applicationReleaseRevision: context.applicationReleaseRevision,
                targets: pending,
              });
              if (read.outcome !== "read") throw new Error("RECORD_LINK_INSTALLATION_MISMATCH");
              for (const [key, title] of read.titles) titles.set(key, title);
              pending = [];
              pendingRecords = 0;
            };
            for (const typeRead of typeReads) {
              for (let start = 0; start < typeRead.recordIds.length;) {
                if (
                  pendingRecords >= viewerSafeRecordLinkTitleRecordLimit ||
                  pending.length >= viewerSafeRecordLinkTitleTypeLimit
                )
                  await flushTitles();
                const take = Math.min(
                  viewerSafeRecordLinkTitleRecordLimit - pendingRecords,
                  typeRead.recordIds.length - start,
                );
                pending.push({
                  identity: typeRead.identity,
                  titleFieldId: typeRead.titleFieldId,
                  recordIds: typeRead.recordIds.slice(start, start + take),
                });
                pendingRecords += take;
                start += take;
              }
            }
            await flushTitles();

            for (const typeRead of typeReads) {
              const { typeKey, page } = typeRead;
              const visible = typeRead.protectedGroups
                ? await readVisibleGroupLabels(transaction, typeRead.recordIds)
                : undefined;
              for (const recordId of typeRead.recordIds) {
                const key = `${typeKey}:${recordId.toLowerCase()}`;
                const title = titles.get(key);
                const titleText = title === undefined ? undefined : labelText(title);
                if (title !== undefined && titleText === undefined)
                  console.error("[page] record link title is empty: RECORD_LINK_TITLE_EMPTY");
                let label: string | undefined = titleText;
                if (visible !== undefined) {
                  const groupName = visible.get(recordId.toLowerCase());
                  label =
                    groupName !== undefined && titleText !== undefined
                      ? typeRead.titleIsGroupName
                        ? groupName
                        : titleText
                      : undefined;
                }
                labels.set(
                  key,
                  label === undefined
                    ? { outcome: "restricted" }
                    : {
                        outcome: "available",
                        label,
                        ...(typeRead.openable && page !== undefined
                          ? {
                              detail: {
                                applicationKey: context.releaseSet.application.definitionKey,
                                pageKey: page.key,
                                recordId,
                              },
                            }
                          : {}),
                      },
                );
              }
            }
            return { outcome: "read", labels };
          },
        );
        if (request.kind === "available") return request.value;
        console.error(
          `[page] record link labels unavailable: RECORD_LINK_LABELS_${request.kind.toUpperCase()}`,
        );
        return labelsUnavailable;
      } catch (error) {
        console.error(
          `[page] record link labels unavailable: RECORD_LINK_LABELS_READ_FAILED ${describeFailure(error)}`,
        );
        return labelsUnavailable;
      }
    },
    async read(
      session: IdentitySession,
      identityCandidate: unknown,
    ): Promise<ViewerSafeRecordLinkResult> {
      const identity = viewerSafeRecordLinkIdentitySchema.safeParse(identityCandidate);
      if (!identity.success) return unavailable;

      const selection: OrganizationSelectionCandidate = {
        organizationId: identity.data.organizationId,
        applicationRootId: identity.data.applicationRootId,
      };
      try {
        const request = await requests.run(
          session,
          selection,
          async (transaction, scope): Promise<ViewerSafeRecordLinkResult> => {
            if (
              !sameId(scope.organizationId, identity.data.organizationId) ||
              scope.applicationRootId === undefined ||
              !sameId(scope.applicationRootId, identity.data.applicationRootId)
            )
              return unavailable;

            const context = requireInstalledRuntimeContext(
              await dependencies.createInstalledContextLoader(transaction, scope).load(),
            );
            if (!currentContextMatches(context, identity.data)) return unavailable;
            const recordType = matchingRecordType(context, identity.data);
            const page = matchingDetailPage(context, identity.data);
            if (recordType === undefined || page === undefined) return unavailable;
            if (
              !(await canOpenDetailPage(
                dependencies.permissions,
                transaction,
                scope,
                context,
                page,
              ))
            )
              return unavailable;

            const titleRead = await records.read(transaction, scope, {
              identity: identity.data,
              applicationReleaseRevision: context.applicationReleaseRevision,
              titleFieldId: recordType.titleFieldId,
            });
            return completeRead(context, identity.data, page, titleRead);
          },
        );
        return request.kind === "available"
          ? viewerSafeRecordLinkResultSchema.parse(request.value)
          : unavailable;
      } catch {
        return unavailable;
      }
    },
  });
};
