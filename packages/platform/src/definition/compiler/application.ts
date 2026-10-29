import type { PlatformPermissionSource } from "../../access/platform-permissions";
import type { applicationCompilationRequestSchema } from "../definition-compilation-contracts";
import { inspectApplicationPageReplacements } from "../../pages/application-page-replacement";
import type { FlowDefinition } from "../../workflows/flow-contracts";
import { applicationDraftSchema } from "../application-contracts";
import {
  applicationCompilationOutputSchema,
  type ApplicationCompilationOutput,
  type DefinitionCompilationOutput,
} from "../definition-compilation-contracts";
import type { ApplicationSourceDocument } from "../definition-source";
import type { ModuleField } from "../module-contracts";
import { conditionNodeSchema } from "../module-foundation-contracts";
import { APPLICATION_PLATFORM_COMPATIBILITY_VERSION } from "../platform-compatibility";
import {
  applicationRoleReviewBytes,
  applicationRoleReviewRefusal,
} from "../application-role-review-volume";
import { compareCanonicalStrings, fingerprintCanonicalValue } from "../canonical-json-definition";
import {
  DefinitionCompilationError,
  type DefinitionCompilerRefusalCode,
} from "../compilation-error";
import { flowBindingSettingsSchema } from "../application-flow-bindings";
import type { ComponentSemanticEventKind } from "../component-semantic-events";
import { flowBindingSettingNotYetRunnable } from "../flow-step-settings";
import { applicationSearchSourceReferences } from "../source-identities";
import {
  materialiseApplicationComposition,
  type MaterialisedApplicationComposition,
} from "../application-materialisation";
import {
  type ApplicationCompositionResolution,
  applicationSearchFieldIsSelectable,
  fieldInputSourceField,
} from "../application-resolution";
import { validateApplicationSourceCatalogue } from "../application-catalogue-validation";
import { settleDefinitionRuleFailures } from "../rule-failure-order";
import { applicationProvenance } from "./application-provenance";
import { compiledSourceFlowBindings } from "./application-flow-binding-sources";
import { compileApplicationToolBundle } from "./application-tools";
import { dependencyOrder, resolvedDependencies } from "./dependencies";
import { compileCheckedFlowSources } from "./flow-sources";
import { derivePersonGrants } from "./person-grants";
import {
  applicationPermissionSharingConditions,
  compilePermissionFieldPolicy,
  compilePermissionRecordScope,
  permissionScopeSourceOwners,
} from "./permission-scopes";
import type { compatibleVersion } from "./resolution";
import { exactVersion, Resolution } from "./resolution";
import {
  asObject,
  compilerRootLocation,
  fail,
  type JsonObject,
  objectFromUniqueEntries,
  applicationModuleKeysOf,
  CURRENT_MODULE_RELEASE,
} from "./shared";
import {
  applicationModuleValueIndex,
  type ApplicationModuleValueIndex,
  condition,
  qualifiedField,
} from "./values";

