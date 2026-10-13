import type { ApplicationToolBundle } from "@vortex/platform/schema";
import type { InstalledRuntimeContext } from "@web/platform-server";
import { projectedUseAvailability } from "./placement-helpers";
import type { PlacementFlowBinding } from "./types";

type ApplicationFlowBinding =
  InstalledRuntimeContext["releaseSet"]["application"]["content"]["flowBindings"][number];
type ApplicationTool = ApplicationToolBundle["tools"][number];
type FlowInputDeclaration = Extract<
  ApplicationTool["inputSchema"],
  { kind: "flow_inputs" }
>["inputs"][string];

export type WebMcpPropertySchema = Readonly<{
  type: "string" | "integer" | "number" | "boolean" | "array" | "object";
  format?: "date" | "date-time" | "uuid";
  items?: WebMcpPropertySchema;
  properties?: Readonly<Record<string, WebMcpPropertySchema>>;
  required?: readonly string[];
  additionalProperties?: false;
  const?: string;
}>;

export type PageWebMcpTool = Readonly<{
  name: string;
  description: string;
  inputSchema: Readonly<{
    type: "object";
    properties: Readonly<Record<string, WebMcpPropertySchema>>;
    required: readonly string[];
    additionalProperties: false;
  }>;
  binding: Readonly<{ bindingId: string; flowId: string; event: string }>;
}>;

type ProjectionInput = Readonly<{
  page: Readonly<Record<string, unknown>>;
  activeStepId?: string;
  bindings: Readonly<Record<string, readonly PlacementFlowBinding[]>>;
  applicationBindings: readonly ApplicationFlowBinding[];
  toolBundle: ApplicationToolBundle;
  applicationRootId: string;
  applicationKey: string;
  permittedApplications: readonly Readonly<{ applicationRootId: string; key: string }>[];
}>;

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();
const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
  typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);

const visiblePlacementIds = (page: Readonly<Record<string, unknown>>): ReadonlySet<string> => {
  const breakpoints = ["desktop", "tablet", "phone"] as const;
  type Visibility = Record<(typeof breakpoints)[number], boolean>;
  const visible = new Set<string>();
  const visit = (slot: unknown, ancestors: Visibility): void => {
    if (!isRecord(slot) || !isRecord(slot.placements)) return;
    for (const [placementId, candidate] of Object.entries(slot.placements)) {
      if (!isRecord(candidate)) continue;
      const responsive = candidate.responsive;
      if (!isRecord(responsive)) continue;
      const effective: Visibility = {
        desktop:
          ancestors.desktop && isRecord(responsive.desktop) && responsive.desktop.visible === true,
        tablet:
          ancestors.tablet && isRecord(responsive.tablet) && responsive.tablet.visible === true,
        phone: ancestors.phone && isRecord(responsive.phone) && responsive.phone.visible === true,
      };
      if (
        projectedUseAvailability(candidate) === "available" &&
        breakpoints.some((breakpoint) => effective[breakpoint])
      )
        visible.add(placementId.toLowerCase());
      if (isRecord(candidate.slots))
        for (const child of Object.values(candidate.slots)) visit(child, effective);
    }
  };
  const composition = page.composition;
  const allVisible: Visibility = { desktop: true, tablet: true, phone: true };
  if (isRecord(composition)) {
    if ("main" in composition) visit(composition.main, allVisible);
    else if (isRecord(composition.stepContent))
      for (const content of Object.values(composition.stepContent)) visit(content, allVisible);
  }
  return visible;
};

const activeStepPage = (
  page: Readonly<Record<string, unknown>>,
  activeStepId: string | undefined,
): Readonly<Record<string, unknown>> => {
  if (
    activeStepId === undefined ||
    !isRecord(page.composition) ||
    !isRecord(page.composition.stepContent)
  )
    return page;
  const step = page.composition.stepContent[activeStepId];
  return isRecord(step)
    ? { ...page, composition: { main: step } }
    : { ...page, composition: { main: {} } };
};

