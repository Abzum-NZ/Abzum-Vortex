import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  applicationRootIdSchema,
  correlationIdSchema,
  identityIdSchema,
  organizationAccountIdSchema,
  organizationIdSchema,
  protectedOperationRequestSchema,
  revisionSchema,
  stableDefinitionReleaseVersionSchema,
  workflowIdSchema,
  workflowNodeIdSchema,
  workflowRunIdSchema,
  type ProtectedOperationRequest,
} from "@vortex/contracts";
import { z } from "zod";
import { kestraProtectedOperationContractVersion } from "./kestra-compiler";

/**
 * #663: the durable actor context of one protected workflow operation.
 *
 * Kestra calls the protected-operation endpoint with a signed envelope naming
 * the run, node and attempt. This module turns that envelope plus the retained
 * run authority into one purpose-bound, short-lived context for exactly one
 * protected operation, or a safe refusal. It is pure: it performs no I/O, reads
 * no environment and never mints an actor, account, grant or credential.
 *
 * What it establishes, and what it deliberately does not:
 *
 * - The envelope proof is an HMAC-SHA256 over the canonical envelope with the
 *   application instance's callback key (#1152). A valid proof proves only that
 *   the application Kestra instance sent this exact, unexpired envelope. It
 *   confers no authority and names no actor.
 * - The retained run is trusted server state read by the caller: the exact run,
 *   its organisation, application, installed release, workflow revision, run-as
 *   policy and the node-to-operation map of that release. The envelope must
 *   match it field for field. An unknown, terminal, withdrawn or mismatched run
 *   refuses before an effect.
 * - `initiating_person` yields the retained initiator, which the Access step
 *   re-resolves against current account state before every protected step.
 *   `system_with_source_authority` yields no actor at all: the effective system
 *   actor is resolved by Access from the system actor grant registry for this
 *   exact operation, organisation, flow and application source. A run-as label,
 *   an engine signature or an installation never names or authorises one.
 * - The initiating person of a system-run workflow is never an actor. When the
 *   retained run carries one, only its account identifier travels as safe
 *   correlation for Activity and events.
 *
 * The context expires with the envelope, so it cannot outlive the attempt that
 * requested it.
 */

/** The longest an attempt envelope may be valid; anything longer is malformed. */
export const durableEnvelopeMaximumLifetimeMs = 15 * 60_000;

/** The clock skew tolerated when an envelope is issued slightly ahead of this server. */
export const durableEnvelopeClockSkewMs = 60_000;

const runAsSchema = z.enum(["initiating_person", "system_with_source_authority"]);

const retainedNodeSchema = z
  .object({
    nodeId: workflowNodeIdSchema,
    operationKey: protectedOperationRequestSchema.shape.operationKey,
  })
  .strict();

/** The person a run was started by; the account is re-resolved against current authority. */
export const retainedRunInitiatorSchema = z
  .object({
    organizationAccountId: organizationAccountIdSchema,
    identityId: identityIdSchema,
  })
  .strict();

/**
 * The exact retained run, as the trusted caller read it from Vortex's own
 * storage. `nodes` is the published node-to-operation map of the run's
 * installed release, so an envelope can name only a node the release declares
 * and only the operation that node declares. `state` other than `running`
 * refuses: a cancelled, completed, refused or withdrawn run takes no new effect.
 */
export const retainedRunAuthoritySchema = z
  .object({
    runId: workflowRunIdSchema,
    organizationId: organizationIdSchema,
    applicationRootId: applicationRootIdSchema,
    applicationReleaseVersion: stableDefinitionReleaseVersionSchema,
    workflowId: workflowIdSchema,
    workflowRevision: revisionSchema,
    runAs: runAsSchema,
    state: z.enum(["running", "waiting", "completed", "cancelled", "refused", "withdrawn"]),
    /** The person that started the run. Required for `initiating_person`; correlation otherwise. */
    initiator: retainedRunInitiatorSchema.optional(),
    nodes: z.array(retainedNodeSchema).min(1).max(100),
  })
  .strict();

