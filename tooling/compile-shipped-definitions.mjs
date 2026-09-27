import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

// The pinned workspace installs tsx as a transitive tool. Locate its loader for this offline
// comparison without adding a production package dependency.
if (!process.argv.includes("--worker")) {
  const virtualStore = path.join(root, "node_modules", ".pnpm");
  const tsxDirectory = readdirSync(virtualStore).find((name) => name.startsWith("tsx@"));
  if (!tsxDirectory)
    throw new Error("The offline definition compiler needs the installed tsx loader");
  const loader = pathToFileURL(
    path.join(virtualStore, tsxDirectory, "node_modules", "tsx", "dist", "loader.mjs"),
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      loader,
      fileURLToPath(import.meta.url),
      "--worker",
      ...process.argv.slice(2),
    ],
    { cwd: root, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
  );
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  process.exitCode = result.status ?? 1;
} else {
  const { compileDefinitionWithContext } = await import("../runtime/definition/src/compiler.ts");
  const { canonicalJson, fingerprintCanonicalValue } =
    await import("../runtime/definition/src/canonical-json.ts");
  const {
    extractApplicationSourceIdentityRequirementsV2,
    extractModuleSourceIdentityRequirementsV3,
  } = await import("../runtime/definition/src/source-identities.ts");
  const {
    applicationCompilationRequestV2Schema,
    DEFAULT_PLATFORM_THEME_RELEASE_V2,
    IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
    sourceIdentityKindV2Schema,
    sourceProvenanceRegistry,
    jsonValueSchema,
    moduleSourceDocumentSchema,
    applicationSourceDocumentV2Schema,
    connectionTypeSourceDocumentSchema,
  } = await import("../contracts/src/index.ts");

  if (process.argv.includes("--audit")) {
    const missing = [];
    const seen = new WeakSet();
    const seenLazyGetters = new WeakSet();
    const inspect = (schema, path) => {
      if (seen.has(schema)) return;
      seen.add(schema);
      if (schema === jsonValueSchema || sourceProvenanceRegistry.get(schema)?.includeDescendants)
        return;
      const definition = schema._zod.def;
      switch (definition.type) {
        case "object":
          for (const [key, child] of Object.entries(definition.shape)) {
            if (!sourceProvenanceRegistry.get(child)) missing.push([...path, key].join("/"));
            inspect(child, [...path, key]);
          }
          break;
        case "array":
          inspect(definition.element, [...path, "#"]);
          break;
        case "record":
          inspect(definition.valueType, [...path, "*"]);
          break;
        case "tuple":
          definition.items.forEach((child, index) => inspect(child, [...path, String(index)]));
          break;
        case "union":
          definition.options.forEach((child, index) => inspect(child, [...path, `option${index}`]));
          break;
        case "pipe":
          inspect(definition.out, path);
          break;
        case "lazy":
          if (!seenLazyGetters.has(definition.getter)) {
            seenLazyGetters.add(definition.getter);
            inspect(definition.getter(), path);
          }
          break;
        case "optional":
        case "nullable":
        case "default":
        case "readonly":
          inspect(definition.innerType, path);
          break;
      }
    };
    inspect(moduleSourceDocumentSchema, ["module"]);
    inspect(applicationSourceDocumentV2Schema, ["application"]);
    inspect(connectionTypeSourceDocumentSchema, ["connection"]);
    process.stdout.write(
      `${JSON.stringify({ missingCount: missing.length, missing: missing.slice(0, 100) }, null, 2)}\n`,
    );
    process.exit(0);
  }

  const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  const uuidFor = (key) => {
    const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const draftMetadata = {
    organizationId: "10000000-0000-4000-a000-000000000001",
    draftRevision: 1,
    createdAt: "2026-09-01T00:00:00+00:00",
    createdBy: "10000000-0000-4000-a000-000000000002",
    updatedAt: "2026-09-01T00:00:00+00:00",
    updatedBy: "10000000-0000-4000-a000-000000000002",
  };
  const sources = [];
  const failures = [];
  const modulesRoot = path.join(root, "modules", "src");
  for (const directory of readdirSync(modulesRoot, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    for (const kind of ["module", "application"]) {
      const relativePath = `modules/src/${directory.name}/${kind}.ts`;
      if (!existsSync(path.join(root, relativePath))) continue;
      try {
        const exports = await import(`../${relativePath}`);
        const values = Object.values(exports).flatMap((value) =>
          Array.isArray(value) ? value : [value],
        );
        for (const source of values) {
          if (source?.kind !== kind) continue;
          sources.push({ path: relativePath, source });
        }
      } catch (error) {
        failures.push({ path: relativePath, stage: "source import", error: String(error) });
      }
    }
  }
  sources.sort((left, right) => left.source.key.localeCompare(right.source.key));
  const definitions = sources.map(({ source }) => ({
    kind: source.kind,
    key: source.key,
    rootId: uuidFor(`root:${source.kind}:${source.key}`),
    exactVersion: "1.0.0",
  }));
  const requirements = sources.flatMap(({ source }) =>
    source.kind === "module"
      ? extractModuleSourceIdentityRequirementsV3(source)
      : extractApplicationSourceIdentityRequirementsV2(source),
  );
  const identities = requirements.flatMap((requirement) => {
    const identifier =
      requirement.kind === "root"
        ? definitions.find(({ key }) => key === requirement.definitionKey).rootId
        : uuidFor(
            `${requirement.definitionKey}:${requirement.ownerScope}:${requirement.kind}:${requirement.componentOwner}`,
          );
    return requirement.aliases.map((alias) => ({
      definitionKey: requirement.definitionKey,
      scope: requirement.scope,
      kind: requirement.kind,
      componentOwner: requirement.componentOwner,
      alias,
      identifier,
    }));
  });
  const snapshot = (contractVersion) => {
    const allowedIdentities =
      contractVersion === "2.0.0"
        ? identities.filter(({ kind }) => sourceIdentityKindV2Schema.safeParse(kind).success)
        : identities;
    const evidence = { contractVersion, definitions, identities: allowedIdentities };
    return { ...evidence, fingerprint: fingerprintCanonicalValue(evidence) };
  };
  const catalogueEvidence = {
    contractVersion: "2.0.0",
    platformBlocks: {
      ...IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2,
      releases: [...IMMUTABLE_PLATFORM_BLOCK_CATALOGUE_V2.releases].sort((left, right) =>
        `${left.blockId}@${left.releaseVersion}`.localeCompare(
          `${right.blockId}@${right.releaseVersion}`,
        ),
      ),
    },
    platformTheme: DEFAULT_PLATFORM_THEME_RELEASE_V2,
  };
  const catalogueSnapshot = {
    ...catalogueEvidence,
    fingerprint: fingerprintCanonicalValue(catalogueEvidence),
  };
  const outputs = [];
  const results = [];
  for (const { path: sourcePath, source } of sources) {
    try {
      const request =
        source.kind === "module"
          ? {
              sourceContractVersion: "3.0.0",
              validationContractVersion: "3.0.0",
              source,
              resolution: snapshot("3.0.0"),
              draftMetadata,
              savedConditionRevisions: identities
                .filter(
                  ({ definitionKey, kind }) =>
                    definitionKey === source.key && kind === "sharing_condition",
                )
                .map(({ identifier }) => identifier)
                .filter((identifier, index, all) => all.indexOf(identifier) === index)
                .map((identifier) => ({ conditionId: identifier, revision: 1 })),
            }
          : {
              sourceContractVersion: "2.0.0",
              validationContractVersion: "2.0.0",
              source,
              resolution: snapshot("2.0.0"),
              catalogueSnapshot,
              draftMetadata,
            };
      if (source.kind === "application") {
        const parsed = applicationCompilationRequestV2Schema.safeParse(request);
        if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
      }
      const output = compileDefinitionWithContext(request, { dependencyOutputs: outputs });
      outputs.push(output);
      results.push({
        path: sourcePath,
        kind: source.kind,
        key: source.key,
        sha256: sha256(canonicalJson(output)),
      });
    } catch (error) {
      failures.push({
        path: sourcePath,
        kind: source.kind,
        key: source.key,
        stage: "compile",
        error: String(error),
        location: error.location,
      });
    }
  }
  results.sort((left, right) => left.key.localeCompare(right.key));
  failures.sort((left, right) => left.path.localeCompare(right.path));
  process.stdout.write(
    `${JSON.stringify({ discovered: sources.length, compiled: results.length, results, failures }, null, 2)}\n`,
  );
}
