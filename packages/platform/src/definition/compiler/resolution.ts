import { createHash } from "node:crypto";
import { satisfies } from "semver";
import type {
  ModuleSourceDocument,
  ApplicationSourceDocument,
  DefinitionResolutionSnapshot,
  DefinitionSourceDocument,
  DefinitionValidationLocation,
} from "../../schema";
import { canonicalJson } from "../canonical-json-definition";
import {
  DefinitionCompilationError,
  type DefinitionCompilerRefusalCode,
} from "../compilation-error";
import {
  extractApplicationSourceIdentityRequirements,
  extractSourceIdentityRequirements,
  extractModuleSourceIdentityRequirements,
} from "../source-identities";
import { compilerRootLocation, fail, type JsonObject } from "./shared";

type ResolutionSnapshot = DefinitionResolutionSnapshot;

/**
 * Narrowing key only. Every lookup still applies its own predicate to the entries it finds, so
 * a separator inside an alias can widen the candidates but never change what matches.
 */
const identityLookupKey = (definitionKey: string, kind: string, alias: string): string =>
  `${definitionKey}\0${kind}\0${alias}`;

export class Resolution {
  readonly snapshot: DefinitionResolutionSnapshot;
  readonly sourceLocation: DefinitionValidationLocation;
  /** Filled by the constructor passes that already visit every definition and identity. */
  private readonly definitionsByKey = new Map<
    string,
    ResolutionSnapshot["definitions"][number][]
  >();
  private readonly identitiesByLookup = new Map<
    string,
    ResolutionSnapshot["identities"][number][]
  >();

  constructor(snapshot: DefinitionResolutionSnapshot, source: JsonObject) {
    this.snapshot = snapshot;
    this.sourceLocation = compilerRootLocation(source);
    const requirements =
      source.kind === "module"
        ? extractModuleSourceIdentityRequirements(source as unknown as ModuleSourceDocument)
        : source.kind === "application"
          ? extractApplicationSourceIdentityRequirements(
              source as unknown as ApplicationSourceDocument,
            )
          : extractSourceIdentityRequirements(source as unknown as DefinitionSourceDocument);
    const authenticSourceIdentities = new Set(
      requirements.flatMap((requirement) =>
        requirement.aliases.map((alias) =>
          JSON.stringify([requirement.scope, requirement.kind, requirement.componentOwner, alias]),
        ),
      ),
    );
    const actualFingerprint = `sha256:${createHash("sha256")
      .update(
        canonicalJson({
          contractVersion: snapshot.contractVersion,
          definitions: snapshot.definitions,
          identities: snapshot.identities,
        }),
        "utf8",
      )
      .digest("hex")}`;
    if (snapshot.fingerprint !== actualFingerprint)
      fail(
        "vortex.definition.invalid_resolution_fingerprint",
        "invalid_value",
        this.sourceLocation,
      );
    const definitions = new Set<string>();
    const ownersByIdentifier = new Map<string, string>();
    const identityOwnerGroups = new Map<
      string,
      { aliases: Set<string>; identifiers: Set<string>; kind: string; owner: string }
    >();
    const registerOwner = (
      identifier: string,
      owner: string,
      code: DefinitionCompilerRefusalCode,
    ) => {
      const existingOwner = ownersByIdentifier.get(identifier);
      if (existingOwner !== undefined && existingOwner !== owner)
        fail(code, "duplicate_key", this.sourceLocation);
      ownersByIdentifier.set(identifier, owner);
    };
    for (const definition of snapshot.definitions) {
      const key = `${definition.kind}:${definition.key}`;
      if (definitions.has(key))
        fail("vortex.definition.duplicate_resolution", "duplicate_key", this.sourceLocation);
      definitions.add(key);
      registerOwner(
        definition.rootId,
        `${definition.key}:root`,
        "vortex.definition.duplicate_resolution",
      );
      const sameKey = this.definitionsByKey.get(definition.key);
      if (sameKey) sameKey.push(definition);
      else this.definitionsByKey.set(definition.key, [definition]);
    }
    const identities = new Set<string>();
    for (const identity of snapshot.identities) {
      const key = `${identity.definitionKey}:${identity.scope}:${identity.kind}:${identity.alias}`;
      if (identities.has(key))
        fail(
          "vortex.definition.duplicate_identity_resolution",
          "duplicate_key",
          this.sourceLocation,
        );
      identities.add(key);
      const ownerGroupKey = `${identity.definitionKey}:${identity.scope}:${identity.kind}:${identity.componentOwner}`;
      const ownerGroup = identityOwnerGroups.get(ownerGroupKey) ?? {
        aliases: new Set<string>(),
        identifiers: new Set<string>(),
        kind: identity.kind,
        owner: identity.componentOwner,
      };
      ownerGroup.aliases.add(identity.alias);
      ownerGroup.identifiers.add(identity.identifier);
      identityOwnerGroups.set(ownerGroupKey, ownerGroup);
      if (
        identity.definitionKey === source.key &&
        !authenticSourceIdentities.has(
          JSON.stringify([identity.scope, identity.kind, identity.componentOwner, identity.alias]),
        )
      ) {
        fail(
          "vortex.definition.duplicate_identity_resolution",
          "duplicate_key",
          this.sourceLocation,
        );
      }
      const componentOwner =
        identity.kind === "root"
          ? `${identity.definitionKey}:root`
          : `${identity.definitionKey}:${identity.scope}:${identity.kind}:${identity.componentOwner}`;
      registerOwner(
        identity.identifier,
        componentOwner,
        "vortex.definition.duplicate_identity_resolution",
      );
      const lookupKey = identityLookupKey(identity.definitionKey, identity.kind, identity.alias);
      const sameLookup = this.identitiesByLookup.get(lookupKey);
      if (sameLookup) sameLookup.push(identity);
      else this.identitiesByLookup.set(lookupKey, [identity]);
    }
    for (const group of identityOwnerGroups.values())
      if (group.identifiers.size !== 1)
        fail(
          "vortex.definition.duplicate_identity_resolution",
          "duplicate_key",
          this.sourceLocation,
        );
  }

