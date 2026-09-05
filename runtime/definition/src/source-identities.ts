import type {
  ApplicationSourceDocumentV2,
  DefinitionSourceDocument,
  SourceIdentityKind,
  SourceIdentityKindV2,
} from "@vortex/contracts";

export type SourceIdentityRequirement = Readonly<{
  definitionKey: string;
  /** Stable parent-owner scope used only by the identity store. */
  ownerScope: string;
  /** Current authored lookup scope emitted into a compilation resolution. */
  scope: string;
  kind: SourceIdentityKind;
  componentOwner: string;
  aliases: readonly string[];
}>;

export type SourceIdentityRequirementV2 = Readonly<{
  definitionKey: string;
  ownerScope: string;
  scope: string;
  kind: SourceIdentityKindV2;
  componentOwner: string;
  aliases: readonly string[];
}>;

type SourceObject = Record<string, unknown>;

const objects = (value: unknown): SourceObject[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is SourceObject =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const uniqueStrings = (values: readonly unknown[]): string[] => [
  ...new Set(values.flatMap((value) => (typeof value === "string" ? [value] : []))),
];

const objectValue = (value: unknown): SourceObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceObject)
    : undefined;

/**
 * Derives every permanent identity owner and authentic alias from a parsed source document.
 * Source `id` values are owners; mutable keys and paths are aliases of that owner.
 */
export function extractSourceIdentityRequirements(
  source: DefinitionSourceDocument,
): SourceIdentityRequirement[] {
  const sourceObject = source as unknown as SourceObject;
  const definitionKey = source.key;
  const requirements: SourceIdentityRequirement[] = [];
  const add = (
    kind: SourceIdentityRequirement["kind"],
    ownerScope: string,
    scope: string,
    componentOwner: unknown,
    aliases: readonly unknown[],
  ) => {
    const owner = stringValue(componentOwner);
    if (owner === undefined) return;
    requirements.push({
      definitionKey,
      ownerScope,
      scope,
      kind,
      componentOwner: owner,
      aliases: uniqueStrings(aliases),
    });
  };
  const addIdentified = (
    kind: SourceIdentityRequirement["kind"],
    ownerScope: string,
    scope: string,
    component: SourceObject,
    extraAliases: readonly unknown[] = [],
  ) => add(kind, ownerScope, scope, component.id, [component.id, component.key, ...extraAliases]);

  add("root", "document", "document", "root", [source.key, source.root_alias]);
  if (source.kind === "connection_type") return requirements;

  const body = sourceObject.body as SourceObject;
  const collection = (key: string): SourceObject[] => objects(body[key]);
  const addTopLevel = (
    kind: SourceIdentityRequirement["kind"],
    collectionKey: string,
    aliases: (component: SourceObject) => readonly unknown[] = () => [],
  ) => {
    for (const component of collection(collectionKey))
      addIdentified(kind, "content", "content", component, aliases(component));
  };

  addTopLevel("permission", "permissions");
  addTopLevel("action", "actions");
  addTopLevel("rule", "rules");
  addTopLevel("event", "events");

  if (source.kind === "module") {
    for (const recordType of collection("record_types")) {
      const recordKey = stringValue(recordType.key);
      const recordOwner = stringValue(recordType.id);
      if (recordKey === undefined || recordOwner === undefined) continue;
      const scope = `record:${recordKey}`;
      const ownerScope = `record_owner:${recordOwner}`;
      addIdentified("record_type", "content", "content", recordType);
      add("storage_contract", ownerScope, scope, recordType.storage_contract_id, [
        recordType.storage_contract_id,
        recordType.key,
      ]);
      for (const field of objects(recordType.fields))
        addIdentified("field", ownerScope, scope, field);
      for (const relationship of objects(recordType.relationships))
        addIdentified("relationship", ownerScope, scope, relationship);
    }
    addTopLevel("extension_point", "extension_points");
    addTopLevel("sharing_condition", "sharing_conditions");
    return requirements;
  }

  addTopLevel("role", "roles");
  addTopLevel("query", "queries");
  addTopLevel("block", "block_registrations");
  addTopLevel("pipeline", "pipelines");
  addTopLevel("connection_binding", "connection_bindings");
  addTopLevel("public_address", "public_addresses", (component) => [component.path]);

  const flattenNavigation = (items: readonly SourceObject[]): SourceObject[] =>
    items.flatMap((item) => [item, ...flattenNavigation(objects(item.children))]);
  for (const item of flattenNavigation(collection("navigation")))
    addIdentified("navigation_item", "content", "content", item);

  for (const page of collection("pages")) {
    addIdentified("page", "content", "content", page);
    const pageKey = stringValue(page.key);
    const pageOwner = stringValue(page.id);
    for (const placement of objects(page.blocks))
      addIdentified("block_placement", "content", "content", placement);
    for (const step of objects(page.steps)) {
      if (pageKey !== undefined && pageOwner !== undefined)
        addIdentified("guided_step", `page_owner:${pageOwner}`, `page:${pageKey}`, step);
      for (const placement of objects(step.blocks))
        addIdentified("block_placement", "content", "content", placement);
    }
  }

  for (const workflow of collection("workflows")) {
    addIdentified("workflow", "content", "content", workflow);
    const workflowKey = stringValue(workflow.key);
    const workflowOwner = stringValue(workflow.id);
    if (workflowKey === undefined || workflowOwner === undefined) continue;
    for (const node of objects(workflow.nodes))
      addIdentified(
        "workflow_node",
        `workflow_owner:${workflowOwner}`,
        `workflow:${workflowKey}`,
        node,
      );
  }

  for (const definition of collection("interfaces")) {
    addIdentified("interface", "content", "content", definition);
    const interfaceKey = stringValue(definition.key);
    const interfaceOwner = stringValue(definition.id);
    if (interfaceKey === undefined || interfaceOwner === undefined) continue;
    for (const operation of objects(definition.operations))
      addIdentified(
        "interface_operation",
        `interface_owner:${interfaceOwner}`,
        `interface:${interfaceKey}`,
        operation,
      );
  }

  return requirements;
}

