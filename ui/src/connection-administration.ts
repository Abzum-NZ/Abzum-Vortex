import {
  applicationRootIdSchema,
  builderKeySchema,
  connectionInstanceIdSchema,
  connectionTypeIdSchema,
  namespacedKeySchema,
  semanticVersionSchema,
  timestampSchema,
} from "@vortex/contracts";
import { DefinitionRenderError, type DefinitionRenderErrorLocation } from "./definition-error";
import type { DisplayCellValue, DisplayField, RecordDetailPayload } from "./display/projected-data";
import type {
  BooleanInputPayload,
  DateInputPayload,
  NumberInputPayload,
  TextInputPayload,
  ValidationPayload,
} from "./controls/projected-data";

/**
 * The browser half of the generic connection administration page.
 *
 * It mirrors the resolution that `runtime/page/src/connection-administration.ts` projects over the
 * #692 administration commands and their results, and it re-validates that payload here rather than
 * trusting it. A missing, extra, renamed or malformed property fails closed, exactly as the launcher
 * bindings and the projected display data do, so a page can only ever render what the server
 * authorised.
 *
 * Three things never cross into this module. A secret value: a write-only field is presented as a
 * control with no value property at all, so there is nothing to read back into a control, a draft, a
 * log or an error. A secret reference, an organisation identity or an activity identity: the server
 * omits them and this module fails closed if any of them appears. A provider adapter: this module
 * starts no request, opens no socket and calls no connection service; it renders a payload, like
 * every other block in the platform.
 *
 * The closed vocabularies below are restated rather than imported, because a browser package cannot
 * depend on a server one. Each is a wire vocabulary the server validates first, so a value outside
 * one fails closed here instead of rendering.
 */

/** The closed instance states the safe status view may report. */
export const CONNECTION_ADMINISTRATION_STATE_VALUES = Object.freeze([
  "pending",
  "active",
  "unhealthy",
  "revoked",
] as const);
export type ConnectionAdministrationState = (typeof CONNECTION_ADMINISTRATION_STATE_VALUES)[number];

/** The closed health outcomes the safe status view may report. */
export const CONNECTION_ADMINISTRATION_HEALTH_VALUES = Object.freeze([
  "healthy",
  "unhealthy",
  "unknown",
] as const);
export type ConnectionAdministrationHealth =
  (typeof CONNECTION_ADMINISTRATION_HEALTH_VALUES)[number];

/** The closed value types a declared form field may declare, from the shared value-type catalogue. */
export const CONNECTION_ADMINISTRATION_VALUE_TYPES = Object.freeze([
  "text",
  "number",
  "boolean",
  "date",
  "date_time",
  "record_reference",
  "json",
] as const);
export type ConnectionAdministrationValueType =
  (typeof CONNECTION_ADMINISTRATION_VALUE_TYPES)[number];

