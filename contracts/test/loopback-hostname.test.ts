import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isLoopbackHostname } from "../src/loopback-hostname";

describe("isLoopbackHostname", () => {
  it.each(["127.0.0.1", "localhost", "[::1]"])("accepts the exact spelling %s", (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true);
  });

  it.each([
    "localhost.evil.example",
    "127.0.0.1.evil.example",
    "0.0.0.0",
    "[::2]",
    "127.0.0.2",
    "",
  ])("rejects the look-alike or unrelated host %j", (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(false);
  });
});

// Repository scan: the loopback allowlist is a security-relevant predicate. It must be
// written down exactly once so it cannot silently drift back into per-site copies.
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const predicateModule = path.join(repositoryRoot, "contracts/src/loopback-hostname.ts");
const excludedDirectoryNames = new Set(["node_modules", "test", "tests", "__tests__"]);
const sourceExtensions = new Set([".ts", ".tsx"]);
const loopbackLiteral = "[::1]";

const collectSourceFiles = (directory: string): string[] => {
  if (!fs.existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excludedDirectoryNames.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(entryPath));
      continue;
    }
    if (!sourceExtensions.has(path.extname(entry.name))) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
    files.push(entryPath);
  }
  return files;
};

const runtimePackageSourceRoots = (): string[] => {
  const runtimeDirectory = path.join(repositoryRoot, "runtime");
  return fs
    .readdirSync(runtimeDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runtimeDirectory, entry.name, "src"))
    .filter((candidate) => fs.existsSync(candidate));
};

describe("loopback hostname literal ownership", () => {
  it("keeps the literal [::1] written in exactly one source module", () => {
    const scannedRoots = [
      path.join(repositoryRoot, "contracts/src"),
      path.join(repositoryRoot, "db/src"),
      ...runtimePackageSourceRoots(),
      path.join(repositoryRoot, "apps/web/app"),
    ];

    const filesContainingTheLiteral = scannedRoots
      .flatMap((root) => collectSourceFiles(root))
      .filter((file) => fs.readFileSync(file, "utf8").includes(loopbackLiteral));

    expect(filesContainingTheLiteral).toEqual([predicateModule]);
  });
});
