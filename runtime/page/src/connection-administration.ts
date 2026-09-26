import "server-only";

import {
  activityIdSchema,
  applicationRootIdSchema,
  archiveDestinationReferenceSchema,
  connectionInstanceIdSchema,
  connectionInstanceStatusSchema,
  connectionTypeIdSchema,
  connectionTypeSchema,
  semanticVersionSchema,
  timestampSchema,
  type ConnectionType,
} from "@vortex/contracts";
import {
  assertDestinationFingerprint,
  assertSafeIntegerRevision,
  type ConnectionAdministrationCommand,
  type ConnectionAdministrationRefusalCode,
  type ConnectionAdministrationResult,
  type ConnectionHealthOutcome,
  type ConnectionState,
} from "@vortex/connection";

/**
 * The generic connection administration page, composed over the #692 administration commands and
 * their results and over nothing else.
 *
 * One page flow administers every registered connection type. A connection type contributes exactly
 * two things from its own declared schema - its resolved version, and the secret field keys its
 * authentication declares - and nothing more: it adds no step, no field of its own invention, no
 * provider call and no second path. The flow's only outputs are #692 commands; the only view it
 * produces is the instance and status view below, which carries no secret, no secret reference, no
 * organisation identity and no activity identity, and a recovery state that names a fixed reason
 * code rather than a message.
 *
 * Nothing here is authority. This module validates shape only; the organisation, the
 * `platform.organization.connections.manage` authority, the expected revision and every application
 * grant are re-checked by the #692 SQL writers on every call. It never reads a table, never composes
 * a credential and never calls a provider adapter: a secret travels on a write command to the
 * server-only secret store and appears in no value this module returns.
 */

/** The one Vortex value-type catalogue a connection administration field may declare. */
export type ConnectionAdministrationValueType =
  ConnectionType["shapes"][number]["fields"][number]["type"];

/** A step of the one page flow is exactly one #692 command; no step invents a command name. */
export type ConnectionAdministrationStepKey = ConnectionAdministrationCommand["command"];

/** The only grant direction the #692 application-grant command declares. */
export type ConnectionAdministrationApplicationChange = Extract<
  ConnectionAdministrationCommand,
  { readonly command: "application_grant" }
>["change"];

/**
 * The health results a #692 health check records. `unknown` is a status this platform infers from a
 * connection that has never reported, not a result a check records, so the two vocabularies stay
 * separate and the recorded domain is taken from the command itself.
 */
export type ConnectionAdministrationHealthCheckOutcome = Extract<
  ConnectionAdministrationCommand,
  { readonly command: "health_check" }
>["healthOutcome"];

/**
 * Every input key the one page flow may read. These are the #692 command's own property names, in
 * camelCase like every other typed command in the platform. The list is closed, so a step and a
 * command input can only ever be one of these names and a caller cannot smuggle an extra property
 * past a step into a #692 command.
 *
 * A form field is addressed by a definition key rather than by one of these; `input` on a declared
 * field is what ties the two vocabularies together.
 */
export const connectionAdministrationInputKeys = Object.freeze([
  "administratorActivityId",
  "applicationRootId",
  "change",
  "connectionInstanceId",
  "connectionTypeId",
  "connectionTypeVersion",
  "destinationFingerprint",
  "destinationKey",
  "expectedRevision",
  "healthOutcome",
  "secret",
  "tokenExpiresAt",
] as const);
export type ConnectionAdministrationInputKey = (typeof connectionAdministrationInputKeys)[number];

/**
 * One step of the one administration page flow: the #692 command it submits, the inputs that command
 * requires, and the inputs it accepts as optional. A step may not name a command the #692 contract
 * lacks or a key that command does not declare; the check below proves both at compile time.
 */
export type ConnectionAdministrationPageFlowStep = Readonly<{
  command: ConnectionAdministrationStepKey;
  requiredInputKeys: readonly ConnectionAdministrationInputKey[];
  optionalInputKeys: readonly ConnectionAdministrationInputKey[];
}>;

/**
 * The one administration page flow, in the order a person reads it. `configure` is the only step that
 * takes no expected revision, because the #692 writer it calls registers the instance; every
 * revision-checking step takes the revision the status view read, so two people cannot overwrite one
 * another from a stale page. The declared secret field keys of a connection type are not listed here:
 * they are collected into the credential the write commands carry, and the type's own declared
 * schema decides which they are.
 */
