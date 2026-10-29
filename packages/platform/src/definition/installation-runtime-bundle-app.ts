import "server-only";

import { createHash } from "node:crypto";
import { jsonValueSchema, type JsonValue } from "../catalogue/common";
import { applicationRootIdSchema } from "../catalogue/identifiers";
import { logRefusal } from "../catalogue/runtime-primitives";
import { resolvePageComposition } from "../pages/page-composition-resolution";
import { canonicalJson } from "./canonical-json";
import {
  installationRuntimeBundleFormatVersion,
  installationRuntimeBundleIndexSchema,
  installationRuntimeBundleKeySchema,
  installationRuntimeBundleMaximumPartBytes,
  installationRuntimeBundlePagesSectionSchema,
  installationRuntimeBundlePartSchema,
  installationRuntimeBundleReadPartsCommandSchema,
  installationRuntimeBundleSections,
  installationRuntimeBundleSourceManifestSchema,
  installationRuntimeBundleWriteCommandSchema,
  type InstallationRuntimeBundleIndex,
  type InstallationRuntimeBundleKey,
  type InstallationRuntimeBundlePart,
  type InstallationRuntimeBundleSection,
  type PreparedInstallationRuntimeSource,
  type InstallationRuntimeBundleWriteCommand,
} from "./installation-runtime-bundle";
import type { DatabaseRow, RequestDatabaseTransaction } from "../db/request-transaction";
import {
  DefinitionError,
  classifyDatabaseError,
  unexpectedDefinitionFailure,
} from "./definition-error";

type BundleIndexRow = DatabaseRow & { readonly bundle_index: unknown };
type BundlePartsRow = DatabaseRow & { readonly bundle_parts: unknown };

type InstallationRuntimeBundleErrorCode =
  | "INVALID_INSTALLATION_RUNTIME_BUNDLE"
  | "INSTALLATION_RUNTIME_BUNDLE_AUTHORITY_REFUSED"
  | "INSTALLATION_RUNTIME_BUNDLE_NOT_FOUND"
  | "INSTALLATION_RUNTIME_BUNDLE_PIN_MISMATCH"
  | "INSTALLATION_RUNTIME_BUNDLE_STORAGE_CONFLICT"
  | "INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED";

const mapFailure = (error: unknown): DefinitionError<InstallationRuntimeBundleErrorCode> => {
  if (error instanceof DefinitionError) return error;
  switch (classifyDatabaseError(error)) {
    case "invalid":
      return new DefinitionError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
    case "refused":
      return new DefinitionError("INSTALLATION_RUNTIME_BUNDLE_AUTHORITY_REFUSED");
    case "not_found":
      return new DefinitionError("INSTALLATION_RUNTIME_BUNDLE_NOT_FOUND");
    case "duplicate":
      return new DefinitionError("INSTALLATION_RUNTIME_BUNDLE_PIN_MISMATCH");
    case "conflict":
      return new DefinitionError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_CONFLICT");
    default:
      return unexpectedDefinitionFailure(
        "INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED",
        error,
        "installation-runtime-bundle",
      );
  }
};

const indexFromRow = (row: BundleIndexRow): InstallationRuntimeBundleIndex => {
  const parsed = installationRuntimeBundleIndexSchema.safeParse(row.bundle_index);
  if (!parsed.success)
    throw unexpectedDefinitionFailure(
      "INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED",
      parsed.error,
      "installation-runtime-bundle",
    );
  return parsed.data;
};

const isUtf8ContinuationByte = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & 0xc0) === 0x80;

const splitSection = (
  section: InstallationRuntimeBundleSection,
  serialized: string,
): InstallationRuntimeBundlePart[] => {
  const bytes = Buffer.from(serialized, "utf8");
  const chunks: InstallationRuntimeBundlePart[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + installationRuntimeBundleMaximumPartBytes, bytes.length);
    while (end < bytes.length && isUtf8ContinuationByte(bytes[end])) end -= 1;
    const slice = bytes.subarray(start, end);
    chunks.push({
      section,
      ordinal: chunks.length,
      byteSize: slice.length,
      sha256: `sha256:${createHash("sha256").update(slice).digest("hex")}`,
      content: slice.toString("utf8"),
    });
    start = end;
  }
  return chunks;
};

