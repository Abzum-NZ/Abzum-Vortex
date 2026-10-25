import "server-only";

import { createHash } from "node:crypto";
import { jsonValueSchema, type JsonValue } from "../catalogue/common";
import { logRefusal } from "../catalogue/runtime-primitives";
import { canonicalJson } from "./canonical-json";
import {
  installationRuntimeBundleMaximumPartBytes,
  installationRuntimeBundleIndexSchema,
  installationRuntimeBundleKeySchema,
  installationRuntimeBundlePartSchema,
  installationRuntimeBundleReadPartsCommandSchema,
  installationRuntimeBundleSections,
  installationRuntimeBundleWriteCommandSchema,
  type InstallationRuntimeBundleIndex,
  type InstallationRuntimeBundleKey,
  type InstallationRuntimeBundlePart,
  type InstallationRuntimeBundleSection,
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
        "installation-runtime-bundle-repository",
      );
  }
};

const indexFromRow = (row: BundleIndexRow): InstallationRuntimeBundleIndex => {
  const parsed = installationRuntimeBundleIndexSchema.safeParse(row.bundle_index);
  if (!parsed.success)
    throw unexpectedDefinitionFailure(
      "INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED",
      parsed.error,
      "installation-runtime-bundle-repository",
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
  ): Promise<InstallationRuntimeBundleSections>;
}

/** The reconstructed sections and the character length of the stored text they were parsed from. */
export type InstallationRuntimeBundleSections = Readonly<{
  sections: Partial<Record<InstallationRuntimeBundleSection, JsonValue>>;
  textLength: number;
}>;

/** Stores exact-release bundle sections through the verified request transaction. */
export const createInstallationRuntimeBundleRepository = (
  transaction: RequestDatabaseTransaction,
): InstallationRuntimeBundleRepository => {
  const readIndex = async (
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

  const readPartsWithIndex = async (
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
      const parsedParts = installationRuntimeBundlePartSchema
        .array()
        .safeParse(rows[0].bundle_parts);
      if (!parsedParts.success)
        throw unexpectedDefinitionFailure(
          "INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED",
          parsedParts.error,
          "installation-runtime-bundle-repository",
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

  return Object.freeze({
    async write(commandCandidate: InstallationRuntimeBundleWriteCommand) {
      const parsedCommand = installationRuntimeBundleWriteCommandSchema.safeParse(commandCandidate);
      if (!parsedCommand.success) throw new DefinitionError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
      const command = parsedCommand.data;
      let parts: InstallationRuntimeBundlePart[];
      try {
        parts = prepareParts(command);
      } catch (error) {
        logRefusal(
          "runtime-bundles",
          "prepare parts",
          "INVALID_INSTALLATION_RUNTIME_BUNDLE",
          error,
        );
        throw new DefinitionError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
      }
      try {
        const rows = await transaction.query<BundleIndexRow>`
          select vortex_definition.write_installation_runtime_bundle_internal(
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
    },
    readIndex,
    async readParts(
      keyCandidate: InstallationRuntimeBundleKey,
      sections: readonly InstallationRuntimeBundleSection[],
    ) {
      const key = installationRuntimeBundleKeySchema.safeParse(keyCandidate);
      if (!key.success) throw new DefinitionError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
      const index = await readIndex(key.data);
      return readPartsWithIndex(key.data, sections, index);
    },
    async readSections(
      keyCandidate: InstallationRuntimeBundleKey,
      sections: readonly InstallationRuntimeBundleSection[] = installationRuntimeBundleSections,
    ) {
      const key = installationRuntimeBundleKeySchema.safeParse(keyCandidate);
      if (!key.success) throw new DefinitionError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
      const command = installationRuntimeBundleReadPartsCommandSchema.safeParse({
        ...key.data,
        sections: [...sections],
      });
      if (!command.success) throw new DefinitionError("INVALID_INSTALLATION_RUNTIME_BUNDLE");
      const index = await readIndex(key.data);
      const parts = await readPartsWithIndex(key.data, command.data.sections, index);
      const reconstructed: Partial<Record<InstallationRuntimeBundleSection, JsonValue>> = {};
      let textLength = 0;
      for (const section of command.data.sections) {
        const sectionParts = parts.filter((part) => part.section === section);
        if (
          sectionParts.length === 0 ||
          sectionParts.some((part, ordinal) => part.ordinal !== ordinal)
        )
          throw new DefinitionError("INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED");
        try {
          const text = sectionParts.map((part) => part.content).join("");
          textLength += text.length;
          const value: unknown = JSON.parse(text);
          const parsedValue = jsonValueSchema.safeParse(value);
          if (!parsedValue.success)
            throw unexpectedDefinitionFailure(
              "INSTALLATION_RUNTIME_BUNDLE_STORAGE_FAILED",
              parsedValue.error,
              "installation-runtime-bundle-repository",
            );
          reconstructed[section] = parsedValue.data;
        } catch (error) {
          throw mapFailure(error);
        }
      }
      return { sections: reconstructed, textLength };
    },
  });
};
