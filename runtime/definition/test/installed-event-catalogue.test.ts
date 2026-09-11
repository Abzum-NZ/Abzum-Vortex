import {
  applicationDefinitionConsumerReadResultV1Schema,
  moduleDefinitionConsumerReadResultV2Schema,
} from "@vortex/contracts";
import { describe, expect, it } from "vitest";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import {
  InstalledEventCatalogueError,
  projectInstalledEventCatalogue,
} from "../src/installed-event-catalogue";

const id = (value: number) => `10000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1);
const applicationRootId = id(2);
const moduleOneRootId = id(3);
const moduleTwoRootId = id(4);
const recordOneId = id(5);
const recordTwoId = id(6);
const safeFieldId = id(7);
const sensitiveFieldId = id(8);
const secondFieldId = id(9);
const moduleEventId = id(10);
const applicationEventId = id(11);
const correlationId = id(12);
const fingerprint = (character: string) => `sha256:${character.repeat(64)}`;

const field = (fieldId: string, key: string, personalData: "none" | "personal" | "sensitive") => ({
  fieldId,
  key,
  label: key,
  required: true,
  unique: false,
  filterable: true,
  sortable: true,
  personalData,
  publicDisplay: "refused" as const,
  type: "text" as const,
  settings: { maxLength: 120 },
});

const recordType = (
  recordTypeId: string,
  key: string,
  storageContractId: string,
  fields: ReturnType<typeof field>[],
) => ({
  recordTypeId,
  key,
  singularLabel: key,
  pluralLabel: `${key}s`,
  titleFieldId: fields[0]!.fieldId,
  storageContractId,
  storageScope: "organization_shared" as const,
  ownershipMode: "none" as const,
  fields,
  relationships: [],
  standardActions: ["create", "read"] as const,
  customActionIds: [],
});

const moduleTwoContent = {
  name: "Dependency",
  description: "Second exact Module consumer result.",
  dependencies: [],
  recordTypes: [recordType(recordTwoId, "second", id(20), [field(secondFieldId, "title", "none")])],
  permissions: [],
  actions: [],
  events: [],
  rules: [],
  sharingConditions: [],
  extensionPoints: [],
};
const moduleTwoContentFingerprint = fingerprintCanonicalValue(moduleTwoContent);
const moduleTwo = moduleDefinitionConsumerReadResultV2Schema.parse({
  kind: "module",
  organizationId,
  definitionKey: "example.module_two",
  rootId: moduleTwoRootId,
  releaseRevision: 22,
  releaseVersion: "2.2.0",
  validationContractVersion: "2.0.0",
  contentFingerprint: moduleTwoContentFingerprint,
  resolutionFingerprint: fingerprint("2"),
  content: moduleTwoContent,
  dependencyManifest: [],
  correlationId,
});

const moduleOneContent = {
  name: "Primary",
  description: "Primary exact Module consumer result.",
  dependencies: [
    {
      dependencyKey: "dependency",
      moduleRootId: moduleTwoRootId,
      moduleKey: moduleTwo.definitionKey,
      version: { selection: "exact" as const, version: moduleTwo.releaseVersion },
      resolvedVersion: moduleTwo.releaseVersion,
    },
  ],
  recordTypes: [
    recordType(recordOneId, "item", id(21), [
      field(safeFieldId, "status", "none"),
      field(sensitiveFieldId, "private_note", "sensitive"),
    ]),
  ],
  permissions: [],
  actions: [],
  events: [
    {
      eventId: moduleEventId,
      key: "example.item.reviewed",
      recordTypeId: recordOneId,
      carriedFieldIds: [safeFieldId],
      personalOrSensitiveValuesAllowed: false as const,
    },
  ],
  rules: [],
  sharingConditions: [],
  extensionPoints: [],
};
const moduleOneContentFingerprint = fingerprintCanonicalValue(moduleOneContent);
const moduleOne = moduleDefinitionConsumerReadResultV2Schema.parse({
  kind: "module",
  organizationId,
  definitionKey: "example.module_one",
  rootId: moduleOneRootId,
  releaseRevision: 21,
  releaseVersion: "2.1.0",
  validationContractVersion: "2.0.0",
  contentFingerprint: moduleOneContentFingerprint,
  resolutionFingerprint: fingerprint("1"),
  content: moduleOneContent,
  dependencyManifest: [
    {
      kind: "module",
      key: moduleTwo.definitionKey,
      rootId: moduleTwo.rootId,
      releaseRevision: moduleTwo.releaseRevision,
      releaseVersion: moduleTwo.releaseVersion,
      contentFingerprint: moduleTwo.contentFingerprint,
      resolutionFingerprint: moduleTwo.resolutionFingerprint,
    },
  ],
  correlationId,
});

const applicationContent = {
  name: "Synthetic application",
  description: "Synthetic exact Application V1 consumer result.",
  icon: "application",
  moduleBindings: [
    {
      moduleRootId: moduleOne.rootId,
      version: { selection: "exact" as const, version: moduleOne.releaseVersion },
      resolvedVersion: moduleOne.releaseVersion,
      purpose: "primary",
    },
  ],
  navigation: [],
  pages: [
    {
      pageId: id(30),
      key: "home",
      name: "Home",
      accessPermissionKey: "example.application.open",
      states: ["normal" as const],
      layout: {
        desktop: { columns: 12 as const, componentOrder: [id(31)] },
        phone: { componentOrder: [id(31)] },
      },
      type: "dashboard" as const,
      blocks: [
        {
          placementId: id(31),
          blockId: id(32),
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
      roleId: id(33),
      key: "user",
      name: "User",
      homePageId: id(30),
      permissionKeys: ["example.application.open"],
      permissionSelection: { kind: "exact" as const },
    },
  ],
  queries: [],
  blockRegistrations: [
    {
      blockId: id(32),
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
      recordTypeId: recordOneId,
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
  homePageId: id(30),
};
const applicationContentFingerprint = fingerprintCanonicalValue(applicationContent);
const application = applicationDefinitionConsumerReadResultV1Schema.parse({
  kind: "application",
  organizationId,
  definitionKey: "example.application",
  rootId: applicationRootId,
  releaseRevision: 10,
  releaseVersion: "1.4.0",
  validationContractVersion: "1.0.0",
  contentFingerprint: applicationContentFingerprint,
  resolutionFingerprint: fingerprint("a"),
  content: applicationContent,
  dependencyManifest: [moduleOne]
    .map((module) => ({
      kind: "module" as const,
      key: module.definitionKey,
      rootId: module.rootId,
      releaseRevision: module.releaseRevision,
      releaseVersion: module.releaseVersion,
      contentFingerprint: module.contentFingerprint,
      resolutionFingerprint: module.resolutionFingerprint,
    }))
    .sort((left, right) => left.key.localeCompare(right.key)),
  correlationId,
});

const bindings = [moduleOne, moduleTwo].map((module, index) => ({
  organizationId,
  applicationRootId,
  moduleRootId: module.rootId,
  bindingRevision: index + 7,
  applicationReleaseRevision: application.releaseRevision,
  moduleReleaseRevision: module.releaseRevision,
  state: "active" as const,
}));

const input = () => ({ application, modules: [moduleOne, moduleTwo], bindings });

const expectCode = (operation: () => unknown, code: string) => {
  try {
    operation();
    throw new Error("Expected installed event refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(InstalledEventCatalogueError);
    expect((error as InstalledEventCatalogueError).code).toBe(code);
  }
};

describe("installed event Definition projector", () => {
  it("projects stable standard, Module and Application descriptors for App V1 with Module V2", () => {
    const projected = projectInstalledEventCatalogue(input());
    const reordered = projectInstalledEventCatalogue({
      application,
      modules: [moduleTwo, moduleOne],
      bindings: [...bindings].reverse(),
    });
    expect(projected).toEqual(reordered);
    expect(projected.descriptors).toHaveLength(16);
    expect(
      projected.descriptors.filter((descriptor) => descriptor.kind === "standard"),
    ).toHaveLength(14);
    expect(projected.descriptors).toEqual(
      expect.arrayContaining([
        {
          kind: "declared",
          owner: { kind: "module", moduleRootId: moduleOneRootId },
          declarationId: moduleEventId,
          key: "example.item.reviewed",
          recordTypeId: recordOneId,
          carriedFieldIds: [safeFieldId],
        },
        {
          kind: "declared",
          owner: { kind: "application", applicationRootId },
          declarationId: applicationEventId,
          key: "example.application.item_archived",
          recordTypeId: recordOneId,
          carriedFieldIds: [],
        },
      ]),
    );
    expect(projected.moduleBindings.map((entry) => entry.bindingRevision)).toEqual([7, 8]);
  });

  it("scopes identical declaration keys and identifiers to their owning roots", () => {
    const sharedKey = moduleOne.content.events[0]!.key;
    const applicationWithSharedKey = {
      ...application,
      content: {
        ...application.content,
        events: application.content.events.map((event) => ({
          ...event,
          eventId: moduleEventId,
          key: sharedKey,
        })),
      },
    };
    applicationWithSharedKey.contentFingerprint = fingerprintCanonicalValue(
      applicationWithSharedKey.content,
    );
    expect(
      projectInstalledEventCatalogue({
        application: applicationWithSharedKey,
        modules: input().modules,
        bindings: input().bindings,
      }).descriptors.filter(
        (descriptor) =>
          descriptor.kind === "declared" &&
          descriptor.declarationId === moduleEventId &&
          descriptor.key === sharedKey,
      ),
    ).toHaveLength(2);
  });

  it("refuses inactive evidence and exact dependency evidence that does not match the target read", () => {
    for (const state of ["provisioned", "detached"] as const)
      expectCode(
        () =>
          projectInstalledEventCatalogue({
            ...input(),
            bindings: bindings.map((binding, index) =>
              index === 0 ? { ...binding, state } : binding,
            ),
          }),
        "INSTALLED_EVENT_BINDING_INACTIVE",
      );
    expectCode(
      () =>
        projectInstalledEventCatalogue({
          ...input(),
          application: {
            ...application,
            dependencyManifest: application.dependencyManifest.map((dependency, index) =>
              index === 0
                ? { ...dependency, resolutionFingerprint: application.resolutionFingerprint }
                : dependency,
            ),
          },
        }),
      "INSTALLED_EVENT_DEPENDENCY_MISMATCH",
    );
  });

  it("refuses an exact Module read and active binding outside the Application's dependency closure", () => {
    const unreachedContent = {
      ...moduleTwoContent,
      name: "Unreached",
      description: "Exact Module consumer result that no installed dependency reaches.",
      recordTypes: [recordType(id(13), "unreached", id(22), [field(id(14), "title", "none")])],
    };
    const unreached = moduleDefinitionConsumerReadResultV2Schema.parse({
      ...moduleTwo,
      definitionKey: "example.module_three",
      rootId: id(15),
      releaseRevision: 23,
      releaseVersion: "2.3.0",
      contentFingerprint: fingerprintCanonicalValue(unreachedContent),
      resolutionFingerprint: fingerprint("3"),
      content: unreachedContent,
    });
    expectCode(
      () =>
        projectInstalledEventCatalogue({
          application,
          modules: [moduleOne, moduleTwo, unreached],
          bindings: [
            ...bindings,
            {
              ...bindings[1]!,
              moduleRootId: unreached.rootId,
              bindingRevision: 9,
              moduleReleaseRevision: unreached.releaseRevision,
            },
          ],
        }),
      "INSTALLED_EVENT_DEPENDENCY_MISMATCH",
    );
  });

  it("accepts an exact foreign-owned Module but still refuses release substitution", () => {
    const foreignModule = { ...moduleOne, organizationId: id(90) };
    expect(
      projectInstalledEventCatalogue({
        ...input(),
        modules: [foreignModule, moduleTwo],
      }).moduleBindings,
    ).toHaveLength(2);

    expectCode(
      () =>
        projectInstalledEventCatalogue({
          ...input(),
          modules: [{ ...foreignModule, releaseRevision: 23 }, moduleTwo],
        }),
      "INSTALLED_EVENT_DEPENDENCY_MISMATCH",
    );
  });
});
