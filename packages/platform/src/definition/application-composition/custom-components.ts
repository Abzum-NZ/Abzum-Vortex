import { z } from "zod";
import { workflowValueTypeSchema } from "../../catalogue/catalogues";
import { labelSchema } from "../../catalogue/common";
import { sourceProvenanceUnchanged } from "../definition-source-common";
import {
  builderKeySchema,
  namespacedKeySchema,
  semanticVersionSchema,
} from "../../catalogue/identifiers";

/**
 * The owner of a custom component release: the exact application or module release that bundles
 * it. A custom component belongs to exactly one owning release; only that application, or an
 * application that binds the owning module, may place it (application packages appendix,
 * "Custom components").
 */
export const customComponentOwnerSchema = z
  .object({
    kind: sourceProvenanceUnchanged(z.enum(["application", "module"])),
    definitionKey: sourceProvenanceUnchanged(namespacedKeySchema),
    releaseVersion: sourceProvenanceUnchanged(semanticVersionSchema),
  })
  .strict();

/** One typed value a custom component event carries. A payload field always declares a type. */
export const customComponentEventPayloadFieldSchema = z
  .object({
    key: sourceProvenanceUnchanged(builderKeySchema),
    label: sourceProvenanceUnchanged(labelSchema),
    type: sourceProvenanceUnchanged(workflowValueTypeSchema),
    required: sourceProvenanceUnchanged(z.boolean()),
  })
  .strict();

/**
 * One declared custom component event. An event carries a typed payload; an undeclared or untyped
 * payload field is refused, because the renderer validates every incoming message against this
 * declaration and drops anything else (it never trusts the component's origin).
 */
export const customComponentEventSchema = z
  .object({
    key: sourceProvenanceUnchanged(builderKeySchema),
    label: sourceProvenanceUnchanged(labelSchema),
    payload: sourceProvenanceUnchanged(z.array(customComponentEventPayloadFieldSchema).max(50)),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.payload.map((field) => field.key)).size !== value.payload.length)
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "Event payload field keys must be unique",
      });
  });

/**
 * The typed data contract a custom component reads: the values the renderer may send it, each
 * with a declared value type. Every value is treated as disclosed to the package's publisher, so
 * the contract is closed and typed rather than free-form.
 */
export const customComponentDataContractSchema = z
  .object({
    values: sourceProvenanceUnchanged(
      z
        .array(
          z
            .object({
              key: sourceProvenanceUnchanged(builderKeySchema),
              label: sourceProvenanceUnchanged(labelSchema),
              type: sourceProvenanceUnchanged(workflowValueTypeSchema),
              required: sourceProvenanceUnchanged(z.boolean()),
            })
            .strict(),
        )
        .max(200),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.values.map((entry) => entry.key)).size !== value.values.length)
      context.addIssue({
        code: "custom",
        path: ["values"],
        message: "Data-contract value keys must be unique",
      });
  });

/** A relative module entry file inside the bundle: no scheme, absolute path, dot step or escape. */
const customComponentEntryFileSchema = z
  .string()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.m?js$/, "Use a relative JavaScript module path")
  .refine(
    (value) => value.split("/").every((segment) => !/^\.+$/.test(segment)),
    "Use a relative path without dot or parent steps",
  );

/**
 * One external host the sandboxed frame may reach: a bare lowercase DNS name with at least two
 * labels, never a wildcard, a scheme or URL (so never a `data:` or `javascript:` source), a port,
 * an IP literal or a single-label name such as `localhost`.
 */
const customComponentHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    "Use a bare lowercase host name",
  );

/**
 * The bundle manifest of a custom component: the Subresource Integrity digest the bootstrap
 * document verifies, the relative entry file it loads, and the external hosts the sandboxed frame
 * may reach. The digest is the release's immutable content address (application packages
 * appendix, "Custom components").
 */
export const customComponentBundleSchema = z
  .object({
    digest: sourceProvenanceUnchanged(
      z
        .string()
        .regex(/^sha384-[A-Za-z0-9+/]{64}$/, "Use a base64 SHA-384 Subresource Integrity digest"),
    ),
    entryFile: sourceProvenanceUnchanged(customComponentEntryFileSchema),
    allowedHosts: sourceProvenanceUnchanged(z.array(customComponentHostSchema).max(50)),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.allowedHosts).size !== value.allowedHosts.length)
      context.addIssue({
        code: "custom",
        path: ["allowedHosts"],
        message: "Allowed hosts must be unique",
      });
  });

/**
 * The custom-component-specific part of a release: its owning release, its typed declared events,
 * its typed data contract, the accessible text alternative the host renders and its bundle
 * manifest. The release's own `properties`, `capabilities.accessibleName` and
 * `supportedStateOperations` carry the rest of the component contract.
 */
export const customComponentReleaseSchema = z
  .object({
    owner: sourceProvenanceUnchanged(customComponentOwnerSchema),
    events: sourceProvenanceUnchanged(z.array(customComponentEventSchema).max(50)),
    dataContract: sourceProvenanceUnchanged(customComponentDataContractSchema),
    textAlternative: sourceProvenanceUnchanged(labelSchema),
    bundle: sourceProvenanceUnchanged(customComponentBundleSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.events.map((event) => event.key)).size !== value.events.length)
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "Custom component event keys must be unique",
      });
  });

export type CustomComponentOwner = z.infer<typeof customComponentOwnerSchema>;
export type CustomComponentRelease = z.infer<typeof customComponentReleaseSchema>;

/**
 * The context in which one application release places custom components: the placing application's
 * key and the exact module releases it binds. A custom component is placeable only by its owning
 * application, or by an application that binds the owning module release.
 */
export type CustomComponentPlacementContext = Readonly<{
  applicationKey: string;
  boundModuleReleases: readonly Readonly<{ moduleKey: string; releaseVersion: string }>[];
}>;

/**
 * True when the placing application may place the custom component: it is the owning application,
 * or it binds the exact module release that owns it. Any other application is refused, so a custom
 * component never leaks into an unrelated application.
 */
export const customComponentPlacementAllowed = (
  owner: CustomComponentOwner,
  context: CustomComponentPlacementContext,
): boolean =>
  owner.kind === "application"
    ? owner.definitionKey === context.applicationKey
    : context.boundModuleReleases.some(
        (binding) =>
          binding.moduleKey === owner.definitionKey &&
          binding.releaseVersion === owner.releaseVersion,
      );

/**
 * True when any of the releases is a custom component release. Installation uses this on the exact
 * resolved releases so a package carrying custom components also requires `custom_code.manage`.
 */
export const containsCustomComponentReleases = (
  releases: readonly Readonly<{ customComponent?: CustomComponentRelease | undefined }>[],
): boolean => releases.some((release) => release.customComponent !== undefined);

/** One immutable, platform-owned block release used by validation and renderer lookup. */