export const connectionAdministrationPageFlow = Object.freeze([
  Object.freeze({
    command: "configure",
    requiredInputKeys: Object.freeze([
      "connectionTypeId",
      "connectionTypeVersion",
      "destinationKey",
      "destinationFingerprint",
      "secret",
    ] as const),
    optionalInputKeys: Object.freeze(["tokenExpiresAt"] as const),
  }),
  Object.freeze({
    command: "rotate_credential",
    requiredInputKeys: Object.freeze(["expectedRevision", "secret"] as const),
    optionalInputKeys: Object.freeze(["destinationFingerprint", "tokenExpiresAt"] as const),
  }),
  Object.freeze({
    command: "health_check",
    requiredInputKeys: Object.freeze(["expectedRevision", "healthOutcome"] as const),
    optionalInputKeys: Object.freeze([] as const),
  }),
  Object.freeze({
    command: "application_grant",
    requiredInputKeys: Object.freeze(["applicationRootId", "change"] as const),
    optionalInputKeys: Object.freeze([] as const),
  }),
  Object.freeze({
    command: "disable",
    requiredInputKeys: Object.freeze(["expectedRevision"] as const),
    optionalInputKeys: Object.freeze([] as const),
  }),
] as const);

/** The exact keys one #692 command declares, so no step can require or accept an undeclared one. */
type CommandKeysOf<Command extends ConnectionAdministrationStepKey> = keyof Extract<
  ConnectionAdministrationCommand,
  { readonly command: Command }
>;

/** Every key any #692 command declares, so no page input can name a property no command has. */
type AllCommandInputKeys = ConnectionAdministrationCommand extends infer Command
  ? Command extends unknown
    ? keyof Command
    : never
  : never;

type StepCommandOf<Step> = Step extends { readonly command: infer Command }
  ? Command extends ConnectionAdministrationStepKey
    ? Command
    : never
  : never;

type StepRequiredInputsOf<Step> = Step extends {
  readonly requiredInputKeys: infer Keys extends readonly ConnectionAdministrationInputKey[];
}
  ? Keys[number]
  : never;

type StepOptionalInputsOf<Step> = Step extends {
  readonly optionalInputKeys: infer Keys extends readonly ConnectionAdministrationInputKey[];
}
  ? Keys[number]
  : never;

/**
 * Fails to compile when a flow step requires or accepts an input the #692 command it submits does not
 * declare. The conditional is distributive, so every step of the flow is checked on its own.
 */
type AssertStepDeclaresOnlyCommandInputs<Step> = Exclude<
  StepRequiredInputsOf<Step> | StepOptionalInputsOf<Step>,
  CommandKeysOf<StepCommandOf<Step>>
> extends never
  ? Step
  : never;

/** Fails to compile when a declared page input is not a property some #692 command declares. */
type AssertInputIsACommandProperty<Input extends Readonly<{ input: string }>> = Exclude<
  Input["input"],
  AllCommandInputKeys
> extends never
  ? Input
  : never;

/** Whether a type collapsed to `never`, so an assertion can fail the build instead of vanishing. */
type IsNever<Value> = [Value] extends [never] ? true : false;

/**
 * `false` only when every step of the flow declared only inputs its own #692 command declares. A
 * single failing step makes the whole tuple's element union include `true`, so assigning `false`
 * fails. Checking the tuple rather than a union of steps matters: `Step | never` collapses back to
 * `Step`, so a union of step types would hide one broken step.
 */
type FlowIsExact<Steps extends readonly unknown[]> = {
  [Index in keyof Steps]: IsNever<AssertStepDeclaresOnlyCommandInputs<Steps[Index]>>;
}[number];

/** Shorthand for the flow's own step tuple, so the assertion below names no type twice. */
type PageFlowSteps = typeof connectionAdministrationPageFlow;

/**
 * Proves every step of the one flow declares only inputs its own #692 command declares, so a step
 * can never be collected for a property the service would refuse. This is a value, not only a type,
 * so a broken flow fails the build rather than passing silently.
 */
export const connectionAdministrationPageFlowIsExact: FlowIsExact<PageFlowSteps> = false;

/**
 * Proves every input key the one page flow declares is a property some #692 command declares, so the
 * closed input list cannot drift away from the commands it exists to feed.
 */
export const connectionAdministrationInputKeysAreCommandProperties: IsNever<
  AssertInputIsACommandProperty<{ readonly input: ConnectionAdministrationInputKey }>
> = false;

