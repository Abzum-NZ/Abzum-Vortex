import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const expectedEngines = [
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
];

const dependencyFields = ["dependencies", "devDependencies", "peerDependencies"];
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const allowedEnvironmentDependencies = {
  app: new Set(["browser", "server", "shared"]),
  browser: new Set(["browser", "shared"]),
  server: new Set(["server", "shared"]),
  shared: new Set(["shared"]),
  test: new Set(["app", "browser", "server", "shared", "test"]),
};

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".next", "coverage", "dist", "node_modules"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else files.push(target);
  }
  return files;
}

export async function loadWorkspace(root) {
  const rootManifest = await readJson(path.join(root, "package.json"));
  const locations = [];
  for (const workspace of rootManifest.workspaces ?? []) {
    if (!workspace.endsWith("/*")) {
      locations.push(workspace);
      continue;
    }
    const parent = workspace.slice(0, -2);
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) locations.push(path.join(parent, entry.name));
    }
  }

  return Promise.all(
    locations.map(async (location) => {
      const directory = path.join(root, location);
      return { directory, manifest: await readJson(path.join(directory, "package.json")) };
    }),
  );
}

export function validateGraph(packages) {
  const errors = [];
  const byName = new Map();

  for (const item of packages) {
    const { manifest } = item;
    if (byName.has(manifest.name)) errors.push(`Duplicate package name: ${manifest.name}`);
    byName.set(manifest.name, item);
    if (!manifest.vortex) {
      errors.push(`${manifest.name} has no vortex boundary metadata`);
      continue;
    }
    if (!Number.isInteger(manifest.vortex.tier) || manifest.vortex.tier < 0) {
      errors.push(`${manifest.name} has an invalid tier`);
    }
    if (!["app", "browser", "server", "shared", "test"].includes(manifest.vortex.environment)) {
      errors.push(`${manifest.name} has an invalid environment`);
    }
    if (typeof manifest.vortex.ships !== "boolean") {
      errors.push(`${manifest.name} must declare whether it ships`);
    }
    if (!manifest.exports?.["."]) errors.push(`${manifest.name} has no public root export`);
    if (
      manifest.vortex.environment === "server" &&
      manifest.dependencies?.["server-only"] !== "0.0.1"
    ) {
      errors.push(`${manifest.name} must carry the server-only marker`);
    }
  }

  const roots = packages.filter(({ manifest }) => manifest.vortex?.compositionRoot);
  if (roots.length !== 1 || roots[0]?.manifest.name !== "@vortex/web") {
    errors.push("@vortex/web must be the only composition root");
  }

  const engines = packages
    .filter(({ manifest }) => manifest.vortex?.engine)
    .map(({ manifest }) => manifest.vortex.service)
    .sort();
  if (JSON.stringify(engines) !== JSON.stringify(expectedEngines)) {
    errors.push(`Runtime engine set differs from the required 16: ${engines.join(", ")}`);
  }
  for (const { manifest } of packages.filter(({ manifest }) => manifest.vortex?.engine)) {
    if (manifest.name !== `@vortex/${manifest.vortex.service}`) {
      errors.push(`${manifest.name} does not match service ${manifest.vortex.service}`);
    }
  }

  for (const { manifest } of packages) {
    const metadata = manifest.vortex;
    if (!metadata) continue;
    for (const field of dependencyFields) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (!dependency.startsWith("@vortex/")) continue;
        const target = byName.get(dependency);
        if (!target) {
          errors.push(`${manifest.name} declares missing workspace dependency ${dependency}`);
          continue;
        }
        const targetMetadata = target.manifest.vortex;
        if (targetMetadata.tier >= metadata.tier) {
          errors.push(`${manifest.name} cannot depend on same/higher tier ${dependency}`);
        }
        if (metadata.ships && !targetMetadata.ships) {
          errors.push(`${manifest.name} cannot ship with non-shipping dependency ${dependency}`);
        }
        if (
          !allowedEnvironmentDependencies[metadata.environment]?.has(targetMetadata.environment)
        ) {
          errors.push(
            `${manifest.name} ${metadata.environment} code cannot depend on ${targetMetadata.environment} package ${dependency}`,
          );
        }
      }
    }
  }
  return errors;
}

export async function validateImports(packages) {
  const errors = [];
  for (const { directory, manifest } of packages) {
    const declared = new Set(
      dependencyFields.flatMap((field) => Object.keys(manifest[field] ?? {})),
    );
    const files = (await walk(directory)).filter((file) =>
      sourceExtensions.has(path.extname(file)),
    );
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(
        /(?:from\s+|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']+)["']/g,
      )) {
        const request = match[1];
        if (/(^|[\\/])(migrations|workflows)([\\/]|$)/.test(request)) {
          errors.push(`${file} imports non-package operational directory ${request}`);
        }
        if (request.startsWith(".")) {
          const resolved = path.resolve(path.dirname(file), request);
          const relative = path.relative(directory, resolved);
          if (relative.startsWith("..") || path.isAbsolute(relative)) {
            errors.push(`${file} uses relative import outside its package ${request}`);
          }
          continue;
        }
        if (request.startsWith("node:")) continue;

        const segments = request.split("/");
        const packageName = request.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
        if (request.startsWith("@vortex/") && segments.length > 2) {
          const target = packages.find((item) => item.manifest.name === packageName);
          const publicSubpath = `./${segments.slice(2).join("/")}`;
          const exports = target?.manifest.exports;
          if (
            exports === null ||
            typeof exports !== "object" ||
            !Object.prototype.hasOwnProperty.call(exports, publicSubpath)
          )
            errors.push(`${file} uses forbidden deep import ${request}`);
        }
        if (!declared.has(packageName)) {
          errors.push(`${file} imports undeclared dependency ${packageName}`);
        }
      }
    }
  }
  return errors;
}
