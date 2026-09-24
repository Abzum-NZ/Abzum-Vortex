import "server-only";

import {
  applicationRootIdSchema,
  applicationToolBundleSchema,
  correlationIdSchema,
  organizationAccessDeclarationSchema,
  organizationIdSchema,
  revisionSchema,
  selectedOrganizationScopeSchema,
  type ApplicationRootId,
  type ApplicationTool,
  type ApplicationToolBundle,
  type ApplicationToolInputSchema,
  type OrganizationAccessDeclaration,
  type SelectedOrganizationScope,
} from "@vortex/contracts";
import type { RequestDatabaseTransaction } from "@vortex/db";

/**
 * The application tool bundle of one exact installed release, filtered for one viewer.
 *
 * This is the runtime reader for the bundle compiled into an Application release (#865). It
 * follows the same rules as page capability projection: a tool the viewer may not discover is
 * removed, a tool the viewer may discover but not use is described as unavailable and is never
 * callable, and missing, refused or unprovable evidence fails the whole projection closed rather
 * than exposing a tool. It projects only the one exact organisation, application root and release
 * that the viewer's verified request scope selects, never another installation.
 *
 * The Definition tier owns the projection and the fixed-source contract. It cannot import the
 * Access service (Access depends on Definition), so the live Access decision path is supplied as
 * an injected `ApplicationToolAccessEvaluator`; the caller composes it from
 * `runOrganizationAccessOperation` exactly as page capability does, and runs `project` inside the
 * human organisation request whose transaction and selected scope it passes in. The trusted source
 * supplies the bundle and the exact Access declaration for each gate; it never carries a permission
 * key, role name or private value into the projected result.
 */

export const applicationToolBundleProjectionErrorCodes = [
  "APPLICATION_TOOL_BUNDLE_SOURCE_INVALID",
  "APPLICATION_TOOL_BUNDLE_BINDING_UNAVAILABLE",
  "APPLICATION_TOOL_BUNDLE_SCOPE_UNAVAILABLE",
  "APPLICATION_TOOL_BUNDLE_EVIDENCE_UNAVAILABLE",
] as const;

export type ApplicationToolBundleProjectionErrorCode =
  (typeof applicationToolBundleProjectionErrorCodes)[number];

/** A projection fault. It carries only its code and is never a caller-facing tool result. */
export class ApplicationToolBundleProjectionError extends Error {
  readonly code: ApplicationToolBundleProjectionErrorCode;

  constructor(code: ApplicationToolBundleProjectionErrorCode) {
    super(code);
    this.name = "ApplicationToolBundleProjectionError";
    this.code = code;
  }
}

/**
 * The live result for one exact Access declaration, produced by the caller through the same
 * `runOrganizationAccessOperation` path page capability uses, inside the given request transaction
 * and selected scope. It names only whether the viewer holds the declared authority and the
 * correlation the decision belongs to.
 */
export type ApplicationToolAccessEvaluator = (
  transaction: RequestDatabaseTransaction,
  scope: SelectedOrganizationScope,
  declaration: OrganizationAccessDeclaration,
) => Promise<Readonly<{ allowed: boolean; correlationId: string }>>;

/**
 * The exact Access declarations that govern one tool's two gates for the fixed release. Every
 * declaration targets the fixed application.
 *
 * `discover` holds the tool's navigation entry and page access for `application_navigation` (every
 * declaration must hold) or the access of each page that hosts the operation for `page_access` (any
 * one suffices); a tool no page hosts has none and is never discoverable.
 *
 * `use` is empty when the tool's meaning is `none`. `operation_permission` names the owning
 * operation's own permission, so it is never empty. `delegated_operations` names the permission of
 * every protected operation the Frontend Flow reaches; every one must hold, and a flow that reaches
 * no protected operation is governed by discovery alone, as a page placement that binds no
 * operation is.
 */
export type FixedApplicationToolAccessBinding = Readonly<{
  discover: readonly OrganizationAccessDeclaration[];
  use: readonly OrganizationAccessDeclaration[];
}>;

/**
 * The one trusted, viewer-independent source for a projection: the exact organisation, Application
 * root and active installed release revision, that release's compiled bundle, and the exact Access
 * declaration per tool and gate, with one binding for every bundle tool and no other. The source is
 * assembled from the protected installed-release read and the release's prepared permission
 * registration, never from client JSON.
 */
export type FixedAuthenticatedApplicationToolBundle = Readonly<{
  organizationId: string;
  applicationRootId: string;
  applicationReleaseRevision: number;
  bundle: ApplicationToolBundle;
  tools: Readonly<Record<string, FixedApplicationToolAccessBinding>>;
  sourceCorrelationId: string;
}>;

export interface FixedAuthenticatedApplicationToolBundleAdapter<Command> {
  load(
    transaction: RequestDatabaseTransaction,
    scope: SelectedOrganizationScope,
    command: Command,
  ): Promise<FixedAuthenticatedApplicationToolBundle>;
}