export type RetainedRunAuthority = z.infer<typeof retainedRunAuthoritySchema>;

export const durableActorRefusalReasons = [
  "malformed_envelope",
  "proof_key_unavailable",
  "proof_invalid",
  "envelope_not_yet_valid",
  "envelope_expired",
  "envelope_lifetime_invalid",
  "contract_version_unsupported",
  "retained_run_malformed",
  "run_mismatch",
  "run_not_active",
  "node_unknown",
  "operation_mismatch",
  "initiator_missing",
  "wrong_operation",
] as const;

export type DurableActorRefusalReason = (typeof durableActorRefusalReasons)[number];

/**
 * How the actor of the operation is decided. `initiating_person` carries the
 * retained initiator for Access to re-resolve. `system_with_source_authority`
 * carries no actor; Access resolves it from the system actor grant registry.
 */
export type DurableActorPolicy =
  | Readonly<{
      kind: "initiating_person";
      initiator: z.infer<typeof retainedRunInitiatorSchema>;
    }>
  | Readonly<{
      kind: "system_with_source_authority";
      /** Safe correlation only; never an actor, never authority. */
      initiatorCorrelation?: Readonly<{ organizationAccountId: string }>;
    }>;

/** The exact protected operation this context is bound to. */
export type DurableActorPurpose = Readonly<{
  runId: string;
  organizationId: string;
  applicationRootId: string;
  applicationReleaseVersion: string;
  workflowId: string;
  workflowRevision: number;
  nodeId: string;
  attempt: number;
  operationKey: string;
  duplicateProtectionKey: string;
}>;

/**
 * The verified, purpose-bound durable actor context for one protected
 * operation. It carries no session, credential or role, and it is not itself
 * authority: the Access step must resolve the current actor and refuse when the
 * person, account, system actor grant or organisation no longer authorises it.
 */
export type VerifiedDurableActorContext = Readonly<{
  purpose: DurableActorPurpose;
  policy: DurableActorPolicy;
  correlationId: string;
  issuedAt: string;
  expiresAt: string;
}>;

export type DurableActorContextResolution =
  | Readonly<{ outcome: "verified"; context: VerifiedDurableActorContext }>
  | Readonly<{ outcome: "refused"; reason: DurableActorRefusalReason }>;

export type DurableActorContextDependencies = Readonly<{
  /**
   * The application instance's callback signing key (#1152), resolved by trusted
   * wiring. It is never read from the environment or logged here.
   */
  callbackKey: () => Uint8Array | undefined;
  clock?: () => Date;
  /** The correlation identifier of this attempt; an invalid value refuses. */
  correlationId: () => string;
}>;

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
};

/**
 * The exact bytes an envelope proof covers: every envelope field except the
 * proof itself, as canonical JSON with sorted keys. The signing flow and this
 * verifier share this one definition.
 */
export const canonicalDurableEnvelopePayload = (
  envelope: Omit<ProtectedOperationRequest, "signedCallerProof">,
): string => canonicalJson(envelope);

/** The proof a signer holding the callback key produces for one envelope. */
export const signDurableEnvelope = (
  envelope: Omit<ProtectedOperationRequest, "signedCallerProof">,
  callbackKey: Uint8Array,
): string =>
  createHmac("sha256", callbackKey)
    .update(canonicalDurableEnvelopePayload(envelope))
    .digest("base64url");

const proofMatches = (presented: string, expected: string): boolean => {
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
};

const sameId = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

const refused = (reason: DurableActorRefusalReason): DurableActorContextResolution => ({
  outcome: "refused",
  reason,
});

/**
 * Verifies one signed run/node/attempt envelope against the retained run and
 * returns the purpose-bound durable actor context, or a refusal. Every failure
 * is a refusal before any effect; nothing falls back to another actor.
 */
