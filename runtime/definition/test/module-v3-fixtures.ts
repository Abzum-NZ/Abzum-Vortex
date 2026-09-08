import fs from "node:fs";
import path from "node:path";
import {
  moduleSourceDocumentV3Schema,
  moduleCompilationRequestV3Schema,
  type ModuleSourceDocumentV3,
  type ModuleCompilationRequestV3,
} from "@vortex/contracts";
import { fingerprintCanonicalValue } from "../src/canonical-json";
import { extractModuleSourceIdentityRequirementsV3 } from "../src/source-identities";

export const graphModuleFixture = (name: "candidate" | "shared"): ModuleSourceDocumentV3 =>
  moduleSourceDocumentV3Schema.parse(
    JSON.parse(
      fs.readFileSync(
        path.resolve(
          import.meta.dirname,
          `../../../testing/fixtures/rule-graphs/${name}-module.source.json`,
        ),
        "utf8",
      ),
    ),
  );

export const graphModuleRequests = (
  sources: readonly ModuleSourceDocumentV3[] = [
    graphModuleFixture("shared"),
    graphModuleFixture("candidate"),
  ],
): ModuleCompilationRequestV3[] => {
  let nextId = 1;
  const id = () => `90000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
  const roots = new Map(sources.map((source) => [source.key, id()]));
  const identities = sources.flatMap((source) =>
    extractModuleSourceIdentityRequirementsV3(source).flatMap((requirement) => {
      const identifier = requirement.kind === "root" ? roots.get(source.key)! : id();
      return requirement.aliases.map((alias) => ({
        definitionKey: source.key,
        scope: requirement.scope,
        kind: requirement.kind,
        componentOwner: requirement.componentOwner,
        alias,
        identifier,
      }));
    }),
  );
  const resolution = {
    contractVersion: "3.0.0" as const,
    definitions: sources.map((source) => ({
      kind: "module" as const,
      key: source.key,
      rootId: roots.get(source.key)!,
      exactVersion: "1.0.0",
    })),
    identities,
  };
  return sources.map((source) =>
    moduleCompilationRequestV3Schema.parse({
      sourceContractVersion: "3.0.0",
      validationContractVersion: "3.0.0",
      source,
      resolution: { ...resolution, fingerprint: fingerprintCanonicalValue(resolution) },
      draftMetadata: {
        organizationId: "10000000-0000-4000-8000-000000000001",
        draftRevision: 1,
        createdAt: "2026-09-09T00:00:00+00:00",
        updatedAt: "2026-09-09T00:00:00+00:00",
        createdBy: "10000000-0000-4000-8000-000000000002",
        updatedBy: "10000000-0000-4000-8000-000000000002",
      },
    }),
  );
};