const prepareParts = (
  command: InstallationRuntimeBundleWriteCommand,
): InstallationRuntimeBundlePart[] => {
  const parts = installationRuntimeBundleSections.flatMap((section) =>
    splitSection(section, canonicalJson(command.sections[section])),
  );
  if (parts.some((part) => !installationRuntimeBundlePartSchema.safeParse(part).success))
    throw new DefinitionError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
  return parts;
};

const requireMatchingKey = (
  index: InstallationRuntimeBundleIndex,
  key: InstallationRuntimeBundleKey,
): void => {
  if (
    index.applicationRootId !== key.applicationRootId ||
    index.applicationReleaseRevision !== key.applicationReleaseRevision ||
    index.bundleFormatVersion !== key.bundleFormatVersion
  )
    throw new DefinitionError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
};

const sortParts = (
  parts: readonly InstallationRuntimeBundlePart[],
): InstallationRuntimeBundlePart[] =>
  [...parts].sort((left, right) =>
    left.section === right.section
      ? left.ordinal - right.ordinal
      : installationRuntimeBundleSections.indexOf(left.section) -
        installationRuntimeBundleSections.indexOf(right.section),
  );

/** The reconstructed sections and the character length of the stored text they were parsed from. */
export type InstallationRuntimeBundleSections = Readonly<{
  sections: Partial<Record<InstallationRuntimeBundleSection, JsonValue>>;
  textLength: number;
}>;

/** Reads an exact-release bundle index through the verified request transaction. */
const readInstallationRuntimeBundleIndex = async (
  transaction: RequestDatabaseTransaction,
  keyCandidate: InstallationRuntimeBundleKey,
): Promise<InstallationRuntimeBundleIndex> => {
  const key = installationRuntimeBundleKeySchema.safeParse(keyCandidate);
  if (!key.success) throw new DefinitionError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
  try {
    const rows = await transaction.query<BundleIndexRow>`
      select vortex_definition.read_installation_runtime_bundle_index(
        ${key.data.applicationRootId}::uuid,
        ${key.data.applicationReleaseRevision}::bigint,
        ${key.data.bundleFormatVersion}::integer
      ) as bundle_index
    `;
    if (rows.length !== 1 || rows[0] === undefined)
      throw new DefinitionError("INSTALLATION_RUNTIME_BUNDLE_NOT_FOUND");
    const index = indexFromRow(rows[0]);
    requireMatchingKey(index, key.data);
    return index;
  } catch (error) {
    throw mapFailure(error);
  }
};

const readInstallationRuntimeBundleParts = async (
  transaction: RequestDatabaseTransaction,
  key: InstallationRuntimeBundleKey,
  sections: readonly InstallationRuntimeBundleSection[],
  index: InstallationRuntimeBundleIndex,
): Promise<readonly InstallationRuntimeBundlePart[]> => {
  const command = installationRuntimeBundleReadPartsCommandSchema.safeParse({
    ...key,
    sections: [...sections],
  });
  if (!command.success) throw new DefinitionError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
  const expected = index.parts.filter((part) => command.data.sections.includes(part.section));

  try {
    const rows = await transaction.query<BundlePartsRow>`
      select vortex_definition.read_installation_runtime_bundle_parts(
        ${command.data.applicationRootId}::uuid,
        ${command.data.applicationReleaseRevision}::bigint,
        ${command.data.bundleFormatVersion}::integer,
        ${JSON.stringify(command.data.sections)}::text::jsonb
      ) as bundle_parts
    `;
    if (rows.length !== 1 || rows[0] === undefined || !Array.isArray(rows[0].bundle_parts))
      throw new DefinitionError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
    const parsedParts = installationRuntimeBundlePartSchema.array().safeParse(rows[0].bundle_parts);
    if (!parsedParts.success)
      throw unexpectedDefinitionFailure(
        "INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED",
        parsedParts.error,
        "installation-runtime-bundle",
      );
    const parts = parsedParts.data;
    if (parts.length !== expected.length)
      throw new DefinitionError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
    const expectedByKey = new Map(
      expected.map((part) => [`${part.section}:${part.ordinal}`, part] as const),
    );
    for (const part of parts) {
      const metadata = expectedByKey.get(`${part.section}:${part.ordinal}`);
      if (
        metadata === undefined ||
        metadata.byteSize !== part.byteSize ||
        metadata.sha256 !== part.sha256
      )
        throw new DefinitionError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
      expectedByKey.delete(`${part.section}:${part.ordinal}`);
    }
    if (expectedByKey.size !== 0)
      throw new DefinitionError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
    return sortParts(parts);
  } catch (error) {
    throw mapFailure(error);
  }
};