/**
 * Derives V2 Application identities from its exact parsed source contract.
 * Platform-block identities belong to the immutable catalogue and are never allocated here.
 */
export function extractApplicationSourceIdentityRequirementsV2(
  source: ApplicationSourceDocumentV2,
): SourceIdentityRequirementV2[] {
  const sourceObject = source as unknown as SourceObject;
  const body = sourceObject.body as SourceObject;
  const requirements: SourceIdentityRequirementV2[] = [];
  const add = (
    kind: SourceIdentityKindV2,
    ownerScope: string,
    scope: string,
    componentOwner: unknown,
    aliases: readonly unknown[],
  ) => {
    const owner = stringValue(componentOwner);
    if (owner === undefined) return;
    requirements.push({
      definitionKey: source.key,
      ownerScope,
      scope,
      kind,
      componentOwner: owner,
      aliases: uniqueStrings(aliases),
    });
  };
  const addIdentified = (
    kind: SourceIdentityKindV2,
    ownerScope: string,
    scope: string,
    component: SourceObject,
    extraAliases: readonly unknown[] = [],
  ) => add(kind, ownerScope, scope, component.id, [component.id, component.key, ...extraAliases]);
  const collection = (key: string): SourceObject[] => objects(body[key]);
  const addTopLevel = (
    kind: SourceIdentityKindV2,
    collectionKey: string,
    aliases: (component: SourceObject) => readonly unknown[] = () => [],
  ) => {
    for (const component of collection(collectionKey))
      addIdentified(kind, "content", "content", component, aliases(component));
  };
  const addPlacementSlot = (slotValue: unknown): void => {
    const slot = objectValue(slotValue);
    const placements = objectValue(slot?.placements);
    if (placements === undefined) return;
    for (const [placementOwner, placementValue] of Object.entries(placements)) {
      const placement = objectValue(placementValue);
      if (placement === undefined) continue;
      add("block_placement", "content", "content", placementOwner, [placementOwner]);
      const childSlots = objectValue(placement.slots);
      if (childSlots !== undefined)
        for (const childSlot of Object.values(childSlots)) addPlacementSlot(childSlot);
    }
  };

  add("root", "document", "document", "root", [source.key, source.root_alias]);
  addTopLevel("permission", "permissions");
  addTopLevel("action", "actions");
  addTopLevel("rule", "rules");
  addTopLevel("event", "events");
  addTopLevel("role", "roles");
  addTopLevel("query", "queries");
  addTopLevel("pipeline", "pipelines");
  addTopLevel("connection_binding", "connection_bindings");
  addTopLevel("public_address", "public_addresses", (component) => [component.path]);

  const flattenNavigation = (items: readonly SourceObject[]): SourceObject[] =>
    items.flatMap((item) => [item, ...flattenNavigation(objects(item.children))]);
  for (const item of flattenNavigation(collection("navigation")))
    addIdentified("navigation_item", "content", "content", item);

  for (const shell of collection("shells")) {
    addIdentified("shell", "content", "content", shell);
    for (const contentSlot of objects(shell.content_slots))
      addIdentified("shell_content_slot", "content", "content", contentSlot);
    addPlacementSlot(shell.layout);
  }

  for (const page of collection("pages")) {
    addIdentified("page", "content", "content", page);
    const pageKey = stringValue(page.key);
    const pageOwner = stringValue(page.id);
    for (const step of objects(page.steps))
      if (pageKey !== undefined && pageOwner !== undefined)
        addIdentified("guided_step", `page_owner:${pageOwner}`, `page:${pageKey}`, step);
    const composition = objectValue(page.composition);
    if (composition?.shell_kind === "default") addPlacementSlot(composition.main);
    else {
      const content = objectValue(composition?.content);
      if (content !== undefined) for (const slot of Object.values(content)) addPlacementSlot(slot);
    }
  }

  for (const workflow of collection("workflows")) {
    addIdentified("workflow", "content", "content", workflow);
    const workflowKey = stringValue(workflow.key);
    const workflowOwner = stringValue(workflow.id);
    if (workflowKey === undefined || workflowOwner === undefined) continue;
    for (const node of objects(workflow.nodes))
      addIdentified(
        "workflow_node",
        `workflow_owner:${workflowOwner}`,
        `workflow:${workflowKey}`,
        node,
      );
  }

  for (const definition of collection("interfaces")) {
    addIdentified("interface", "content", "content", definition);
    const interfaceKey = stringValue(definition.key);
    const interfaceOwner = stringValue(definition.id);
    if (interfaceKey === undefined || interfaceOwner === undefined) continue;
    for (const operation of objects(definition.operations))
      addIdentified(
        "interface_operation",
        `interface_owner:${interfaceOwner}`,
        `interface:${interfaceKey}`,
        operation,
      );
  }

  return requirements;
}