/** The step that submits a command, or undefined when the one flow does not submit that command. */
const stepForCommand = (
  command: ConnectionAdministrationStepKey,
): ConnectionAdministrationPageFlowStep | undefined =>
  connectionAdministrationPageFlow.find((step) => step.command === command);

/** The credential command input, shared by the two write commands that carry one. */
const CREDENTIAL_INPUT_KEY = "secret";

/**
 * A single declared input of the administration form.
 *
 * `key` is the definition key an author places a control under, so it is a builder key in the
 * platform's lowercase word form. `input` is the #692 command input that control feeds, which is the
 * platform's own camelCase property name. The two vocabularies stay separate on purpose: a definition
 * key is what a person reads and what a page places, and a command input is what the service accepts.
 *
 * `valueType` is drawn from the one shared value-type catalogue, so a connection type that declares
 * a non-text value for a field is presented with the control that value already has rather than with
 * a control invented for connections.
 *
 * `writeOnly` marks the credential and every secret field the connection type declares: a write-only
 * field is collected, sent once and has no value to read back, so it can never appear in a view, a
 * draft, an export or an activity entry. Several write-only fields may feed the one `secret` input,
 * because the declared secret fields of a connection type are collected together into the single
 * credential the write commands carry.
 */
export type ConnectionAdministrationFormField = Readonly<{
  key: string;
  input: ConnectionAdministrationInputKey;
  valueType: ConnectionAdministrationValueType;
  required: boolean;
  writeOnly: boolean;
}>;

/**
 * The one definition-led settings form, built from a connection type's own declared schema. The
 * fixed fields are the inputs the #692 `configure` command declares; the write-only fields are
 * exactly the secret field keys `authentication.secretFieldKeys` declares, in declared order. The
 * form declares no flow of its own: the flow is the same one for every connection type, and the form
 * holds no value, and therefore no secret.
 */
export type ConnectionAdministrationFormDefinition = Readonly<{
  connectionTypeId: string;
  connectionTypeVersion: string;
  fields: readonly ConnectionAdministrationFormField[];
}>;

/** The definition keys the one form always collects, whatever the connection type declares. */
const connectionTypeVersionField: ConnectionAdministrationFormField = Object.freeze({
  key: "connection_type_version",
  input: "connectionTypeVersion",
  valueType: "text",
  required: true,
  writeOnly: false,
});
const destinationKeyField: ConnectionAdministrationFormField = Object.freeze({
  key: "destination_key",
  input: "destinationKey",
  valueType: "text",
  required: true,
  writeOnly: false,
});
const destinationFingerprintField: ConnectionAdministrationFormField = Object.freeze({
  key: "destination_fingerprint",
  input: "destinationFingerprint",
  valueType: "text",
  required: true,
  writeOnly: false,
});
const tokenExpiresAtField: ConnectionAdministrationFormField = Object.freeze({
  key: "token_expires_at",
  input: "tokenExpiresAt",
  valueType: "date_time",
  required: false,
  writeOnly: false,
});
const credentialField: ConnectionAdministrationFormField = Object.freeze({
  key: CREDENTIAL_INPUT_KEY,
  input: "secret",
  valueType: "text",
  required: true,
  writeOnly: true,
});

/** The definition keys the platform owns, which a connection type's declared keys may not shadow. */
const platformFormDefinitionKeys: ReadonlySet<string> = new Set([
  connectionTypeVersionField.key,
  destinationKeyField.key,
  destinationFingerprintField.key,
  tokenExpiresAtField.key,
  credentialField.key,
]);

/** The largest number of declared secret field keys one form may present. */
const MAXIMUM_DECLARED_SECRET_FIELDS = 32;

/** The largest scope list one status view may present, so one cell cannot become unbounded. */
const MAXIMUM_SCOPE_ENTRIES = 100;

/**
 * The declared secret field keys of a connection type, or undefined when no form can present them:
 * a repeated key, a key that shadows one the platform owns, or a count beyond the form bound. The
 * connection type contract bounds none of these, and a form that silently dropped or merged a
 * declared secret field would administer a different connection than the one published.
 */
const declaredSecretFieldKeys = (connectionType: ConnectionType): readonly string[] | undefined => {
  const declared = connectionType.authentication.secretFieldKeys;
  if (declared.length > MAXIMUM_DECLARED_SECRET_FIELDS) return undefined;
  const unique = new Set<string>();
  for (const key of declared) {
    if (unique.has(key) || platformFormDefinitionKeys.has(key)) return undefined;
    unique.add(key);
  }
  return declared;
};

