import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  definitionCompilerRefusalCodes,
  DefinitionCompilationError,
  type DefinitionCompilerRefusalCode,
  isDefinitionCompilerRefusalCode,
} from "../src/compilation-error";
import { definitionSemanticRules } from "../src/validation";

const sourceDirectory = path.resolve(import.meta.dirname, "../src");
const compilerErrorLiteralPattern =
  /(?:\bfail|\bnew\s+DefinitionCompilationError)\(\s*["'](vortex\.definition\.[a-z0-9_]+)["']/g;

const emittedLiteralCodes = (): string[] => {
  const sourceFiles = fs
    .readdirSync(sourceDirectory)
    .filter((name) => name.endsWith(".ts") && name !== "compilation-error.ts");
  const codes = new Set<string>();

  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(sourceDirectory, file), "utf8");
    for (const match of source.matchAll(compilerErrorLiteralPattern)) codes.add(match[1]!);
  }

  return [...codes].sort();
};

describe("definition compiler refusal codes", () => {
  it("registers every direct and semantic refusal emitted by the definition runtime", () => {
    expect(
      emittedLiteralCodes().every((code) => definitionCompilerRefusalCodes.includes(code as never)),
    ).toBe(true);
    expect(
      definitionSemanticRules
        .flatMap((rule) => rule.emittedCodes)
        .every((code) => definitionCompilerRefusalCodes.includes(code as never)),
    ).toBe(true);
    expect(new Set(definitionCompilerRefusalCodes).size).toBe(
      definitionCompilerRefusalCodes.length,
    );
  });

  it("keeps the error boundary closed to the registered code catalogue", () => {
    const registeredCode: DefinitionCompilerRefusalCode =
      "vortex.definition.invalid_compilation_request";
    const error = new DefinitionCompilationError(registeredCode, "invalid_value");

    expect(error.ruleCode).toBe(registeredCode);
    expect(isDefinitionCompilerRefusalCode(registeredCode)).toBe(true);
    expect(isDefinitionCompilerRefusalCode("vortex.definition.unregistered_refusal")).toBe(false);
    expect(
      () =>
        new DefinitionCompilationError("vortex.definition.unregistered_refusal", "invalid_value"),
    ).toThrowError("Unregistered definition compiler refusal code");
  });
});
