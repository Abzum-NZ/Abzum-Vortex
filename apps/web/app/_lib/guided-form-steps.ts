import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  createHumanOrganizationRequestService,
  type HumanOrganizationRequestResult,
} from "@vortex/access";
import {
  organizationAccessDeclarationSchema,
  FIELD_INPUT_BLOCK_RELEASE,
  FIELD_INPUT_CONTROL_RELEASES,
  FORM_CONTAINER_BLOCK_RELEASE,
  builderKeySchema,
  containedComponentIdSchema,
  jsonValueSchema,
  richTextDocumentV2Schema,
  recordIdSchema,
  ruleIdSchema,
  type IdentitySession,
  type JsonValue,
  type ModuleFieldV3,
  type OrganizationAccessDeclaration,
  type OrganizationSelectionCandidate,
  type PageDefinitionV2,
  type RecordTypeDefinitionV3,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import {
  createPrivateFormDraftService,
  type PrivateFormDraft,
  type PrivateFormDraftAuthorityAdapter,
  type PrivateFormDraftFieldValidation,
  type PrivateFormDraftScope,
  type PrivateFormDraftServiceDependencies,
} from "@vortex/page";
import {
  createHumanInstalledRuntimeContextLoader,
  type InstalledRuntimeContext,
} from "@vortex/app";
import type { RequestDatabaseTransaction } from "@vortex/db";
import { createDatabaseApplicationBoundReleaseSetService } from "@vortex/definition";
import { createActiveApplicationInstallationRepository } from "@vortex/module";
import { platformPermissionFor, platformPermissionOwnerId } from "@vortex/modules";
import { prepareRecordFieldValuesV2 } from "@vortex/record";
import { getIdentityAuthorityConfiguration } from "../auth/_lib/authority-configuration";
import { installedReleaseCatalogue } from "./definition-catalogue";
import { getQueryContinuationKey } from "./query-continuation-key";

export type GuidedFormStepField = Readonly<{
  field: ModuleFieldV3;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

export const guidedFormConfirmationKey = "$guidedFormConfirmation";
const confirmationLifetimeSeconds = 120;
const confirmationPurpose = "vortex-guided-form-final-confirmation-v1";

export const guidedFormConfirmationReference = (
  candidate: unknown,
): Readonly<{ draftId: string; revision: number; issuedAt: number; signature: string }> | undefined => {
  if (typeof candidate !== "string") return undefined;
  const match = /^([0-9a-f-]{36})\.([1-9][0-9]*)\.([0-9]{10})\.([0-9a-f]{64})$/u.exec(candidate);
  if (match === null) return undefined;
  const revision = Number(match[2]);
  const issuedAt = Number(match[3]);
  if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(issuedAt)) return undefined;
  return { draftId: match[1]!, revision, issuedAt, signature: match[4]! };
};

const confirmationSignature = (
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
): Buffer => createHmac("sha256", getQueryContinuationKey().key).update(JSON.stringify([
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
])).digest();

export const issueGuidedFormConfirmation = async (
  details: Omit<Parameters<typeof confirmationSignature>[0], "issuedAt">,
): Promise<string | undefined> => {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const signature = confirmationSignature({ ...details, issuedAt }).toString("hex");
  return `${details.draftId.toLowerCase()}.${details.revision}.${issuedAt}.${signature}`;
};

export const verifiesGuidedFormConfirmation = async (
  proof: unknown,
  details: Omit<Parameters<typeof confirmationSignature>[0], "issuedAt" | "draftId" | "revision">,
): Promise<boolean> => {
  const reference = guidedFormConfirmationReference(proof);
  if (reference === undefined) return false;
  const age = Math.floor(Date.now() / 1_000) - reference.issuedAt;
  if (age < 0 || age > confirmationLifetimeSeconds) return false;
  const expected = confirmationSignature({ ...details, ...reference });
  return timingSafeEqual(Buffer.from(reference.signature, "hex"), expected);
};

const readGuidedFormContext = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
) => {
  if (scope.applicationRootId === undefined) return undefined;
  return createHumanInstalledRuntimeContextLoader({
    activeInstallationReader: createActiveApplicationInstallationRepository(transaction),
    releaseSetReader: createDatabaseApplicationBoundReleaseSetService(
      installedReleaseCatalogue,
      transaction,
    ),
    scope: {
      organizationId: scope.organizationId,
      applicationRootId: scope.applicationRootId,
    },
  }).load();
};