/** The one definition-led settings form for an already-validated connection type. */
const buildAdministrationForm = (
  type: ConnectionType,
): ConnectionAdministrationFormDefinition | undefined => {
  const secretFieldKeys = declaredSecretFieldKeys(type);
  if (secretFieldKeys === undefined) return undefined;
  const fields: ConnectionAdministrationFormField[] = [
    connectionTypeVersionField,
    destinationKeyField,
    destinationFingerprintField,
    tokenExpiresAtField,
  ];
  // Every declared secret field feeds the one credential the write commands carry, so the declared
  // fields keep the type's own order and the combined credential is the form's last field.
  for (const key of secretFieldKeys) fields.push(Object.freeze({ ...credentialField, key }));
  fields.push(credentialField);
  return Object.freeze({
    connectionTypeId: type.connectionTypeId,
    connectionTypeVersion: type.version,
    fields: Object.freeze(fields),
  });
};

/**
 * Builds the one settings form for a connection type. Returns undefined for a value that is not a
 * valid connection type, and for a type whose declared secret field keys repeat, shadow a key the
 * platform owns or exceed the form bound, so the caller refuses the whole page instead of offering a
 * form for a different connection than the one published. The result names field keys, value types
 * and requiredness only: it holds no value, and therefore no secret.
 */
export const projectConnectionAdministrationForm = (
  connectionType: unknown,
): ConnectionAdministrationFormDefinition | undefined => {
  const parsed = connectionTypeSchema.safeParse(connectionType);
  return parsed.success ? buildAdministrationForm(parsed.data) : undefined;
};

/**
 * The safe instance and status view of one connection instance. It carries the facts an
 * administrator acts on - state, health, credential expiry and the authority revision - plus the
 * type identity the page was built from and the two scope lists the administration commands check.
 *
 * It deliberately omits the instance's secret reference, its organisation identity and its
 * administrator activity identity: none is a value a page may render, and the organisation is always
 * the request context's own. No property of this view is a secret or a credential.
 */
export type ConnectionInstanceStatusView = Readonly<{
  connectionInstanceId: string;
  connectionTypeId: string;
  connectionTypeVersion: string;
  state: ConnectionState;
  healthOutcome: ConnectionHealthOutcome;
  /** The authority revision the revision-checking #692 commands must send unchanged. */
  revision: number;
  tokenExpiresAt?: string;
  authorizedApplicationIds: readonly string[];
  grantedScopes: readonly string[];
}>;

/**
 * Projects one connection instance page read model into the safe status view.
 *
 * The instance is the shared page read model the caller's own protected reader produces, not a table
 * row: this module reads no table, and `connectionInstanceStatusSchema` is re-parsed here so state,
 * health, expiry, the authority revision and both scope lists are its closed values and never a
 * stored string. That read model is deliberately separate from `connectionInstanceSchema`: it carries
 * no secret reference, no organisation identity and no activity identity, and it accepts an instance
 * with no authorised application and no granted scope, so a grant-less instance is shown as such. A
 * value that does not satisfy the read model returns undefined, so the caller refuses the page
 * neutrally instead of showing a view whose revision-checking commands would be refused anyway.
 */
export const projectConnectionInstanceStatus = (
  instance: unknown,
): ConnectionInstanceStatusView | undefined => {
  const parsed = connectionInstanceStatusSchema.safeParse(instance);
  if (!parsed.success) return undefined;
  const row = parsed.data;
  if (
    row.authorizedApplicationIds.length > MAXIMUM_SCOPE_ENTRIES ||
    row.grantedScopes.length > MAXIMUM_SCOPE_ENTRIES
  )
    return undefined;
  return Object.freeze({
    connectionInstanceId: row.connectionInstanceId,
    connectionTypeId: row.connectionTypeId,
    connectionTypeVersion: row.connectionTypeVersion,
    state: row.state,
    healthOutcome: row.lastHealthOutcome,
    revision: row.revision,
    ...(row.tokenExpiresAt === undefined ? {} : { tokenExpiresAt: row.tokenExpiresAt }),
    authorizedApplicationIds: Object.freeze([...row.authorizedApplicationIds]),
    grantedScopes: Object.freeze([...row.grantedScopes]),
  });
};

/** The closed set of recovery states a refused #692 command can leave the page in. */
export type ConnectionAdministrationRecoveryState =
  | "correct_the_form"
  | "authority_unavailable"
  | "reload_the_connection"
  | "retry_the_credential"
  | "retry_later";