export const resolveDurableActorContext = (
  envelopeCandidate: unknown,
  retainedRunCandidate: unknown,
  dependencies: DurableActorContextDependencies,
): DurableActorContextResolution => {
  const envelope = protectedOperationRequestSchema.safeParse(envelopeCandidate);
  if (!envelope.success) return refused("malformed_envelope");
  const retainedParsed = retainedRunAuthoritySchema.safeParse(retainedRunCandidate);
  if (!retainedParsed.success) return refused("retained_run_malformed");
  const retained = retainedParsed.data;
  const { signedCallerProof, ...signed } = envelope.data;

  if (envelope.data.contractVersion !== kestraProtectedOperationContractVersion)
    return refused("contract_version_unsupported");

  const key = dependencies.callbackKey();
  if (key === undefined || key.length < 32) return refused("proof_key_unavailable");
  const expectedProof = signDurableEnvelope(signed, key);
  if (!proofMatches(signedCallerProof, expectedProof)) return refused("proof_invalid");

  const now = (dependencies.clock ?? (() => new Date()))().valueOf();
  if (!Number.isFinite(now)) return refused("malformed_envelope");
  const issuedAt = Date.parse(envelope.data.issuedAt);
  const expiresAt = Date.parse(envelope.data.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > durableEnvelopeMaximumLifetimeMs
  )
    return refused("envelope_lifetime_invalid");
  if (issuedAt > now + durableEnvelopeClockSkewMs) return refused("envelope_not_yet_valid");
  if (expiresAt <= now) return refused("envelope_expired");

  // The envelope must name exactly the retained run, in the exact organisation,
  // application and workflow revision it was accepted under.
  if (
    !sameId(envelope.data.runId, retained.runId) ||
    !sameId(envelope.data.organizationId, retained.organizationId) ||
    !sameId(envelope.data.applicationRootId, retained.applicationRootId) ||
    envelope.data.workflowRevision !== retained.workflowRevision
  )
    return refused("run_mismatch");
  if (retained.state !== "running") return refused("run_not_active");

  const node = retained.nodes.find((candidate) => sameId(candidate.nodeId, envelope.data.nodeId));
  if (node === undefined) return refused("node_unknown");
  if (node.operationKey !== envelope.data.operationKey) return refused("operation_mismatch");

  const correlation = correlationIdSchema.safeParse(dependencies.correlationId());
  if (!correlation.success) return refused("malformed_envelope");

  let policy: DurableActorPolicy;
  if (retained.runAs === "initiating_person") {
    if (retained.initiator === undefined) return refused("initiator_missing");
    policy = { kind: "initiating_person", initiator: retained.initiator };
  } else {
    policy =
      retained.initiator === undefined
        ? { kind: "system_with_source_authority" }
        : {
            kind: "system_with_source_authority",
            initiatorCorrelation: {
              organizationAccountId: retained.initiator.organizationAccountId,
            },
          };
  }

  return {
    outcome: "verified",
    context: {
      purpose: {
        runId: retained.runId,
        organizationId: retained.organizationId,
        applicationRootId: retained.applicationRootId,
        applicationReleaseVersion: retained.applicationReleaseVersion,
        workflowId: retained.workflowId,
        workflowRevision: retained.workflowRevision,
        nodeId: envelope.data.nodeId,
        attempt: envelope.data.attempt,
        operationKey: envelope.data.operationKey,
        duplicateProtectionKey: envelope.data.duplicateProtectionKey,
      },
      policy,
      correlationId: correlation.data,
      issuedAt: envelope.data.issuedAt,
      expiresAt: envelope.data.expiresAt,
    },
  };
};

/**
 * The narrow adapter an owning Record or Event operation calls before it
 * accepts a durable actor: the context must be bound to exactly that fixed
 * operation. A context minted for another operation, however valid, refuses.
 */
export const requireDurableActorForOperation = (
  context: VerifiedDurableActorContext,
  operationKey: string,
): DurableActorContextResolution =>
  context.purpose.operationKey === operationKey
    ? { outcome: "verified", context }
    : refused("wrong_operation");