const recordTypeForPage = (
  page: Readonly<Record<string, unknown>>,
  modules: readonly Readonly<Record<string, unknown>>[],
): RecordTypeDefinitionV3 | undefined => {
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
    if (matches.length === 1) return matches[0] as RecordTypeDefinitionV3;
  }
  return undefined;
};

const inputBlock = (placement: Record<string, unknown>): boolean => {
  const block = placement.block;
  if (!isRecord(block) || typeof block.blockId !== "string") return false;
  return (
    sameId(block.blockId, FIELD_INPUT_BLOCK_RELEASE.blockId) ||
    Object.values(FIELD_INPUT_CONTROL_RELEASES).some((release) =>
      sameId(release.blockId, block.blockId as string),
    )
  );
};

const fieldForPlacement = (
  placement: Record<string, unknown>,
  recordType: RecordTypeDefinitionV3,
): Omit<GuidedFormStepField, "placementId"> | undefined => {
  const settings = placement.settings;
  if (!isRecord(settings)) return undefined;
  const name = settings.name;
  const parsedKey = isRecord(name) && name.kind === "text" ? builderKeySchema.safeParse(name.value) : undefined;
  const fieldReference = settings.field;
  const field =
    isRecord(fieldReference) &&
    fieldReference.kind === "field_reference" &&
    typeof fieldReference.fieldId === "string"
      ? recordType.fields.find((candidate) => sameId(String(candidate.fieldId), fieldReference.fieldId))
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

const placementIdsInTree = (
  root: unknown,
  availableOnly = false,
): ReadonlySet<string> => {
  const ids = new Set<string>();
  const visit = (slot: unknown): void => {
    if (!isRecord(slot)) return;
    if (!isRecord(slot.placements)) {
      for (const child of Object.values(slot)) visit(child);
      return;
    }
    for (const [placementId, candidate] of Object.entries(slot.placements)) {
      if (!isRecord(candidate)) continue;
      if (availableOnly && candidate.availability === "unavailable") continue;
      ids.add(placementId.toLowerCase());
      if (isRecord(candidate.slots))
        for (const child of Object.values(candidate.slots)) visit(child);
    }
  };
  visit(root);
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

  if (composition.shellKind !== "application") {
    if (composition.shellKind !== undefined && composition.shellKind !== "default") return undefined;
    const roots = declaredSteps.map((stepId) => ({
      stepId: stepId!,
      root: stepContent[stepId!],
      pagePlacementIds: placementIdsInTree(stepContent[stepId!]),
    }));
    return roots.every((entry) => isRecord(entry.root)) ? roots : undefined;
  }

  if (
    typeof composition.shellId !== "string" ||
    !Array.isArray(shellsCandidate) ||
    !declaredSteps.every((stepId) => Object.hasOwn(stepContent, stepId!))
  )
    return undefined;
  const shells = shellsCandidate.filter(isRecord);
  const matchingShells = shells.filter(
    (shell) => typeof shell.shellId === "string" && sameId(shell.shellId, composition.shellId as string),
  );
  const shell = matchingShells[0];
  if (matchingShells.length !== 1 || shell === undefined) return undefined;
  const shellLayout = shell.layout;
  const shellContentSlots = shell.contentSlots;
  if (!isRecord(shellLayout) || !Array.isArray(shellContentSlots)) return undefined;
  const contentSlots = shellContentSlots.filter(isRecord);
  if (contentSlots.length !== shellContentSlots.length) return undefined;

  const resolved: GuidedStepRoot[] = [];
  for (const stepId of declaredSteps as string[]) {
    const pageContent = stepContent[stepId];
    if (!isRecord(pageContent)) return undefined;
    const slotIds = new Set(contentSlots.map((slot) => String(slot.slotId)));
    if (Object.keys(pageContent).some((slotId) => !slotIds.has(slotId))) return undefined;
    const usedContentSlots = new Set<string>();
    const merge = (slotCandidate: unknown): Readonly<Record<string, unknown>> | undefined => {
      if (!isRecord(slotCandidate) || !isRecord(slotCandidate.placements)) return undefined;
      const placements: Record<string, unknown> = {};
      for (const [placementId, placementCandidate] of Object.entries(slotCandidate.placements)) {
        if (!isRecord(placementCandidate) || !isRecord(placementCandidate.slots)) return undefined;
        const slots: Record<string, unknown> = {};
        for (const [slotKey, child] of Object.entries(placementCandidate.slots)) {
          const bindings = contentSlots.filter(
            (binding) =>
              sameId(String(binding.parentPlacementId), placementId) &&
              binding.parentSlotKey === slotKey,
          );
          if (bindings.length > 1) return undefined;
          const binding = bindings[0];
          if (binding !== undefined) {
            usedContentSlots.add(String(binding.slotId));
            const supplied = pageContent[String(binding.slotId)];
            if (
              binding.required === true &&
              (!isRecord(supplied) ||
                !isRecord(supplied.placements) ||
                Object.keys(supplied.placements).length === 0)
            )
              return undefined;
            slots[slotKey] = supplied ?? child;
          } else {
            const mergedChild = merge(child);
            if (mergedChild === undefined) return undefined;
            slots[slotKey] = mergedChild;
          }
        }
        placements[placementId] = { ...placementCandidate, slots };
      }
      return { ...slotCandidate, placements };
    };
    const root = merge(shellLayout);
    if (root === undefined || contentSlots.some((slot) => !usedContentSlots.has(String(slot.slotId))))
      return undefined;
    resolved.push({
      stepId,
      root,
      pagePlacementIds: new Set(
        Object.values(pageContent).flatMap((content) => [...placementIdsInTree(content)]),
      ),
    });
  }
  return resolved;
};

const collectStepFields = (
  page: Readonly<Record<string, unknown>>,
  recordType: RecordTypeDefinitionV3,
  shellsCandidate?: unknown,
  visiblePlacementIds?: ReadonlySet<string>,
): readonly GuidedFormStepFields[] | undefined => {
  const roots = guidedStepRoots(page, shellsCandidate);
  if (roots === undefined) return undefined;
  const result: GuidedFormStepFields[] = [];
  const allFieldKeys = new Set<string>();
  for (const candidate of page.steps as readonly unknown[]) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.summary !== "boolean")
      return undefined;
    const stepRoot = roots.find((entry) => entry.stepId === candidate.id);
    const root = stepRoot?.root;
    const fields: GuidedFormStepField[] = [];
    const seenKeys = new Set<string>();
    const stepFormIds = new Set<string>();
    const visit = (slot: unknown, formPlacementId?: string): boolean => {
      if (!isRecord(slot)) return false;
      if (!isRecord(slot.placements))
        return Object.values(slot).every((child) => visit(child, formPlacementId));
      for (const [placementId, placementCandidate] of Object.entries(slot.placements)) {
        if (!isRecord(placementCandidate)) return false;
        const block = placementCandidate.block;
        const isForm =
          isRecord(block) &&
          typeof block.blockId === "string" &&
          sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId);
        if (isForm) stepFormIds.add(placementId.toLowerCase());
        const owner = isForm ? placementId : formPlacementId;
        if (
          stepRoot?.pagePlacementIds.has(placementId.toLowerCase()) === true &&
          inputBlock(placementCandidate) &&
          owner === undefined
        )
          return false;
        if (
          owner !== undefined &&
          stepRoot?.pagePlacementIds.has(placementId.toLowerCase()) === true &&
          (visiblePlacementIds === undefined || visiblePlacementIds.has(placementId.toLowerCase())) &&
          inputBlock(placementCandidate)
        ) {
          const field = fieldForPlacement(placementCandidate, recordType);
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
        if (isRecord(placementCandidate.slots))
          for (const child of Object.values(placementCandidate.slots))
            if (!visit(child, owner)) return false;
      }
      return true;
    };
    if (!visit(root) || stepFormIds.size > 1 || (candidate.summary && fields.length > 0))
      return undefined;
    result.push({ stepId: candidate.id, summary: candidate.summary, fields });
  }
  return result;
};