/** The #692 command inputs a declared form field may feed. */
export const CONNECTION_ADMINISTRATION_INPUT_KEYS = Object.freeze([
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
export type ConnectionAdministrationInputKey =
  (typeof CONNECTION_ADMINISTRATION_INPUT_KEYS)[number];

/** The closed #692 commands the one page flow submits. */
export const CONNECTION_ADMINISTRATION_STEP_KEYS = Object.freeze([
  "configure",
  "rotate_credential",
  "health_check",
  "application_grant",
  "disable",
] as const);
export type ConnectionAdministrationStepKey = (typeof CONNECTION_ADMINISTRATION_STEP_KEYS)[number];

/** The closed refusal codes a #692 command may be refused with. */
export const CONNECTION_ADMINISTRATION_REFUSAL_CODES = Object.freeze([
  "invalid_parameters",
  "not_authorized",
  "connection_unavailable",
  "secret_store_unavailable",
  "administration_unavailable",
] as const);
export type ConnectionAdministrationRefusalCode =
  (typeof CONNECTION_ADMINISTRATION_REFUSAL_CODES)[number];

/** The closed recovery states the server decided a refusal code means. */
export const CONNECTION_ADMINISTRATION_RECOVERY_STATES = Object.freeze([
  "correct_the_form",
  "authority_unavailable",
  "reload_the_connection",
  "retry_the_credential",
  "retry_later",
] as const);
export type ConnectionAdministrationRecoveryState =
  (typeof CONNECTION_ADMINISTRATION_RECOVERY_STATES)[number];

/**
 * The fixed, data-free text for each recovery state. The server decides which state a refusal code
 * means and sends no message of its own, so the copy that names a person what to do next lives here,
 * once, in the browser that shows it. No entry carries a code, an identity or a stored value.
 */
export const CONNECTION_ADMINISTRATION_RECOVERY_MESSAGES = Object.freeze({
  correct_the_form: "Review the connection settings and submit them again",
  authority_unavailable: "You cannot administer this connection",
  reload_the_connection: "The connection changed. Reload it and try again",
  retry_the_credential: "The credential was not stored. Submit the credential again",
  retry_later: "Connection administration is temporarily unavailable. Try again shortly",
} as const satisfies Readonly<Record<ConnectionAdministrationRecoveryState, string>>);

/**
 * The control kinds a declared field may be presented with, taken from the payloads the platform's
 * own registered form controls consume, so a connection type can never need a control invented for it.
 */
export type ConnectionAdministrationControlKind =
  | TextInputPayload["kind"]
  | NumberInputPayload["kind"]
  | BooleanInputPayload["kind"]
  | DateInputPayload["kind"];

export const CONNECTION_ADMINISTRATION_CONTROL_KINDS = Object.freeze([
  "text_input",
  "number_input",
  "boolean_input",
  "date_input",
] as const satisfies readonly ConnectionAdministrationControlKind[]);

/** The largest declared form field list one page may render. */
const MAXIMUM_FORM_FIELDS = 64;
/** The largest scope list one page may render, matching the server's own bound. */
const MAXIMUM_SCOPE_ENTRIES = 100;
/** The largest rendered cell text, so one cell cannot become an unbounded string. */
const MAXIMUM_CELL_TEXT = 500;
/** The largest granted scope text, matching the connection type contract's own scope bound. */
const MAXIMUM_SCOPE_TEXT = 200;

const fail = (
  message: string,
  location: DefinitionRenderErrorLocation,
  propertyPath?: readonly string[],
): never => {
  throw new DefinitionRenderError(
    "INVALID_COMPOSITION",
    message,
    propertyPath === undefined ? location : { ...location, propertyPath },
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): Record<string, unknown> => (isRecord(value) ? value : fail(message, location));

/**
 * Every supplied key must be one of `allowed` and every `allowed` key must be present. The presence
 * half is stricter than the two projected-data parsers, because the server's payload types are exact:
 * a missing key means the server did not send what it declares, which this page cannot fill in.
 */
const requireExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: DefinitionRenderErrorLocation,
): void => {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      fail("Unexpected connection administration field", location);
  for (const key of allowed)
    if (!Object.hasOwn(value, key))
      fail(`Missing connection administration field '${key}'`, location);
};

const requireOptionalExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  location: DefinitionRenderErrorLocation,
): void => {
  for (const key of Object.keys(value))
    if (!required.includes(key) && !optional.includes(key))
      fail("Unexpected connection administration field", location);
  for (const key of required)
    if (!Object.hasOwn(value, key))
      fail(`Missing connection administration field '${key}'`, location);
};

const requireArray = (
  value: unknown,
  maximum: number,
  message: string,
  location: DefinitionRenderErrorLocation,
): readonly unknown[] =>
  Array.isArray(value) && value.length <= maximum ? value : fail(message, location);

/**
 * Bounded text a person reads but the platform stored verbatim, so a stored value is never altered.
 * Every value this checks came from a connection type's or a connection instance's own contract,
 * none of which trims, so trimming here would show a value the person never declared - and would
 * refuse a contract-valid value that is nothing but whitespace.
 */
const requireStoredText = (
  value: unknown,
  maximum: number,
  message: string,
  location: DefinitionRenderErrorLocation,
): string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : fail(message, location);

const requireBoolean = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): boolean => (typeof value === "boolean" ? value : fail(message, location));

const requireSafeInteger = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= Number.MAX_SAFE_INTEGER
    ? value
    : fail(message, location);

