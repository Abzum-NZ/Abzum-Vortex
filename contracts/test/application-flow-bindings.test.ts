import {
  applicationFlowBindingContractVersion,
  componentFlowBindingSchema,
  flowNodeRunAsSchema,
  frontendFlowNodeBindingSchema,
  protectedOperationDescriptorSchema,
} from "../src";
import { describe, expect, it } from "vitest";

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const applicationRootId = id(1);
const pageRecordTypeId = id(2);
const relatedRecordTypeId = id(3);
const rowRecordTypeId = id(4);
const formId = id(5);
const controlId = id(6);
const flowId = id(7);

const applicationFlow = {
  kind: "application_owned" as const,
  applicationRootId,
  flowId,
};

const componentBinding = {
  contractVersion: applicationFlowBindingContractVersion,
  controlId,
  eventId: id(8),
  event: "action" as const,
  flow: applicationFlow,
  inputs: {
    subject: {
      type: "record_reference" as const,
      value: {
        source: "context_record" as const,
        context: { kind: "page_subject" as const, recordTypeId: pageRecordTypeId },
      },
    },
    related_name: {
      type: "text" as const,
      value: {
        source: "context_field" as const,
        context: {
          kind: "related_record" as const,
          relationshipId: id(9),
          recordTypeId: relatedRecordTypeId,
        },
        fieldId: id(10),
      },
    },
    row_name: {
      type: "text" as const,
      value: {
        source: "context_field" as const,
        context: {
          kind: "row" as const,
          controlId: id(11),
          recordTypeId: rowRecordTypeId,
        },
        fieldId: id(12),
      },
    },
    selected_rows: {
      type: "record_reference_list" as const,
      value: {
        source: "context_record" as const,
        context: {
          kind: "selection" as const,
          controlId: id(13),
          recordTypeId: rowRecordTypeId,
          cardinality: "many" as const,
        },
      },
    },
    answer: {
      type: "text" as const,
      value: { source: "form_input" as const, formId, input: "answer" },
    },
    current_account: {
      type: "organization_account_reference" as const,
      value: { source: "current_organization_account_id" as const },
    },
  },
  results: { message: { output: "message", type: "text" as const } },
  declaredEffects: ["form_interaction", "change"] as const,
};