const propertyForInput = (
  input: FlowInputDeclaration,
  selectedReadType: string | undefined,
): WebMcpPropertySchema | undefined => {
  if (input.type === "record_reference" && selectedReadType !== undefined) {
    if (
      input.recordTypeIds !== undefined &&
      !input.recordTypeIds.some((id) => sameId(id, selectedReadType))
    )
      return undefined;
    return {
      type: "object",
      properties: {
        recordTypeId: { type: "string", const: selectedReadType },
        recordId: { type: "string", format: "uuid" },
      },
      required: ["recordTypeId", "recordId"],
      additionalProperties: false,
    };
  }
  switch (input.type) {
    case "choice":
    case "record_reference":
    case "relationship_reference":
      return {
        type: "string",
        ...(input.type === "record_reference" ? { format: "uuid" as const } : {}),
      };
    case "whole_number":
      return { type: "integer" };
    case "decimal_number":
    case "money":
      // Flow decimal values use canonical decimal text to avoid JSON floating-point loss.
      return { type: "string" };
    case "yes_no":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date" };
    case "date_time":
      return { type: "string", format: "date-time" };
    case "several_choices":
    case "record_reference_list":
    case "relationship_reference_list":
      return {
        type: "array",
        items: {
          type: "string",
          ...(input.type === "record_reference_list" ? { format: "uuid" as const } : {}),
        },
      };
    default:
      // This first projection does not accept free-form text, rich text, JSON or opaque credentials.
      return undefined;
  }
};

const inputContract = (
  tool: ApplicationTool,
  binding: ApplicationFlowBinding,
  pageBinding: PlacementFlowBinding,
): PageWebMcpTool["inputSchema"] | undefined => {
  if (tool.inputSchema.kind !== "flow_inputs") return undefined;
  const properties: Record<string, WebMcpPropertySchema> = {};
  const required: string[] = [];
  for (const [flowInputName, mappedInput] of Object.entries(binding.flow.inputs)) {
    if (!isRecord(mappedInput)) return undefined;
    if (mappedInput.kind === "literal") continue;
    if (mappedInput.kind !== "caller" || typeof mappedInput.name !== "string") return undefined;
    const declaration = tool.inputSchema.inputs[flowInputName];
    if (declaration === undefined || Object.hasOwn(properties, mappedInput.name)) return undefined;
    const selectedRead = pageBinding.selectedReadInputs?.find(
      (entry) => entry.callerInputName === mappedInput.name,
    );
    const property = propertyForInput(declaration, selectedRead?.recordTypeId);
    if (property === undefined) return undefined;
    properties[mappedInput.name] = property;
    // The protected flow invoker requires every caller value the selected control maps.
    required.push(mappedInput.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
};

/** Projects only current-page Flow tools that resolve to one usable control and its exact input map. */
export const projectPageWebMcpTools = (input: ProjectionInput): readonly PageWebMcpTool[] => {
  const page = activeStepPage(input.page, input.activeStepId);
  const usablePlacements = visiblePlacementIds(page);
  const projectedBindingIds = new Map<string, PlacementFlowBinding>();
  for (const [placementId, entries] of Object.entries(input.bindings)) {
    if (!usablePlacements.has(placementId.toLowerCase())) continue;
    for (const binding of entries)
      projectedBindingIds.set(binding.bindingId.toLowerCase(), binding);
  }
  const installedBindings = input.applicationBindings.filter(
    (binding) =>
      projectedBindingIds.has(String(binding.bindingId).toLowerCase()) &&
      usablePlacements.has(String(binding.controlId).toLowerCase()),
  );
  const visibleByFlowId = new Map<
    string,
    Array<{ binding: ApplicationFlowBinding; pageBinding: PlacementFlowBinding }>
  >();
  for (const binding of installedBindings) {
    const pageBinding = projectedBindingIds.get(String(binding.bindingId).toLowerCase());
    if (
      pageBinding === undefined ||
      !["action", "row_action", "bulk_action"].includes(binding.event)
    )
      continue;
    const flowId = String(binding.flow.flowId).toLowerCase();
    const matches = visibleByFlowId.get(flowId) ?? [];
    matches.push({ binding, pageBinding });
    visibleByFlowId.set(flowId, matches);
  }
  const duplicateApplicationKey =
    input.permittedApplications.filter((application) => application.key === input.applicationKey)
      .length > 1;
  const ownerSegment = input.applicationRootId.replaceAll("-", "").toLowerCase();
  const tools: PageWebMcpTool[] = [];
  for (const tool of input.toolBundle.tools) {
    if (tool.operation.kind !== "flow") continue;
    const matches = visibleByFlowId.get(String(tool.operation.flowId).toLowerCase()) ?? [];
    if (matches.length !== 1) continue;
    const { binding, pageBinding } = matches[0]!;
    const inputSchema = inputContract(tool, binding, pageBinding);
    if (inputSchema === undefined) continue;
    const name = duplicateApplicationKey
      ? `${input.applicationKey}.${ownerSegment}.${tool.name.slice(input.applicationKey.length + 1)}`
      : tool.name;
    if (name.length > 128) continue;
    tools.push({
      name,
      description: tool.description ?? `${input.applicationKey} ${tool.operation.key} flow`,
      inputSchema,
      binding: {
        bindingId: String(binding.bindingId),
        flowId: String(binding.flow.flowId),
        event: binding.event,
      },
    });
  }
  return Object.freeze(tools);
};