const requireOneOf = <Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  message: string,
  location: DefinitionRenderErrorLocation,
): Value => {
  const found = allowed.find((candidate) => candidate === value);
  return found === undefined ? fail(message, location) : found;
};

const requireDefinitionKey = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = builderKeySchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
};

const requireCatalogKey = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = namespacedKeySchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
};

const requireSemanticVersion = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = semanticVersionSchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
};

const requireConnectionInstanceId = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = connectionInstanceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
};

const requireConnectionTypeId = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = connectionTypeIdSchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
};

const requireApplicationRootId = (
  value: unknown,
  message: string,
  location: DefinitionRenderErrorLocation,
): string => {
  const parsed = applicationRootIdSchema.safeParse(value);
  return parsed.success ? parsed.data : fail(message, location);
};

/** One declared form field: its definition key, the #692 command input it feeds, and its shape. */
export type ConnectionAdministrationFormFieldProjection = Readonly<{
  key: string;
  input: ConnectionAdministrationInputKey;
  valueType: ConnectionAdministrationValueType;
  required: boolean;
  writeOnly: boolean;
}>;

/** The one definition-led settings form, as the server declared it for this connection type. */
export type ConnectionAdministrationFormProjection = Readonly<{
  connectionTypeId: string;
  connectionTypeVersion: string;
  fields: readonly ConnectionAdministrationFormFieldProjection[];
}>;

/** The safe instance and status view, as the server projected it. */
export type ConnectionAdministrationStatusProjection = Readonly<{
  connectionInstanceId: string;
  connectionTypeId: string;
  connectionTypeVersion: string;
  state: ConnectionAdministrationState;
  healthOutcome: ConnectionAdministrationHealth;
  /** The authority revision the revision-checking #692 commands must send unchanged. */
  revision: number;
  tokenExpiresAt?: string;
  authorizedApplicationIds: readonly string[];
  grantedScopes: readonly string[];
}>;

/** The safe connection type identity, as the server projected it. */
export type ConnectionAdministrationTypeProjection = Readonly<{
  connectionTypeId: string;
  key: string;
  version: string;
  name: string;
  provider: string;
}>;

/**
 * How the page reports the last command it submitted. The browser never decides which state a
 * refusal code means: it validates the state the server sent and resolves that decision's own text.
 */
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

/** One connection administration page this module will render. */
export type ConnectionAdministrationPagePayload = Readonly<{
  kind: "ready";
  connectionType: ConnectionAdministrationTypeProjection;
  form: ConnectionAdministrationFormProjection;
  status: ConnectionAdministrationStatusProjection;
  recovery: ConnectionAdministrationRecoveryProjection;
}>;

/**
 * What one connection administration page resolved to. A page that could not be projected and a page
 * whose reader could not answer are distinct data-free states rather than one empty page, so the two
 * never look alike and neither discloses whether a connection exists.
 */
export type ConnectionAdministrationPageProjection =
  | Readonly<{ kind: "refused" }>
  | Readonly<{ kind: "unavailable" }>
  | ConnectionAdministrationPagePayload;

const parseFormField = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): ConnectionAdministrationFormFieldProjection => {
  const field = requireRecord(
    value,
    "A connection administration field must be an object",
    location,
  );
  requireExactKeys(field, ["key", "input", "valueType", "required", "writeOnly"], location);
  return Object.freeze({
    key: requireDefinitionKey(
      field.key,
      "A connection administration field requires a valid definition key",
      location,
    ),
    input: requireOneOf(
      field.input,
      CONNECTION_ADMINISTRATION_INPUT_KEYS,
      "A connection administration field requires a declared command input",
      location,
    ),
    valueType: requireOneOf(
      field.valueType,
      CONNECTION_ADMINISTRATION_VALUE_TYPES,
      "A connection administration field requires a declared value type",
      location,
    ),
    required: requireBoolean(
      field.required,
      "A connection administration field must declare required",
      location,
    ),
    writeOnly: requireBoolean(
      field.writeOnly,
      "A connection administration field must declare write-only",
      location,
    ),
  });
};