describe("application flow binding contracts", () => {
  it("describes neutral action/data bindings and distinct page, related, row and form context", () => {
    expect(componentFlowBindingSchema.parse(componentBinding)).toEqual(componentBinding);

    const changingLoad = {
      ...componentBinding,
      eventId: id(14),
      event: "load",
      declaredEffects: ["read", "change"],
    };
    expect(componentFlowBindingSchema.safeParse(changingLoad).success).toBe(true);

    const managedRefresh = {
      ...componentBinding,
      eventId: id(15),
      event: "refresh",
      flow: { kind: "platform_managed", flowId: id(16), releaseVersion: "1.2.0" },
      declaredEffects: ["read"],
    };
    expect(componentFlowBindingSchema.safeParse(managedRefresh).success).toBe(true);
  });

  it("accepts protected operation, query, form-continuation and durable-start node targets", () => {
    const baseNode = {
      contractVersion: applicationFlowBindingContractVersion,
      nodeId: id(20),
      runAs: { kind: "current_user" as const },
      inputs: {},
      results: {},
    };
    const targets = [
      {
        kind: "protected_operation",
        operation: {
          owner: { kind: "platform_service", serviceId: id(21) },
          operationId: id(22),
        },
      },
      {
        kind: "query",
        moduleRootId: id(23),
        moduleReleaseVersion: "2.4.0",
        queryId: id(24),
      },
      {
        kind: "form_continuation",
        applicationRootId,
        formId,
        continuationEventId: id(25),
      },
      { kind: "durable_workflow_start", applicationRootId, workflowId: id(26) },
    ];

    for (const [index, target] of targets.entries())
      expect(
        frontendFlowNodeBindingSchema.safeParse({
          ...baseNode,
          nodeId: id(20 + index),
          target,
        }).success,
      ).toBe(true);

    expect(
      flowNodeRunAsSchema.safeParse({
        kind: "specified_user",
        executionBindingId: id(27),
      }).success,
    ).toBe(true);
    expect(
      flowNodeRunAsSchema.safeParse({ kind: "system", executionBindingId: id(28) }).success,
    ).toBe(true);
  });

  it("requires the fixed account reference type in node inputs", () => {
    const node = {
      contractVersion: applicationFlowBindingContractVersion,
      nodeId: id(60),
      target: { kind: "durable_workflow_start", applicationRootId, workflowId: id(61) },
      runAs: { kind: "current_user" },
      inputs: {
        account: {
          type: "organization_account_reference",
          value: { source: "current_organization_account_id" },
        },
      },
      results: {},
    };
    expect(frontendFlowNodeBindingSchema.safeParse(node).success).toBe(true);
    expect(
      frontendFlowNodeBindingSchema.safeParse({
        ...node,
        inputs: { account: { ...node.inputs.account, type: "text" } },
      }).success,
    ).toBe(false);
  });

  it("describes exact protected operation policy without accepting executable material", () => {
    const descriptor = {
      contractVersion: applicationFlowBindingContractVersion,
      operation: {
        owner: { kind: "module" as const, moduleRootId: id(30) },
        operationId: id(31),
      },
      inputs: {
        subject: {
          type: "record_reference" as const,
          required: true,
          recordTypeIds: [pageRecordTypeId],
        },
      },
      outputs: { result: { type: "json" as const, required: true } },
      permission: { permissionId: id(32), key: "vortex.neutral.operation.use" },
      effect: "change" as const,
      expectedRevision: "required" as const,
      confirmation: "required" as const,
      duplicateProtection: "required" as const,
      safeResults: ["committed", "refused", "conflict", "uncertain"],
    };
    expect(protectedOperationDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    expect(
      protectedOperationDescriptorSchema.safeParse({ ...descriptor, callback: "run()" }).success,
    ).toBe(false);
    expect(
      protectedOperationDescriptorSchema.safeParse({
        ...descriptor,
        permissionEvidence: { allowed: true },
      }).success,
    ).toBe(false);
  });

  it("refuses direct component operations, non-events and caller-authored authority", () => {
    expect(
      componentFlowBindingSchema.safeParse({
        ...componentBinding,
        flow: {
          kind: "protected_operation",
          operationId: id(40),
        },
      }).success,
    ).toBe(false);
    expect(
      componentFlowBindingSchema.safeParse({ ...componentBinding, event: "render" }).success,
    ).toBe(false);
    expect(
      componentFlowBindingSchema.safeParse({ ...componentBinding, event: "prefetch" }).success,
    ).toBe(false);
    expect(flowNodeRunAsSchema.safeParse({ kind: "specified_user", actorId: id(41) }).success).toBe(
      false,
    );
    expect(
      flowNodeRunAsSchema.safeParse({
        kind: "system",
        executionBindingId: id(42),
        trustedContext: { callerKind: "system" },
      }).success,
    ).toBe(false);
  });

  it("refuses wrong structural value shapes and duplicate effect/result declarations", () => {
    const wrongAccountType = {
      ...componentBinding,
      inputs: {
        ...componentBinding.inputs,
        current_account: { ...componentBinding.inputs.current_account, type: "text" },
      },
    };
    expect(componentFlowBindingSchema.safeParse(wrongAccountType).success).toBe(false);

    const wrongSelectionType = {
      ...componentBinding,
      inputs: {
        ...componentBinding.inputs,
        selected_rows: { ...componentBinding.inputs.selected_rows, type: "record_reference" },
      },
    };
    expect(componentFlowBindingSchema.safeParse(wrongSelectionType).success).toBe(false);

    expect(
      componentFlowBindingSchema.safeParse({
        ...componentBinding,
        declaredEffects: ["read", "read"],
      }).success,
    ).toBe(false);

    const descriptor = {
      contractVersion: applicationFlowBindingContractVersion,
      operation: {
        owner: { kind: "application", applicationRootId },
        operationId: id(50),
      },
      inputs: {},
      outputs: {},
      permission: { permissionId: id(51), key: "vortex.neutral.operation.use" },
      effect: "read",
      expectedRevision: "not_required",
      confirmation: "not_required",
      duplicateProtection: "not_required",
      safeResults: ["completed", "completed"],
    };
    expect(protectedOperationDescriptorSchema.safeParse(descriptor).success).toBe(false);
  });
});
