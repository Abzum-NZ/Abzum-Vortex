import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  createHumanOrganizationRequestService,
  runOrganizationAccessOperation,
  type HumanOrganizationRequestResult,
} from "../access/index";
import type { RequestDatabaseTransaction } from "../db/index";
import {
  FIELD_INPUT_BLOCK_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  FORM_CONTAINER_BLOCK_RELEASE,
  placementSettings,
  type InstalledRuntimeContext,
} from "../definition/index";
import type { QueryContinuationKey } from "../queries/index";
import { prepareRecordFieldValues } from "../records/index";
import {
  organizationAccessDeclarationSchema,
  builderKeySchema,
  containedComponentIdSchema,
  jsonValueSchema,
  richTextDocumentSchema,
  moduleFieldValueSchemas,
  recordIdSchema,
  ruleIdSchema,
  timestampSchema,
  type IdentitySession,
  type JsonValue,
  type ModuleField,
  type OrganizationAccessDeclaration,
  type OrganizationSelectionCandidate,
  type PageDefinition,
  type PermissionDeclaration,
  type PlatformId,
  type RecordTypeDefinition,
  type SelectedOrganizationScope,
  isRecord,
  itemPropSlots,
  sameId,
  walkPlacementData,
  resolveShellLayout,
  type ApplicationShell,
  type PageComposition,
} from "../schema";
import {
  createPrivateFormDraftService,
  privateFormDraftLimits,
  type PrivateFormDraft,
  type PrivateFormDraftAuthorityAdapter,
  type PrivateFormDraftFieldValidation,
  type PrivateFormDraftScope,
  type PrivateFormDraftServiceDependencies,
} from "./form-drafts";

/**
 * What the guided form needs from the web composition root: how to read the installed runtime
 * context inside a protected request, which authority the session belongs to, and the platform
 * permission declarations (owned by the definitions package, which depends on this one).
 */
export type GuidedFormDependencies = Readonly<{
  identityAuthorityId: PrivateFormDraftServiceDependencies["identityAuthorityId"];
  readContext: (
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
  ) => Promise<InstalledRuntimeContext | undefined>;
  platformPermissionFor: (key: string) => PermissionDeclaration | undefined;
  platformPermissionOwnerId: PlatformId;
}>;

export type GuidedFormStepField = Readonly<{
  field: ModuleField;
  fieldKey: string;
  placementId: string;
  required: boolean;
}>;

export type GuidedFormStepFields = Readonly<{
  stepId: string;
  summary: boolean;
  fields: readonly GuidedFormStepField[];
}>;

export type GuidedFormPageAddress = Readonly<{
  tenantShortName: string;
  organizationShortName: string;
  applicationKey: string;
  pageKey: string;
  subjectRecordId?: string;
}>;

export type GuidedFormStepRequest = Readonly<{
  address: GuidedFormPageAddress;
  draftId: string;
  expectedRevision: number;
  stepId: string;
  requestedStepId?: string;
  values: Readonly<Record<string, unknown>>;
}>;

export type GuidedFormStepActionResult =
  | Readonly<{
      kind: "updated";
      activeStepId: string;
      computedStepId: string;
      revision: number;
      valid: boolean;
    }>
  | Readonly<{ kind: "unchanged"; activeStepId: string; computedStepId: string; revision: number }>
  | Readonly<{ kind: "conflict"; activeStepId: string; computedStepId: string; revision: number }>
  | Readonly<{ kind: "unavailable" | "temporarily_unavailable" }>;

export type GuidedFormConfirmRequest = Readonly<{
  address: GuidedFormPageAddress;
  draftId: string;
  expectedRevision: number;
  stepId: string;
}>;

export type GuidedFormConfirmResult =
  | Readonly<{ kind: "confirmed"; proof: string }>
  | Readonly<{ kind: "conflict" | "unavailable" | "temporarily_unavailable" }>;

export type GuidedFormAbandonRequest = Readonly<{
  address: GuidedFormPageAddress;
  draftId: string;
  expectedRevision: number;
}>;

export const guidedFormConfirmationKey = "$guidedFormConfirmation";
const confirmationLifetimeSeconds = 120;
const confirmationPurpose = "vortex-guided-form-final-confirmation-v1";

export const guidedFormConfirmationReference = (
  candidate: unknown,
):
  | Readonly<{ draftId: string; revision: number; issuedAt: number; signature: string }>
  | undefined => {
  if (typeof candidate !== "string") return undefined;
  const match = /^([0-9a-f-]{36})\.([1-9][0-9]*)\.([0-9]{10})\.([0-9a-f]{64})$/u.exec(candidate);
  if (match === null) return undefined;
  const revision = Number(match[2]);
  const issuedAt = Number(match[3]);
  if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(issuedAt)) return undefined;
  return { draftId: match[1]!, revision, issuedAt, signature: match[4]! };
};

const confirmationSignature = (
  continuationKey: QueryContinuationKey,
  details: Readonly<{
    draftId: string;
    revision: number;
    issuedAt: number;
    pageId: string;
    flowId: string;
    sessionId: string;
    identityId: string;
    organizationId: string;
    applicationRootId: string;
    subjectRecordId?: string;
  }>,
): Buffer =>
  createHmac("sha256", continuationKey.key)
    .update(
      JSON.stringify([
        confirmationPurpose,
        details.draftId.toLowerCase(),
        details.revision,
        details.issuedAt,
        details.pageId.toLowerCase(),
        details.flowId.toLowerCase(),
        details.sessionId.toLowerCase(),
        details.identityId.toLowerCase(),
        details.organizationId.toLowerCase(),
        details.applicationRootId.toLowerCase(),
        details.subjectRecordId?.toLowerCase() ?? null,
      ]),
    )
    .digest();

