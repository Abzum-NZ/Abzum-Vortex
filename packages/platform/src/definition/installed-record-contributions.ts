import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { sameId } from "../catalogue/runtime-primitives";
import { flowSchema } from "../workflows/flow-contracts";
import { componentFlowBindingSchema } from "./application-flow-bindings";
import { defaultFlowBindingSettings } from "./component-semantic-events";
import type { SystemApplicationBoundReleaseSetResult } from "./definition-consumer-read";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import { DefinitionError } from "./definition-error";
import { contributedActionKey } from "./installed-named-actions";
import { actionDefinitionSchema, moduleFieldSchema } from "./module-contracts";

/**
 * The exact installed contributions on the record types an application's active installation binds:
 * each is a field or an action another installed Module of the organisation added to an owner
 * record type, with the contributor's own exact definition. The database resolves them once, from
 * the contribution storage the exact install provisioned and the contributor's active installation,
 * and serves the same fields to every record read and write; this is the one place the runtime
 * context learns them, so nothing downstream names or guesses a contributor.
 */
const installedFieldContributionSchema = z
  .object({
    kind: z.literal("field"),
    contributionId: z.uuid(),
    contributorModuleRootId: z.uuid(),
    contributorReleaseRevision: z.number().int().min(1),
    contributorApplicationRootIds: z.array(z.uuid()).min(1),
    field: moduleFieldSchema,
  })
  .strict();

const installedActionContributionSchema = z
  .object({
    kind: z.literal("action"),
    contributionId: z.uuid(),
    extensionPointId: z.uuid(),
    contributorModuleRootId: z.uuid(),
    contributorReleaseRevision: z.number().int().min(1),
    contributorApplicationRootIds: z.array(z.uuid()).min(1),
    action: actionDefinitionSchema,
    // The contributor's compiled transaction flow, validated once per immutable identity below.
    flow: z.unknown(),
  })
  .strict();

const installedRecordContributionsSchema = z.array(
  z
    .object({
      moduleRootId: z.uuid(),
      recordTypeId: z.uuid(),
      contributions: z
        .array(
          z.discriminatedUnion("kind", [
            installedFieldContributionSchema,
            installedActionContributionSchema,
          ]),
        )
        .min(1)
        .max(200),
    })
    .strict(),
);

export type InstalledRecordTypeContributions = Readonly<{
  moduleRootId: string;
  recordTypeId: string;
  fields: readonly Readonly<{
    fieldId: string;
    contributorModuleRootId: string;
    contributorReleaseRevision: number;
  }>[];
  actions: readonly Readonly<{
    actionId: string;
    key: string;
    label: string;
    contributorModuleRootId: string;
    contributorReleaseRevision: number;
  }>[];
}>;

export type InstalledRecordContributions = Readonly<{
  /** The owner record types with the fields and actions contributed to them. */
  recordTypes: readonly InstalledRecordTypeContributions[];
  /** The contributed field definitions by `${moduleRootId}:${recordTypeId}`, lowercase. */
  fieldsByRecordType: ReadonlyMap<string, readonly z.infer<typeof moduleFieldSchema>[]>;
  /** The compiled transaction flows the contributed actions run, by the action's identity. */
  actionFlows: readonly z.infer<typeof flowSchema>[];
}>;

export const noInstalledRecordContributions: InstalledRecordContributions = Object.freeze({
  recordTypes: Object.freeze([]),
  fieldsByRecordType: new Map(),
  actionFlows: Object.freeze([]),
});

const recordTypeKey = (moduleRootId: string, recordTypeId: string): string =>
  `${moduleRootId.toLowerCase()}:${recordTypeId.toLowerCase()}`;

type ContributionRow = DatabaseRow & { readonly contributions: unknown };

/** Keeps at most `limit` entries; the oldest leaves first. Nothing is replaced in place. */
const remember = <Value>(cache: Map<string, Value>, key: string, value: Value, limit: number) => {
  cache.set(key, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value!);
  return value;
};

