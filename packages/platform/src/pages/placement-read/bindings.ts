import "server-only";

import type { JsonValue } from "../../catalogue/common";
import { compiledPageBindingFacts } from "../../definition/application-composition/compiled-query-bindings";
import { compiledPageShellId } from "../../definition/application-composition/compiled-item-tree";
import type { QueryBindingValueType } from "../../definition/application-composition/query-binding-values";
import {
  readAwaitingMessage,
  readQueryBindings,
} from "../../definition/application-composition/query-bindings";
import type { PageDefinition } from "../../definition/application-contracts";
import {
  placementBlockRelease,
  placementSettings,
} from "../../definition/application-composition-catalogue";
import type { InstalledRuntimeContext } from "../../definition/installed-runtime-context";
import { walkPageComposition, walkPlacementData } from "../placement-walk";
import {
  resolveQueryBindings,
  type QueryBindingContext,
  type QueryBindingRecordRead,
} from "../query-binding-resolver";
import type { PageSubjectReadResult } from "../page-subject-read";
import {
  logPlacementFailure,
  placementSettingsOf,
  type AddressParameters,
  type PlacementQuery,
  type PlacementReadEntry,
} from "./shared";
import type { PlacementReadInput } from "./types";

const blockOf = (vortex: unknown): Readonly<{ key: string; name: string }> | undefined => {
  try {
    return placementBlockRelease((vortex as { block?: unknown } | undefined)?.block);
    // guard-allow: silent-catch A custom component placement has no platform block release and publishes no page parameter.
  } catch {
    // A custom component publishes no page parameter.
    return undefined;
  }
};

/**
 * The binding context of one page for one request: the parameters and controls its installed
 * definition declares (the same facts publication checked), the address, the subject read the page
 * already makes, the viewer from the verified request scope and the organisation's time zone, read
 * only if a relative date asks for it.
 */
export const pageQueryBindingContext = (
  input: Readonly<{
    context: InstalledRuntimeContext;
    pageDefinition: PageDefinition;
    parameters: AddressParameters;
    /** The subject read of a record page; undefined on any other page. */
    readSubject: (() => Promise<PageSubjectReadResult>) | undefined;
    subjectRecordTypeId: string | undefined;
    readTimeZone: () => Promise<string | undefined>;
    /** The viewer's active organisation group identities from the verified request, or undefined. */
    readViewerTeams: () => Promise<readonly string[] | undefined>;
  }>,
): QueryBindingContext => {
  const entries: [string, { settings: unknown; vortex: unknown }][] = [];
  walkPageComposition(input.pageDefinition.composition, ({ placementId, props, vortex }) => {
    if (blockOf(vortex) !== undefined)
      entries.push([placementId, { settings: placementSettings(props), vortex }]);
    return undefined;
  });
  const shellId = compiledPageShellId(input.pageDefinition.composition);
  const shell = input.context.releaseSet.application.content.shells.find(
    (candidate) => String(candidate.shellId) === shellId,
  );
  if (shell !== undefined)
    walkPlacementData(shell.layout, ({ placementId, props, vortex }) => {
      if (blockOf(vortex) !== undefined)
        entries.push([placementId, { settings: placementSettings(props), vortex }]);
      return undefined;
    });
  const records = new Map(
    input.context.releaseSet.modules.flatMap((module) =>
      module.content.recordTypes.map((recordType) => [String(recordType.recordTypeId), recordType]),
    ),
  );
  const facts = compiledPageBindingFacts(
    input.pageDefinition as unknown as Readonly<Record<string, unknown>>,
    entries,
    (placement) => blockOf(placement.vortex),
    records,
    new Map(
      input.context.releaseSet.modules.flatMap((module) =>
        module.content.queries.map((query) => [String(query.queryId), query]),
      ),
    ),
  );
  const parameters = new Map<string, QueryBindingValueType>();
  for (const parameter of facts.parameters)
    if (!parameters.has(parameter.name)) parameters.set(parameter.name, parameter.type);
  const controls = new Map(
    facts.controls.flatMap((control) =>
      control.parameter === undefined
        ? []
        : [[control.placement.toLowerCase(), control.parameter] as const],
    ),
  );
  const readSubject = input.readSubject;
  const subjectRecordTypeId = input.subjectRecordTypeId;
  return {
    address: input.parameters,
    parameters,
    controls,
    subject:
      readSubject === undefined || subjectRecordTypeId === undefined
        ? undefined
        : async (): Promise<QueryBindingRecordRead> => {
            const read = await readSubject();
            return read.kind === "read"
              ? {
                  kind: "read",
                  recordTypeId: subjectRecordTypeId,
                  recordId: String(read.row.recordId),
                  values: read.row.values,
                }
              : { kind: "unreadable" };
          },
    // The protected directory projection's record identity IS the organisation account identity.
    // A live verified human context already proves that account exists and is active; no address
    // parameter or control may choose either part of this reference.
    viewerPerson:
      facts.currentPersonRecordType === undefined ||
      input.context.viewerOrganizationAccountId === undefined
        ? undefined
        : {
            recordTypeId: facts.currentPersonRecordType,
            recordId: input.context.viewerOrganizationAccountId,
          },
    // A team is an organisation group the verified viewer is an active member of; the read runs
    // inside the request's own verified context, once, and only if a binding asks for it.
    viewerTeams:
      facts.currentTeamRecordType === undefined
        ? undefined
        : { recordTypeId: facts.currentTeamRecordType, read: input.readViewerTeams },
    // The organisation of the verified installed context; no address parameter, control or preview
    // value may choose it.
    viewerOrganisation: String(input.context.organizationId),
    timeZone: input.readTimeZone,
    now: new Date(),
  };
};