function compileApplicationPages(
  source: JsonObject,
  resolution: Resolution,
  composition: MaterialisedApplicationComposition,
  moduleQueryId: (reference: string) => string,
  platformPermissions: PlatformPermissionSource,
) {
  const body = asObject(source.body);
  const definitionKey = String(source.key);
  const pageId = (alias: string) => resolution.id(definitionKey, "page", alias, "content");
  const allowedPermissionOwners = permissionScopeSourceOwners(source);
  const pages = (body.pages as JsonObject[]).map((page, index) => {
    const compiledComposition = composition.pages[index];
    if (compiledComposition === undefined)
      fail("vortex.definition.invalid_compilation_output", "invalid_value");
    const base = {
      pageId: pageId(String(page.id)),
      ...(page.replaces_page === undefined
        ? {}
        : { replacementOfPageId: pageId(String(page.replaces_page)) }),
      key: page.key,
      name: page.name,
      // A page keeps its exact access permission key. An application or bound-Module permission is
      // resolved against its owner; a platform administration permission is carried through as its
      // exact catalogue key, which the runtime evaluates against the viewer's platform authority.
      accessPermissionKey: platformPermissions.hasKey(String(page.permission))
        ? String(page.permission)
        : resolution.exactOwnedReference(
            "permission",
            String(page.permission),
            allowedPermissionOwners,
          ),
      composition: compiledComposition.composition,
    };
    if (page.type === "list") {
      const record = String(page.record_type);
      return {
        ...base,
        type: "list",
        recordType: resolution.recordType(record),
        queryId: moduleQueryId(String(page.query)),
      };
    }
    if (page.type === "dashboard") return { ...base, type: "dashboard" };
    if (page.type === "detail")
      return {
        ...base,
        type: "detail",
        recordType: resolution.recordType(String(page.record_type)),
      };
    if (page.type === "form")
      return {
        ...base,
        type: "form",
        recordType: resolution.recordType(String(page.record_type)),
      };
    if (page.type === "guided_form")
      return {
        ...base,
        type: "guided_form",
        recordType: resolution.recordType(String(page.record_type)),
        steps: (page.steps as JsonObject[]).map((step) => ({
          id: resolution.id(
            definitionKey,
            "guided_step",
            String(step.id),
            `page:${String(page.key)}`,
          ),
          name: step.name,
          summary: step.summary,
        })),
      };
    return {
      ...base,
      type: "public",
      ...(page.record_type ? { recordType: resolution.recordType(String(page.record_type)) } : {}),
      publicFieldIds: page.record_type
        ? (page.public_fields as string[]).map((alias) =>
            resolution.field(String(page.record_type), alias),
          )
        : [],
      ...(page.public_action
        ? {
            publicActionKey: resolution.exactOwnedReference(
              "action",
              String(page.public_action),
              allowedPermissionOwners,
            ),
          }
        : {}),
      rateLimitPerMinute: page.rate_limit_per_minute,
    };
  });
  for (const issue of inspectApplicationPageReplacements(
    pages.map((page) => {
      const record = "recordType" in page ? page.recordType : undefined;
      return {
        identities: [page.pageId],
        type: page.type,
        permission: page.accessPermissionKey,
        replaces: page.replacementOfPageId,
        subject:
          record === undefined ? undefined : ([record.moduleRootId, record.recordTypeId] as const),
      };
    }),
  ))
    fail(
      issue.kind === "identity"
        ? "vortex.definition.application_identity_unique"
        : issue.kind === "permission"
          ? "vortex.definition.application_page_permission"
          : "vortex.definition.application_page_references",
      issue.kind === "identity" ? "duplicate_key" : "broken_reference",
      resolution.location("page", String((body.pages as JsonObject[])[issue.index]!.key)),
    );
  return pages;
}