/**
 * A contributed action's flow is the contributor's compiled flow in one immutable Module release,
 * so (contributor root, release revision, contribution) names one flow forever: it is validated
 * the first time it is read and reused after that.
 */
const contributedFlows = new Map<string, z.infer<typeof flowSchema>>();
const contributedFlowOf = (
  action: Readonly<{
    contributionId: string;
    contributorModuleRootId: string;
    contributorReleaseRevision: number;
    flow: unknown;
  }>,
): z.infer<typeof flowSchema> | undefined => {
  const key = JSON.stringify([
    action.contributorModuleRootId.toLowerCase(),
    action.contributorReleaseRevision,
    action.contributionId.toLowerCase(),
  ]);
  const known = contributedFlows.get(key);
  if (known !== undefined) return known;
  const parsed = flowSchema.safeParse(action.flow);
  return parsed.success ? remember(contributedFlows, key, parsed.data, 2_000) : undefined;
};

/** Reads the contributions under the verified human request transaction, failing loudly on any malformed row. */
export const readInstalledRecordContributions = async (
  transaction: RequestDatabaseTransaction,
): Promise<InstalledRecordContributions> => {
  const rows = await transaction.query<ContributionRow>`
    select vortex_record.read_installed_record_contributions() as contributions
  `;
  if (rows.length !== 1 || rows[0] === undefined)
    throw new DefinitionError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED");
  const parsed = installedRecordContributionsSchema.safeParse(rows[0].contributions);
  if (!parsed.success) {
    console.error(
      `[contributions] installed record contributions are malformed: ${parsed.error.message}`,
    );
    throw new DefinitionError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED", {
      cause: { part: "record_contributions", reason: "malformed" },
    });
  }
  const fieldsByRecordType = new Map<string, readonly z.infer<typeof moduleFieldSchema>[]>();
  const actionFlows = new Map<string, z.infer<typeof flowSchema>>();
  const recordTypes = parsed.data.map((entry) => {
    const fields = entry.contributions.flatMap((contribution) =>
      contribution.kind === "field" ? [contribution] : [],
    );
    const actions = entry.contributions.flatMap((contribution) =>
      contribution.kind === "action" ? [contribution] : [],
    );
    for (const action of actions) {
      const flow = contributedFlowOf(action);
      if (flow === undefined) {
        console.error("[contributions] a contributed action flow is malformed");
        throw new DefinitionError("INSTALLED_RUNTIME_CONTEXT_INTEGRITY_FAILED", {
          cause: { part: "record_contributions", reason: "malformed" },
        });
      }
      actionFlows.set(action.contributionId.toLowerCase(), flow);
    }
    if (fields.length > 0)
      fieldsByRecordType.set(
        recordTypeKey(entry.moduleRootId, entry.recordTypeId),
        fields.map((contribution) => contribution.field),
      );
    return Object.freeze({
      moduleRootId: entry.moduleRootId,
      recordTypeId: entry.recordTypeId,
      fields: Object.freeze(
        fields.map((contribution) =>
          Object.freeze({
            fieldId: contribution.contributionId,
            contributorModuleRootId: contribution.contributorModuleRootId,
            contributorReleaseRevision: contribution.contributorReleaseRevision,
          }),
        ),
      ),
      actions: Object.freeze(
        actions.map((contribution) =>
          Object.freeze({
            actionId: contribution.contributionId,
            key: contribution.action.key,
            label: contribution.action.label,
            contributorModuleRootId: contribution.contributorModuleRootId,
            contributorReleaseRevision: contribution.contributorReleaseRevision,
          }),
        ),
      ),
    });
  });
  return Object.freeze({
    recordTypes: Object.freeze(recordTypes),
    fieldsByRecordType,
    actionFlows: Object.freeze([...actionFlows.values()]),
  });
};

