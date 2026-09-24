import "server-only";

import {
  applicationRootIdSchema,
  applicationToolBundleSchema,
  correlationIdSchema,
  organizationAccessDeclarationSchema,
  type ApplicationRootId,
  type ApplicationTool,
  type ApplicationToolBundle,
  type ApplicationToolInputSchema,
  type OrganizationAccessDeclaration,
} from "@vortex/contracts";

/**
 * The application tool bundle of one exact installed release, filtered for one viewer.
 *
 * This is the runtime reader for the bundle compiled into an Application release (#865). It
 * follows the same rules as page capability projection: a tool the viewer may not discover is
 * removed, a tool the viewer may discover but not use is described as unavailable and is never
 * callable, and missing, refused or unprovable evidence fails the whole projection closed rather
 * than exposing a tool. It reads only the one exact application release and organisation its
 * fixed source names, never another installation.
 *
 * The Definition tier owns the projection and the fixed-source contract. It cannot import the
 * Access service (Access depends on Definition), so the live Access decision path is supplied as
 * an injected `ApplicationToolAccessEvaluator`; the caller composes it from
 * `runOrganizationAccessOperation` exactly as page capability does. The trusted source supplies
 * the bundle and the exact Access declaration for each gate; it never carries a permission key,
 * role name or private value into the projected result.
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
 * `runOrganizationAccessOperation` path page capability uses. It names only whether the viewer
 * holds the declared authority and the correlation the decision belongs to.
 */
export type ApplicationToolAccessEvaluator = (
  declaration: OrganizationAccessDeclaration,
) => Promise<Readonly<{ allowed: boolean; correlationId: string }>>;

/**
 * The exact Access declarations that govern one tool's two gates for the fixed release. `discover`
 * is never empty for a compiled tool: `application_navigation` needs the navigation entry and page
 * access (every declaration must hold), while `page_access` needs at least one hosting page (any
 * declaration suffices). `use` is empty only when the tool's own meaning is `none`; otherwise every
 * declaration must hold, and an absent one fails closed.
 */
export type FixedApplicationToolAccessBinding = Readonly<{
  discover: readonly OrganizationAccessDeclaration[];
  use: readonly OrganizationAccessDeclaration[];
}>;

/**
 * The one trusted, viewer-independent source for a projection: the exact Application root, the
 * bundle of its active installed release, and the exact Access declaration per tool and gate.
 * Every declaration must target the fixed application root. The source is assembled from the
 * protected installed-release read and the release's prepared permission registration, never from
 * client JSON.
 */
export type FixedAuthenticatedApplicationToolBundle = Readonly<{
  applicationRootId: ApplicationRootId;
  bundle: ApplicationToolBundle;
  tools: Readonly<Record<string, FixedApplicationToolAccessBinding>>;
  sourceCorrelationId: string;
}>;

export interface FixedAuthenticatedApplicationToolBundleAdapter<Command> {
  load(command: Command): Promise<FixedAuthenticatedApplicationToolBundle>;
}

export type ApplicationToolBundleProjectionDependencies<Command> = Readonly<{
  /** The caller's live Access path, bound to the human request transaction and selected scope. */
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

/** Every tool name the release declares, for one Access evaluation per tool. */
export const collectApplicationToolNames = (bundle: ApplicationToolBundle): readonly string[] =>
  bundle.tools.map((tool) => tool.name);

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

const sameApplicationRoot = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/**
 * Evaluates one gate's declarations through the injected live Access path. Every decision must
 * belong to the fixed source's one request, and every declaration must target the fixed
 * application, so a bundle can never be filtered against another organisation's installation.
 */
const evaluateGate = async (
  evaluate: ApplicationToolAccessEvaluator,
  applicationRootId: ApplicationRootId,
  declarations: readonly OrganizationAccessDeclaration[],
  requireAll: boolean,
  correlations: Set<string>,
): Promise<boolean> => {
  let allAllowed = declarations.length > 0;
  let anyAllowed = false;
  for (const candidate of declarations) {
    const parsed = organizationAccessDeclarationSchema.safeParse(candidate);
    if (!parsed.success)
      throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_EVIDENCE_UNAVAILABLE");
    const declaration = parsed.data;
    if (
      declaration.target.kind === "application" &&
      !sameApplicationRoot(declaration.target.applicationRootId, applicationRootId)
    )
      throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_SCOPE_UNAVAILABLE");
    const evaluated = await evaluate(declaration);
    const correlation = correlationIdSchema.safeParse(evaluated.correlationId);
    if (!correlation.success)
      throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_EVIDENCE_UNAVAILABLE");
    correlations.add(correlation.data.toLowerCase());
    if (evaluated.allowed) anyAllowed = true;
    else allAllowed = false;
  }
  return requireAll ? allAllowed : anyAllowed;
};

/**
 * Projects the active installed release's tool bundle for one viewer. The fixed source names the
 * exact organisation, application root and release, reads the bundle from the release's compilation
 * output, and supplies the exact Access declaration per gate; this service evaluates each through
 * the live Access path, fails the projection closed on any missing or cross-installation evidence,
 * and then filters the bundle. A missing binding for any declared tool refuses the whole
 * projection rather than silently dropping or exposing it.
 */
export const createApplicationToolBundleProjectionService = <Command>(
  dependencies: ApplicationToolBundleProjectionDependencies<Command>,
) =>
  Object.freeze({
    async project(command: Command): Promise<ProjectedApplicationToolBundle> {
      let fixed: FixedAuthenticatedApplicationToolBundle;
      try {
        fixed = await dependencies.adapter.load(command);
      } catch {
        throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_SOURCE_INVALID");
      }
      const applicationRoot = applicationRootIdSchema.safeParse(fixed.applicationRootId);
      const source = correlationIdSchema.safeParse(fixed.sourceCorrelationId);
      const bundle = applicationToolBundleSchema.safeParse(fixed.bundle);
      if (!applicationRoot.success || !source.success || !bundle.success)
        throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_SOURCE_INVALID");
      const applicationRootId = applicationRoot.data;
      const correlations = new Set([source.data.toLowerCase()]);
      const capability: Record<string, ApplicationToolCapabilityState> = {};

      for (const tool of bundle.data.tools) {
        const binding = Object.hasOwn(fixed.tools, tool.name) ? fixed.tools[tool.name] : undefined;
        if (binding === undefined)
          throw new ApplicationToolBundleProjectionError(
            "APPLICATION_TOOL_BUNDLE_BINDING_UNAVAILABLE",
          );
        if (
          (tool.operation.kind === "action" || tool.operation.kind === "query") &&
          tool.operation.owner.kind === "application" &&
          !sameApplicationRoot(tool.operation.owner.applicationRootId, applicationRootId)
        )
          throw new ApplicationToolBundleProjectionError("APPLICATION_TOOL_BUNDLE_SCOPE_UNAVAILABLE");

        const discoverAllowed = await evaluateGate(
          dependencies.evaluate,
          applicationRootId,
          binding.discover,
          tool.permission.discover === "application_navigation",
          correlations,
        );
        const useAllowed =
          tool.permission.use === "none"
            ? true
            : await evaluateGate(
                dependencies.evaluate,
                applicationRootId,
                binding.use,
                true,
                correlations,
              );
        capability[tool.name] = { discoverAllowed, useAllowed };
      }

      if (correlations.size !== 1)
        throw new ApplicationToolBundleProjectionError(
          "APPLICATION_TOOL_BUNDLE_EVIDENCE_UNAVAILABLE",
        );
      return projectApplicationToolBundle(bundle.data, capability);
    },
  });
