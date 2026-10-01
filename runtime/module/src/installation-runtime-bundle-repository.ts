import "server-only";

import { createHash } from "node:crypto";
import {
  canonicalJson,
  installationRuntimeBundleMaximumPartBytes,
  installationRuntimeBundleIndexSchema,
  installationRuntimeBundleKeySchema,
  installationRuntimeBundlePartSchema,
  installationRuntimeBundleReadPartsCommandSchema,
  installationRuntimeBundleSections,
  installationRuntimeBundleWriteCommandSchema,
  jsonValueSchema,
  type InstallationRuntimeBundleIndex,
  type InstallationRuntimeBundleKey,
  type InstallationRuntimeBundlePart,
  type InstallationRuntimeBundleSection,
  type InstallationRuntimeBundleWriteCommand,
  type JsonValue,
} from "@vortex/contracts";
import type { DatabaseRow, RequestDatabaseTransaction } from "@vortex/db";
import {
  configureInstallationRuntimeBundleCache,
  readInstallationRuntimeBundleCachePart,
  readInstallationRuntimeBundleCacheStatus,
  retainInstallationRuntimeBundleCachePart,
  type InstallationRuntimeBundleCacheStatus,
} from "./installation-runtime-bundle-cache";

export {
  configureInstallationRuntimeBundleCache,
  readInstallationRuntimeBundleCacheStatus,
  type InstallationRuntimeBundleCacheStatus,
};

type BundleIndexRow = DatabaseRow & { readonly bundle_index: unknown };
type BundlePartsRow = DatabaseRow & { readonly bundle_parts: unknown };

export const installationRuntimeBundleErrorCodes = [
  "INVALID_INSTALLATION_RUNTIME_BUNDLE",
  "INSTALLATION_RUNTIME_BUNDLE_AUTHORITY_REFUSED",
  "INSTALLATION_RUNTIME_BUNDLE_NOT_FOUND",
  "INSTALLATION_RUNTIME_BUNDLE_PIN_MISMATCH",
  "INSTALLATION_RUNTIME_BUNDLE_STORAGE_CONFLICT",
  "INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED",
] as const;

export type InstallationRuntimeBundleErrorCode =
  (typeof installationRuntimeBundleErrorCodes)[number];

export class InstallationRuntimeBundleError extends Error {
  readonly code: InstallationRuntimeBundleErrorCode;

  constructor(code: InstallationRuntimeBundleErrorCode) {
    super(code);
    this.name = "InstallationRuntimeBundleError";
    this.code = code;
  }
}

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const mapFailure = (error: unknown): InstallationRuntimeBundleError => {
  if (error instanceof InstallationRuntimeBundleError) return error;
  switch (databaseCode(error)) {
    case "22023":
      return new InstallationRuntimeBundleError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
    case "42501":
      return new InstallationRuntimeBundleError(
        "INSTALLATION_RUNTIME_BUNDLE_AUTHORITY_REFUSED",
      );
    case "P0002":
      return new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_NOT_FOUND");
    case "23505":
      return new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_PIN_MISMATCH");
    case "40001":
      return new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_CONFLICT");
    default:
      return new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
  }
};

const indexFromRow = (row: BundleIndexRow): InstallationRuntimeBundleIndex => {
  const parsed = installationRuntimeBundleIndexSchema.safeParse(row.bundle_index);
  if (!parsed.success)
    throw new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
  return parsed.data;
};

const sha256 = (content: string): string =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

const splitSection = (
  section: InstallationRuntimeBundleSection,
  serialized: string,
): InstallationRuntimeBundlePart[] => {
  const chunks: InstallationRuntimeBundlePart[] = [];
  let content = "";
  let byteSize = 0;
  let ordinal = 0;

  const save = () => {
    if (content.length === 0) return;
    chunks.push({
      section,
      ordinal,
      byteSize,
      sha256: sha256(content),
      content,
    });
    ordinal += 1;
    content = "";
    byteSize = 0;
  };

  for (const character of serialized) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (byteSize + characterBytes > installationRuntimeBundleMaximumPartBytes) save();
    content += character;
    byteSize += characterBytes;
  }
  save();
  return chunks;
};