/** A permanent identity derived from the parts that name it, a valid RFC 9562 UUID. */
const derivedId = (...parts: readonly string[]): string => {
  const bytes = createHash("sha256")
    .update(`contributed-action:${parts.map((part) => part.toLowerCase()).join(":")}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * The identities of the control that runs one contributed action on one detail page: the placement
 * the page shows, the binding that starts the flow, its event and the flow itself. Derived only from
 * the page, the owner record type and the action, so the page and the flow endpoint agree on them
 * without sharing state, and an action contributed to two record types runs through two flows.
 */
export const contributedActionControlIds = (
  pageId: string,
  recordTypeId: string,
  actionId: string,
) =>
  Object.freeze({
    controlId: derivedId("control", pageId, actionId),
    bindingId: derivedId("binding", pageId, actionId),
    eventId: derivedId("event", pageId, actionId),
    flowId: derivedId("flow", recordTypeId, actionId),
  });

type Application = SystemApplicationBoundReleaseSetResult["application"];

/**
 * The flows and bindings through which a person starts the actions contributed to the record types
 * of the detail pages of `application`: one interactive flow per action and owner record type that
 * calls the action by its contributed key, and one `action` binding per detail page of the owner
 * record type. They are ordinary compiled flows and bindings; the flow endpoint runs them exactly as it runs an authored
 * one, and the named action path decides whether the person may run the action on the record.
 */
const contributedActionFlows = (
  application: Application,
  recordTypes: readonly InstalledRecordTypeContributions[],
) => {
  const flows = new Map<string, ReturnType<typeof flowSchema.parse>>();
  const bindings: ReturnType<typeof componentFlowBindingSchema.parse>[] = [];
  for (const page of application.content.pages) {
    if (page.type !== "detail" || page.recordType?.state !== "resolved") continue;
    const subject = page.recordType;
    const entry = recordTypes.find(
      (candidate) =>
        sameId(candidate.moduleRootId, String(subject.moduleRootId)) &&
        sameId(candidate.recordTypeId, String(subject.recordTypeId)),
    );
    for (const action of entry?.actions ?? []) {
      const ids = contributedActionControlIds(
        String(page.pageId),
        String(subject.recordTypeId),
        action.actionId,
      );
      if (!flows.has(ids.flowId))
        flows.set(
          ids.flowId,
          flowSchema.parse({
            id: ids.flowId,
            key: `contributed_action_${ids.flowId.replaceAll("-", "").slice(0, 16)}`,
            description: `Runs the contributed action ${action.label} on the record the page shows.`,
            labels: { name: action.label },
            namespace: application.definitionKey,
            execution: "interactive",
            runAs: { kind: "initiator" },
            inputs: {},
            tasks: [
              {
                id: "call",
                type: "operation.call",
                version: "1.0.0",
                properties: {
                  operation: {
                    kind: "literal",
                    literal: {
                      type: "text",
                      value: contributedActionKey(String(subject.recordTypeId), action.actionId),
                    },
                  },
                },
              },
            ],
            outputs: {},
          }),
        );
      bindings.push(
        componentFlowBindingSchema.parse({
          bindingId: ids.bindingId,
          controlId: ids.controlId,
          eventId: ids.eventId,
          event: "action",
          flow: { flowId: ids.flowId, inputs: {} },
          settings: defaultFlowBindingSettings("action"),
        }),
      );
    }
  }
  return { flows: [...flows.values()], bindings };
};

type ModuleContent = SystemApplicationBoundReleaseSetResult["modules"][number]["content"];
type ContributedContents = Readonly<{
  /** The Module contents these were built over, compared by identity. */
  modules: readonly ModuleContent[];
  application: Application["content"] | undefined;
  contributed: ReadonlyMap<string, ModuleContent>;
}>;

/**
 * The contents a set of contributions produces for one installed release, by the release's frozen
 * application content and the identities of the contributions: the same inputs always serve the
 * same content objects, so the flow plans built over them (`flowPlansOf`) are built once. A new
 * release or a changed contribution is a new key; nothing is replaced in place.
 */
const contributedContents = new WeakMap<Application["content"], Map<string, ContributedContents>>();

const contributionsKey = (contributions: InstalledRecordContributions): string =>
  JSON.stringify(
    contributions.recordTypes.map((entry) => [
      entry.moduleRootId.toLowerCase(),
      entry.recordTypeId.toLowerCase(),
      entry.fields.map((field) => [
        field.fieldId.toLowerCase(),
        field.contributorModuleRootId.toLowerCase(),
        field.contributorReleaseRevision,
      ]),
      entry.actions.map((action) => [
        action.actionId.toLowerCase(),
        action.contributorModuleRootId.toLowerCase(),
        action.contributorReleaseRevision,
      ]),
    ]),
  );

const buildContributedContents = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
  contributions: InstalledRecordContributions,
): ContributedContents => {
  const contributed = new Map<string, ModuleContent>();
  for (const module of releaseSet.modules) {
    const entries = contributions.recordTypes.filter((entry) =>
      sameId(entry.moduleRootId, module.rootId),
    );
    if (entries.length === 0) continue;
    const recordTypes = module.content.recordTypes.map((recordType) => {
      const added = contributions.fieldsByRecordType.get(
        recordTypeKey(module.rootId, recordType.recordTypeId),
      );
      return added === undefined
        ? recordType
        : Object.freeze({ ...recordType, fields: [...recordType.fields, ...added] });
    });
    contributed.set(module.rootId.toLowerCase(), Object.freeze({ ...module.content, recordTypes }));
  }
  const actions = contributedActionFlows(releaseSet.application, contributions.recordTypes);
  // A contributor this application also binds already serves its action's transaction flow; the
  // same flow identity is never listed twice.
  const servedFlowIds = new Set(
    [
      ...releaseSet.application.content.flows,
      ...releaseSet.modules.flatMap((module) => module.content.flows),
    ].map((flow) => String(flow.id).toLowerCase()),
  );
  const actionFlows = contributions.actionFlows.filter(
    (flow) => !servedFlowIds.has(String(flow.id).toLowerCase()),
  );
  return {
    modules: releaseSet.modules.map((module) => module.content),
    contributed,
    application:
      actions.bindings.length === 0
        ? undefined
        : Object.freeze({
            ...releaseSet.application.content,
            flows: [...releaseSet.application.content.flows, ...actionFlows, ...actions.flows],
            flowBindings: [...releaseSet.application.content.flowBindings, ...actions.bindings],
          }),
  };
};

/**
 * The release set the context serves: each owner record type with the fields contributed to it
 * after its own, so every consumer of an installed record type (display, forms, flows, reference
 * choices) reads one effective field list, exactly the one the record paths serve, and the
 * application with the flows and bindings that start the contributed actions on its detail pages.
 * The contributed field keeps its permanent identity and the contributor's definition; nothing else
 * is merged.
 */
export const withInstalledRecordContributions = (
  releaseSet: SystemApplicationBoundReleaseSetResult,
  contributions: InstalledRecordContributions,
): SystemApplicationBoundReleaseSetResult => {
  if (contributions.recordTypes.length === 0) return releaseSet;
  const byKey =
    contributedContents.get(releaseSet.application.content) ??
    new Map<string, ContributedContents>();
  contributedContents.set(releaseSet.application.content, byKey);
  const key = contributionsKey(contributions);
  const known = byKey.get(key);
  const contents =
    known !== undefined &&
    known.modules.length === releaseSet.modules.length &&
    known.modules.every((content, index) => content === releaseSet.modules[index]!.content)
      ? known
      : remember(byKey, key, buildContributedContents(releaseSet, contributions), 20);
  const modules = releaseSet.modules.map((module) => {
    const content = contents.contributed.get(module.rootId.toLowerCase());
    return content === undefined ? module : Object.freeze({ ...module, content });
  });
  const application =
    contents.application === undefined
      ? releaseSet.application
      : Object.freeze({ ...releaseSet.application, content: contents.application });
  return { application, modules };
};