/** Reads and reconstructs the named sections of an exact-release bundle. */
export const readInstallationRuntimeBundleSections = async (
  transaction: RequestDatabaseTransaction,
  keyCandidate: InstallationRuntimeBundleKey,
  sections: readonly InstallationRuntimeBundleSection[] = installationRuntimeBundleSections,
): Promise<InstallationRuntimeBundleSections> => {
  const key = installationRuntimeBundleKeySchema.safeParse(keyCandidate);
  if (!key.success) throw new DefinitionError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
  const command = installationRuntimeBundleReadPartsCommandSchema.safeParse({
    ...key.data,
    sections: [...sections],
  });
  if (!command.success) throw new DefinitionError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
  const index = await readInstallationRuntimeBundleIndex(transaction, key.data);
  const parts = await readInstallationRuntimeBundleParts(
    transaction,
    key.data,
    command.data.sections,
    index,
  );
  const reconstructed: Partial<Record<InstallationRuntimeBundleSection, JsonValue>> = {};
  let textLength = 0;
  for (const section of command.data.sections) {
    const sectionParts = parts.filter((part) => part.section === section);
    if (sectionParts.length === 0 || sectionParts.some((part, ordinal) => part.ordinal !== ordinal))
      throw new DefinitionError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
    try {
      const text = sectionParts.map((part) => part.content).join("");
      textLength += text.length;
      // JSON text parses only to JSON values; each section's own contract checks its shape where
      // the bundle is read.
      reconstructed[section] = JSON.parse(text) as JsonValue;
    } catch (error) {
      throw mapFailure(error);
    }
  }
  return { sections: reconstructed, textLength };
};

/** Stores exact-release bundle sections through the verified request transaction. */
const writeInstallationRuntimeBundle = async (
  transaction: RequestDatabaseTransaction,
  commandCandidate: InstallationRuntimeBundleWriteCommand,
): Promise<InstallationRuntimeBundleIndex> => {
  const parsedCommand = installationRuntimeBundleWriteCommandSchema.safeParse(commandCandidate);
  if (!parsedCommand.success) throw new DefinitionError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
  const command = parsedCommand.data;
  let parts: InstallationRuntimeBundlePart[];
  try {
    parts = prepareParts(command);
  } catch (error) {
    logRefusal("runtime-bundles", "prepare parts", "INVALID_INSTALLATION_RUNTIME_BUNDLE", error);
    throw new DefinitionError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
  }
  try {
    const rows = await transaction.query<BundleIndexRow>`
      select vortex_definition.write_installation_runtime_bundle(
        ${command.applicationRootId}::uuid,
        ${command.applicationReleaseRevision}::bigint,
        ${command.bundleFormatVersion}::integer,
        ${command.pinFingerprint}::text,
        ${JSON.stringify(parts)}::text::jsonb
      ) as bundle_index
    `;
    if (rows.length !== 1 || rows[0] === undefined)
      throw new DefinitionError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
    const index = indexFromRow(rows[0]);
    requireMatchingKey(index, command);
    if (index.pinFingerprint !== command.pinFingerprint)
      throw new DefinitionError("INSTALLATION_RUNTIME_BUNDLE_PIN_MISMATCH");
    return index;
  } catch (error) {
    throw mapFailure(error);
  }
};