export const issueGuidedFormConfirmation = async (
  continuationKey: QueryContinuationKey,
  details: Omit<Parameters<typeof confirmationSignature>[1], "issuedAt">,
): Promise<string | undefined> => {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const signature = confirmationSignature(continuationKey, { ...details, issuedAt }).toString(
    "hex",
  );
  return `${details.draftId.toLowerCase()}.${details.revision}.${issuedAt}.${signature}`;
};

export const verifiesGuidedFormConfirmation = async (
  continuationKey: QueryContinuationKey,
  proof: unknown,
  details: Omit<Parameters<typeof confirmationSignature>[1], "issuedAt" | "draftId" | "revision">,
): Promise<boolean> => {
  const reference = guidedFormConfirmationReference(proof);
  if (reference === undefined) return false;
  const age = Math.floor(Date.now() / 1_000) - reference.issuedAt;
  if (age < 0 || age > confirmationLifetimeSeconds) return false;
  const expected = confirmationSignature(continuationKey, { ...details, ...reference });
  return timingSafeEqual(Buffer.from(reference.signature, "hex"), expected);
};

const recordTypeForPage = (
  page: Readonly<Record<string, unknown>>,
  modules: readonly Readonly<Record<string, unknown>>[],
): RecordTypeDefinition | undefined => {
  const reference = page.recordType;
  if (!isRecord(reference) || reference.state !== "resolved") return undefined;
  for (const module of modules) {
    if (
      typeof module.rootId !== "string" ||
      !sameId(module.rootId, String(reference.moduleRootId)) ||
      !isRecord(module.content) ||
      !Array.isArray(module.content.recordTypes)
    )
      continue;
    const matches = module.content.recordTypes.filter(
      (candidate) =>
        isRecord(candidate) &&
        typeof candidate.recordTypeId === "string" &&
        sameId(candidate.recordTypeId, String(reference.recordTypeId)),
    );
    if (matches.length === 1) return matches[0] as RecordTypeDefinition;
  }
  return undefined;
};

const inputBlock = (vortex: Record<string, unknown>): boolean => {
  const block = vortex.block;
  if (!isRecord(block) || typeof block.blockId !== "string") return false;
  return (
    sameId(block.blockId, FIELD_INPUT_BLOCK_RELEASE.blockId) ||
    Object.values(FIELD_INPUT_CONTROL_RELEASES).some((release) =>
      sameId(release.blockId, block.blockId as string),
    )
  );
};

const guidedStepFieldForPlacement = (
  props: Record<string, unknown>,
  recordType: RecordTypeDefinition,
): Omit<GuidedFormStepField, "placementId"> | undefined => {
  const settings = placementSettings(props);
  const name = settings.name;
  const parsedKey =
    isRecord(name) && name.kind === "text" ? builderKeySchema.safeParse(name.value) : undefined;
  const fieldReference = settings.field;
  const referencedFieldId =
    isRecord(fieldReference) &&
    fieldReference.kind === "field_reference" &&
    typeof fieldReference.fieldId === "string"
      ? fieldReference.fieldId
      : undefined;
  const field =
    referencedFieldId !== undefined
      ? recordType.fields.find((candidate) => sameId(String(candidate.fieldId), referencedFieldId))
      : parsedKey?.success
        ? recordType.fields.find((candidate) => candidate.key === parsedKey.data)
        : undefined;
  // Form controls submit under their authored name. A field reference with a different name
  // cannot be validated or saved as the referenced record field.
  if (field === undefined || !parsedKey?.success || parsedKey.data !== field.key) return undefined;
  return {
    field,
    fieldKey: field.key,
    required:
      field.required ||
      (isRecord(settings.required) &&
        settings.required.kind === "boolean" &&
        settings.required.value === true),
  };
};

type GuidedStepRoot = Readonly<{
  stepId: string;
  root: unknown;
  pagePlacementIds: ReadonlySet<string>;
}>;

const placementIdsInTree = (root: unknown, availableOnly = false): ReadonlySet<string> => {
  const ids = new Set<string>();
  walkPlacementData(root, ({ placementId, vortex }) => {
    if (availableOnly && vortex.availability === "unavailable") return false;
    ids.add(placementId.toLowerCase());
    return undefined;
  });
  return ids;
};

