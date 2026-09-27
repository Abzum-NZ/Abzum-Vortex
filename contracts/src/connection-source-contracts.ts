import { sourceProvenanceUnchanged } from "./definition-source-common";
import { z } from "zod";
import { builderKeySchema } from "./identifiers";
import { authoredSourceBase, sourceProvenanceTarget } from "./definition-source-common";

export const connectionTypeSourceDocumentSchema = z
  .object({
    ...authoredSourceBase,
    kind: sourceProvenanceUnchanged(z.literal("connection_type")),
    body: sourceProvenanceUnchanged(
      z
        .object({
          name: sourceProvenanceUnchanged(z.string().min(1).max(120)),
          purpose: sourceProvenanceUnchanged(z.string().min(1).max(1_000)),
          provider: sourceProvenanceUnchanged(z.string().min(1).max(120)),
          authentication: sourceProvenanceUnchanged(
            z.discriminatedUnion("kind", [
              z
                .object({
                  kind: sourceProvenanceUnchanged(z.literal("oauth2")),
                  secret_fields: sourceProvenanceUnchanged(
                    z.array(sourceProvenanceTarget(builderKeySchema, ["secretFieldKeys/#"])).min(1),
                  ),
                  scopes: sourceProvenanceUnchanged(z.array(z.string().min(1).max(200))),
                })
                .strict(),
              z
                .object({
                  kind: sourceProvenanceUnchanged(z.literal("signed_secret")),
                  secret_fields: sourceProvenanceUnchanged(
                    z.array(sourceProvenanceTarget(builderKeySchema, ["secretFieldKeys/#"])).min(1),
                  ),
                  algorithm: sourceProvenanceUnchanged(z.enum(["hmac_sha256", "ed25519"])),
                })
                .strict(),
              z
                .object({
                  kind: sourceProvenanceUnchanged(z.literal("api_key")),
                  secret_fields: sourceProvenanceUnchanged(
                    z.array(sourceProvenanceTarget(builderKeySchema, ["secretFieldKeys/#"])).min(1),
                  ),
                  placement: sourceProvenanceUnchanged(z.enum(["header", "query"])),
                })
                .strict(),
            ]),
          ),
          allowed_hosts: sourceProvenanceUnchanged(
            z
              .array(
                z
                  .string()
                  .min(1)
                  .max(253)
                  .regex(/^[a-z0-9.-]+$/),
              )
              .min(1),
          ),
          allow_redirects: sourceProvenanceUnchanged(z.boolean()),
          shapes: sourceProvenanceUnchanged(
            z
              .array(
                z
                  .object({
                    key: sourceProvenanceUnchanged(builderKeySchema),
                    fields: sourceProvenanceUnchanged(
                      z
                        .array(
                          z
                            .object({
                              key: sourceProvenanceUnchanged(builderKeySchema),
                              type: sourceProvenanceUnchanged(
                                z.enum([
                                  "text",
                                  "number",
                                  "boolean",
                                  "date",
                                  "date_time",
                                  "record_reference",
                                  "json",
                                ]),
                              ),
                              required: sourceProvenanceUnchanged(z.boolean()),
                            })
                            .strict(),
                        )
                        .max(100),
                    ),
                  })
                  .strict(),
              )
              .min(1),
          ),
          operations: sourceProvenanceUnchanged(
            z
              .array(
                z
                  .object({
                    key: sourceProvenanceUnchanged(builderKeySchema),
                    method: sourceProvenanceUnchanged(
                      z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
                    ),
                    path: sourceProvenanceTarget(z.string().startsWith("/").max(500), [
                      "pathTemplate",
                    ]),
                    input: sourceProvenanceTarget(builderKeySchema, ["inputShapeKey"]),
                    output: sourceProvenanceTarget(builderKeySchema, ["outputShapeKey"]),
                    timeout_seconds: sourceProvenanceUnchanged(z.number().int().min(1).max(120)),
                    max_attempts: sourceProvenanceTarget(z.number().int().min(1).max(10), [
                      "maximumAttempts",
                    ]),
                    maximum_response_bytes: sourceProvenanceUnchanged(
                      z.number().int().min(1).max(100_000_000),
                    ),
                  })
                  .strict(),
              )
              .min(1),
          ),
          incoming_messages: sourceProvenanceUnchanged(
            z.array(
              z
                .object({
                  key: sourceProvenanceUnchanged(builderKeySchema),
                  signature: sourceProvenanceUnchanged(z.enum(["hmac_sha256", "ed25519"])),
                  replay_window_seconds: sourceProvenanceUnchanged(
                    z.number().int().min(1).max(86_400),
                  ),
                  input: sourceProvenanceTarget(builderKeySchema, ["inputShapeKey"]),
                  workflow_trigger: sourceProvenanceTarget(builderKeySchema, [
                    "workflowTriggerKey",
                  ]),
                })
                .strict(),
            ),
          ),
          health_operation: sourceProvenanceTarget(builderKeySchema.optional(), [
            "healthOperationKey",
          ]),
          revocation_operation: sourceProvenanceTarget(builderKeySchema.optional(), [
            "revocationOperationKey",
          ]),
        })
        .strict(),
    ),
  })
  .strict();