const parseForm = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): ConnectionAdministrationFormProjection => {
  const form = requireRecord(value, "A connection administration form must be an object", location);
  requireExactKeys(form, ["connectionTypeId", "connectionTypeVersion", "fields"], location);
  const fields = requireArray(
    form.fields,
    MAXIMUM_FORM_FIELDS,
    "A connection administration form requires a bounded field list",
    location,
  ).map((entry, index) =>
    parseFormField(entry, { ...location, propertyPath: [`fields[${index}]`] }),
  );
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.key))
      fail(`Duplicate connection administration field '${field.key}'`, location);
    seen.add(field.key);
    // The declared secret fields of a connection type are collected together into the one credential
    // the write commands carry. A write-only field feeding any other input, or a readable field
    // feeding the credential, would let a secret be shown, drafted or read back, so either fails.
    if (field.writeOnly !== (field.input === "secret"))
      fail(
        `Connection administration field '${field.key}' must be write-only exactly when it feeds the credential`,
        location,
      );
  }
  return Object.freeze({
    connectionTypeId: requireConnectionTypeId(
      form.connectionTypeId,
      "A connection administration form requires a connection type identity",
      location,
    ),
    connectionTypeVersion: requireSemanticVersion(
      form.connectionTypeVersion,
      "A connection administration form requires a connection type version",
      location,
    ),
    fields: Object.freeze(fields),
  });
};

/** The optional credential expiry a status view may carry: absent, unreadable, or readable. */
const parseOptionalTimestamp = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): string | undefined => {
  if (value === undefined) return undefined;
  const parsed = timestampSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : fail("A connection status view requires a readable credential expiry", location);
};

const parseStatus = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): ConnectionAdministrationStatusProjection => {
  const status = requireRecord(value, "A connection status view must be an object", location);
  requireOptionalExactKeys(
    status,
    [
      "connectionInstanceId",
      "connectionTypeId",
      "connectionTypeVersion",
      "state",
      "healthOutcome",
      "revision",
      "authorizedApplicationIds",
      "grantedScopes",
    ],
    ["tokenExpiresAt"],
    location,
  );
  const tokenExpiresAt = parseOptionalTimestamp(status.tokenExpiresAt, location);
  const applications = requireArray(
    status.authorizedApplicationIds,
    MAXIMUM_SCOPE_ENTRIES,
    "A connection status view requires a bounded authorised application list",
    location,
  ).map((entry, index) =>
    requireApplicationRootId(entry, "A connection status view requires authorised applications", {
      ...location,
      propertyPath: [`authorizedApplicationIds[${index}]`],
    }),
  );
  const scopes = requireArray(
    status.grantedScopes,
    MAXIMUM_SCOPE_ENTRIES,
    "A connection status view requires a bounded granted scope list",
    location,
  ).map((entry, index) =>
    requireStoredText(
      entry,
      MAXIMUM_SCOPE_TEXT,
      "A connection status view requires granted scopes",
      { ...location, propertyPath: [`grantedScopes[${index}]`] },
    ),
  );
  return Object.freeze({
    connectionInstanceId: requireConnectionInstanceId(
      status.connectionInstanceId,
      "A connection status view requires a connection instance identity",
      location,
    ),
    connectionTypeId: requireConnectionTypeId(
      status.connectionTypeId,
      "A connection status view requires a connection type identity",
      location,
    ),
    connectionTypeVersion: requireSemanticVersion(
      status.connectionTypeVersion,
      "A connection status view requires a connection type version",
      location,
    ),
    state: requireOneOf(
      status.state,
      CONNECTION_ADMINISTRATION_STATE_VALUES,
      "A connection status view requires a declared state",
      location,
    ),
    healthOutcome: requireOneOf(
      status.healthOutcome,
      CONNECTION_ADMINISTRATION_HEALTH_VALUES,
      "A connection status view requires a declared health outcome",
      location,
    ),
    revision: requireSafeInteger(
      status.revision,
      "A connection status view requires a safe authority revision",
      location,
    ),
    ...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt }),
    authorizedApplicationIds: Object.freeze([...new Set(applications)]),
    grantedScopes: Object.freeze([...new Set(scopes)]),
  });
};