const compareCanonical = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export type PreparedInstallationRuntimeSourceReader = (
  transaction: RequestDatabaseTransaction,
  input: Readonly<{
    organizationId: string;
    applicationRootId: string;
    applicationReleaseRevision: number;
    moduleBindings: readonly Readonly<{
      moduleRootId: string;
      moduleReleaseRevision: number;
      bindingRevision: number;
      state: "provisioned";
    }>[];
  }>,
) => Promise<PreparedInstallationRuntimeSource>;

const installationRuntimeBundleKey = (
  applicationRootId: string,
  applicationReleaseRevision: number,
) => {
  const parsedApplicationRootId = applicationRootIdSchema.safeParse(applicationRootId);
  if (!parsedApplicationRootId.success)
    throw new Error("PREPARED_INSTALLATION_RUNTIME_SOURCE_INVALID");
  return {
    applicationRootId: parsedApplicationRootId.data,
    applicationReleaseRevision,
    bundleFormatVersion: installationRuntimeBundleFormatVersion,
  };
};

const buildInstallationRuntimeBundleWriteCommand = (
  sourceCandidate: PreparedInstallationRuntimeSource,
): InstallationRuntimeBundleWriteCommand => {
  const sourceManifest = installationRuntimeBundleSourceManifestSchema.parse(
    sourceCandidate.sourceManifest,
  );
  // The prepared runtime source holds the release set already parsed and checked.
  const releaseSet = sourceCandidate.releaseSet;
  const application = releaseSet.application;
  const content = application.content;
  const expectedApplicationIdentity = {
    rootId: application.rootId,
    definitionKey: application.definitionKey,
    releaseRevision: application.releaseRevision,
    releaseVersion: application.releaseVersion,
    validationContractVersion: application.validationContractVersion,
    contentFingerprint: application.contentFingerprint,
    resolutionFingerprint: application.resolutionFingerprint,
  };
  const expectedModuleIdentities = [...releaseSet.modules]
    .sort((left, right) => compareCanonical(left.rootId, right.rootId))
    .map((module) => ({
      rootId: module.rootId,
      definitionKey: module.definitionKey,
      releaseRevision: module.releaseRevision,
      releaseVersion: module.releaseVersion,
      validationContractVersion: module.validationContractVersion,
      contentFingerprint: module.contentFingerprint,
      resolutionFingerprint: module.resolutionFingerprint,
    }));
  if (
    canonicalJson(sourceManifest.application) !== canonicalJson(expectedApplicationIdentity) ||
    canonicalJson(sourceManifest.modules) !== canonicalJson(expectedModuleIdentities) ||
    sourceManifest.preparedRecordAccessPlan.planKey !==
      sourceCandidate.preparedRecordAccessPlan.planKey ||
    sourceManifest.preparedRecordAccessPlan.mappingFingerprint !==
      sourceCandidate.preparedRecordAccessPlan.mappingFingerprint
  )
    throw new Error("PREPARED_INSTALLATION_RUNTIME_SOURCE_INVALID");
  const {
    navigation,
    flows,
    flowBindings,
    theme,
    platformBlockDependencies,
    pages,
    shells,
    ...pageContent
  } = content;
  const modules = [...releaseSet.modules]
    .sort((left, right) => compareCanonical(left.rootId, right.rootId))
    .map((module) => ({
      identity: {
        kind: module.kind,
        organizationId: module.organizationId,
        rootId: module.rootId,
        definitionKey: module.definitionKey,
        releaseRevision: module.releaseRevision,
        releaseVersion: module.releaseVersion,
        validationContractVersion: module.validationContractVersion,
        contentFingerprint: module.contentFingerprint,
        resolutionFingerprint: module.resolutionFingerprint,
        dependencyManifest: module.dependencyManifest,
      },
      content: module.content,
    }));
  const pageSource = installationRuntimeBundlePagesSectionSchema.parse({
    application: {
      identity: {
        kind: application.kind,
        organizationId: application.organizationId,
        rootId: application.rootId,
        definitionKey: application.definitionKey,
        releaseRevision: application.releaseRevision,
        releaseVersion: application.releaseVersion,
        validationContractVersion: application.validationContractVersion,
        contentFingerprint: application.contentFingerprint,
        resolutionFingerprint: application.resolutionFingerprint,
        dependencyManifest: application.dependencyManifest,
        platformCompatibilityVersion: application.platformCompatibilityVersion,
      },
      content: pageContent,
      shells,
      pages,
    },
    modules,
    resolvedCompositions: pages.map((page) => ({
      pageId: page.pageId,
      roots: resolvePageComposition(page, shells).roots,
    })),
  });
  const sections = {
    pages: pageSource,
    navigation,
    flows: { flows, flowBindings },
    theme,
    component_registry: platformBlockDependencies,
    access_plan: {
      preparedRecordAccessPlan: sourceCandidate.preparedRecordAccessPlan,
      declaredPermissions: {
        application: content.permissions,
        modules: releaseSet.modules
          .map((module) => ({ rootId: module.rootId, permissions: module.content.permissions }))
          .sort((left, right) => compareCanonical(left.rootId, right.rootId)),
      },
    },
    tool_bundle: application.toolBundle,
  } satisfies Record<(typeof installationRuntimeBundleSections)[number], unknown>;

  return installationRuntimeBundleWriteCommandSchema.parse({
    applicationRootId: application.rootId,
    applicationReleaseRevision: application.releaseRevision,
    bundleFormatVersion: installationRuntimeBundleFormatVersion,
    pinFingerprint: sourceManifest.pinFingerprint,
    sections: Object.fromEntries(
      installationRuntimeBundleSections.map((section) => [
        section,
        jsonValueSchema.parse(sections[section]),
      ]),
    ),
  });
};