export type ApplicationToolBundleProjectionDependencies<Command> = Readonly<{
  /** The caller's live Access path, composed from `runOrganizationAccessOperation`. */
  evaluate: ApplicationToolAccessEvaluator;
  adapter: FixedAuthenticatedApplicationToolBundleAdapter<Command>;
}>;

/** One tool's live gate outcome, from trusted evidence only. */
export type ApplicationToolCapabilityState = Readonly<{
  discoverAllowed: boolean;
  useAllowed: boolean;
}>;

/** The per-tool live gate outcomes for one viewer, keyed by the tool's stable name. */
export type ApplicationToolCapability = Readonly<Record<string, ApplicationToolCapabilityState>>;

/**
 * A tool the viewer may see. `available` tools are callable; `unavailable` tools are described but
 * never callable, and carry no permission key, role name or private value. A refused tool is absent
 * from the bundle entirely.
 */
export type ProjectedApplicationTool =
  | Readonly<{
      name: string;
      description?: string;
      inputSchema: ApplicationToolInputSchema;
      availability: "available";
    }>
  | Readonly<{
      name: string;
      description?: string;
      inputSchema: ApplicationToolInputSchema;
      availability: "unavailable";
      unavailableReason: "use_permission";
    }>;

/** The viewer-filtered bundle, in the release's canonical tool order. */
export type ProjectedApplicationToolBundle = Readonly<{
  contractVersion: "1.0.0";
  applicationKey: string;
  tools: readonly ProjectedApplicationTool[];
}>;

/**
 * The projected bundle together with the exact application release and organisation Access
 * version it was decided under, so a consumer can refuse a stale or cached projection.
 */
export type ApplicationToolBundleProjection = ProjectedApplicationToolBundle &
  Readonly<{
    applicationRootId: ApplicationRootId;
    applicationReleaseRevision: number;
    accessVersion: number;
  }>;

const descriptionOf = (tool: ApplicationTool): { description?: string } =>
  tool.description === undefined ? {} : { description: tool.description };

/**
 * Filters one compiled bundle to the viewer's live gates, preserving bundle order. A missing gate
 * is treated exactly like a refusal, so the pure projection fails closed when it is handed
 * incomplete evidence: an undiscoverable tool is dropped, and a discoverable but unusable tool is
 * fixed to the opaque unavailable state.
 */
export const projectApplicationToolBundle = (
  bundle: ApplicationToolBundle,
  capability: ApplicationToolCapability,
): ProjectedApplicationToolBundle => ({
  contractVersion: "1.0.0",
  applicationKey: bundle.applicationKey,
  tools: bundle.tools.flatMap((tool): readonly ProjectedApplicationTool[] => {
    const state = Object.hasOwn(capability, tool.name) ? capability[tool.name] : undefined;
    if (state === undefined || state.discoverAllowed !== true) return [];
    if (state.useAllowed !== true)
      return [
        {
          name: tool.name,
          ...descriptionOf(tool),
          inputSchema: tool.inputSchema,
          availability: "unavailable",
          unavailableReason: "use_permission",
        },
      ];
    return [
      {
        name: tool.name,
        ...descriptionOf(tool),
        inputSchema: tool.inputSchema,
        availability: "available",
      },
    ];
  }),
});

const sameUuid = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

const exactReleaseRevisionSchema = revisionSchema.max(Number.MAX_SAFE_INTEGER);

type GateContext = Readonly<{
  evaluate: ApplicationToolAccessEvaluator;
  transaction: RequestDatabaseTransaction;
  scope: SelectedOrganizationScope;
  applicationRootId: ApplicationRootId;
  correlations: Set<string>;
}>;

/**
 * Evaluates one gate's declarations through the injected live Access path, in the one request
 * transaction and scope. Every declaration must target the fixed application and every decision
 * must belong to the source's one request, so a bundle can never be filtered against another
 * installation's authority. An empty gate is refused.
 */
const evaluateGate = async (
  gate: GateContext,
  declarations: readonly OrganizationAccessDeclaration[],
  requireAll: boolean,
): Promise<boolean> => {
  let allAllowed = declarations.length > 0;
  let anyAllowed = false;
  for (const candidate of declarations) {
    const parsed = organizationAccessDeclarationSchema.safeParse(candidate);
    if (!parsed.success)
      throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_EVIDENCE_UNAVAILABLE");
    const declaration = parsed.data;
    if (
      declaration.target.kind !== "application" ||
      !sameUuid(declaration.target.applicationRootId, gate.applicationRootId)
    )
      throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_SCOPE_UNAVAILABLE");
    const evaluated = await gate.evaluate(gate.transaction, gate.scope, declaration);
    const correlation = correlationIdSchema.safeParse(evaluated.correlationId);
    if (!correlation.success || typeof evaluated.allowed !== "boolean")
      throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_EVIDENCE_UNAVAILABLE");
    gate.correlations.add(correlation.data.toLowerCase());
    if (evaluated.allowed) anyAllowed = true;
    else allAllowed = false;
  }
  return requireAll ? allAllowed : anyAllowed;
};

