import {
  connectionTypeIdSchema,
  semanticVersionSchema,
  type ConnectionTypeSourceDocument,
} from "@vortex/contracts";
import type { PlatformConnectionTypeReleaseDefinition } from "@vortex/definition";

/**
 * Development placeholder connection types (#1306). The CRM and Service Desk applications bind the
 * email, calendar and webhook connection types at exact 1.0.0, but no platform release of them
 * ships yet (#1316), so without these the two applications cannot be published locally.
 *
 * They exist only in this development setup's publication catalogue; no shipped product code
 * carries them. Each keeps the operations and shapes the applications bind, has no provider, and
 * allows only a host under the reserved `.invalid` top-level domain, which never resolves, so no
 * call can reach a network endpoint. No connection is created or configured: an installed CRM or
 * Service Desk shows its connections as not configured.
 */

const placeholderProvider = "Development placeholder (no provider)";

const placeholderPurpose = (kind: string) =>
  `${placeholderProvider} for the ${kind} connection type the shipped applications bind. ` +
  "Its only allowed host is reserved and never resolves, so it cannot reach any network " +
  "endpoint (#1316 ships the platform release).";

const placeholderRelease = (
  rootId: string,
  source: ConnectionTypeSourceDocument,
): PlatformConnectionTypeReleaseDefinition => ({
  source,
  rootId: connectionTypeIdSchema.parse(rootId),
  releaseVersion: semanticVersionSchema.parse("1.0.0"),
});

const emailPlaceholder = placeholderRelease("6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d16", {
  source_contract_version: "1.0.0",
  kind: "connection_type",
  root_alias: "connection_email",
  key: "vortex.connection.email",
  body: {
    name: "Email (development placeholder, no provider)",
    purpose: placeholderPurpose("email"),
    provider: placeholderProvider,
    authentication: {
      kind: "oauth2",
      secret_fields: ["client_id", "client_secret", "refresh_token"],
      scopes: ["messages.send", "delivery.read"],
    },
    allowed_hosts: ["email.placeholder.invalid"],
    allow_redirects: false,
    shapes: [
      {
        key: "email_message",
        fields: [
          { key: "recipient", type: "text", required: true },
          { key: "subject", type: "text", required: true },
          { key: "body", type: "text", required: true },
        ],
      },
      {
        key: "template_message",
        fields: [
          { key: "recipient", type: "text", required: true },
          { key: "template_key", type: "text", required: true },
          { key: "variables", type: "json", required: true },
        ],
      },
      {
        key: "delivery_receipt",
        fields: [
          { key: "provider_message_id", type: "text", required: true },
          { key: "accepted", type: "boolean", required: true },
        ],
      },
      {
        key: "delivery_status",
        fields: [
          { key: "provider_message_id", type: "text", required: true },
          { key: "status", type: "text", required: true },
        ],
      },
    ],
    operations: [
      {
        key: "send_message",
        method: "POST",
        path: "/v1/messages",
        input: "email_message",
        output: "delivery_receipt",
        timeout_seconds: 20,
        max_attempts: 3,
        maximum_response_bytes: 1_000_000,
      },
      {
        key: "send_template",
        method: "POST",
        path: "/v1/templates/send",
        input: "template_message",
        output: "delivery_receipt",
        timeout_seconds: 20,
        max_attempts: 3,
        maximum_response_bytes: 1_000_000,
      },
    ],
    incoming_messages: [
      {
        key: "delivery_status",
        signature: "hmac_sha256",
        replay_window_seconds: 300,
        input: "delivery_status",
        workflow_trigger: "delivery_status_received",
      },
    ],
  },
});

const calendarPlaceholder = placeholderRelease("6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d17", {
  source_contract_version: "1.0.0",
  kind: "connection_type",
  root_alias: "connection_calendar",
  key: "vortex.connection.calendar",
  body: {
    name: "Calendar (development placeholder, no provider)",
    purpose: placeholderPurpose("calendar"),
    provider: placeholderProvider,
    authentication: {
      kind: "oauth2",
      secret_fields: ["client_id", "client_secret", "refresh_token"],
      scopes: ["events.write"],
    },
    allowed_hosts: ["calendar.placeholder.invalid"],
    allow_redirects: false,
    shapes: [
      {
        key: "calendar_event",
        fields: [
          { key: "title", type: "text", required: true },
          { key: "starts_at", type: "date_time", required: true },
          { key: "ends_at", type: "date_time", required: true },
        ],
      },
      {
        key: "calendar_event_reference",
        fields: [
          { key: "event_id", type: "text", required: true },
        ],
      },
      {
        key: "calendar_event_receipt",
        fields: [
          { key: "event_id", type: "text", required: true },
          { key: "accepted", type: "boolean", required: true },
        ],
      },
    ],
    operations: [
      {
        key: "create_event",
        method: "POST",
        path: "/v1/events",
        input: "calendar_event",
        output: "calendar_event_receipt",
        timeout_seconds: 20,
        max_attempts: 3,
        maximum_response_bytes: 1_000_000,
      },
      {
        key: "cancel_event",
        method: "POST",
        path: "/v1/events/cancel",
        input: "calendar_event_reference",
        output: "calendar_event_receipt",
        timeout_seconds: 20,
        max_attempts: 3,
        maximum_response_bytes: 1_000_000,
      },
    ],
    incoming_messages: [],
  },
});

const webhookPlaceholder = placeholderRelease("6d1f0c52-3b7a-4c4e-8a51-0e1a7b0c9d18", {
  source_contract_version: "1.0.0",
  kind: "connection_type",
  root_alias: "connection_webhook",
  key: "vortex.connection.webhook",
  body: {
    name: "Webhook (development placeholder, no provider)",
    purpose: placeholderPurpose("webhook"),
    provider: placeholderProvider,
    authentication: {
      kind: "signed_secret",
      secret_fields: ["signing_secret"],
      algorithm: "hmac_sha256",
    },
    allowed_hosts: ["webhook.placeholder.invalid"],
    allow_redirects: false,
    shapes: [
      {
        key: "signed_json",
        fields: [
          { key: "event_key", type: "text", required: true },
          { key: "payload", type: "json", required: true },
        ],
      },
      {
        key: "webhook_receipt",
        fields: [
          { key: "accepted", type: "boolean", required: true },
        ],
      },
      {
        key: "external_case",
        fields: [
          { key: "external_id", type: "text", required: true },
          { key: "payload", type: "json", required: true },
        ],
      },
    ],
    operations: [
      {
        key: "post_json",
        method: "POST",
        path: "/events",
        input: "signed_json",
        output: "webhook_receipt",
        timeout_seconds: 15,
        max_attempts: 5,
        maximum_response_bytes: 1_000_000,
      },
    ],
    incoming_messages: [
      {
        key: "case_created",
        signature: "hmac_sha256",
        replay_window_seconds: 300,
        input: "external_case",
        workflow_trigger: "external_event_received",
      },
    ],
  },
});

export const developmentPlaceholderConnectionTypeReleases: readonly PlatformConnectionTypeReleaseDefinition[] =
  Object.freeze([emailPlaceholder, calendarPlaceholder, webhookPlaceholder]);