function compileApplication(
  source: JsonObject,
  resolution: Resolution,
  metadata: JsonObject,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
  composition: MaterialisedApplicationComposition,
  valueIndex: ApplicationModuleValueIndex,
  flows: readonly FlowDefinition[],
  platformPermissions: PlatformPermissionSource,
) {
  const body = asObject(source.body);
  const definitionKey = String(source.key);
  const root = resolution.definition(definitionKey, "application");
  // Resolve permission-owned evidence before the general value-consumer index so
  // invalid saved-condition dependencies keep their established diagnostic.
  const permissions = (body.permissions as JsonObject[]).map((permission) => {
    const referencedSharing = applicationPermissionSharingConditions(
      permission,
      source,
      resolution,
      metadata.organizationId,
      dependencyOutputs,
    );
    const recordScope = compilePermissionRecordScope(
      permission,
      source,
      resolution,
      referencedSharing,
    );
    const fieldPolicy = compilePermissionFieldPolicy(permission, source, resolution);
    return {
      permissionId: resolution.id(definitionKey, "permission", String(permission.id), "content"),
      key: permission.key,
      label: permission.label,
      description: permission.description,
      ...(permission.record_type
        ? { recordTypeId: resolution.recordType(String(permission.record_type)).recordTypeId }
        : {}),
      actionKind: permission.action_kind,
      ...(permission.named_action ? { namedAction: permission.named_action } : {}),
      administrative: permission.administrative,
      ...(recordScope === undefined ? {} : { recordScope }),
      ...(fieldPolicy === undefined ? {} : { fieldPolicy }),
    };
  });
  const pageId = (alias: string) => resolution.id(definitionKey, "page", alias, "content");
  const pages = compileApplicationPages(
    source,
    resolution,
    composition,
    valueIndex.query,
    platformPermissions,
  );
  const searchSource = (source as unknown as ApplicationSourceDocument).body.search;
  const searchReferences = applicationSearchSourceReferences(
    source as unknown as ApplicationSourceDocument,
  );
  const search =
    searchSource === undefined
      ? undefined
      : {
          enabled: searchSource.enabled,
          recordTypes: searchSource.record_types.map((entry, index) => {
            const references = searchReferences[index]!;
            const recordType = resolution.recordType(references.recordType);
            const record = valueIndex.record(references.recordType)?.record;
            const fields = record?.fields as ModuleField[] | undefined;
            if (
              fields === undefined ||
              references.fields.some(
                (reference) =>
                  !applicationSearchFieldIsSelectable(
                    fields,
                    qualifiedField(resolution, reference),
                  ),
              )
            )
              fail("vortex.definition.application_page_query", "broken_reference");
            return {
              recordType,
              fields: entry.fields.map((field) => ({
                fieldId: qualifiedField(resolution, field.field),
                priority: field.priority,
              })),
              titleFieldId: qualifiedField(resolution, entry.title_field),
              ...(entry.subtitle_field === undefined
                ? {}
                : { subtitleFieldId: qualifiedField(resolution, entry.subtitle_field) }),
              targetPageId: pageId(references.page),
            };
          }),
        };
  // An application never owns a query: the Query engine runs only the queries a Module exposes, so
  // every page and placement binds a dependency-qualified Module query instead.
  const queries: never[] = [];
  // Each Module release records the one Application that owns it: an inline Module must be owned
  // by this Application, and a used Module by the Application the source names.
  const expectedOwners: [string, string][] = [
    ...(body.modules as JsonObject[]).map((module): [string, string] => [
      String(module.key),
      definitionKey,
    ]),
    ...(body.uses as JsonObject[]).map((use): [string, string] => [
      String(use.module),
      String(use.application),
    ]),
  ];
  for (const [moduleKey, owner] of expectedOwners) {
    const expected = resolution.definition(moduleKey, "module");
    const release = dependencyOutputs.find(
      (output) =>
        output.kind === "module" &&
        output.artifact.rootId === expected.rootId &&
        output.artifact.exactVersion === expected.exactVersion,
    );
    if (release?.kind !== "module" || release.canonical.content.ownerApplication !== owner)
      fail(
        "vortex.definition.application_module_bindings",
        "scope_conflict",
        resolution.location("module", moduleKey),
      );
  }
  const wildcardPermissions = permissions
    .filter((permission) => permission.administrative === false)
    .sort((left, right) => compareCanonicalStrings(String(left.key), String(right.key)));
  const wildcardPermissionKeys = wildcardPermissions.map((permission) => permission.key);
  const withPersonGrant = derivePersonGrants(
    dependencyOutputs,
    expectedOwners.map(([moduleKey]) => moduleKey),
  );
  const wildcardCatalogueFingerprint = fingerprintCanonicalValue(wildcardPermissions);
  const canonical = applicationDraftSchema.parse({
    envelope: {
      kind: "application",
      rootId: root.rootId,
      organizationId: metadata.organizationId,
      key: definitionKey,
      draftRevision: metadata.draftRevision,
      ...(metadata.publishedRevision ? { publishedRevision: metadata.publishedRevision } : {}),
      createdAt: metadata.createdAt,
      createdBy: metadata.createdBy,
      updatedAt: metadata.updatedAt,
      updatedBy: metadata.updatedBy,
    },
    content: {
      name: body.name,
      description: body.description,
      icon: body.icon,
      // Each release pins the exact Module release it was compiled against, so publishing one
      // Application never changes which release of a shared Module another Application uses.
      moduleBindings: applicationModuleKeysOf(body).map((moduleKey) => {
        const target = resolution.definition(moduleKey, "module");
        const resolvedVersion = exactVersion(
          resolution,
          moduleKey,
          "module",
          CURRENT_MODULE_RELEASE,
        );
        return {
          moduleRootId: target.rootId,
          version: { selection: "exact", version: resolvedVersion },
          resolvedVersion,
        };
      }),
      navigation: (body.navigation as JsonObject[]).map(function visit(item): unknown {
        if (item.type === "heading")
          return {
            id: resolution.id(definitionKey, "navigation_item", String(item.id)),
            type: "heading",
            label: item.label,
            icon: item.icon,
            children: (item.children as JsonObject[]).map(visit),
          };
        if (item.type === "external")
          return {
            id: resolution.id(definitionKey, "navigation_item", String(item.id)),
            type: "external",
            label: item.label,
            icon: item.icon,
            address: item.address,
            permissionKey: item.permission,
          };
        return {
          id: resolution.id(definitionKey, "navigation_item", String(item.id)),
          type: "page",
          label: item.label,
          icon: item.icon,
          pageId: pageId(String(item.page)),
          permissionKey: item.permission,
        };
      }),
      pages,
      ...(body.experiences === undefined
        ? {}
        : {
            experiences: (body.experiences as JsonObject[]).map((experience) => ({
              state: experience.state,
              pageId: pageId(String(experience.page)),
            })),
          }),
      roles: (body.roles as JsonObject[]).map((role) => {
        const authoredPermissionKeys = role.permissions as string[];
        const usesApplicationWildcard =
          authoredPermissionKeys.length === 1 && authoredPermissionKeys[0] === "*";
        return {
          roleId: resolution.id(definitionKey, "role", String(role.id), "content"),
          key: role.key,
          name: role.name,
          homePageId: pageId(String(role.home_page)),
          permissionKeys: usesApplicationWildcard
            ? wildcardPermissionKeys
            : withPersonGrant(authoredPermissionKeys),
          permissionSelection: usesApplicationWildcard
            ? {
                kind: "application_wildcard",
                catalogueFingerprint: wildcardCatalogueFingerprint,
              }
            : { kind: "exact" },
          ...(role.default_member === true ? { defaultMember: true } : {}),
        };
      }),
      queries,
      platformBlockDependencies: composition.platformBlockDependencies,
      shells: composition.shells,
      permissions,
      // Every action belongs to a Module; an Application declares none of its own.
      actions: [],
      events: (body.events as JsonObject[]).map((event) => {
        const record = event.record_type === undefined ? undefined : String(event.record_type);
        return {
          eventId: resolution.id(definitionKey, "event", String(event.id), "content"),
          key: event.key,
          label: event.label,
          ...(record === undefined
            ? {}
            : { recordTypeId: resolution.recordType(record).recordTypeId }),
          carriedFieldIds: (event.carries as string[])
            .map((alias) => resolution.field(record!, alias))
            .sort(compareCanonicalStrings),
          personalOrSensitiveValuesAllowed: false,
        };
      }),
      connectionBindings: (body.connection_bindings as JsonObject[]).map((binding) => {
        const requirement = binding.version as Parameters<typeof compatibleVersion>[0];
        const target = resolution.definition(String(binding.connection_type), "connection_type");
        if (target.kind !== "connection_type")
          fail("vortex.definition.connection_type_mismatch", "unresolved_reference");
        if (
          (binding.required_operations as string[]).some(
            (operation) => !target.operationKeys.includes(operation),
          )
        )
          fail("vortex.definition.connection_operation_missing", "unresolved_reference");
        return {
          bindingId: resolution.id(
            definitionKey,
            "connection_binding",
            String(binding.id),
            "content",
          ),
          key: binding.key,
          connectionTypeId: target.rootId,
          version: requirement,
          resolvedVersion: exactVersion(
            resolution,
            String(binding.connection_type),
            "connection_type",
            requirement,
          ),
          requiredOperationKeys: binding.required_operations,
        };
      }),
      interfaces: (body.interfaces as JsonObject[]).map((definition) => ({
        interfaceId: resolution.id(definitionKey, "interface", String(definition.id), "content"),
        key: definition.key,
        version: definition.version,
        state: definition.state,
        operations: (definition.operations as JsonObject[]).map((operation) => ({
          operationId: resolution.id(
            definitionKey,
            "interface_operation",
            String(operation.id),
            `interface:${definition.key}`,
          ),
          key: operation.key,
          description: operation.description,
          method: operation.method,
          path: operation.path,
          inputShape: objectFromUniqueEntries(
            Object.entries(asObject(operation.input_shape)).map(([key, descriptorValue]) => {
              const descriptor = asObject(descriptorValue);
              const targetBinding = asObject(descriptor.target_binding);
              return [
                key,
                {
                  type: descriptor.type,
                  required: descriptor.required,
                  targetBinding:
                    targetBinding.kind === "action_input"
                      ? { kind: "action_input", key: targetBinding.key }
                      : { kind: "action_subject" },
                },
              ];
            }),
          ),
          outputShape: objectFromUniqueEntries(
            Object.entries(asObject(operation.output_shape)).map(([key, descriptorValue]) => {
              const descriptor = asObject(descriptorValue);
              const targetBinding = asObject(descriptor.target_binding);
              return [
                key,
                {
                  type: descriptor.type,
                  required: descriptor.required,
                  targetBinding:
                    targetBinding.kind === "query_field"
                      ? {
                          kind: "query_field",
                          fieldId: qualifiedField(resolution, String(targetBinding.field)),
                        }
                      : targetBinding.kind === "query_page_information"
                        ? { kind: "query_page_information", value: targetBinding.value }
                        : { kind: "workflow_run_id" },
                },
              ];
            }),
          ),
          authentication: operation.authentication,
          permissionKey: operation.permission,
          visibility: operation.visibility,
          rateLimitPerMinute: operation.rate_limit_per_minute,
          maximumRequestBytes: operation.maximum_request_bytes,
          duplicateProtection: operation.duplicate_protection,
          // A change or background start names an application-owned flow entry point, resolved to
          // its permanent flow identity; a read keeps its declared query key.
          target:
            asObject(operation.target).kind === "flow"
              ? {
                  kind: "flow",
                  flowId: resolution.id(
                    definitionKey,
                    "flow",
                    String(asObject(operation.target).flow),
                    "content",
                  ),
                }
              : operation.target,
          errorCodes: operation.error_codes,
        })),
      })),
      publicAddresses: (body.public_addresses as JsonObject[]).map((address) => ({
        addressId: resolution.id(definitionKey, "public_address", String(address.id), "content"),
        pageId: pageId(String(address.page)),
        path: address.path,
        state: address.state,
        rateLimitPerMinute: address.rate_limit_per_minute,
      })),
      theme: composition.theme,
      homePageId: pageId(String(body.home_page)),
      ...(search === undefined ? {} : { search }),
      flows,
      flowBindings: compileApplicationFlowBindings(source, resolution, flows),
    },
  });
  return canonical;
}