/** The page parameters each placement's bindings read, so a control change rereads only those. */
/** The one record type a control on the page selects, or undefined when it selects none or several. */
export const controlSelectedRecordType = (
  bindings: Pick<QueryBindingContext, "controls" | "parameters">,
  control: string,
): string | undefined => {
  const name = bindings.controls.get(control.toLowerCase());
  const declared = name === undefined ? undefined : bindings.parameters.get(name);
  return declared?.kind === "record" && declared.recordTypes.length === 1
    ? declared.recordTypes[0]
    : undefined;
};

export const placementParameterDependencies = (
  placements: readonly PlacementReadEntry[],
  bindings: QueryBindingContext,
): Readonly<Record<string, readonly string[]>> => {
  const dependents: Record<string, string[]> = {};
  const depend = (name: string | undefined, placementId: string): void => {
    if (name === undefined) return;
    const held = (dependents[name] ??= []);
    if (!held.includes(placementId)) held.push(placementId);
  };
  for (const placement of placements) {
    const settings = placementSettingsOf(placement);
    // A Record detail showing a control's selected record reads again when the selection changes.
    const recordFrom = settings["record_from"];
    if (recordFrom?.kind === "text")
      depend(bindings.controls.get(recordFrom.value.toLowerCase()), placement.placementId);
    const read = readQueryBindings(settings);
    if (read.kind !== "read") continue;
    for (const binding of read.bindings) {
      const name =
        binding.source.kind === "page_parameter"
          ? binding.source.name
          : binding.source.kind === "control"
            ? bindings.controls.get(binding.source.placement.toLowerCase())
            : undefined;
      depend(name, placement.placementId);
    }
  }
  return dependents;
};

const titleOf = (placement: PlacementReadEntry): string | undefined => {
  const title = placementSettingsOf(placement)["title"];
  return title?.kind === "text" && title.value.trim() !== "" ? title.value.trim() : undefined;
};

/**
 * The query inputs of one bound placement, resolved by the one resolver. When a required input has
 * no value the placement shows its awaiting message, and a binding the server cannot honour is
 * logged with its typed cause and refused; in both cases no query runs and this returns undefined.
 */
export const resolvePlacementInputs = async (
  read: PlacementReadInput,
  placement: PlacementReadEntry,
  query: PlacementQuery,
): Promise<Readonly<Record<string, JsonValue>> | undefined> => {
  const { placementId } = placement;
  const settings = placementSettingsOf(placement);
  const bindings = readQueryBindings(settings);
  if (bindings.kind === "malformed") {
    logPlacementFailure(read.address, placementId, "query_binding_refused", "bindings_malformed");
    read.data[placementId] = { status: "refused", reason: "not_permitted" };
    return undefined;
  }
  const title = titleOf(placement);
  const awaitingMessage = readAwaitingMessage(settings);
  const resolution = await resolveQueryBindings(
    bindings.bindings,
    query.inputs,
    read.bindings,
    {
      ...(title === undefined ? {} : { title }),
      ...(awaitingMessage === undefined ? {} : { awaitingMessage }),
    },
    (cause) => logPlacementFailure(read.address, placementId, "query_binding_withheld", cause),
  );
  if (resolution.kind === "resolved") return resolution.inputValues;
  if (resolution.kind === "awaiting")
    read.data[placementId] = { status: "awaiting_input", message: resolution.message };
  else {
    logPlacementFailure(
      read.address,
      placementId,
      "query_binding_refused",
      `${resolution.part} ${resolution.reason}`,
    );
    read.data[placementId] = { status: "refused", reason: "not_permitted" };
  }
  return undefined;
};