/**
 * Projects the active installed release's tool bundle for one viewer. `project` runs inside the
 * caller's human organisation request: the scope must select exactly one application, and the
 * fixed source must name that same organisation and application root. Each gate is evaluated
 * through the live Access path; any missing, inconsistent or cross-installation evidence refuses
 * the whole projection rather than silently dropping or exposing a tool. Adapter and Access faults
 * propagate unchanged so the request keeps its refused and temporarily-unavailable outcomes.
 */
export const createApplicationToolBundleProjectionService = <Command>(
  dependencies: ApplicationToolBundleProjectionDependencies<Command>,
) =>
  Object.freeze({
    async project(
      transaction: RequestDatabaseTransaction,
      scopeCandidate: SelectedOrganizationScope,
      command: Command,
    ): Promise<ApplicationToolBundleProjection> {
      const verifiedScope = selectedOrganizationScopeSchema.safeParse(scopeCandidate);
      if (!verifiedScope.success || verifiedScope.data.applicationRootId === undefined)
        throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_SCOPE_UNAVAILABLE");
      const scope = verifiedScope.data;
      const scopeApplicationRootId = verifiedScope.data.applicationRootId;

      const fixed = await dependencies.adapter.load(transaction, scope, command);
      if (typeof fixed !== "object" || fixed === null)
        throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_SOURCE_INVALID");
      const organization = organizationIdSchema.safeParse(fixed.organizationId);
      const applicationRoot = applicationRootIdSchema.safeParse(fixed.applicationRootId);
      const releaseRevision = exactReleaseRevisionSchema.safeParse(fixed.applicationReleaseRevision);
      const source = correlationIdSchema.safeParse(fixed.sourceCorrelationId);
      const bundle = applicationToolBundleSchema.safeParse(fixed.bundle);
      if (
        !organization.success ||
        !applicationRoot.success ||
        !releaseRevision.success ||
        !source.success ||
        !bundle.success ||
        typeof fixed.tools !== "object" ||
        fixed.tools === null
      )
        throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_SOURCE_INVALID");
      if (
        !sameUuid(organization.data, scope.organizationId) ||
        !sameUuid(applicationRoot.data, scopeApplicationRootId)
      )
        throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_SCOPE_UNAVAILABLE");
      const applicationRootId = applicationRoot.data;
      // Exactly one binding per bundle tool: a missing binding or one for a tool this release does
      // not declare means the source was assembled from different evidence.
      if (Object.keys(fixed.tools).length !== bundle.data.tools.length)
        throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_BINDING_UNAVAILABLE");

      const gate: GateContext = {
        evaluate: dependencies.evaluate,
        transaction,
        scope,
        applicationRootId,
        correlations: new Set([source.data.toLowerCase()]),
      };
      const capability: Record<string, ApplicationToolCapabilityState> = {};

      for (const tool of bundle.data.tools) {
        const binding = Object.hasOwn(fixed.tools, tool.name) ? fixed.tools[tool.name] : undefined;
        if (
          binding === undefined ||
          !Array.isArray(binding.discover) ||
          !Array.isArray(binding.use) ||
          (tool.permission.use === "none" && binding.use.length > 0) ||
          (tool.permission.use === "operation_permission" && binding.use.length === 0)
        )
          throw new ApplicationToolBundleProjectionError(
            "APPLICATION_TOOL_BUNDLE_BINDING_UNAVAILABLE",
          );
        if (
          (tool.operation.kind === "action" || tool.operation.kind === "query") &&
          tool.operation.owner.kind === "application" &&
          !sameUuid(tool.operation.owner.applicationRootId, applicationRootId)
        )
          throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_SCOPE_UNAVAILABLE");

        const discoverAllowed = await evaluateGate(
          gate,
          binding.discover,
          tool.permission.discover === "application_navigation",
        );
        const useAllowed =
          binding.use.length === 0
            ? tool.permission.use !== "operation_permission"
            : await evaluateGate(gate, binding.use, true);
        capability[tool.name] = { discoverAllowed, useAllowed };
      }

      if (gate.correlations.size !== 1)
        throw new ApplicationToolBundleProjectionError(
          "APPLICATION_TOOL_BUNDLE_EVIDENCE_UNAVAILABLE",
        );
      return {
        ...projectApplicationToolBundle(bundle.data, capability),
        applicationRootId,
        applicationReleaseRevision: releaseRevision.data,
        accessVersion: scope.accessVersion,
      };
    },
  });