/**
 * The Application's bindings of component events to flows: the flow's permanent identity and its
 * typed input map. A binding starts an interactive flow, names only inputs the flow declares, and
 * supplies every input the flow requires, so a mismatch is refused here instead of when the
 * control is used. Values the invoking surface supplies are `caller` inputs the surface fills by
 * the same name.
 */
function compileApplicationFlowBindings(
  source: JsonObject,
  resolution: Resolution,
  flows: readonly FlowDefinition[],
): JsonObject[] {
  const body = asObject(source.body);
  const definitionKey = String(source.key);
  const flowsById = new Map(flows.map((flow) => [String(flow.id), flow]));
  return compiledSourceFlowBindings(body).map((binding) => {
    const flowId = resolution.id(definitionKey, "flow", String(binding.flow), "content");
    const flow = flowsById.get(flowId);
    const location = resolution.location("flow_binding", String(binding.id));
    if (flow === undefined)
      fail("vortex.definition.application_flow_binding_target", "broken_reference", location);
    if (flow.execution !== "interactive")
      fail("vortex.definition.application_flow_binding_target", "invalid_value", location);
    const inputs = asObject(binding.inputs ?? {});
    for (const name of Object.keys(inputs))
      if (!Object.hasOwn(flow.inputs, name))
        fail("vortex.definition.application_flow_binding_inputs", "unknown_property", location);
    for (const [name, declared] of Object.entries(flow.inputs))
      if (declared.required && !Object.hasOwn(inputs, name))
        fail("vortex.definition.application_flow_binding_inputs", "required_value", location);
    const settings = flowBindingSettingsSchema.safeParse(binding.settings);
    if (!settings.success)
      fail("vortex.definition.application_flow_binding_inputs", "invalid_value", location);
    const notYet = flowBindingSettingNotYetRunnable(
      binding.event as ComponentSemanticEventKind,
      settings.data,
    );
    if (notYet !== undefined)
      throw new DefinitionCompilationError(
        "vortex.definition.unsupported_workflow_node",
        "unsupported_choice",
        location,
        undefined,
        `Binding ${String(binding.id)}: ${notYet}`,
      );
    return {
      bindingId: resolution.id(definitionKey, "flow_binding", String(binding.id), "content"),
      controlId: resolution.id(definitionKey, "block_placement", String(binding.control)),
      eventId: resolution.id(definitionKey, "event", String(binding.event_id), "content"),
      event: binding.event,
      flow: { flowId, inputs },
      settings: asObject(binding.settings),
    };
  });
}

