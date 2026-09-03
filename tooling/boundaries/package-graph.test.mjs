import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { validateGraph, validateImports } from "./package-graph.mjs";

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const item = (name, tier, environment, extra = {}) => ({
  directory: name,
  manifest: {
    name,
    exports: { ".": "./src/index.ts" },
    dependencies: environment === "server" ? { "server-only": "0.0.1" } : undefined,
    vortex: {
      tier,
      environment,
      ships: true,
      ...(extra.engine ? { service: name.replace("@vortex/", "") } : {}),
      ...extra,
    },
  },
});

const validPackages = () => [
  item("@vortex/contracts", 0, "shared"),
  ...[
    "access",
    "app",
    "connection",
    "definition",
    "event",
    "file",
    "identity",
    "interface",
    "module",
    "page",
    "query",
    "record",
    "rule",
    "search",
    "theme",
    "workflow",
  ].map((name) => item(`@vortex/${name}`, 1, "shared", { engine: true })),
  item("@vortex/web", 2, "app", { compositionRoot: true }),
];

describe("workspace boundaries", () => {
  test("accepts the exact engine set and one composition root", () => {
    expect(validateGraph(validPackages())).toEqual([]);
  });

  test("rejects upward dependencies", () => {
    const packages = validPackages();
    packages[0].manifest.dependencies = { "@vortex/web": "workspace:*" };
    expect(validateGraph(packages)).toContain(
      "@vortex/contracts cannot depend on same/higher tier @vortex/web",
    );
  });

  test("rejects equal-tier dependencies", () => {
    const packages = validPackages();
    packages[2].manifest.dependencies = { "@vortex/access": "workspace:*" };
    expect(validateGraph(packages).some((error) => error.includes("same/higher tier"))).toBe(true);
  });

  test("rejects server dependencies from browser packages", () => {
    const packages = validPackages();
    packages.push(item("@vortex/server-example", 0, "server"));
    packages.push({
      ...item("@vortex/browser-example", 2, "browser"),
      manifest: {
        ...item("@vortex/browser-example", 2, "browser").manifest,
        dependencies: { "@vortex/server-example": "workspace:*" },
      },
    });
    expect(validateGraph(packages)).toContain(
      "@vortex/browser-example browser code cannot depend on server package @vortex/server-example",
    );
  });

  test("rejects shipping dependencies on testing packages", () => {
    const packages = validPackages();
    packages.push(item("@vortex/testing", 0, "test", { ships: false }));
    packages[packages.length - 2].manifest.dependencies = { "@vortex/testing": "workspace:*" };
    expect(validateGraph(packages)).toContain(
      "@vortex/web cannot ship with non-shipping dependency @vortex/testing",
    );
  });

  test("rejects missing metadata and a second composition root", () => {
    const packages = validPackages();
    packages.push({
      directory: "bad",
      manifest: { name: "@vortex/bad", exports: { ".": "./src/index.ts" } },
    });
    packages.push(item("@vortex/other-root", 3, "app", { compositionRoot: true }));
    expect(validateGraph(packages)).toContain("@vortex/bad has no vortex boundary metadata");
    expect(validateGraph(packages)).toContain("@vortex/web must be the only composition root");
  });

  test("rejects a duplicate or unknown service and accepts an unrelated lower tier", () => {
    const packages = validPackages();
    packages.push(item("@vortex/extra-contract", 0, "shared"));
    expect(validateGraph(packages)).toEqual([]);
    packages.push(item("@vortex/extra-contract", 0, "shared"));
    expect(validateGraph(packages)).toContain("Duplicate package name: @vortex/extra-contract");
    packages.pop();
    packages[1].manifest.vortex.service = "unknown";
    expect(validateGraph(packages).some((error) => error.includes("required 16"))).toBe(true);
  });

  test("rejects undeclared and deep imports in an isolated package", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vortex-boundary-"));
    temporaryDirectories.push(directory);
    const source = path.join(directory, "src");
    await mkdir(source);
    await writeFile(
      path.join(source, "index.ts"),
      'import { value } from "@vortex/contracts/internal";\nexport { value };\n',
    );
    const errors = await validateImports([
      {
        directory,
        manifest: {
          name: "@vortex/example",
          dependencies: {},
          exports: { ".": "./src/index.ts" },
          vortex: { tier: 1, environment: "shared", ships: true },
        },
      },
    ]);
    expect(errors.some((error) => error.includes("forbidden deep import"))).toBe(true);
    expect(errors.some((error) => error.includes("undeclared dependency"))).toBe(true);
  });

  test("accepts a declared package export subpath", async () => {
    const consumerDirectory = await mkdtemp(path.join(tmpdir(), "vortex-boundary-consumer-"));
    const providerDirectory = await mkdtemp(path.join(tmpdir(), "vortex-boundary-provider-"));
    temporaryDirectories.push(consumerDirectory, providerDirectory);
    await mkdir(path.join(consumerDirectory, "src"));
    await mkdir(path.join(providerDirectory, "src"));
    await writeFile(
      path.join(consumerDirectory, "src", "index.ts"),
      'import { value } from "@vortex/provider/compiler";\nexport { value };\n',
    );
    await writeFile(
      path.join(providerDirectory, "src", "compiler.ts"),
      "export const value = 1;\n",
    );
    const errors = await validateImports([
      {
        directory: consumerDirectory,
        manifest: {
          name: "@vortex/consumer",
          dependencies: { "@vortex/provider": "workspace:*" },
          exports: { ".": "./src/index.ts" },
          vortex: { tier: 2, environment: "server", ships: false },
        },
      },
      {
        directory: providerDirectory,
        manifest: {
          name: "@vortex/provider",
          dependencies: {},
          exports: { ".": "./src/index.ts", "./compiler": "./src/compiler.ts" },
          vortex: { tier: 1, environment: "server", ships: true },
        },
      },
    ]);
    expect(errors).toEqual([]);
  });

  test("rejects undeclared external dependencies and relative package escapes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vortex-boundary-"));
    temporaryDirectories.push(directory);
    const source = path.join(directory, "src");
    await mkdir(source);
    await writeFile(
      path.join(source, "index.ts"),
      'import value from "zod";\nexport { other } from "../../outside";\nexport { value };\n',
    );
    const errors = await validateImports([
      {
        directory,
        manifest: {
          name: "@vortex/example",
          dependencies: {},
          exports: { ".": "./src/index.ts" },
          vortex: { tier: 1, environment: "shared", ships: true },
        },
      },
    ]);
    expect(errors.some((error) => error.includes("undeclared dependency zod"))).toBe(true);
    expect(errors.some((error) => error.includes("relative import outside its package"))).toBe(
      true,
    );
  });
});