const prepareParts = (
  command: InstallationRuntimeBundleWriteCommand,
): InstallationRuntimeBundlePart[] => {
  const parts = installationRuntimeBundleSections.flatMap((section) =>
    splitSection(section, canonicalJson(command.sections[section])),
  );
  if (parts.some((part) => !installationRuntimeBundlePartSchema.safeParse(part).success))
    throw new InstallationRuntimeBundleError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
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
    throw new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
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

export interface InstallationRuntimeBundleRepository {
  write(command: InstallationRuntimeBundleWriteCommand): Promise<InstallationRuntimeBundleIndex>;
  readIndex(key: InstallationRuntimeBundleKey): Promise<InstallationRuntimeBundleIndex>;
  readParts(
    key: InstallationRuntimeBundleKey,
    sections: readonly InstallationRuntimeBundleSection[],
  ): Promise<readonly InstallationRuntimeBundlePart[]>;
  readSections(
    key: InstallationRuntimeBundleKey,
    sections?: readonly InstallationRuntimeBundleSection[],
  ): Promise<Partial<Record<InstallationRuntimeBundleSection, JsonValue>>>;
}

/** Stores exact-release bundle sections through the verified request transaction. */
export const createInstallationRuntimeBundleRepository = (
  transaction: RequestDatabaseTransaction,
): InstallationRuntimeBundleRepository => {
  const readIndex = async (
    keyCandidate: InstallationRuntimeBundleKey,
  ): Promise<InstallationRuntimeBundleIndex> => {
    const key = installationRuntimeBundleKeySchema.safeParse(keyCandidate);
    if (!key.success)
      throw new InstallationRuntimeBundleError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
    try {
      const rows = await transaction.query<BundleIndexRow>`
        select vortex_module.read_installation_runtime_bundle_index(
          ${key.data.applicationRootId}::uuid,
          ${key.data.applicationReleaseRevision}::bigint,
          ${key.data.bundleFormatVersion}::integer
        ) as bundle_index
      `;
      if (rows.length !== 1 || rows[0] === undefined)
        throw new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_NOT_FOUND");
      const index = indexFromRow(rows[0]);
      requireMatchingKey(index, key.data);
      return index;
    } catch (error) {
      throw mapFailure(error);
    }
  };

  const readPartsWithIndex = async (
    key: InstallationRuntimeBundleKey,
    sections: readonly InstallationRuntimeBundleSection[],
    index: InstallationRuntimeBundleIndex,
  ): Promise<readonly InstallationRuntimeBundlePart[]> => {
    const command = installationRuntimeBundleReadPartsCommandSchema.safeParse({
      ...key,
      sections: [...sections],
    });
    if (!command.success)
      throw new InstallationRuntimeBundleError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
    const expected = index.parts.filter((part) => command.data.sections.includes(part.section));
    const cachedParts = expected.map((metadata) =>
      readInstallationRuntimeBundleCachePart(index, metadata),
    );
    const completeCachedParts = cachedParts.filter(
      (part): part is InstallationRuntimeBundlePart => part !== undefined,
    );
    if (expected.length > 0 && completeCachedParts.length === expected.length)
      return sortParts(completeCachedParts);

    try {
      const rows = await transaction.query<BundlePartsRow>`
        select vortex_module.read_installation_runtime_bundle_parts(
          ${command.data.applicationRootId}::uuid,
          ${command.data.applicationReleaseRevision}::bigint,
          ${command.data.bundleFormatVersion}::integer,
          ${JSON.stringify(command.data.sections)}::text::jsonb
        ) as bundle_parts
      `;
      if (rows.length !== 1 || rows[0] === undefined || !Array.isArray(rows[0].bundle_parts))
        throw new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
      const parsedParts = installationRuntimeBundlePartSchema.array().safeParse(
        rows[0].bundle_parts,
      );
      if (!parsedParts.success)
        throw new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
      const parts = parsedParts.data;
      if (parts.length !== expected.length)
        throw new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
      const expectedByKey = new Map(
        expected.map((part) => [`${part.section}:${part.ordinal}`, part] as const),
      );
      for (const part of parts) {
        const metadata = expectedByKey.get(`${part.section}:${part.ordinal}`);
        if (
          metadata === undefined ||
          metadata.byteSize !== part.byteSize ||
          metadata.sha256 !== part.sha256 ||
          Buffer.byteLength(part.content, "utf8") !== part.byteSize ||
          sha256(part.content) !== part.sha256
        )
          throw new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
        expectedByKey.delete(`${part.section}:${part.ordinal}`);
      }
      if (expectedByKey.size !== 0)
        throw new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
      const sortedParts = sortParts(parts);
      for (const part of sortedParts) retainInstallationRuntimeBundleCachePart(index, part);
      return sortedParts;
    } catch (error) {
      throw mapFailure(error);
    }
  };

  return Object.freeze({
    async write(commandCandidate: InstallationRuntimeBundleWriteCommand) {
      const parsedCommand = installationRuntimeBundleWriteCommandSchema.safeParse(commandCandidate);
      if (!parsedCommand.success)
        throw new InstallationRuntimeBundleError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
      const command = parsedCommand.data;
      let parts: InstallationRuntimeBundlePart[];
      try {
        parts = prepareParts(command);
      } catch {
        throw new InstallationRuntimeBundleError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
      }
      try {
        const rows = await transaction.query<BundleIndexRow>`
          select vortex_module.write_installation_runtime_bundle_internal(
            ${command.applicationRootId}::uuid,
            ${command.applicationReleaseRevision}::bigint,
            ${command.bundleFormatVersion}::integer,
            ${command.pinFingerprint}::text,
            ${JSON.stringify(parts)}::text::jsonb
          ) as bundle_index
        `;
        if (rows.length !== 1 || rows[0] === undefined)
          throw new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
        const index = indexFromRow(rows[0]);
        requireMatchingKey(index, command);
        if (index.pinFingerprint !== command.pinFingerprint)
          throw new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_PIN_MISMATCH");
        return index;
      } catch (error) {
        throw mapFailure(error);
      }
    },
    readIndex,
    async readParts(
      keyCandidate: InstallationRuntimeBundleKey,
      sections: readonly InstallationRuntimeBundleSection[],
    ) {
      const key = installationRuntimeBundleKeySchema.safeParse(keyCandidate);
      if (!key.success)
        throw new InstallationRuntimeBundleError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
      const index = await readIndex(key.data);
      return readPartsWithIndex(key.data, sections, index);
    },
    async readSections(
      keyCandidate: InstallationRuntimeBundleKey,
      sections: readonly InstallationRuntimeBundleSection[] = installationRuntimeBundleSections,
    ) {
      const key = installationRuntimeBundleKeySchema.safeParse(keyCandidate);
      if (!key.success)
        throw new InstallationRuntimeBundleError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
      const command = installationRuntimeBundleReadPartsCommandSchema.safeParse({
        ...key.data,
        sections: [...sections],
      });
      if (!command.success)
        throw new InstallationRuntimeBundleError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
      const index = await readIndex(key.data);
      const parts = await readPartsWithIndex(key.data, command.data.sections, index);
      const reconstructed: Partial<Record<InstallationRuntimeBundleSection, JsonValue>> = {};
      for (const section of command.data.sections) {
        const sectionParts = parts.filter((part) => part.section === section);
        if (
          sectionParts.length === 0 ||
          sectionParts.some((part, ordinal) => part.ordinal !== ordinal)
        )
          throw new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
        try {
          const value: unknown = JSON.parse(sectionParts.map((part) => part.content).join(""));
          const parsedValue = jsonValueSchema.safeParse(value);
          if (!parsedValue.success)
            throw new InstallationRuntimeBundleError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
          reconstructed[section] = parsedValue.data;
        } catch (error) {
          throw mapFailure(error);
        }
      }
      return reconstructed;
    },
  });
};