/**
 * The recovery each #692 refusal reason code means on this page, decided once from the closed code set
 * so the browser never chooses a recovery of its own. `retryable` says whether submitting the same
 * step again can succeed while the person changes nothing.
 */
export const connectionAdministrationRecoveryStates = Object.freeze({
  invalid_parameters: Object.freeze({ state: "correct_the_form", retryable: false }),
  not_authorized: Object.freeze({ state: "authority_unavailable", retryable: false }),
  connection_unavailable: Object.freeze({ state: "reload_the_connection", retryable: true }),
  secret_store_unavailable: Object.freeze({ state: "retry_the_credential", retryable: true }),
  administration_unavailable: Object.freeze({ state: "retry_later", retryable: true }),
} as const satisfies Readonly<
  Record<
    ConnectionAdministrationRefusalCode,
    Readonly<{ state: ConnectionAdministrationRecoveryState; retryable: boolean }>
  >
>);

/** How one administration page reports the last command it submitted. */
export type ConnectionAdministrationRecoveryProjection =
  | Readonly<{ status: "not_attempted" }>
  | Readonly<{
      status: "applied";
      command: ConnectionAdministrationStepKey;
      /** The new authority revision; absent for a grant change, which advances no revision. */
      revision?: number;
    }>
  | Readonly<{
      status: "recovery";
      state: ConnectionAdministrationRecoveryState;
      reasonCode: ConnectionAdministrationRefusalCode;
      retryable: boolean;
    }>;

/** The data-free state of a page on which no command has been submitted yet. */
export const NO_COMMAND_ATTEMPTED: ConnectionAdministrationRecoveryProjection = Object.freeze({
  status: "not_attempted",
});

/**
 * Projects one #692 command result into the page's recovery state. The result's own message is
 * dropped: it is a fixed service string, and the recovery text belongs to the browser, so only the
 * closed reason code and the recovery it means cross this boundary. The applied branch keeps the
 * command and its new authority revision and nothing else.
 */
export const projectConnectionAdministrationRecovery = (
  result: ConnectionAdministrationResult,
): ConnectionAdministrationRecoveryProjection => {
  if (result.outcome === "applied")
    return Object.freeze({
      status: "applied" as const,
      command: result.command,
      ...(result.revision === undefined ? {} : { revision: result.revision }),
    });
  const recovery = connectionAdministrationRecoveryStates[result.reasonCode];
  return Object.freeze({
    status: "recovery" as const,
    state: recovery.state,
    reasonCode: result.reasonCode,
    retryable: recovery.retryable,
  });
};

/**
 * The safe identity of the connection type an administration page administers. Only the declared
 * fields a person reads are carried: the catalogue key, the resolved version, the name and the
 * provider.
 */
export type ConnectionAdministrationTypeView = Readonly<{
  connectionTypeId: string;
  key: string;
  version: string;
  name: string;
  provider: string;
}>;

/** The complete safe payload one connection administration page renders. */
export type ConnectionAdministrationPageView = Readonly<{
  kind: "ready";
  connectionType: ConnectionAdministrationTypeView;
  form: ConnectionAdministrationFormDefinition;
  status: ConnectionInstanceStatusView;
  recovery: ConnectionAdministrationRecoveryProjection;
}>;

/** What the caller's own connection instance reader returned, before this module projects it. */
export type ConnectionAdministrationPageSource =
  | Readonly<{
      kind: "available";
      /** The platform catalogue connection type this page administers. */
      connectionType: unknown;
      /** The connection instance page read model the protected reader produced. */
      instance: unknown;
    }>
  | Readonly<{ kind: "unavailable" }>;

/**
 * A page that cannot be projected is a neutral refusal, never an empty page, and a reader that could
 * not answer is a temporary state the person may retry. The two never look alike, and neither carries
 * a value, so neither can disclose whether a connection exists.
 */
export type ConnectionAdministrationPageResolution =
  | Readonly<{ kind: "available"; page: ConnectionAdministrationPageView }>
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "unavailable" }>;

const REFUSED_PAGE: ConnectionAdministrationPageResolution = Object.freeze({ kind: "refused" });
const UNAVAILABLE_PAGE: ConnectionAdministrationPageResolution = Object.freeze({
  kind: "unavailable",
});

