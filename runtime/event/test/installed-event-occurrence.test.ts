import {
  applicationDefinitionConsumerReadResultV1Schema,
  moduleDefinitionConsumerReadResultV1Schema,
  moduleDefinitionConsumerReadResultV2Schema,
  type EventOccurrenceEnvelopeV2,
  type InstalledEventDescriptor,
} from "@vortex/contracts";
import { fingerprintCanonicalValue, projectInstalledEventCatalogue } from "@vortex/definition";
import { describe, expect, it } from "vitest";
import {
  InstalledEventOccurrenceError,
  validateInstalledEventOccurrence,
} from "../src/installed-event-occurrence";

const id = (value: number) => `20000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1);
const applicationRootId = id(2);
const moduleRootId = id(3);
const recordTypeId = id(4);
const safeFieldId = id(5);
const sensitiveFieldId = id(6);
const moduleEventId = id(7);
const applicationEventId = id(8);
const correlationId = id(9);
const fingerprint = (character: string) => `sha256:${character.repeat(64)}`;

const field = (fieldId: string, key: string, personalData: "none" | "personal" | "sensitive") => ({
  fieldId,
  key,
  label: key,
  required: false,
  unique: false,
  filterable: true,
  sortable: true,
  personalData,
  publicDisplay: "refused" as const,
  type: "text" as const,
  settings: { maxLength: 3 },
});

const moduleContent = {
  name: "Event test module",
  description: "Exact module read used by the Event boundary test.",
  dependencies: [],
  recordTypes: [
    {
      recordTypeId,
      key: "item",
      singularLabel: "Item",
      pluralLabel: "Items",
      titleFieldId: safeFieldId,
      storageContractId: id(10),
      storageScope: "organization_shared" as const,
      ownershipMode: "none" as const,
      fields: [
        field(safeFieldId, "state", "none"),
        field(sensitiveFieldId, "private_note", "sensitive"),
      ],
      relationships: [],
      standardActions: ["create", "read"] as const,
      customActionIds: [],
    },
  ],
  permissions: [],
  actions: [],
  events: [
    {
      eventId: moduleEventId,
      key: "example.item.reviewed",
      recordTypeId,
      carriedFieldIds: [safeFieldId],
      personalOrSensitiveValuesAllowed: false as const,
    },
  ],
  rules: [],
  sharingConditions: [],
  extensionPoints: [],
};

const moduleContentFingerprint = fingerprintCanonicalValue(moduleContent);
const moduleV2 = moduleDefinitionConsumerReadResultV2Schema.parse({
  kind: "module",
  organizationId,
  definitionKey: "example.event_test",
  rootId: moduleRootId,
  releaseRevision: 4,
  releaseVersion: "2.0.0",
  validationContractVersion: "2.0.0",
  contentFingerprint: moduleContentFingerprint,
  resolutionFingerprint: fingerprint("2"),
  content: moduleContent,
  dependencyManifest: [],
  correlationId,
});
const moduleV1 = moduleDefinitionConsumerReadResultV1Schema.parse({
  ...moduleV2,
  releaseRevision: 3,
  releaseVersion: "1.0.0",
  validationContractVersion: "1.0.0",
});

type ModuleRead = typeof moduleV1 | typeof moduleV2;

const applicationFor = (module: ModuleRead) => {
  const content = {
    name: "Event test application",
    description: "Application V1 bound to the exact test module release.",
    icon: "application",
    moduleBindings: [
      {
        moduleRootId,
        version: { selection: "exact" as const, version: module.releaseVersion },
        resolvedVersion: module.releaseVersion,
        purpose: "primary",
      },
    ],
    navigation: [],
    pages: [
      {
        pageId: id(20),
        key: "home",
        name: "Home",
        accessPermissionKey: "example.application.open",
        states: ["normal" as const],
        layout: {
          desktop: { columns: 12 as const, componentOrder: [id(21)] },
          phone: { componentOrder: [id(21)] },
        },
        type: "dashboard" as const,
        blocks: [
          {
            placementId: id(21),
            blockId: id(22),
            blockReleaseVersion: "1.0.0",
            settings: {},
            desktop: { startColumn: 1, span: 12, height: 4 },
            phone: { order: 0, behaviour: "full_width" as const },
            viewPermissionKey: "example.application.open",
          },
        ],
      },
    ],
    roles: [
      {
        roleId: id(23),
        key: "user",
        name: "User",
        homePageId: id(20),
        permissionKeys: ["example.application.open"],
        permissionSelection: { kind: "exact" as const },
      },
    ],
    queries: [],
    blockRegistrations: [
      {
        blockId: id(22),
        releaseVersion: "1.0.0",
        name: "Content",
        icon: "content",
        paletteGroup: "content" as const,
        settings: [],
        allowedChildBlockIds: [],
        phoneBehaviour: "full_width" as const,
        resizableHeight: true,
        liveUpdate: false,
        publicPage: false,
      },
    ],
    pipelines: [],
    permissions: [],
    actions: [],
    rules: [],
    events: [
      {
        eventId: applicationEventId,
        key: "example.application.item_archived",
        recordTypeId,
        carriedFieldIds: [],
        personalOrSensitiveValuesAllowed: false as const,
      },
    ],
    workflows: [],
    connectionBindings: [],
    interfaces: [],
    publicAddresses: [],
    theme: {
      mode: "application" as const,
      lightAndDark: true,
      tokens: {
        brand: "blue",
        density: "comfortable" as const,
        corners: "medium" as const,
        focus: "high_contrast" as const,
      },
    },
    homePageId: id(20),
  };
  return applicationDefinitionConsumerReadResultV1Schema.parse({
    kind: "application",
    organizationId,
    definitionKey: "example.application",
    rootId: applicationRootId,
    releaseRevision: 10,
    releaseVersion: "1.0.0",
    validationContractVersion: "1.0.0",
    contentFingerprint: fingerprintCanonicalValue(content),
    resolutionFingerprint: fingerprint("a"),
    content,
    dependencyManifest: [
      {
        kind: "module",
        key: module.definitionKey,
        rootId: module.rootId,
        releaseRevision: module.releaseRevision,
        releaseVersion: module.releaseVersion,
        contentFingerprint: module.contentFingerprint,
        resolutionFingerprint: module.resolutionFingerprint,
      },
    ],
    correlationId,
  });
};

const inputFor = (module: ModuleRead) => {
  const application = applicationFor(module);
  return {
    application,
    modules: [module],
    bindings: [
      {
        organizationId,
        applicationRootId,
        moduleRootId,
        bindingRevision: 7,
        applicationReleaseRevision: application.releaseRevision,
        moduleReleaseRevision: module.releaseRevision,
        state: "active" as const,
      },
    ],
  };
};

const releaseFor = (
  module: ModuleRead,
  descriptor: InstalledEventDescriptor,
): EventOccurrenceEnvelopeV2["definitionRelease"] => {
  if (descriptor.kind === "declared" && descriptor.owner.kind === "application") {
    const application = applicationFor(module);
    return {
      kind: "application",
      rootId: application.rootId,
      releaseRevision: application.releaseRevision,
      releaseVersion: application.releaseVersion,
      contentFingerprint: application.contentFingerprint,
      resolutionFingerprint: application.resolutionFingerprint,
    };
  }
  return {
    kind: "module",
    rootId: module.rootId,
    releaseRevision: module.releaseRevision,
    releaseVersion: module.releaseVersion,
    contentFingerprint: module.contentFingerprint,
    resolutionFingerprint: module.resolutionFingerprint,
  };
};

const occurrenceFor = (
  module: ModuleRead,
  descriptor: InstalledEventDescriptor,
  payload: EventOccurrenceEnvelopeV2["payload"],
) => ({
  contractVersion: "2.0.0" as const,
  occurrenceId: id(30),
  organizationId,
  installation: {
    applicationRootId,
    applicationReleaseRevision: 10,
    moduleBinding: {
      moduleRootId,
      moduleReleaseRevision: module.releaseRevision,
      bindingRevision: 7,
    },
  },
  descriptor,
  definitionRelease: releaseFor(module, descriptor),
  recordId: id(31),
  occurredAt: "2026-09-09T01:02:03.000Z",
  actorId: id(32),
  correlationId,
  recordSequence: 1,
  payload,
});

const descriptorFor = (
  module: ModuleRead,
  predicate: (descriptor: InstalledEventDescriptor) => boolean,
) => projectInstalledEventCatalogue(inputFor(module)).descriptors.find(predicate)!;

const expectCode = (operation: () => unknown, code: string) => {
  try {
    operation();
    throw new Error("Expected installed event occurrence refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(InstalledEventOccurrenceError);
    expect((error as InstalledEventOccurrenceError).code).toBe(code);
  }
};

describe("installed event occurrence validation", () => {
  it("reuses Record V2 type, settings and classification semantics", () => {
    const descriptor = descriptorFor(
      moduleV2,
      (candidate) => candidate.kind === "declared" && candidate.declarationId === moduleEventId,
    );
    expect(
      validateInstalledEventOccurrence(
        inputFor(moduleV2),
        occurrenceFor(moduleV2, descriptor, {
          kind: "declared",
          carriedValues: { [safeFieldId]: "yes" },
        }),
      ).payload,
    ).toEqual({ kind: "declared", carriedValues: { [safeFieldId]: "yes" } });
    for (const carriedValues of [
      { [safeFieldId]: 7 },
      { [safeFieldId]: "long" },
      { [sensitiveFieldId]: "no" },
    ])
      expectCode(
        () =>
          validateInstalledEventOccurrence(
            inputFor(moduleV2),
            occurrenceFor(moduleV2, descriptor, { kind: "declared", carriedValues }),
          ),
        "INSTALLED_EVENT_OCCURRENCE_PAYLOAD_INVALID",
      );
  });

  it("uses historical V1 field settings through the same Record checker", () => {
    const descriptor = descriptorFor(
      moduleV1,
      (candidate) => candidate.kind === "declared" && candidate.declarationId === moduleEventId,
    );
    expect(
      validateInstalledEventOccurrence(
        inputFor(moduleV1),
        occurrenceFor(moduleV1, descriptor, {
          kind: "declared",
          carriedValues: { [safeFieldId]: "old" },
        }),
      ).payload,
    ).toMatchObject({ carriedValues: { [safeFieldId]: "old" } });
    expectCode(
      () =>
        validateInstalledEventOccurrence(
          inputFor(moduleV1),
          occurrenceFor(moduleV1, descriptor, {
            kind: "declared",
            carriedValues: { [safeFieldId]: "long" },
          }),
        ),
      "INSTALLED_EVENT_OCCURRENCE_PAYLOAD_INVALID",
    );
  });

  it("uses the Application release for its declaration and the Module binding for its record", () => {
    const descriptor = descriptorFor(
      moduleV2,
      (candidate) =>
        candidate.kind === "declared" && candidate.declarationId === applicationEventId,
    );
    const occurrence = validateInstalledEventOccurrence(
      inputFor(moduleV2),
      occurrenceFor(moduleV2, descriptor, { kind: "declared", carriedValues: {} }),
    );
    expect(occurrence.definitionRelease).toMatchObject({
      kind: "application",
      rootId: applicationRootId,
    });
    expect(occurrence.installation.moduleBinding.moduleRootId).toBe(moduleRootId);
  });

  it("represents set and clear by omission while classified values remain absent", () => {
    const stateChanged = descriptorFor(
      moduleV2,
      (candidate) => candidate.kind === "standard" && candidate.eventKind === "state_changed",
    );
    for (const payload of [
      { kind: "state_changed" as const, fieldId: safeFieldId, newValue: "new" },
      { kind: "state_changed" as const, fieldId: safeFieldId, previousValue: "old" },
      {
        kind: "state_changed" as const,
        fieldId: safeFieldId,
        previousValue: "old",
        newValue: "new",
      },
      { kind: "state_changed" as const, fieldId: sensitiveFieldId },
    ])
      expect(
        validateInstalledEventOccurrence(
          inputFor(moduleV2),
          occurrenceFor(moduleV2, stateChanged, payload),
        ).payload,
      ).toEqual(payload);
    for (const payload of [
      { kind: "state_changed" as const, fieldId: safeFieldId },
      { kind: "state_changed" as const, fieldId: safeFieldId, newValue: null },
      { kind: "state_changed" as const, fieldId: sensitiveFieldId, previousValue: "no" },
    ])
      expectCode(
        () =>
          validateInstalledEventOccurrence(
            inputFor(moduleV2),
            occurrenceFor(moduleV2, stateChanged, payload),
          ),
        "INSTALLED_EVENT_OCCURRENCE_PAYLOAD_INVALID",
      );
  });

  it("refuses retargeting an occurrence to another binding revision", () => {
    const descriptor = descriptorFor(
      moduleV2,
      (candidate) => candidate.kind === "declared" && candidate.declarationId === moduleEventId,
    );
    const occurrence = occurrenceFor(moduleV2, descriptor, {
      kind: "declared",
      carriedValues: {},
    });
    expectCode(
      () =>
        validateInstalledEventOccurrence(inputFor(moduleV2), {
          ...occurrence,
          installation: {
            ...occurrence.installation,
            moduleBinding: { ...occurrence.installation.moduleBinding, bindingRevision: 8 },
          },
        }),
      "INSTALLED_EVENT_OCCURRENCE_CONTEXT_MISMATCH",
    );
  });
});
