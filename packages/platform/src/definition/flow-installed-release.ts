import "server-only";

import { flowPlansOf } from "../workflows/flow-plan";
import type { InstalledFlowBindings } from "./flow-binding-endpoint";
import type { FlowNamedAction, FlowRecordType } from "./flow-orchestrator-types";
import { flowRecordTypeRelationships } from "./flow-record-changes";
import { installedNamedActionDescriptors, installedNamedActions } from "./installed-named-actions";
import type { InstalledRuntimeContext } from "./installed-runtime-context";
import { installedSelectedRecordReadContext } from "./flow-selected-record-context";

/** The flows, plans, record types and actions of one trusted installed context. */
export const installedFlowRelease = (
  installation: InstalledRuntimeContext,
): InstalledFlowBindings => {
  const releaseSet = installation.releaseSet;
  const application = releaseSet.application;
  // The release's plans, built once per installed release: one flow per identity (a Module flow
  // never shadows an Application flow; an ambiguous release is refused rather than run).
  const { flows, plans } = flowPlansOf(releaseSet);
  const selectedReadContext = installedSelectedRecordReadContext(application, releaseSet.modules);
  if (selectedReadContext === undefined)
    throw new Error("SELECTED_RECORD_READ_BINDING_UNAVAILABLE");
  const installedActions = installedNamedActionDescriptors(
    application,
    releaseSet.modules,
    installation.recordContributions,
  );
  // Each record type's fields by key and by identity, for the values of a Save record task,
  // and the named action that declares it sets each choice option.
  const recordTypes = new Map<string, FlowRecordType>();
  for (const recordType of releaseSet.modules.flatMap((module) => module.content.recordTypes)) {
    const fieldIds = new Map<string, string>();
    const optionActions = new Map<string, ReadonlyMap<string, FlowNamedAction>>();
    for (const field of recordType.fields) {
      fieldIds.set(String(field.key).toLowerCase(), String(field.fieldId));
      fieldIds.set(String(field.fieldId).toLowerCase(), String(field.fieldId));
    }
    for (const { named, setsChoice } of installedActions) {
      if (
        setsChoice === undefined ||
        named.subjectRecordTypeId.toLowerCase() !== String(recordType.recordTypeId).toLowerCase()
      )
        continue;
      const linked = new Map(optionActions.get(setsChoice.fieldId.toLowerCase()));
      linked.set(setsChoice.option, named);
      optionActions.set(setsChoice.fieldId.toLowerCase(), linked);
    }
    recordTypes.set(String(recordType.recordTypeId).toLowerCase(), {
      fieldIds,
      optionActions,
      relationships: flowRecordTypeRelationships(recordType),
    });
  }
  const namedActions = installedNamedActions(
    application,
    releaseSet.modules,
    installation.recordContributions,
  );
  const installed: InstalledFlowBindings = {
    organizationId: installation.organizationId,
    applicationRootId: installation.applicationRootId,
    installationRevision: installation.applicationReleaseRevision,
    releaseKey: [
      application.releaseVersion,
      application.contentFingerprint,
      application.resolutionFingerprint,
    ].join(":"),
    bindings: application.content.flowBindings,
    flows,
    plans,
    recordTypes,
    namedActions,
    selectedRecordReadProjections: selectedReadContext.projections,
    selectedRecordReadInputs: selectedReadContext.inputs,
    selectedRecordReadModules: selectedReadContext.modules,
    applicationContent: application.content,
    modules: releaseSet.modules,
  };
  return installed;
};