/**
 * Composes the one administration page for a connection type and the instance it administers.
 *
 * A value that is not a valid connection type, an instance the page read model does not accept, and
 * an instance of a different connection type than the form was built from are all the same neutral
 * refusal, so a page never offers one type's declared schema over another type's instance and never
 * shows a view whose commands would be refused.
 *
 * The instance's pinned `connectionTypeVersion` is deliberately not required to equal the catalogue
 * type's current version: an instance registered against an older version is a supported state, and
 * the status view reports that pinned version precisely so an administrator can see which version
 * the instance will keep using.
 */
export const projectConnectionAdministrationPage = (
  source: ConnectionAdministrationPageSource,
): ConnectionAdministrationPageResolution => {
  if (source.kind === "unavailable") return UNAVAILABLE_PAGE;
  const parsed = connectionTypeSchema.safeParse(source.connectionType);
  if (!parsed.success) return REFUSED_PAGE;
  const form = buildAdministrationForm(parsed.data);
  const status = projectConnectionInstanceStatus(source.instance);
  if (form === undefined || status === undefined) return REFUSED_PAGE;
  if (status.connectionTypeId !== parsed.data.connectionTypeId) return REFUSED_PAGE;
  return Object.freeze({
    kind: "available" as const,
    page: Object.freeze({
      kind: "ready" as const,
      connectionType: Object.freeze({
        connectionTypeId: parsed.data.connectionTypeId,
        key: parsed.data.key,
        version: parsed.data.version,
        name: parsed.data.name,
        provider: parsed.data.provider,
      }),
      form,
      status,
      recovery: NO_COMMAND_ATTEMPTED,
    }),
  });
};

/**
 * The typed shape one administration step's inputs have. The builder below takes `unknown` and
 * validates it, so a value that reaches it from a request body, a draft or an agent is checked the
 * same way a TypeScript caller is; this type is the convenience a typed caller builds against.
 */
export type ConnectionAdministrationCommandInput = Readonly<{
  step: ConnectionAdministrationStepKey;
  connectionInstanceId: string;
  administratorActivityId: string;
  applicationRootId?: string;
  change?: ConnectionAdministrationApplicationChange;
  connectionTypeId?: string;
  connectionTypeVersion?: string;
  destinationFingerprint?: string;
  destinationKey?: string;
  expectedRevision?: number;
  healthOutcome?: ConnectionAdministrationHealthCheckOutcome;
  secret?: string;
  tokenExpiresAt?: string;
}>;

/**
 * What a submitted step produced. `incomplete` names the input keys still missing so a form can ask
 * for them; `refused` says the supplied values do not match the declared shape. Neither branch ever
 * carries a submitted value, so a missing or malformed credential is reported as a key and never as
 * what was typed.
 */
export type ConnectionAdministrationCommandReadiness =
  | Readonly<{ outcome: "ready"; command: ConnectionAdministrationCommand }>
  | Readonly<{
      outcome: "incomplete";
      command: ConnectionAdministrationStepKey;
      missingInputKeys: readonly ConnectionAdministrationInputKey[];
    }>
  | Readonly<{ outcome: "refused"; reasonCode: ConnectionAdministrationRefusalCode }>;