const parseType = (
  value: unknown,
  location: DefinitionRenderErrorLocation,
): ConnectionAdministrationTypeProjection => {
  const type = requireRecord(value, "A connection type view must be an object", location);
  requireExactKeys(type, ["connectionTypeId", "key", "version", "name", "provider"], location);
  return Object.freeze({
    connectionTypeId: requireConnectionTypeId(
      type.connectionTypeId,
      "A connection type view requires a connection type identity",
      location,
    ),
    key: requireCatalogKey(type.key, "A connection type view requires a catalogue key", location),
    version: requireSemanticVersion(
      type.version,
      "A connection type view requires a resolved version",
      location,
    ),
    name: requireStoredText(type.name, 120, "A connection type view requires a name", location),
    provider: requireStoredText(
      type.provider,
      120,
      "A connection type view requires a provider",
      location,
    ),
  });
};

/**
 * Validates one recovery projection the server produced. The state and the refusal code are each
 * checked against their closed sets, but their pairing is not re-decided here: which recovery a code
 * means is the server's decision, and the browser only resolves that decision's own text.
 */
export function parseConnectionAdministrationRecovery(
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ConnectionAdministrationRecoveryProjection {
  const recovery = requireRecord(value, "A connection recovery must be an object", location);
  if (recovery.status === "not_attempted") {
    requireExactKeys(recovery, ["status"], location);
    return Object.freeze({ status: "not_attempted" });
  }
  if (recovery.status === "applied") {
    requireOptionalExactKeys(recovery, ["status", "command"], ["revision"], location);
    const revision =
      recovery.revision === undefined
        ? undefined
        : requireSafeInteger(
            recovery.revision,
            "An applied connection command requires a safe authority revision",
            location,
          );
    return Object.freeze({
      status: "applied",
      command: requireOneOf(
        recovery.command,
        CONNECTION_ADMINISTRATION_STEP_KEYS,
        "An applied connection command requires a declared command",
        location,
      ),
      ...(revision === undefined ? {} : { revision }),
    });
  }
  if (recovery.status !== "recovery")
    return fail("Unknown connection administration recovery status", location);
  requireExactKeys(recovery, ["status", "state", "reasonCode", "retryable"], location);
  return Object.freeze({
    status: "recovery",
    state: requireOneOf(
      recovery.state,
      CONNECTION_ADMINISTRATION_RECOVERY_STATES,
      "A connection recovery requires a declared state",
      location,
    ),
    reasonCode: requireOneOf(
      recovery.reasonCode,
      CONNECTION_ADMINISTRATION_REFUSAL_CODES,
      "A connection recovery requires a declared refusal code",
      location,
    ),
    retryable: requireBoolean(
      recovery.retryable,
      "A connection recovery must declare whether it is retryable",
      location,
    ),
  });
}

/**
 * Validates the unknown resolution `projectConnectionAdministrationPage` produced and projects it
 * for rendering. The server's envelope is read exactly, so a bare page object, an unknown status or
 * a missing page fails closed.
 *
 * A refused or unavailable page is a distinct, data-free state rather than an empty page. An unknown
 * status, a missing or unexpected property, a malformed identity, version, state, health, revision,
 * expiry or recovery fails closed; a field key that is not a valid definition key fails closed; a
 * form, status view and type identity that name different connection types fails closed, so a page
 * never offers one type's declared schema over another type's instance. A payload carrying a secret
 * reference, an organisation identity or an activity identity fails closed, because the server never
 * sends one and a page must not start showing one.
 *
 * The instance's pinned type version is deliberately not required to equal the catalogue type's
 * current version: an instance may still be pinned to an older version, and the status view reports
 * which one it is pinned to.
 */
export function parseConnectionAdministrationPage(
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): ConnectionAdministrationPageProjection {
  const resolution = requireRecord(
    value,
    "A connection administration page must be an object",
    location,
  );
  if (resolution.kind === "refused") {
    requireExactKeys(resolution, ["kind"], location);
    return Object.freeze({ kind: "refused" });
  }
  if (resolution.kind === "unavailable") {
    requireExactKeys(resolution, ["kind"], location);
    return Object.freeze({ kind: "unavailable" });
  }
  if (resolution.kind !== "available")
    return fail("Unknown connection administration page status", location);
  requireExactKeys(resolution, ["kind", "page"], location);
  const page = requireRecord(resolution.page, "A connection administration page must be present", {
    ...location,
    propertyPath: ["page"],
  });
  requireExactKeys(page, ["kind", "connectionType", "form", "status", "recovery"], location);
  if (page.kind !== "ready")
    return fail("Unknown connection administration page status", location);
  const connectionType = parseType(page.connectionType, {
    ...location,
    propertyPath: ["page.connectionType"],
  });
  const form = parseForm(page.form, { ...location, propertyPath: ["page.form"] });
  const status = parseStatus(page.status, { ...location, propertyPath: ["page.status"] });
  if (
    form.connectionTypeId !== status.connectionTypeId ||
    form.connectionTypeId !== connectionType.connectionTypeId
  )
    return fail("A connection administration page mixes connection types", location);
  return Object.freeze({
    kind: "ready" as const,
    connectionType,
    form,
    status,
    recovery: parseConnectionAdministrationRecovery(page.recovery, {
      ...location,
      propertyPath: ["page.recovery"],
    }),
  });
}

/**
 * The recovery text for a projection, or undefined when there is nothing to say. Only a recovery
 * state has text; an applied command and a page on which nothing was submitted have none, and no
 * branch invents a message from a refusal code, a command or a stored value.
 */
export function connectionAdministrationRecoveryMessage(
  recovery: ConnectionAdministrationRecoveryProjection,
): string | undefined {
  return recovery.status === "recovery"
    ? CONNECTION_ADMINISTRATION_RECOVERY_MESSAGES[recovery.state]
    : undefined;
}

/**
 * The recovery as the existing validation message control consumes it: no errors when the command
 * was applied or never attempted, and the one fixed recovery text when it was refused.
 */
export function connectionAdministrationRecoveryValidation(
  recovery: ConnectionAdministrationRecoveryProjection,
): ValidationPayload {
  const message = connectionAdministrationRecoveryMessage(recovery);
  return Object.freeze({
    kind: "validation",
    errors: Object.freeze(message === undefined ? [] : [message]),
  });
}

/**
 * The control a declared value type is presented with. A structured value or a record reference has
 * no control on a connection settings form, so it fails closed rather than being shown as raw text.
 */
const controlForValueType = (
  valueType: ConnectionAdministrationValueType,
  fieldKey: string,
  location: DefinitionRenderErrorLocation,
): ConnectionAdministrationControlKind => {
  switch (valueType) {
    case "text":
      return "text_input";
    case "number":
      return "number_input";
    case "boolean":
      return "boolean_input";
    case "date":
    case "date_time":
      return "date_input";
    case "record_reference":
    case "json":
      return fail(
        `Connection administration field '${fieldKey}' declares a value type with no control`,
        location,
      );
  }
};

/**
 * One declared field as the existing form controls consume it.
 *
 * A write-only field has no `value` property at all, in the type and at run time, so a credential can
 * never be read back into a control, a draft, a log or an error. It is always a text input: a
 * connection type declares its secret fields without a value type, and a secret is always typed text.
 */
export type ConnectionAdministrationControlField =
  | Readonly<{
      key: string;
      required: boolean;
      writeOnly: false;
      control: ConnectionAdministrationControlKind;
    }>
  | Readonly<{ key: string; required: boolean; writeOnly: true; control: "text_input" }>;

/**
 * Projects a ready page's declared form into the ordered control descriptors its inputs render, in
 * declared order. Every control kind is one the platform already registers, so a connection type
 * adds no control and the one page flow places the same controls for every type.
 */
export function connectionAdministrationControlFields(
  payload: ConnectionAdministrationPagePayload,
  location: DefinitionRenderErrorLocation = {},
): readonly ConnectionAdministrationControlField[] {
  const fields: ConnectionAdministrationControlField[] = payload.form.fields.map((field) => {
    const fieldLocation = { ...location, propertyPath: [`page.form.fields.${field.key}`] };
    if (field.writeOnly)
      return Object.freeze({
        key: field.key,
        required: field.required,
        writeOnly: true as const,
        control: "text_input" as const,
      });
    return Object.freeze({
      key: field.key,
      required: field.required,
      writeOnly: false as const,
      control: controlForValueType(field.valueType, field.key, fieldLocation),
    });
  });
  return Object.freeze(fields);
}

/** A closed platform value as readable text, for the choice cells the status view renders. */
const labelForClosedValue = (value: string): string => value.replace(/_/g, " ");

const choiceCell = (value: string): DisplayCellValue =>
  Object.freeze({ kind: "choice", key: value, label: labelForClosedValue(value) });

const textCell = (value: string | undefined): DisplayCellValue =>
  value === undefined
    ? Object.freeze({ kind: "empty" })
    : Object.freeze({ kind: "text", text: value });

/** One bounded scope list as display text, or undefined when the list is empty. */
const scopeText = (entries: readonly string[]): string | undefined => {
  if (entries.length === 0) return undefined;
  const joined = entries.join(", ");
  return joined.length <= MAXIMUM_CELL_TEXT
    ? joined
    : `${joined.slice(0, MAXIMUM_CELL_TEXT - 1)}…`;
};

/**
 * The fixed labels for the platform's own status fields. These field keys belong to the platform, not
 * to a customer's connection type, so one frozen table names them and no label is invented per page.
 * They are definition keys, so they are lowercase words exactly as the form's own field keys are and
 * as the platform's record-detail payload parser requires. A declared secret field's own label is the
 * accessible name its placement declares, never a table lookup, because that key belongs to the
 * connection type.
 */
const CONNECTION_ADMINISTRATION_STATUS_LABELS = Object.freeze({
  connection_type_version: "Connection type version",
  state: "State",
  health_outcome: "Last health check",
  revision: "Revision",
  token_expires_at: "Credential expires",
  authorized_application_ids: "Authorised applications",
  granted_scopes: "Granted scopes",
});

/**
 * Projects a ready page's safe status view into the existing record-detail display payload, so the
 * instance and status view renders through a registered block rather than a page of its own.
 *
 * Only the projected safe view is read, and the seven fields below are the whole set, so the
 * instance's secret reference, its organisation identity and its activity identity - none of which
 * the payload carries - cannot appear. An absent credential expiry is an empty cell rather than a
 * fabricated date, and a list whose text would exceed the display bound is shortened with a visible
 * ellipsis rather than silently cut.
 */
export function connectionAdministrationStatusFields(
  payload: ConnectionAdministrationPagePayload,
): RecordDetailPayload {
  const status = payload.status;
  const fields: DisplayField[] = [
    {
      key: "connection_type_version",
      label: CONNECTION_ADMINISTRATION_STATUS_LABELS.connection_type_version,
      value: textCell(status.connectionTypeVersion),
    },
    {
      key: "state",
      label: CONNECTION_ADMINISTRATION_STATUS_LABELS.state,
      value: choiceCell(status.state),
    },
    {
      key: "health_outcome",
      label: CONNECTION_ADMINISTRATION_STATUS_LABELS.health_outcome,
      value: choiceCell(status.healthOutcome),
    },
    {
      key: "revision",
      label: CONNECTION_ADMINISTRATION_STATUS_LABELS.revision,
      value: Object.freeze({ kind: "number", value: status.revision }),
    },
    {
      key: "token_expires_at",
      label: CONNECTION_ADMINISTRATION_STATUS_LABELS.token_expires_at,
      value:
        status.tokenExpiresAt === undefined
          ? Object.freeze({ kind: "empty" })
          : Object.freeze({ kind: "date", iso: status.tokenExpiresAt }),
    },
    {
      key: "authorized_application_ids",
      label: CONNECTION_ADMINISTRATION_STATUS_LABELS.authorized_application_ids,
      value: textCell(scopeText(status.authorizedApplicationIds)),
    },
    {
      key: "granted_scopes",
      label: CONNECTION_ADMINISTRATION_STATUS_LABELS.granted_scopes,
      value: textCell(scopeText(status.grantedScopes)),
    },
  ];
  return Object.freeze({
    kind: "record_detail",
    recordId: status.connectionInstanceId,
    fields: Object.freeze(fields),
  });
}