const applicationCompositionResolution = (
  source: ApplicationSourceDocument,
  resolution: Resolution,
  valueIndex: ApplicationModuleValueIndex,
): ApplicationCompositionResolution => {
  const definitionKey = source.key;
  const allowedOwners = permissionScopeSourceOwners(source as unknown as JsonObject);
  const splitMember = (
    reference: string,
    code: DefinitionCompilerRefusalCode,
  ): readonly [string, string] => {
    const separator = reference.lastIndexOf(".");
    if (separator < 1) fail(code, "unresolved_reference");
    return [reference.slice(0, separator), reference.slice(separator + 1)];
  };
  return {
    identity: (kind, alias, scope = "content") => resolution.id(definitionKey, kind, alias, scope),
    moduleQuery: valueIndex.query,
    field: (reference) => qualifiedField(resolution, reference),
    fieldInput: (fieldId) => {
      const pair = valueIndex.fieldById(fieldId);
      // Only a field of an exactly bound module release can drive an automatic field input.
      return pair === undefined
        ? undefined
        : fieldInputSourceField(pair.field, (parentId) => valueIndex.fieldById(parentId)?.field);
    },
    relationship: (reference) => {
      const [recordType, alias] = splitMember(
        reference,
        "vortex.definition.qualified_field_required",
      );
      return resolution.relationship(recordType, alias);
    },
    action: (reference) => resolution.exactOwnedReference("action", reference, allowedOwners),
    permission: (reference) =>
      resolution.exactOwnedReference("permission", reference, allowedOwners),
    condition: (authored) =>
      conditionNodeSchema.parse(
        condition(
          authored,
          (reference) => qualifiedField(resolution, reference),
          valueIndex.context(),
        ),
      ),
    recordType: (reference) => resolution.recordType(reference),
  };
};