const INVALID_PARAMETERS: ConnectionAdministrationCommandReadiness = Object.freeze({
  outcome: "refused",
  reasonCode: "invalid_parameters",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A closed shape check: `valid` carries the parsed value and `invalid` carries no value at all. */
type Check<Value> = Readonly<{ valid: true; value: Value }> | Readonly<{ valid: false }>;
const invalid: Check<never> = Object.freeze({ valid: false });
const valid = <Value>(value: Value): Check<Value> => Object.freeze({ valid: true, value });

/**
 * An input a step accepts only when the caller has one. Absent covers the two ways a form says
 * "nothing here": no value at all, and an empty control a form submits as its unset value.
 */
type OptionalCheck<Value> =
  | Readonly<{ valid: true; value: Value | undefined }>
  | Readonly<{ valid: false }>;

const absent: OptionalCheck<never> = Object.freeze({ valid: true, value: undefined });

const isAbsent = (value: unknown): boolean => value === undefined || value === "";

const optionalTimestamp = (value: unknown): OptionalCheck<string> => {
  if (isAbsent(value)) return absent;
  const parsed = timestampSchema.safeParse(value);
  return parsed.success ? valid(parsed.data) : invalid;
};

const requiredDestinationFingerprint = (value: unknown): Check<string> => {
  if (typeof value !== "string") return invalid;
  try {
    return valid(assertDestinationFingerprint(value));
  } catch {
    return invalid;
  }
};

const optionalDestinationFingerprint = (value: unknown): OptionalCheck<string> =>
  isAbsent(value) ? absent : requiredDestinationFingerprint(value);

/**
 * The expected revision a step sends, read through the same safe-integer check the #692 writers use,
 * so a revision a writer would refuse is refused here first and reported as a value problem instead
 * of reaching a transaction.
 */
const requiredExpectedRevision = (value: unknown): Check<number> => {
  try {
    return valid(assertSafeIntegerRevision(value, "Connection administration"));
  } catch {
    return invalid;
  }
};

/** A credential is a non-empty string. Its length bound belongs to the #692 command, not here. */
const requiredSecret = (value: unknown): Check<string> =>
  typeof value === "string" && value.length > 0 ? valid(value) : invalid;

const requiredConnectionInstanceId = (value: unknown) => {
  const parsed = connectionInstanceIdSchema.safeParse(value);
  return parsed.success ? valid(parsed.data) : invalid;
};

const requiredAdministratorActivityId = (value: unknown) => {
  const parsed = activityIdSchema.safeParse(value);
  return parsed.success ? valid(parsed.data) : invalid;
};

const requiredConnectionTypeId = (value: unknown) => {
  const parsed = connectionTypeIdSchema.safeParse(value);
  return parsed.success ? valid(parsed.data) : invalid;
};

const requiredApplicationRootId = (value: unknown) => {
  const parsed = applicationRootIdSchema.safeParse(value);
  return parsed.success ? valid(parsed.data) : invalid;
};

const requiredConnectionTypeVersion = (value: unknown) => {
  const parsed = semanticVersionSchema.safeParse(value);
  return parsed.success ? valid(parsed.data) : invalid;
};

const requiredDestinationKey = (value: unknown) => {
  const parsed = archiveDestinationReferenceSchema.safeParse(value);
  return parsed.success ? valid(parsed.data) : invalid;
};

/** The recorded health result, taken from the #692 command's own domain rather than the status enum. */
const requiredHealthCheckOutcome = (
  value: unknown,
): Check<ConnectionAdministrationHealthCheckOutcome> =>
  value === "healthy" || value === "unhealthy" ? valid(value) : invalid;

const requiredApplicationChange = (value: unknown) => {
  if (value !== "grant" && value !== "revoke") return invalid;
  return valid(value);
};

/** Every key the caller supplied that the step does not declare, so an extra property is refused. */
const undeclaredKeys = (
  input: Readonly<Record<string, unknown>>,
  step: ConnectionAdministrationPageFlowStep,
): readonly string[] => {
  const allowed = new Set<string>([
    "step",
    "connectionInstanceId",
    "administratorActivityId",
    ...step.requiredInputKeys,
    ...step.optionalInputKeys,
  ]);
  return Object.freeze(Object.keys(input).filter((key) => !allowed.has(key)));
};

/** The required inputs of the step that are absent or blank, named by key and never by value. */
const missingInputKeys = (
  input: Readonly<Record<string, unknown>>,
  step: ConnectionAdministrationPageFlowStep,
): readonly ConnectionAdministrationInputKey[] =>
  Object.freeze(
    step.requiredInputKeys.filter((key) => {
      const value = input[key];
      return value === undefined || value === null || value === "";
    }),
  );

/**
 * Builds the one #692 command a step of the one page flow submits.
 *
 * Shape validation only. The organisation, the `platform.organization.connections.manage` authority,
 * the expected revision and every application grant are re-checked by the #692 SQL writers on every
 * call, so a command this function returns is a request, never a decision.
 *
 * Returns `incomplete` when a required input is absent, and `refused` with `invalid_parameters` when
 * a supplied input is malformed, when the step is not one of the one flow's commands, or when the
 * caller supplied a key the step does not declare. No branch returns, echoes or reports a submitted
 * value, so a credential can appear in no outcome.
 */
export const buildConnectionAdministrationCommand = (
  input: unknown,
): ConnectionAdministrationCommandReadiness => {
  if (!isRecord(input)) return INVALID_PARAMETERS;
  const step = input.step;
  if (typeof step !== "string") return INVALID_PARAMETERS;
  const flow = stepForCommand(step as ConnectionAdministrationStepKey);
  if (flow === undefined) return INVALID_PARAMETERS;
  if (undeclaredKeys(input, flow).length > 0) return INVALID_PARAMETERS;

  const missing = missingInputKeys(input, flow);
  if (missing.length > 0)
    return Object.freeze({
      outcome: "incomplete",
      command: flow.command,
      missingInputKeys: missing,
    });

  const instance = requiredConnectionInstanceId(input.connectionInstanceId);
  const activity = requiredAdministratorActivityId(input.administratorActivityId);
  if (!instance.valid || !activity.valid) return INVALID_PARAMETERS;
  const base = {
    connectionInstanceId: instance.value,
    administratorActivityId: activity.value,
  } as const;

  switch (flow.command) {
    case "configure": {
      const connectionTypeId = requiredConnectionTypeId(input.connectionTypeId);
      const connectionTypeVersion = requiredConnectionTypeVersion(input.connectionTypeVersion);
      const destinationKey = requiredDestinationKey(input.destinationKey);
      const destinationFingerprint = requiredDestinationFingerprint(input.destinationFingerprint);
      const tokenExpiresAt = optionalTimestamp(input.tokenExpiresAt);
      const secret = requiredSecret(input.secret);
      if (
        !connectionTypeId.valid ||
        !connectionTypeVersion.valid ||
        !destinationKey.valid ||
        !destinationFingerprint.valid ||
        !tokenExpiresAt.valid ||
        !secret.valid
      )
        return INVALID_PARAMETERS;
      return Object.freeze({
        outcome: "ready",
        command: Object.freeze({
          command: "configure",
          ...base,
          connectionTypeId: connectionTypeId.value,
          connectionTypeVersion: connectionTypeVersion.value,
          destinationKey: destinationKey.value,
          destinationFingerprint: destinationFingerprint.value,
          ...(tokenExpiresAt.value === undefined ? {} : { tokenExpiresAt: tokenExpiresAt.value }),
          secret: secret.value,
        }),
      });
    }
    case "rotate_credential": {
      const expectedRevision = requiredExpectedRevision(input.expectedRevision);
      const destinationFingerprint = optionalDestinationFingerprint(input.destinationFingerprint);
      const tokenExpiresAt = optionalTimestamp(input.tokenExpiresAt);
      const secret = requiredSecret(input.secret);
      if (
        !expectedRevision.valid ||
        !destinationFingerprint.valid ||
        !tokenExpiresAt.valid ||
        !secret.valid
      )
        return INVALID_PARAMETERS;
      return Object.freeze({
        outcome: "ready",
        command: Object.freeze({
          command: "rotate_credential",
          ...base,
          expectedRevision: expectedRevision.value,
          ...(destinationFingerprint.value === undefined
            ? {}
            : { destinationFingerprint: destinationFingerprint.value }),
          ...(tokenExpiresAt.value === undefined ? {} : { tokenExpiresAt: tokenExpiresAt.value }),
          secret: secret.value,
        }),
      });
    }
    case "health_check": {
      const expectedRevision = requiredExpectedRevision(input.expectedRevision);
      // The recorded outcome of the health operation the type declares, supplied by the service that
      // ran it. A browser never asserts a health result of its own.
      const healthOutcome = requiredHealthCheckOutcome(input.healthOutcome);
      if (!expectedRevision.valid || !healthOutcome.valid) return INVALID_PARAMETERS;
      return Object.freeze({
        outcome: "ready",
        command: Object.freeze({
          command: "health_check",
          ...base,
          expectedRevision: expectedRevision.value,
          healthOutcome: healthOutcome.value,
        }),
      });
    }
    case "application_grant": {
      const applicationRootId = requiredApplicationRootId(input.applicationRootId);
      const change = requiredApplicationChange(input.change);
      if (!applicationRootId.valid || !change.valid) return INVALID_PARAMETERS;
      return Object.freeze({
        outcome: "ready",
        command: Object.freeze({
          command: "application_grant",
          ...base,
          applicationRootId: applicationRootId.value,
          change: change.value,
        }),
      });
    }
    case "disable": {
      const expectedRevision = requiredExpectedRevision(input.expectedRevision);
      if (!expectedRevision.valid) return INVALID_PARAMETERS;
      return Object.freeze({
        outcome: "ready",
        command: Object.freeze({
          command: "disable",
          ...base,
          expectedRevision: expectedRevision.value,
        }),
      });
    }
  }
};

/**
 * The form's field keys that carry a credential, in form order. A caller uses this to discard the
 * values it collected once a submission succeeds, so no typed credential survives in a draft, an
 * export, a log or an error.
 */
export const connectionAdministrationWriteOnlyFieldKeys = (
  form: ConnectionAdministrationFormDefinition,
): readonly string[] =>
  Object.freeze(form.fields.filter((field) => field.writeOnly).map((field) => field.key));