  location(kind: string, key: string, scope?: string): DefinitionValidationLocation {
    const componentKinds: Readonly<
      Record<string, DefinitionValidationLocation["segments"][number]["kind"]>
    > = {
      module: "module",
      application: "application",
      connection_type: "connection",
      record_type: "record_type",
      field: "field",
      relationship: "relationship",
      action: "action",
      rule: "rule",
      event: "event",
      page: "page",
      block: "block",
      pipeline: "pipeline",
      query: "query",
      role: "role",
      connection_binding: "connection",
      interface: "interface",
      flow: "flow",
      flow_binding: "flow_binding",
    };
    const segments = [...this.sourceLocation.segments];
    if (scope?.startsWith("record:"))
      segments.push({ kind: "record_type", key: scope.slice("record:".length) });
    else if (scope?.startsWith("flow:"))
      segments.push({ kind: "flow", key: scope.slice("flow:".length) });
    const componentKind = componentKinds[kind];
    if (componentKind) segments.push({ kind: componentKind, key });
    return { ...this.sourceLocation, segments };
  }

  definition(key: string, kind?: "module" | "application" | "connection_type") {
    const matches = (this.definitionsByKey.get(key) ?? []).filter(
      (entry) => entry.key === key && (kind === undefined || entry.kind === kind),
    );
    const location = this.location(kind ?? "module", key);
    if (matches.length === 0)
      fail("vortex.definition.missing_definition", "unresolved_reference", location);
    if (matches.length > 1)
      fail("vortex.definition.ambiguous_definition", "unresolved_reference", location);
    return matches[0]!;
  }

  id(definitionKey: string, kind: string, alias: string, scope?: string): string {
    const matches = (
      this.identitiesByLookup.get(identityLookupKey(definitionKey, kind, alias)) ?? []
    ).filter(
      (entry) =>
        entry.definitionKey === definitionKey &&
        entry.kind === kind &&
        entry.alias === alias &&
        (scope === undefined || entry.scope === scope),
    );
    const unique = [...new Set(matches.map((entry) => entry.identifier))];
    const location = this.location(kind, alias, scope);
    if (unique.length === 0)
      fail("vortex.definition.missing_identity", "unresolved_reference", location);
    if (unique.length > 1)
      fail("vortex.definition.ambiguous_identity", "unresolved_reference", location);
    return unique[0]!;
  }