export const getGuidedFormStepFields = (
  pageCandidate: unknown,
  recordType: RecordTypeDefinitionV3,
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
): RecordTypeDefinitionV3 | undefined => {
  if (!isRecord(pageCandidate) || !Array.isArray(modulesCandidate)) return undefined;
  return recordTypeForPage(
    pageCandidate,
    modulesCandidate.filter(isRecord) as Readonly<Record<string, unknown>>[],
  );
};

const collectFormIds = (
  page: Readonly<Record<string, unknown>>,
  shellsCandidate?: unknown,
): ReadonlySet<string> => {
  const result = new Set<string>();
  const roots = guidedStepRoots(page, shellsCandidate);
  if (roots === undefined) return result;
  const visit = (slot: unknown): void => {
    if (!isRecord(slot)) return;
    if (!isRecord(slot.placements)) {
      for (const child of Object.values(slot)) visit(child);
      return;
    }
    for (const [placementId, candidate] of Object.entries(slot.placements)) {
      if (!isRecord(candidate)) continue;
      if (candidate.availability === "unavailable") continue;
      const block = candidate.block;
      if (
        isRecord(block) &&
        typeof block.blockId === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
      )
        result.add(placementId.toLowerCase());
      if (isRecord(candidate.slots))
        for (const child of Object.values(candidate.slots)) visit(child);
    }
  };
  for (const entry of roots) visit(entry.root);
  return result;
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
  const formIds = (root: unknown): ReadonlySet<string> => {
    const ids = new Set<string>();
    const visit = (slot: unknown): void => {
      if (!isRecord(slot)) return;
      if (!isRecord(slot.placements)) {
        for (const child of Object.values(slot)) visit(child);
        return;
      }
      for (const [placementId, candidate] of Object.entries(slot.placements)) {
        if (!isRecord(candidate)) continue;
        if (
          isRecord(candidate.block) &&
          typeof candidate.block.blockId === "string" &&
          sameId(candidate.block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
        )
          ids.add(placementId.toLowerCase());
        if (isRecord(candidate.slots))
          for (const child of Object.values(candidate.slots)) visit(child);
      }
    };
    visit(root);
    return ids;
  };
  const summaryIds = formIds(summaryRoot.root);
  const all = new Set(roots.flatMap((entry) => [...formIds(entry.root)]));
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
    ? page.steps.find((step) => isRecord(step) && step.summary === true && typeof step.id === "string")
    : undefined;
  if (!isRecord(summary) || roots === undefined) return undefined;
  const summaryForms = new Set<string>();
  const visitSummary = (slot: unknown): void => {
    if (!isRecord(slot)) return;
    if (!isRecord(slot.placements)) {
      for (const child of Object.values(slot)) visitSummary(child);
      return;
    }
    for (const [placementId, candidate] of Object.entries(slot.placements)) {
      if (!isRecord(candidate)) continue;
      if (candidate.availability === "unavailable") continue;
      const block = candidate.block;
      if (
        isRecord(block) &&
        typeof block.blockId === "string" &&
        sameId(block.blockId, FORM_CONTAINER_BLOCK_RELEASE.blockId)
      )
        summaryForms.add(placementId.toLowerCase());
      if (isRecord(candidate.slots))
        for (const child of Object.values(candidate.slots)) visitSummary(child);
    }
  };
  const summaryRoot = roots.find((entry) => entry.stepId === summary.id)?.root;
  if (summaryRoot === undefined) return undefined;
  visitSummary(summaryRoot);
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
  context: InstalledRuntimeContext,
  page: Readonly<Record<string, unknown>>,
): OrganizationAccessDeclaration | undefined => {
  if (typeof page.accessPermissionKey !== "string") return undefined;
  const platform = platformPermissionFor(page.accessPermissionKey);
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
          ownerId: platformPermissionOwnerId,
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

const createAuthorityAdapter = (): PrivateFormDraftAuthorityAdapter => ({
  async load(transaction, scope, form) {
    const context = await readGuidedFormContext(transaction, scope);
    if (context === undefined) return undefined;
    const pages = context.releaseSet.application.content.pages.filter(
      (candidate) => sameId(String(candidate.pageId), String(form.formId)),
    );
    if (pages.length !== 1 || pages[0] === undefined) return undefined;
    const page = pages[0] as unknown as Readonly<Record<string, unknown>>;
    if (page.type !== "guided_form") return undefined;
    const recordType = recordTypeForPage(page, context.releaseSet.modules as unknown as readonly Readonly<Record<string, unknown>>[]);
    if (recordType === undefined) return undefined;
    const steps = collectStepFields(
      page,
      recordType,
      context.releaseSet.application.content.shells,
    );
    const applicationBindings = context.releaseSet.application.content.flowBindings as unknown as readonly Readonly<Record<string, unknown>>[];
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
    const access = pageAccess(context, page);
    if (access === undefined) return undefined;
    const fields = new Map<string, ModuleFieldV3>();
    for (const step of steps)
      for (const entry of step.fields) fields.set(entry.fieldKey, entry.field);
    const fieldChoices: Record<string, JsonValue[]> = {};
    for (const [fieldKey, field] of fields) {
      if (field.type === "choice" || field.type === "several_choices")
        fieldChoices[fieldKey] = field.settings.options.map((option) => option.value);
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

export const createGuidedFormDraftService = () => {
  const dependencies = {
    identityAuthorityId: getIdentityAuthorityConfiguration().authorityId,
  };
  const serviceDependencies: PrivateFormDraftServiceDependencies = {
    ...dependencies,
    authority: createAuthorityAdapter(),
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

export type GuidedFormDraftOpenResult =
  | Readonly<{ kind: "available"; draft: PrivateFormDraft }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "temporarily_unavailable" }>;

export const openGuidedFormDraft = async (
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  scope: PrivateFormDraftScope,
  initialValues: Readonly<Record<string, JsonValue>>,
): Promise<GuidedFormDraftOpenResult> => {
  const service = createGuidedFormDraftService();
  const created = await service.create(session, selection, {
    ...scope,
    values: initialValues,
    validation: {},
  });
  if (created.kind !== "available") return created;
  if (created.value.outcome === "created")
    return { kind: "available", draft: created.value.draft };
  const read = await service.read(session, selection, scope);
  if (read.kind !== "available") return read;
  return read.value.outcome === "available"
    ? { kind: "available", draft: read.value.draft }
    : { kind: "unavailable" };
};

export type GuidedFormStepUpdate = Readonly<{
  values: Readonly<Record<string, JsonValue>>;
  validation: Readonly<Record<string, PrivateFormDraftFieldValidation>>;
  valid: boolean;
}>;

const isIncompleteIssue = (code: string): boolean =>
  code === "required_field_missing" ||
  code === "required_field_clear" ||
  code === "required_attachment_empty";

export const validateGuidedFormStep = (
  recordType: RecordTypeDefinitionV3,
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
  const requiredById = new Map(stepFields.map((entry) => [String(entry.field.fieldId), entry.required]));
  const restrictedRecordType: RecordTypeDefinitionV3 = {
    ...recordType,
    fields: recordType.fields.map((field) => {
      const required = requiredById.get(String(field.fieldId));
      if (required !== undefined) return { ...field, required } as ModuleFieldV3;
      const { default: _default, ...withoutDefault } = field;
      return { ...withoutDefault, required: false } as ModuleFieldV3;
    }),
  };
  const prepared = prepareRecordFieldValuesV2({
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
        !step.summary &&
        step.fields.some((field) => validation[field.fieldKey]?.state !== "valid"),
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
  return Object.fromEntries(
    Object.entries(validation).filter(([fieldKey]) => keys.has(fieldKey)),
  );
};

export const guidedFormInputData = (
  page: unknown,
  recordType: RecordTypeDefinitionV3,
  values: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> => {
  if (!isRecord(page) || page.type !== "guided_form" || !isRecord(page.composition)) return {};
  const stepContent = page.composition.stepContent;
  if (!isRecord(stepContent)) return {};
  const byId: Record<string, JsonValue> = {};
  for (const field of recordType.fields)
    if (Object.hasOwn(values, field.key)) byId[String(field.fieldId)] = values[field.key]!;
  const result: Record<string, Readonly<Record<string, unknown>>> = {};
  const visit = (slot: unknown): void => {
    if (!isRecord(slot)) return;
    if (!isRecord(slot.placements)) {
      for (const child of Object.values(slot)) visit(child);
      return;
    }
    for (const [placementId, placementCandidate] of Object.entries(slot.placements)) {
      if (!isRecord(placementCandidate)) continue;
      if (inputBlock(placementCandidate)) {
        const entry = fieldForPlacement(placementCandidate, recordType);
        const value = entry === undefined ? undefined : byId[String(entry.field.fieldId)];
        if (entry !== undefined && value !== undefined) {
          const blockId = isRecord(placementCandidate.block)
            ? String(placementCandidate.block.blockId)
            : "";
          const settings = isRecord(placementCandidate.settings)
            ? placementCandidate.settings
            : {};
          const control = sameId(blockId, FIELD_INPUT_BLOCK_RELEASE.blockId)
            ? isRecord(settings.control) && settings.control.kind === "choice"
              ? settings.control.value
              : undefined
            : Object.entries(FIELD_INPUT_CONTROL_RELEASES).find(([, release]) =>
                sameId(release.blockId, blockId),
              )?.[0];
          const kind =
            control === "text"
              ? "text_input"
              : control === "rich_text"
                ? "rich_text_input"
                : control === "number"
                  ? "number_input"
                  : control === "boolean"
                    ? "boolean_input"
                    : control === "date"
                      ? "date_input"
                      : control === "choice"
                        ? "choice_input"
                        : control === "link"
                          ? "link_input"
                          : undefined;
          if (kind !== undefined) {
            let displayed: JsonValue = value;
            let usable = true;
            if (control === "text") {
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
            } else if (control === "link") {
              usable =
                value === null ||
                (isRecord(value) &&
                  typeof value.recordTypeId === "string" &&
                  typeof value.recordId === "string");
            } else if (control === "rich_text") {
              usable = value === null || richTextDocumentV2Schema.safeParse(value).success;
            }
            if (usable) result[placementId] = { status: "ready", values: { kind, value: displayed } };
          }
        }
      }
      if (isRecord(placementCandidate.slots))
        for (const child of Object.values(placementCandidate.slots)) visit(child);
    }
  };
  for (const root of Object.values(stepContent)) visit(root);
  return result;
};

export const resolveGuidedFormAuthority = async (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  form: PrivateFormDraftScope,
): Promise<Readonly<{
  access: OrganizationAccessDeclaration;
  page: PageDefinitionV2;
  recordType: RecordTypeDefinitionV3;
  steps: readonly GuidedFormStepFields[];
}> | undefined> => {
  const context = await readGuidedFormContext(transaction, scope);
  if (context === undefined) return undefined;
  const pages = context.releaseSet.application.content.pages.filter(
    (candidate) => sameId(String(candidate.pageId), String(form.formId)),
  );
  if (pages.length !== 1 || pages[0] === undefined) return undefined;
  const page = pages[0] as unknown as Readonly<Record<string, unknown>>;
  const recordType = recordTypeForPage(
    page,
    context.releaseSet.modules as unknown as readonly Readonly<Record<string, unknown>>[],
  );
  if (page.type !== "guided_form" || recordType === undefined) return undefined;
  const steps = collectStepFields(
    page,
    recordType,
    context.releaseSet.application.content.shells,
  );
  const flowId = flowForGuidedForm(
    page,
    context.releaseSet.application.content.flowBindings as unknown as readonly Readonly<Record<string, unknown>>[],
    context.releaseSet.application.content.shells,
  );
  const access = pageAccess(context, page);
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
  session: IdentitySession,
  selection: OrganizationSelectionCandidate,
  form: PrivateFormDraftScope,
): Promise<HumanOrganizationRequestResult<Awaited<ReturnType<typeof resolveGuidedFormAuthority>>>> => {
  const requests = createHumanOrganizationRequestService({
    identityAuthorityId: getIdentityAuthorityConfiguration().authorityId,
  });
  return requests.run(session, selection, (transaction, scope) =>
    resolveGuidedFormAuthority(transaction, scope, form),
  );
};