const guidedStepRoots = (
  page: Readonly<Record<string, unknown>>,
  shellsCandidate?: unknown,
): readonly GuidedStepRoot[] | undefined => {
  if (page.type !== "guided_form" || !Array.isArray(page.steps) || !isRecord(page.composition))
    return undefined;
  const steps = page.steps;
  const composition = page.composition;
  const stepContent = composition.stepContent;
  if (!isRecord(stepContent)) return undefined;
  const declaredSteps = steps.map((candidate) =>
    isRecord(candidate) && typeof candidate.id === "string" ? candidate.id : undefined,
  );
  if (
    declaredSteps.some((stepId) => stepId === undefined) ||
    new Set(declaredSteps).size !== declaredSteps.length ||
    Object.keys(stepContent).length !== declaredSteps.length
  )
    return undefined;

  const data = declaredSteps.map((stepId) => stepContent[stepId!]);
  if (!data.every(isRecord)) return undefined;
  const vortexOf = (candidate: Readonly<Record<string, unknown>>) =>
    isRecord(candidate.root) &&
    isRecord(candidate.root.props) &&
    isRecord(candidate.root.props.vortex)
      ? candidate.root.props.vortex
      : undefined;
  // A projected page is already resolved: every step is one layout in the platform frame. A
  // compiled step names its frame: the default frame (null) or one application shell.
  const shellIds = new Set(data.map((candidate) => vortexOf(candidate)?.shellId));
  if (shellIds.size !== 1) return undefined;
  const shellId = [...shellIds][0];
  if (shellId === undefined || shellId === null)
    return declaredSteps.map((stepId) => ({
      stepId: stepId!,
      root: stepContent[stepId!],
      pagePlacementIds: placementIdsInTree(stepContent[stepId!]),
    }));
  if (typeof shellId !== "string" || !Array.isArray(shellsCandidate)) return undefined;
  const matchingShells = shellsCandidate.filter(
    (shell) =>
      isRecord(shell) && typeof shell.shellId === "string" && sameId(shell.shellId, shellId),
  );
  const shell = matchingShells[0] as ApplicationShell | undefined;
  if (matchingShells.length !== 1 || shell === undefined) return undefined;
  const resolved: GuidedStepRoot[] = [];
  for (const stepId of declaredSteps as string[]) {
    const pageContent = stepContent[stepId] as PageComposition;
    let root: unknown;
    try {
      root = resolveShellLayout(shell, pageContent);
    } catch {
      // A step whose content does not fit its shell has no fields, exactly as an unknown page.
      return undefined;
    }
    resolved.push({ stepId, root, pagePlacementIds: placementIdsInTree(pageContent) });
  }
  return resolved;
};

const collectStepFields = (
  page: Readonly<Record<string, unknown>>,
  recordType: RecordTypeDefinition,
  shellsCandidate?: unknown,
  visiblePlacementIds?: ReadonlySet<string>,
): readonly GuidedFormStepFields[] | undefined => {
  const roots = guidedStepRoots(page, shellsCandidate);
  const lastStep = Array.isArray(page.steps) ? page.steps.at(-1) : undefined;
  if (roots === undefined || !isRecord(lastStep) || lastStep.summary !== true) return undefined;
  const result: GuidedFormStepFields[] = [];
  const allFieldKeys = new Set<string>();
  for (const candidate of page.steps as readonly unknown[]) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.summary !== "boolean"
    )
      return undefined;
    const stepRoot = roots.find((entry) => entry.stepId === candidate.id);
    const root = stepRoot?.root;
    const fields: GuidedFormStepField[] = [];
    const seenKeys = new Set<string>();
    const stepFormIds = new Set<string>();
    const visitItems = (items: unknown, formPlacementId?: string): boolean => {
      if (!Array.isArray(items)) return false;
      for (const item of items) {
        if (!isRecord(item) || !isRecord(item.props) || !isRecord(item.props.vortex)) return false;
        const props = item.props;
        const vortex = item.props.vortex;
        const placementId = String(props.id);
        const block = vortex.block;
        const isForm =
          isRecord(block) &&
          typeof block.blockId === "string" &&
          sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId);
        if (isForm) stepFormIds.add(placementId.toLowerCase());
        const owner = isForm ? placementId : formPlacementId;
        if (
          stepRoot?.pagePlacementIds.has(placementId.toLowerCase()) === true &&
          inputBlock(vortex) &&
          owner === undefined
        )
          return false;
        if (
          owner !== undefined &&
          stepRoot?.pagePlacementIds.has(placementId.toLowerCase()) === true &&
          (visiblePlacementIds === undefined ||
            visiblePlacementIds.has(placementId.toLowerCase())) &&
          inputBlock(vortex)
        ) {
          const field = guidedStepFieldForPlacement(props, recordType);
          if (
            field === undefined ||
            seenKeys.has(field.fieldKey) ||
            allFieldKeys.has(field.fieldKey)
          )
            return false;
          seenKeys.add(field.fieldKey);
          allFieldKeys.add(field.fieldKey);
          fields.push({ ...field, placementId });
        }
        for (const [, child] of itemPropSlots(props)) if (!visitItems(child, owner)) return false;
      }
      return true;
    };
    const visit = (layout: unknown): boolean => isRecord(layout) && visitItems(layout.content);
    if (!visit(root) || stepFormIds.size > 1 || (candidate.summary && fields.length > 0))
      return undefined;
    result.push({ stepId: candidate.id, summary: candidate.summary, fields });
  }
  return result;
};

export const getGuidedFormStepFields = (
  pageCandidate: unknown,
  recordType: RecordTypeDefinition,
  shellsCandidate?: unknown,
  visiblePageCandidate?: unknown,
): readonly GuidedFormStepFields[] | undefined => {
  if (!isRecord(pageCandidate)) return undefined;
  const visiblePlacementIds =
    visiblePageCandidate === undefined
      ? undefined
      : getGuidedFormVisiblePlacementIds(visiblePageCandidate, shellsCandidate);
  if (visiblePageCandidate !== undefined && visiblePlacementIds === undefined) return undefined;
  return collectStepFields(pageCandidate, recordType, shellsCandidate, visiblePlacementIds);
};