export function compileParsedApplicationRequest(
  request: ParsedApplicationRequest,
  dependencyOutputs: readonly DefinitionCompilationOutput[],
  platformPermissions: PlatformPermissionSource,
): ApplicationCompilationOutput {
  const source = request.source;
  const sourceObject = source as unknown as JsonObject;
  try {
    // Publication refuses with the first of the located catalogue results draft save reports,
    // before materialisation can refuse the same document without its location.
    const catalogueFailure = settleDefinitionRuleFailures(
      validateApplicationSourceCatalogue(source, request.catalogueSnapshot.platformBlocks.releases),
    )[0];
    if (catalogueFailure !== undefined)
      throw new DefinitionCompilationError(
        catalogueFailure.ruleCode,
        catalogueFailure.family,
        catalogueFailure.location,
        catalogueFailure.code,
        catalogueFailure.sentence,
      );
    const resolution = new Resolution(request.resolution, sourceObject);
    const flowSet = compileCheckedFlowSources(sourceObject, resolution, dependencyOutputs);
    const valueIndex = applicationModuleValueIndex(sourceObject, resolution, dependencyOutputs);
    const composition = materialiseApplicationComposition(
      source,
      request.catalogueSnapshot,
      applicationCompositionResolution(source, resolution, valueIndex),
    );
    // compileApplication returns the parsed draft; the final output parse below also checks it.
    const canonical = compileApplication(
      sourceObject,
      resolution,
      request.draftMetadata as unknown as JsonObject,
      dependencyOutputs,
      composition,
      valueIndex,
      flowSet.flows,
      platformPermissions,
    );
    const ownDefinition = resolution.definition(source.key, "application");
    const roleReview = applicationRoleReviewBytes(
      canonical.content,
      dependencyOutputs.flatMap((output) =>
        output.kind === "module" ? [output.canonical.content] : [],
      ),
    );
    const roleReviewRefusal = applicationRoleReviewRefusal(roleReview);
    if (roleReviewRefusal !== undefined)
      throw new DefinitionCompilationError(
        "vortex.definition.application_role_review_volume",
        "invalid_value",
        undefined,
        undefined,
        roleReviewRefusal,
      );
    const artifact = {
      kind: "application" as const,
      definitionKey: source.key,
      rootId: ownDefinition.rootId,
      exactVersion: ownDefinition.exactVersion,
      contentFingerprint: fingerprintCanonicalValue(canonical.content),
      resolutionFingerprint: request.resolution.fingerprint,
    };
    const output = applicationCompilationOutputSchema.safeParse({
      kind: "application",
      validationContractVersion: "4.0.0",
      platformCompatibilityVersion: APPLICATION_PLATFORM_COMPATIBILITY_VERSION,
      canonical,
      artifact,
      provenance: applicationProvenance(
        request.catalogueSnapshot.platformBlocks.releases,
        source,
        canonical,
        resolution,
        flowSet,
      ),
      dependencyOrder: dependencyOrder(sourceObject),
      resolvedDependencies: resolvedDependencies(sourceObject, resolution),
      resolutionFingerprint: request.resolution.fingerprint,
      toolBundle: compileApplicationToolBundle(
        request.catalogueSnapshot.platformBlocks.releases,
        canonical,
        sourceObject,
        resolution,
        dependencyOutputs,
      ),
    });
    if (!output.success) {
      console.error("[definition] application compilation output invalid", output.error);
      fail("vortex.definition.invalid_compilation_output", "invalid_value");
    }
    return output.data;
  } catch (error) {
    if (error instanceof DefinitionCompilationError)
      throw error.location
        ? error
        : new DefinitionCompilationError(
            error.ruleCode,
            error.family,
            compilerRootLocation(sourceObject),
            error.code,
            error.sentence,
          );
    console.error("[definition] application compilation failed", error);
    return fail("vortex.definition.invalid_compilation_output", "invalid_value");
  }
}
export type ParsedApplicationRequest = ReturnType<typeof applicationCompilationRequestSchema.parse>;