export const assertPreparedInstallationRuntimeBundleMatches = async (
  transaction: RequestDatabaseTransaction,
  sourceCandidate: PreparedInstallationRuntimeSource,
  moduleBindings: readonly Readonly<{
    moduleRootId: string;
    moduleReleaseRevision: number;
    bindingRevision: number;
    state: "provisioned";
  }>[],
): Promise<InstallationRuntimeBundleIndex> => {
  const sourceManifest = installationRuntimeBundleSourceManifestSchema.parse(
    sourceCandidate.sourceManifest,
  );
  const index = await readInstallationRuntimeBundleIndex(
    transaction,
    installationRuntimeBundleKey(
      sourceManifest.application.rootId,
      sourceManifest.application.releaseRevision,
    ),
  );
  if (
    canonicalJson(index.sourceManifest) !== canonicalJson(sourceManifest) ||
    index.pinFingerprint !== sourceManifest.pinFingerprint
  )
    throw new Error("PREPARED_INSTALLATION_RUNTIME_BUNDLE_MISMATCH");
  const rows = await transaction.query<{ readonly asserted: unknown }>`
    select vortex_definition.assert_prepared_installation_runtime_bundle(
      ${sourceManifest.application.rootId}::uuid,
      ${sourceManifest.application.releaseRevision}::bigint,
      ${JSON.stringify(moduleBindings)}::text::jsonb,
      ${sourceManifest.pinFingerprint}::text
    ) as asserted
  `;
  if (rows.length !== 1 || rows[0]?.asserted === null || rows[0]?.asserted === undefined)
    throw new Error("PREPARED_INSTALLATION_RUNTIME_BUNDLE_MISMATCH");
  return index;
};

export const writePreparedInstallationRuntimeBundle = async (
  transaction: RequestDatabaseTransaction,
  sourceCandidate: PreparedInstallationRuntimeSource,
): Promise<InstallationRuntimeBundleIndex> => {
  const command = buildInstallationRuntimeBundleWriteCommand(sourceCandidate);
  const index = await writeInstallationRuntimeBundle(transaction, command);
  if (
    canonicalJson(index.sourceManifest) !== canonicalJson(sourceCandidate.sourceManifest) ||
    index.pinFingerprint !== command.pinFingerprint
  )
    throw new Error("PREPARED_INSTALLATION_RUNTIME_BUNDLE_MISMATCH");
  return index;
};