export const getGuidedFormVisiblePlacementIds = (
  pageCandidate: unknown,
  shellsCandidate?: unknown,
): ReadonlySet<string> | undefined => {
  if (!isRecord(pageCandidate)) return undefined;
  const roots = guidedStepRoots(pageCandidate, shellsCandidate);
  if (roots === undefined) return undefined;
  return new Set(roots.flatMap((entry) => [...placementIdsInTree(entry.root, true)]));
};

export const getGuidedFormRecordType = (
  pageCandidate: unknown,
  modulesCandidate: unknown,
): RecordTypeDefinition | undefined => {
  if (!isRecord(pageCandidate) || !Array.isArray(modulesCandidate)) return undefined;
  return recordTypeForPage(
    pageCandidate,
    modulesCandidate.filter(isRecord) as Readonly<Record<string, unknown>>[],
  );
};

const formPlacementIdsInTree = (root: unknown, availableOnly: boolean): ReadonlySet<string> => {
  const ids = new Set<string>();
  walkPlacementData(root, ({ placementId, vortex }) => {
    if (availableOnly && vortex.availability === "unavailable") return false;
    if (
      isRecord(vortex.block) &&
      typeof vortex.block.blockId === "string" &&
      sameId(vortex.block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
    )
      ids.add(placementId.toLowerCase());
    return undefined;
  });
  return ids;
};

const collectFormIds = (
  page: Readonly<Record<string, unknown>>,
  shellsCandidate?: unknown,
): ReadonlySet<string> => {
  const roots = guidedStepRoots(page, shellsCandidate);
  return new Set(roots?.flatMap((entry) => [...formPlacementIdsInTree(entry.root, true)]));
};

export const getGuidedFormControlIds = (
  pageCandidate: unknown,
  shellsCandidate?: unknown,
): Readonly<{ all: ReadonlySet<string>; summary?: string }> | undefined => {
  if (!isRecord(pageCandidate)) return undefined;
  const roots = guidedStepRoots(pageCandidate, shellsCandidate);
  const summary = Array.isArray(pageCandidate.steps)
    ? pageCandidate.steps.find((step) => isRecord(step) && step.summary === true)
    : undefined;
  if (roots === undefined || !isRecord(summary) || typeof summary.id !== "string") return undefined;
  const summaryRoot = roots.find((entry) => entry.stepId === summary.id);
  if (summaryRoot === undefined) return undefined;
  const summaryIds = formPlacementIdsInTree(summaryRoot.root, false);
  // Gate step-owned action and display controls as well as form containers, including a form
  // supplied by a shell, so they cannot invoke a flow before final confirmation.
  const all = new Set([
    ...roots.flatMap((entry) => [...entry.pagePlacementIds]),
    ...roots.flatMap((entry) => [...formPlacementIdsInTree(entry.root, false)]),
  ]);
  const summaryId = [...summaryIds][0];
  return summaryIds.size === 1 && summaryId !== undefined && all.has(summaryId)
    ? { all, summary: summaryId }
    : { all };
};

const flowForGuidedForm = (
  page: Readonly<Record<string, unknown>>,
  flowBindings: readonly Readonly<Record<string, unknown>>[],
  shellsCandidate?: unknown,
): string | undefined => {
  const roots = guidedStepRoots(page, shellsCandidate);
  const forms = collectFormIds(page, shellsCandidate);
  if (forms.size === 0) return undefined;
  const summary = Array.isArray(page.steps)
    ? page.steps.find(
        (step) => isRecord(step) && step.summary === true && typeof step.id === "string",
      )
    : undefined;
  if (!isRecord(summary) || roots === undefined) return undefined;
  const summaryRoot = roots.find((entry) => entry.stepId === summary.id)?.root;
  if (summaryRoot === undefined) return undefined;
  const summaryForms = formPlacementIdsInTree(summaryRoot, true);
  if (summaryForms.size !== 1) return undefined;
  const flowIds = new Set<string>();
  const summaryFlowIds = new Set<string>();
  for (const binding of flowBindings) {
    if (
      binding.event !== "form_submit" ||
      typeof binding.controlId !== "string" ||
      !forms.has(binding.controlId.toLowerCase()) ||
      !isRecord(binding.flow) ||
      typeof binding.flow.flowId !== "string"
    )
      continue;
    flowIds.add(binding.flow.flowId.toLowerCase());
    if (summaryForms.has(binding.controlId.toLowerCase()))
      summaryFlowIds.add(binding.flow.flowId.toLowerCase());
  }
  return flowIds.size === 1 && summaryFlowIds.size === 1 && flowIds.has([...summaryFlowIds][0]!)
    ? [...flowIds][0]
    : undefined;
};

export const getGuidedFormFlowId = (
  pageCandidate: unknown,
  bindingsCandidate: unknown,
  shellsCandidate?: unknown,
) => {
  if (!isRecord(pageCandidate) || !Array.isArray(bindingsCandidate)) return undefined;
  return flowForGuidedForm(
    pageCandidate,
    bindingsCandidate.filter(isRecord) as Readonly<Record<string, unknown>>[],
    shellsCandidate,
  );
};

const pageAccess = (
  dependencies: Pick<GuidedFormDependencies, "platformPermissionFor" | "platformPermissionOwnerId">,
  context: InstalledRuntimeContext,
  page: Readonly<Record<string, unknown>>,
): OrganizationAccessDeclaration | undefined => {
  if (typeof page.accessPermissionKey !== "string") return undefined;
  const platform = dependencies.platformPermissionFor(page.accessPermissionKey);
  if (platform !== undefined)
    return organizationAccessDeclarationSchema.parse({
      operationKey: "application.page.discover",
      action: {
        actionKind: platform.actionKind,
        ...(platform.namedAction === undefined ? {} : { namedAction: platform.namedAction }),
      },
      target: { kind: "organization" },
      requiredPermission: {
        ownerKind: "platform",
        ownerId: dependencies.platformPermissionOwnerId,
        permissionId: platform.permissionId,
      },
      recentAuthentication: { kind: "none" },
      authority: { kind: "permission" },
    });
  const entries = context.permissionRegistration.entries.filter(
    (entry) => entry.permission.key === page.accessPermissionKey,
  );
  if (entries.length !== 1 || entries[0] === undefined) return undefined;
  const entry = entries[0];
  return organizationAccessDeclarationSchema.parse({
    operationKey: "application.page.discover",
    action: {
      actionKind: entry.permission.actionKind,
      ...(entry.permission.namedAction === undefined || entry.permission.namedAction === null
        ? {}
        : { namedAction: entry.permission.namedAction }),
    },
    target: { kind: "application", applicationRootId: context.applicationRootId },
    requiredPermission: {
      applicationRootId: entry.applicationRootId,
      ownerKind: entry.ownerKind,
      ownerId: entry.ownerId,
      permissionId: entry.permission.permissionId,
    },
    recentAuthentication: { kind: "none" },
    authority: { kind: "permission" },
  });
};

const createAuthorityAdapter = (
  dependencies: GuidedFormDependencies,
): PrivateFormDraftAuthorityAdapter => ({
  async load(transaction, scope, form) {
    const context = await dependencies.readContext(transaction, scope);
    if (context === undefined) return undefined;
    const pages = context.releaseSet.application.content.pages.filter((candidate) =>
      sameId(String(candidate.pageId), String(form.formId)),
    );
    if (pages.length !== 1 || pages[0] === undefined) return undefined;
    const page = pages[0] as unknown as Readonly<Record<string, unknown>>;
    if (page.type !== "guided_form") return undefined;
    const recordType = recordTypeForPage(
      page,
      context.releaseSet.modules as unknown as readonly Readonly<Record<string, unknown>>[],
    );
    if (recordType === undefined) return undefined;
    const steps = collectStepFields(
      page,
      recordType,
      context.releaseSet.application.content.shells,
    );
    const applicationBindings = context.releaseSet.application.content
      .flowBindings as unknown as readonly Readonly<Record<string, unknown>>[];
    const flowId = flowForGuidedForm(
      page,
      applicationBindings,
      context.releaseSet.application.content.shells,
    );
    if (
      steps === undefined ||
      flowId === undefined ||
      form.flowId === undefined ||
      !sameId(flowId, String(form.flowId))
    )
      return undefined;
    const access = pageAccess(dependencies, context, page);
    if (access === undefined) return undefined;
    const fields = new Map<string, ModuleField>();
    for (const step of steps)
      for (const entry of step.fields) fields.set(entry.fieldKey, entry.field);
    const fieldChoices: Record<string, JsonValue[]> = {};
    const recordTypeReference = page.recordType;
    if (!isRecord(recordTypeReference) || typeof recordTypeReference.moduleRootId !== "string")
      return undefined;
    const moduleRootId = recordTypeReference.moduleRootId;
    const permissionDecisions = new Map<string, boolean>();
    for (const [fieldKey, field] of fields) {
      if (field.type !== "choice" && field.type !== "several_choices") continue;
      const choices: JsonValue[] = [];
      for (const option of field.settings.options) {
        const permissionId = option.requiredPermissionId;
        if (permissionId === undefined) {
          choices.push(option.value);
          continue;
        }
        const permissionKey = `${moduleRootId.toLowerCase()}:${String(permissionId).toLowerCase()}`;
        let allowed = permissionDecisions.get(permissionKey);
        if (allowed === undefined) {
          const matches = context.permissionRegistration.entries.filter(
            (entry) =>
              entry.ownerKind === "module" &&
              sameId(String(entry.ownerId), moduleRootId) &&
              sameId(String(entry.permission.permissionId), String(permissionId)),
          );
          if (matches.length !== 1 || matches[0] === undefined) return undefined;
          const entry = matches[0];
          const declaration: OrganizationAccessDeclaration = {
            operationKey: "application.page.field_choice.view",
            action: {
              actionKind: entry.permission.actionKind,
              ...(entry.permission.namedAction === undefined
                ? {}
                : { namedAction: entry.permission.namedAction }),
            },
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
          const decision = await runOrganizationAccessOperation(
            transaction,
            scope,
            declaration,
            async () => true,
          );
          allowed = decision.outcome === "completed";
          permissionDecisions.set(permissionKey, allowed);
        }
        if (allowed) choices.push(option.value);
      }
      // A cleared optional choice remains valid draft input; a missing allowlist would
      // instead make every value unrestricted in the draft projection.
      if (choices.length >= privateFormDraftLimits.choicesPerField) return undefined;
      choices.push(null);
      fieldChoices[fieldKey] = choices;
    }
    return {
      access,
      projection: {
        permittedFieldIds: [...fields.keys()],
        ...(Object.keys(fieldChoices).length === 0 ? {} : { fieldChoices }),
      },
    };
  },
});

export const createGuidedFormDraftService = (dependencies: GuidedFormDependencies) => {
  const serviceDependencies: PrivateFormDraftServiceDependencies = {
    identityAuthorityId: dependencies.identityAuthorityId,
    authority: createAuthorityAdapter(dependencies),
  };
  return createPrivateFormDraftService(serviceDependencies);
};

export const guidedFormDraftScope = (
  pageId: string,
  flowId: string,
  subjectRecordId?: string,
): PrivateFormDraftScope => ({
  formId: containedComponentIdSchema.parse(pageId),
  flowId: ruleIdSchema.parse(flowId),
  ...(subjectRecordId === undefined
    ? {}
    : { subjectRecordId: recordIdSchema.parse(subjectRecordId) }),
});

type GuidedFormDraftOpenResult =
  | Readonly<{ kind: "available"; draft: PrivateFormDraft }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export const openGuidedFormDraft = async (
  dependencies: GuidedFormDependencies,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  scope: PrivateFormDraftScope,
  initialValues: Readonly<Record<string, JsonValue>>,
): Promise<GuidedFormDraftOpenResult> => {
  const service = createGuidedFormDraftService(dependencies);
  const created = await service.create(session, selection, {
    ...scope,
    values: initialValues,
    validation: {},
  });
  if (created.kind !== "available") return created;
  if (created.value.outcome === "created") return { kind: "available", draft: created.value.draft };
  const read = await service.read(session, selection, scope);
  if (read.kind !== "available") return read;
  return read.value.outcome === "available"
    ? { kind: "available", draft: read.value.draft }
    : { kind: "unavailable" };
};

type GuidedFormStepUpdate = Readonly<{
  values: Readonly<Record<string, JsonValue>>;
  validation: Readonly<Record<string, PrivateFormDraftFieldValidation>>;
  valid: boolean;
}>;

const isIncompleteIssue = (code: string): boolean =>
  code === "required_field_missing" ||
  code === "required_field_clear" ||
  code === "required_attachment_empty";

export const validateGuidedFormStep = (
  recordType: RecordTypeDefinition,
  stepFields: readonly GuidedFormStepField[],
  currentValues: Readonly<Record<string, JsonValue>>,
  currentValidation: Readonly<Record<string, PrivateFormDraftFieldValidation>>,
  submittedCandidate: unknown,
): GuidedFormStepUpdate | undefined => {
  if (!isRecord(submittedCandidate)) return undefined;
  const fieldsByKey = new Map(stepFields.map((entry) => [entry.fieldKey, entry]));
  const submittedById: Record<string, unknown> = {};
  const storedValues: Record<string, JsonValue> = { ...currentValues };
  for (const [fieldKey, value] of Object.entries(submittedCandidate)) {
    const entry = fieldsByKey.get(fieldKey);
    const parsed = jsonValueSchema.safeParse(value);
    if (entry === undefined || !parsed.success) return undefined;
    submittedById[String(entry.field.fieldId)] = parsed.data;
    storedValues[fieldKey] = parsed.data;
  }
  for (const entry of stepFields) {
    if (Object.hasOwn(submittedById, String(entry.field.fieldId))) continue;
    if (Object.hasOwn(currentValues, entry.fieldKey))
      submittedById[String(entry.field.fieldId)] = currentValues[entry.fieldKey];
  }
  const requiredById = new Map(
    stepFields.map((entry) => [String(entry.field.fieldId), entry.required]),
  );
  const restrictedRecordType: RecordTypeDefinition = {
    ...recordType,
    fields: recordType.fields.map((field) => {
      const required = requiredById.get(String(field.fieldId));
      if (required !== undefined) return { ...field, required } as ModuleField;
      const withoutDefault: Record<string, unknown> = { ...field, required: false };
      delete withoutDefault.default;
      return withoutDefault as ModuleField;
    }),
  };
  const prepared = prepareRecordFieldValues({
    operation: "create",
    recordType: restrictedRecordType,
    submittedValues: submittedById,
  });
  const nextValidation: Record<string, PrivateFormDraftFieldValidation> = {
    ...currentValidation,
  };
  for (const entry of stepFields) delete nextValidation[entry.fieldKey];
  if (prepared.success) {
    const clearIds = new Set(prepared.clearFieldIds.map((fieldId) => fieldId.toLowerCase()));
    for (const entry of stepFields) {
      const fieldId = String(entry.field.fieldId);
      if (Object.hasOwn(prepared.setValues, fieldId))
        storedValues[entry.fieldKey] = prepared.setValues[fieldId]!;
      else if (clearIds.has(fieldId.toLowerCase())) storedValues[entry.fieldKey] = null;
      nextValidation[entry.fieldKey] = { state: "valid" };
    }
    return { values: storedValues, validation: nextValidation, valid: true };
  }
  let valid = true;
  for (const entry of stepFields) {
    const issues = prepared.issues.filter(
      (issue) => issue.fieldId !== undefined && sameId(issue.fieldId, String(entry.field.fieldId)),
    );
    const globalIssue = prepared.issues.find((issue) => issue.fieldId === undefined);
    if (issues.length === 0 && globalIssue === undefined) {
      nextValidation[entry.fieldKey] = { state: "valid" };
      continue;
    }
    valid = false;
    const reasonCode = (issues[0] ?? globalIssue)?.code ?? "invalid_input";
    nextValidation[entry.fieldKey] = {
      state: isIncompleteIssue(reasonCode) ? "incomplete" : "invalid",
      reasonCode,
    };
  }
  return { values: storedValues, validation: nextValidation, valid };
};

export const computeGuidedFormStepId = (
  steps: readonly GuidedFormStepFields[],
  validation: Readonly<Record<string, PrivateFormDraftFieldValidation>>,
): string | undefined => {
  const summary = steps.find((step) => step.summary);
  if (summary === undefined) return undefined;
  return (
    steps.find(
      (step) =>
        !step.summary && step.fields.some((field) => validation[field.fieldKey]?.state !== "valid"),
    )?.stepId ?? summary.stepId
  );
};

export const earlierGuidedStepId = (
  steps: readonly GuidedFormStepFields[],
  computedStepId: string,
  requestedStepId: string | undefined,
): string => {
  if (requestedStepId === undefined) return computedStepId;
  const requestedIndex = steps.findIndex((step) => step.stepId === requestedStepId);
  const computedIndex = steps.findIndex((step) => step.stepId === computedStepId);
  return requestedIndex >= 0 && computedIndex >= 0 && requestedIndex <= computedIndex
    ? requestedStepId
    : computedStepId;
};

export const guidedFormInitialValues = (
  steps: readonly GuidedFormStepFields[],
  subjectValues?: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> => {
  const values: Record<string, JsonValue> = {};
  for (const step of steps)
    for (const { field, fieldKey } of step.fields) {
      const subjectValue = subjectValues?.[String(field.fieldId)];
      if (subjectValue !== undefined) values[fieldKey] = subjectValue;
      else if (subjectValues === undefined && field.default !== undefined)
        values[fieldKey] = field.default as JsonValue;
    }
  return values;
};

export const visibleGuidedFormValues = (
  draft: PrivateFormDraft,
  steps: readonly GuidedFormStepFields[],
): Readonly<Record<string, JsonValue>> => {
  const keys = new Set(steps.flatMap((step) => step.fields.map((field) => field.fieldKey)));
  return Object.fromEntries(
    Object.entries(draft.values).filter(([fieldKey]) => keys.has(fieldKey)),
  );
};

export const visibleGuidedFormValidation = (
  validation: Readonly<Record<string, PrivateFormDraftFieldValidation>>,
  steps: readonly GuidedFormStepFields[],
): Readonly<Record<string, PrivateFormDraftFieldValidation>> => {
  const keys = new Set(steps.flatMap((step) => step.fields.map((field) => field.fieldKey)));
  return Object.fromEntries(Object.entries(validation).filter(([fieldKey]) => keys.has(fieldKey)));
};

export const guidedFormInputData = (
  page: unknown,
  recordType: RecordTypeDefinition,
  values: Readonly<Record<string, JsonValue>>,
  dateTimeZones: Readonly<{ personTimeZone?: string; organizationTimeZone?: string }> = {},
): Readonly<Record<string, Readonly<Record<string, unknown>>>> => {
  if (!isRecord(page) || page.type !== "guided_form" || !isRecord(page.composition)) return {};
  const stepContent = page.composition.stepContent;
  if (!isRecord(stepContent)) return {};
  const byId: Record<string, JsonValue> = {};
  for (const field of recordType.fields)
    if (Object.hasOwn(values, field.key)) byId[String(field.fieldId)] = values[field.key]!;
  const result: Record<string, Readonly<Record<string, unknown>>> = {};
  const visitPlacement = ({
    placementId,
    props,
    vortex,
  }: Readonly<{
    placementId: string;
    props: Record<string, unknown>;
    vortex: Record<string, unknown>;
  }>): undefined => {
    {
      if (inputBlock(vortex)) {
        const entry = guidedStepFieldForPlacement(props, recordType);
        const value = entry === undefined ? undefined : byId[String(entry.field.fieldId)];
        if (entry !== undefined && value !== undefined) {
          const blockId = isRecord(vortex.block) ? String(vortex.block.blockId) : "";
          const settings: Record<string, unknown> = placementSettings(props);
          const control = sameId(blockId, FIELD_INPUT_BLOCK_RELEASE.blockId)
            ? isRecord(settings.control) && settings.control.kind === "choice"
              ? settings.control.value
              : undefined
            : Object.entries(FIELD_INPUT_CONTROL_RELEASES).find(([, release]) =>
                sameId(release.blockId, blockId),
              )?.[0];
          const kind =
            control === "attachment"
              ? "attachment_input"
              : control === "table"
                ? "table_input"
                : control === "text"
                  ? "text_input"
                  : control === "rich_text"
                    ? "rich_text_input"
                    : control === "number"
                      ? "number_input"
                      : control === "boolean"
                        ? "boolean_input"
                        : control === "date"
                          ? "date_input"
                          : control === "date_time"
                            ? "date_time_input"
                            : control === "choice"
                              ? "choice_input"
                              : control === "several_choices"
                                ? "several_choices_input"
                                : control === "link"
                                  ? "link_input"
                                  : undefined;
          if (kind !== undefined) {
            let displayed: JsonValue = value;
            let usable = true;
            if (control === "attachment") {
              usable =
                value === null || moduleFieldValueSchemas.attachment.safeParse(value).success;
              if (usable) displayed = value ?? [];
            } else if (control === "table") {
              usable = value === null || moduleFieldValueSchemas.table.safeParse(value).success;
              if (usable) displayed = value ?? [];
            } else if (control === "text") {
              usable = value === null || typeof value === "string";
              if (usable) displayed = value ?? "";
            } else if (control === "number") {
              const integerOnly =
                isRecord(settings.integer) &&
                settings.integer.kind === "boolean" &&
                settings.integer.value === true;
              usable =
                value === null ||
                (typeof value === "number" &&
                  Number.isFinite(value) &&
                  (!integerOnly || Number.isInteger(value)));
            } else if (control === "boolean") {
              usable = typeof value === "boolean";
            } else if (control === "date") {
              usable =
                value === null ||
                (typeof value === "string" &&
                  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
                  !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) &&
                  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
            } else if (control === "date_time") {
              usable = value === null || timestampSchema.safeParse(value).success;
            } else if (control === "choice") {
              usable = value === null || typeof value === "string";
              if (usable && value !== null) {
                const options = settings.options;
                usable =
                  isRecord(options) &&
                  options.kind === "list" &&
                  Array.isArray(options.items) &&
                  options.items.some(
                    (option) =>
                      isRecord(option) &&
                      isRecord(option.properties) &&
                      isRecord(option.properties.key) &&
                      option.properties.key.value === value,
                  );
              }
            } else if (control === "several_choices") {
              const selected = value === null ? [] : value;
              const options = settings.options;
              const optionItems =
                isRecord(options) && options.kind === "list" && Array.isArray(options.items)
                  ? options.items
                  : undefined;
              const maximumSelections = settings.maximum_selections;
              usable =
                Array.isArray(selected) &&
                selected.length <= 200 &&
                selected.every((choice) => typeof choice === "string") &&
                new Set(selected).size === selected.length &&
                optionItems !== undefined &&
                selected.every((choice) =>
                  optionItems.some(
                    (option) =>
                      isRecord(option) &&
                      isRecord(option.properties) &&
                      isRecord(option.properties.key) &&
                      option.properties.key.value === choice,
                  ),
                ) &&
                (!isRecord(maximumSelections) ||
                  maximumSelections.kind !== "number" ||
                  typeof maximumSelections.value !== "number" ||
                  selected.length <= maximumSelections.value);
              if (usable) displayed = selected;
            } else if (control === "link") {
              usable =
                value === null ||
                (isRecord(value) &&
                  typeof value.recordTypeId === "string" &&
                  typeof value.recordId === "string");
            } else if (control === "rich_text") {
              usable = value === null || richTextDocumentSchema.safeParse(value).success;
            }
            if (usable)
              result[placementId] = {
                status: "ready",
                values: {
                  kind,
                  value: displayed,
                  ...(kind === "attachment_input"
                    ? { files: [], uploadUrl: "/api/files/upload?" }
                    : {}),
                  ...(kind === "date_time_input" ? dateTimeZones : {}),
                },
              };
          }
        }
      }
    }
    return undefined;
  };
  for (const data of Object.values(stepContent)) walkPlacementData(data, visitPlacement);
  return result;
};

export const resolveGuidedFormAuthority = async (
  dependencies: GuidedFormDependencies,
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  form: PrivateFormDraftScope,
): Promise<
  | Readonly<{
      access: OrganizationAccessDeclaration;
      page: PageDefinition;
      recordType: RecordTypeDefinition;
      steps: readonly GuidedFormStepFields[];
    }>
  | undefined
> => {
  const context = await dependencies.readContext(transaction, scope);
  if (context === undefined) return undefined;
  const pages = context.releaseSet.application.content.pages.filter((candidate) =>
    sameId(String(candidate.pageId), String(form.formId)),
  );
  if (pages.length !== 1 || pages[0] === undefined) return undefined;
  const page = pages[0] as unknown as Readonly<Record<string, unknown>>;
  const recordType = recordTypeForPage(
    page,
    context.releaseSet.modules as unknown as readonly Readonly<Record<string, unknown>>[],
  );
  if (page.type !== "guided_form" || recordType === undefined) return undefined;
  const steps = collectStepFields(page, recordType, context.releaseSet.application.content.shells);
  const flowId = flowForGuidedForm(
    page,
    context.releaseSet.application.content.flowBindings as unknown as readonly Readonly<
      Record<string, unknown>
    >[],
    context.releaseSet.application.content.shells,
  );
  const access = pageAccess(dependencies, context, page);
  if (
    steps === undefined ||
    flowId === undefined ||
    form.flowId === undefined ||
    !sameId(flowId, String(form.flowId)) ||
    access === undefined
  )
    return undefined;
  return { access, page: pages[0], recordType, steps };
};

export const loadGuidedFormAuthorityForSession = async (
  dependencies: GuidedFormDependencies,
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  form: PrivateFormDraftScope,
): Promise<
  HumanOrganizationRequestResult<Awaited<ReturnType<typeof resolveGuidedFormAuthority>>>
> => {
  const requests = createHumanOrganizationRequestService({
    identityAuthorityId: dependencies.identityAuthorityId,
  });
  return requests.run(session, selection, (transaction, scope) =>
    resolveGuidedFormAuthority(dependencies, transaction, scope, form),
  );
};