  recordType(qualifiedKey: string) {
    const split = qualifiedKey.lastIndexOf(":");
    if (split < 1)
      fail(
        "vortex.definition.invalid_record_type_reference",
        "broken_reference",
        this.location("record_type", qualifiedKey),
      );
    const moduleKey = qualifiedKey.slice(0, split);
    const recordKey = qualifiedKey.slice(split + 1);
    const definition = this.definition(moduleKey, "module");
    return {
      state: "resolved" as const,
      moduleRootId: definition.rootId,
      recordTypeId: this.id(moduleKey, "record_type", recordKey, "content"),
    };
  }

  field(qualifiedRecordType: string, fieldAlias: string): string {
    const split = qualifiedRecordType.lastIndexOf(":");
    const moduleKey = qualifiedRecordType.slice(0, split);
    const recordKey = qualifiedRecordType.slice(split + 1);
    return this.id(moduleKey, "field", fieldAlias, `record:${recordKey}`);
  }

  relationship(qualifiedRecordType: string, alias: string): string {
    const split = qualifiedRecordType.lastIndexOf(":");
    const moduleKey = qualifiedRecordType.slice(0, split);
    const recordKey = qualifiedRecordType.slice(split + 1);
    try {
      return this.id(moduleKey, "relationship", alias, `record:${recordKey}`);
    } catch (error) {
      if (!(error instanceof DefinitionCompilationError)) throw error;
      return this.id(moduleKey, "relationship", alias);
    }
  }

  permission(key: string, allowedDefinitionKeys: readonly string[]): string {
    const allowed = new Set(allowedDefinitionKeys);
    const matches = [...allowed]
      .flatMap(
        (definitionKey) =>
          this.identitiesByLookup.get(identityLookupKey(definitionKey, "permission", key)) ?? [],
      )
      .filter(
        (entry) =>
          allowed.has(entry.definitionKey) &&
          entry.scope === "content" &&
          entry.kind === "permission" &&
          entry.alias === key,
      );
    const unique = [...new Set(matches.map((entry) => entry.identifier))];
    if (unique.length === 0)
      fail(
        "vortex.definition.missing_identity",
        "unresolved_reference",
        this.location("permission", key),
      );
    if (unique.length > 1)
      fail(
        "vortex.definition.ambiguous_identity",
        "unresolved_reference",
        this.location("permission", key),
      );
    return unique[0]!;
  }

  exactOwnedReference(
    kind: "action" | "permission",
    key: string,
    allowedDefinitionKeys: readonly string[],
  ): string {
    const allowed = new Set(allowedDefinitionKeys);
    const matches = [...allowed]
      .flatMap(
        (definitionKey) =>
          this.identitiesByLookup.get(identityLookupKey(definitionKey, kind, key)) ?? [],
      )
      .filter(
        (entry) =>
          allowed.has(entry.definitionKey) &&
          entry.scope === "content" &&
          entry.kind === kind &&
          entry.alias === key,
      );
    const unique = [...new Set(matches.map((entry) => entry.identifier))];
    if (unique.length === 0)
      fail("vortex.definition.missing_identity", "unresolved_reference", this.location(kind, key));
    if (unique.length > 1)
      fail(
        "vortex.definition.ambiguous_identity",
        "unresolved_reference",
        this.location(kind, key),
      );
    return key;
  }
}

export function compatibleVersion(
  requirement:
    { selection: "exact"; version: string } | { selection: "allowed_range"; expression: string },
  exactVersion: string,
) {
  if (requirement.selection === "exact") return requirement.version === exactVersion;
  return satisfies(exactVersion, requirement.expression, { includePrerelease: false });
}

export function exactVersion(
  resolution: Resolution,
  key: string,
  kind: "module" | "connection_type",
  requirement:
    { selection: "exact"; version: string } | { selection: "allowed_range"; expression: string },
) {
  const definition = resolution.definition(key, kind);
  if (!compatibleVersion(requirement, definition.exactVersion))
    fail(
      "vortex.definition.incompatible_version",
      "incompatible_version",
      resolution.location(kind, key),
    );
  return definition.exactVersion;
}
