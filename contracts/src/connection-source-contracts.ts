import { z } from "zod";
import { builderKeySchema } from "./identifiers";
import { authoredSourceBase } from "./definition-source-common";

export const connectionTypeSourceDocumentSchema = z
  .object({
    ...authoredSourceBase,
    kind: z.literal("connection_type"),
    body: z
      .object({
        name: z.string().min(1).max(120),
        purpose: z.string().min(1).max(1_000),
        provider: z.string().min(1).max(120),
        authentication: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("oauth2"),
              secret_fields: z.array(builderKeySchema).min(1),
              scopes: z.array(z.string().min(1).max(200)),
            })
            .strict(),
          z
            .object({
              kind: z.literal("signed_secret"),
              secret_fields: z.array(builderKeySchema).min(1),
              algorithm: z.enum(["hmac_sha256", "ed25519"]),
            })
            .strict(),
          z
            .object({
              kind: z.literal("api_key"),
              secret_fields: z.array(builderKeySchema).min(1),
              placement: z.enum(["header", "query"]),
            })
            .strict(),
        ]),
        allowed_hosts: z
          .array(
            z
              .string()
              .min(1)
              .max(253)
              .regex(/^[a-z0-9.-]+$/),
          )
          .min(1),
        allow_redirects: z.boolean(),
        shapes: z
          .array(
            z
              .object({
                key: builderKeySchema,
                fields: z
                  .array(
                    z
                      .object({
                        key: builderKeySchema,
                        type: z.enum([
                          "text",
                          "number",
                          "boolean",
                          "date",
                          "date_time",
                          "record_reference",
                          "json",
                        ]),
                        required: z.boolean(),
                      })
                      .strict(),
                  )
                  .max(100),
              })
              .strict(),
          )
          .min(1),
        operations: z
          .array(
            z
              .object({
                key: builderKeySchema,
                method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
                path: z.string().startsWith("/").max(500),
                input: builderKeySchema,
                output: builderKeySchema,
                timeout_seconds: z.number().int().min(1).max(120),
                max_attempts: z.number().int().min(1).max(10),
                maximum_response_bytes: z.number().int().min(1).max(100_000_000),
              })
              .strict(),
          )
          .min(1),
        incoming_messages: z.array(
          z
            .object({
              key: builderKeySchema,
              signature: z.enum(["hmac_sha256", "ed25519"]),
              replay_window_seconds: z.number().int().min(1).max(86_400),
              input: builderKeySchema,
              workflow_trigger: builderKeySchema,
            })
            .strict(),
        ),
        health_operation: builderKeySchema.optional(),
        revocation_operation: builderKeySchema.optional(),
      })
      .strict(),
  })
  .strict();
