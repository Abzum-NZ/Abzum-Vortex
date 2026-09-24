import "server-only";

/**
 * #1152: the one Kestra instance the Workflow service may target.
 *
 * Customer durable flows run on a separate application Kestra instance. Kestra's
 * open-source edition lets any namespace read any instance secret, so that
 * instance's environment holds exactly one flow secret, the callback signing
 * key, and never an operational delivery, database or provider secret. The
 * operations instance that runs Vortex's own delivery flows is a different
 * deployment.
 *
 * Registration and start adapters resolve their provider target here. This
 * module has no operations-instance kind and exposes no operations address,
 * credential or secret, so an adapter cannot name or fall back to the
 * operations instance. It performs no I/O and calls, runs and deploys nothing.
 */

/** The Kestra instance kinds this service understands. Operations is not one. */
export const kestraInstanceKinds = ["application"] as const;

export type KestraInstanceKind = (typeof kestraInstanceKinds)[number];

/**
 * The only provider kind the Workflow service may reach. There is intentionally
 * no "operations" kind: an adapter that cannot express the operations instance
 * cannot reach it.
 */
export const workflowServiceKestraInstanceKind: KestraInstanceKind = "application";

/**
 * The single flow secret the application instance environment holds. A compiled
 * Kestra flow reads it by this name to sign the protected-operation envelope
 * Vortex verifies. Kestra exposes it because the instance variable is named
 * `SECRET_<this>`, but no value is committed or invented here.
 */
export const applicationKestraCallbackKeySecretName = "VORTEX_WORKFLOW_CALLBACK_KEY" as const;

/** The environment variable that carries the application instance's address. */
export const applicationKestraBaseUrlEnvironmentKey = "VORTEX_APPLICATION_KESTRA_URL" as const;

/**
 * One resolved application-instance provider target. `baseUrl` is the
 * application instance's own address and `callbackKeySecretName` is the fixed
 * secret a compiled flow reads. There is no field for an operations address or
 * credential, so a target can describe only the application instance.
 */
export type ApplicationKestraInstanceTarget = Readonly<{
  kind: "application";
  baseUrl: string;
  callbackKeySecretName: typeof applicationKestraCallbackKeySecretName;
}>;

export const kestraInstanceTargetErrorCodes = [
  "INVALID_KESTRA_INSTANCE_TARGET",
  "UNSUPPORTED_KESTRA_INSTANCE_KIND",
] as const;

export type KestraInstanceTargetErrorCode = (typeof kestraInstanceTargetErrorCodes)[number];

export class KestraInstanceTargetError extends Error {
  readonly code: KestraInstanceTargetErrorCode;

  constructor(code: KestraInstanceTargetErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "KestraInstanceTargetError";
    this.code = code;
  }
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean => Object.keys(value).every((key) => allowed.includes(key));

/**
 * Accepts only a credential-free http(s) origin. Plain http is allowed only for
 * a loopback address, matching the runtime's local-development boundary; a
 * leading path, query, fragment or embedded credential is refused so the target
 * can never smuggle a second address or secret.
 */
const parseBaseUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return undefined;
  return url.origin;
};

/**
 * Parses one candidate provider target and returns the application instance it
 * addresses. Only the application kind and only the two target fields are
 * accepted, so an operations target, an unknown kind or a carried operations
 * setting is refused rather than silently narrowed.
 */
export const parseApplicationKestraInstanceTarget = (
  candidate: unknown,
): ApplicationKestraInstanceTarget => {
  if (!isObject(candidate) || !hasOnlyKeys(candidate, ["kind", "baseUrl"]))
    throw new KestraInstanceTargetError("INVALID_KESTRA_INSTANCE_TARGET");
  if (candidate.kind !== workflowServiceKestraInstanceKind)
    throw new KestraInstanceTargetError("UNSUPPORTED_KESTRA_INSTANCE_KIND");

  const baseUrl = parseBaseUrl(candidate.baseUrl);
  if (baseUrl === undefined) throw new KestraInstanceTargetError("INVALID_KESTRA_INSTANCE_TARGET");

  return Object.freeze({
    kind: "application" as const,
    baseUrl,
    callbackKeySecretName: applicationKestraCallbackKeySecretName,
  });
};
