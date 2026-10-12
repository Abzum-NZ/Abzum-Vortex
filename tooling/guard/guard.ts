import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative, extname, basename, dirname } from "node:path";
import ts from "typescript";
import { packageAreas, paths } from "./config.ts";

type Finding = { rule: string; file: string; line: number; detail: string; id: string };
const root = resolve(import.meta.dirname, "../..");
const baselinePath = resolve(import.meta.dirname, "baseline.json");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".sql"]);
const findings: Finding[] = [];
const occurrences = new Map<string, number>();
const normalize = (value: string) => value.replaceAll("\\", "/");
const read = (file: string) => readFileSync(resolve(root, file), "utf8").replaceAll("\r\n", "\n");
const lineAt = (content: string, offset: number) => content.slice(0, offset).split("\n").length;
function add(rule: string, file: string, line: number, detail: string): void {
  const base = `${rule}|${file}|${rule === "file-size" ? "over 1500 lines" : detail}`;
  const count = (occurrences.get(base) ?? 0) + 1;
  occurrences.set(base, count);
  const id = `${base}|${count}`;
  findings.push({ rule, file, line, detail, id });
}
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root },
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .map(normalize)
  .filter((file) => existsSync(resolve(root, file)));
const codeFiles = files.filter(
  (file) => sourceExtensions.has(extname(file)) && !file.startsWith("tooling/guard/"),
);
function area(file: string): string {
  for (const [name, prefixes] of Object.entries(paths)) {
    if (Array.isArray(prefixes) && prefixes.some((prefix) => file.startsWith(prefix))) return name;
  }
  return "other";
}
function importedArea(specifier: string, file: string): string {
  if (specifier.startsWith(".")) {
    const target = normalize(relative(root, resolve(root, dirname(file), specifier)));
    return area(target);
  }
  if (specifier.startsWith("@vortex/platform/schema")) return "schema";
  if (specifier.startsWith("@vortex/platform/server")) return "platform";
  if (specifier.startsWith("@vortex/")) {
    const key = specifier.split("/").slice(0, 2).join("/");
    return packageAreas[key] ?? "platform";
  }
  return "other";
}
const applicationFiles = files.filter(
  (file) => file.startsWith(paths.applicationSources) && /\/application\.json$/.test(file),
);
const names = new Set<string>();
for (const file of applicationFiles) {
  const source = JSON.parse(read(file)) as { key?: string; body?: { name?: string } };
  if (source.key) names.add(source.key);
  if (source.body?.name) names.add(source.body.name);
}
const businessPattern = new RegExp(
  `(?<![\\w])(?:${[...names]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![\\w])`,
  "gi",
);

for (const file of codeFiles) {
  const content = read(file);
  if (content.split("\n").length > 1500)
    add("file-size", file, 1501, `${content.split("\n").length} lines`);
  if (/-v[2-9]\d*(?=\.)/i.test(basename(file))) add("versioned-file", file, 1, basename(file));
  const fileArea = area(file);
  if (
    ["platform", "schema", "ui", "web"].includes(fileArea) &&
    !paths.developmentSetup.some((prefix) => file.startsWith(prefix))
  ) {
    for (const match of content.matchAll(businessPattern))
      add("business-name", file, lineAt(content, match.index), match[0].toLowerCase());
  }
  if (file.endsWith(".sql")) {
    if (file.startsWith(paths.canonical) || file.startsWith(paths.migrations)) {
      for (const match of content.matchAll(
        /\bcreate\s+(?:or\s+replace\s+)?(?:table|function|view|materialized\s+view|index|type|sequence|trigger)\s+(?:if\s+not\s+exists\s+)?(?:[\w"]+\.)?[\w"]*(?:receipt|fingerprint|continuity|evidence)[\w"]*/gi,
      )) {
        if (!/command_receipts\b/i.test(match[0]))
          add(
            "process-artifact",
            file,
            lineAt(content, match.index),
            match[0].replace(/\s+/g, " ").toLowerCase(),
          );
      }
    }
    continue;
  }
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier))
        checkImport(specifier.text, specifier.getStart(source));
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(source) === "require")
    ) {
      checkImport(node.arguments[0].text, node.getStart(source));
    }
    if (
      (ts.isVariableStatement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      const namesToCheck = ts.isVariableStatement(node)
        ? node.declarationList.declarations.map((declaration) => declaration.name)
        : [node.name];
      for (const name of namesToCheck)
        if (name && /V[2-9]\d*$/.test(name.getText(source)))
          add(
            "versioned-export",
            file,
            lineAt(content, name.getStart(source)),
            name.getText(source),
          );
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements)
        if (/V[2-9]\d*$/.test(element.name.text))
          add(
            "versioned-export",
            file,
            lineAt(content, element.getStart(source)),
            element.name.text,
          );
    }
    if (
      fileArea !== "other" &&
      ts.isIdentifier(node) &&
      /(?:receipt|fingerprint|continuity|evidence)/i.test(node.text) &&
      node.text !== "command_receipts"
    ) {
      add("process-artifact", file, lineAt(content, node.getStart(source)), node.text);
    }
    ts.forEachChild(node, visit);
  }
  function checkImport(specifier: string, offset: number): void {
    const target = importedArea(specifier, file);
    const invalid =
      (target === "web" && fileArea !== "web") ||
      (fileArea === "platform" && (target === "ui" || target === "definitions")) ||
      ((fileArea === "ui" || fileArea === "definitions") &&
        (target === "platform" ||
          target === "web" ||
          (target === "definitions" && fileArea === "ui") ||
          (target === "ui" && fileArea === "definitions")));
    if (invalid) add("layering", file, lineAt(content, offset), specifier);
  }
  visit(source);
  if (fileArea === "platform" || fileArea === "schema") {
    // Match a parsed value and a later failure branch in the same source region.
    for (const match of content.matchAll(
      /\b(?:const|let)\s+(\w+)\s*=\s*[^;]{0,300}?\.safeParse\s*\(/g,
    )) {
      const variable = match[1];
      const tail = content.slice(match.index + match[0].length, match.index + 4000);
      const failure = new RegExp(
        `if\\s*\\(\\s*!\\s*${variable}\\.success\\s*\\)|if\\s*\\(\\s*${variable}\\.success\\s*===?\\s*false\\s*\\)`,
        "g",
      ).exec(tail);
      if (!failure) continue;
      const branch = tail.slice(failure.index, failure.index + 600);
      const nextClose = branch.indexOf("}");
      const body = nextClose < 0 ? branch : branch.slice(0, nextClose);
      if (
        /return\s+(?:null|undefined|false)\s*;/.test(body) &&
        !/(?:console\.|logger\.|log\(|captureException\()/i.test(body)
      ) {
        add(
          "silent-parse",
          file,
          lineAt(content, match.index + match[0].length + failure.index),
          variable,
        );
      }
    }
  }
}

const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const functionPattern = /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"?\w+"?\.)?"?\w+"?\s*\(/gi;
function functions(
  content: string,
): Map<string, { definition: string; offset: number; body: string }> {
  const result = new Map<string, { definition: string; offset: number; body: string }>();
  for (const match of content.matchAll(functionPattern)) {
    const start = match.index;
    const headerEnd = content.indexOf(")", start) + 1;
    if (!headerEnd) continue;
    const header = content.slice(start, headerEnd).replace(/\s+/g, " ").toLowerCase();
    const tag = /\bas\s+(\$[\w]*\$)/i.exec(content.slice(headerEnd, headerEnd + 1000));
    if (!tag) continue;
    const bodyStart = content.indexOf(tag[1], headerEnd) + tag[1].length;
    const bodyEnd = content.indexOf(tag[1], bodyStart);
    if (bodyEnd < 0) continue;
    const end = content.indexOf(";", bodyEnd + tag[1].length);
    if (end < 0) continue;
    result.set(header, {
      definition: content.slice(start, end + 1).trim(),
      offset: start,
      body: content.slice(bodyStart, bodyEnd),
    });
  }
  return result;
}
const latest = new Map<string, { definition: string; file: string }>();
for (const file of files
  .filter((file) => file.startsWith(paths.migrations) && file.endsWith(".sql"))
  .sort()) {
  for (const [key, value] of functions(read(file)))
    latest.set(key, { definition: value.definition, file });
}
for (const file of files.filter(
  (file) => file.startsWith(paths.canonical) && file.endsWith(".sql"),
)) {
  const content = read(file);
  for (const [key, value] of functions(content)) {
    const migration = latest.get(key);
    if (
      !migration ||
      migration.definition.replace(/\s+/g, " ") !== value.definition.replace(/\s+/g, " ")
    ) {
      add(
        "migration-mismatch",
        file,
        lineAt(content, value.offset),
        `${key} vs ${migration?.file ?? "missing migration"}`,
      );
    }
    for (const match of value.body.matchAll(uuidPattern))
      if (match[0].toLowerCase() !== "00000000-0000-0000-0000-000000000000") {
        add(
          "function-uuid",
          file,
          lineAt(content, value.offset + value.definition.indexOf(value.body) + match.index),
          match[0].toLowerCase(),
        );
      }
  }
}
for (const file of files.filter(
  (file) => file.startsWith(paths.migrations) && file.endsWith(".sql"),
)) {
  const content = read(file);
  for (const value of functions(content).values())
    for (const match of value.body.matchAll(uuidPattern)) {
      if (match[0].toLowerCase() !== "00000000-0000-0000-0000-000000000000")
        add(
          "function-uuid",
          file,
          lineAt(content, value.offset + value.definition.indexOf(value.body) + match.index),
          match[0].toLowerCase(),
        );
    }
}

const knip = spawnSync(
  process.execPath,
  [
    resolve(root, "node_modules/knip/bin/knip.js"),
    "--reporter",
    "json",
    "--include",
    "files,exports,dependencies",
    "--no-progress",
    "--no-exit-code",
    "--include-entry-exports",
    "--cache",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
if (knip.error || !knip.stdout)
  throw new Error(`Knip failed: ${knip.error?.message ?? knip.stderr}`);
const report = JSON.parse(knip.stdout.slice(knip.stdout.indexOf("{"))) as {
  files?: string[];
  issues?: Array<{
    file: string;
    exports?: Array<{ name: string; line?: number }>;
    dependencies?: Array<{ name: string; line?: number }>;
  }>;
};
for (const file of report.files ?? []) add("unused-file", normalize(file), 1, "unused file");
for (const issue of report.issues ?? []) {
  for (const item of issue.exports ?? [])
    add("unused-export", normalize(issue.file), item.line ?? 1, item.name);
  for (const item of issue.dependencies ?? [])
    add("unused-dependency", normalize(issue.file), item.line ?? 1, item.name);
}
const unique = [...new Map(findings.map((finding) => [finding.id, finding])).values()].sort(
  (a, b) => a.id.localeCompare(b.id),
);
const hasBaseline = existsSync(baselinePath);
const baseline = hasBaseline ? (JSON.parse(readFileSync(baselinePath, "utf8")) as string[]) : [];
const mainBaseline = spawnSync("git", ["show", "origin/main:tooling/guard/baseline.json"], {
  cwd: root,
  encoding: "utf8",
});
const allowed =
  mainBaseline.status === 0 ? new Set(JSON.parse(mainBaseline.stdout) as string[]) : null;
const growth = allowed ? baseline.filter((id) => !allowed.has(id)) : [];
const current = new Set(unique.map((finding) => finding.id));
const old = new Set(baseline);
const added = unique.filter((finding) => !old.has(finding.id));
const stale = baseline.filter((id) => !current.has(id));
if (process.argv.includes("--update-baseline")) {
  if (growth.length) throw new Error(`Baseline cannot grow: ${growth[0]}`);
  if (hasBaseline && added.length)
    throw new Error(
      `Baseline cannot grow: ${added[0].file}:${added[0].line} ${added[0].rule} ${added[0].detail}`,
    );
  writeFileSync(
    baselinePath,
    `${JSON.stringify(hasBaseline ? baseline.filter((id) => current.has(id)) : unique.map((finding) => finding.id), null, 2)}\n`,
  );
  console.log(
    `Baseline contains ${baseline.length ? baseline.length - stale.length : unique.length} findings.`,
  );
} else {
  for (const id of growth) console.error(`baseline.json:1: baseline grew: ${id}`);
  for (const finding of added)
    console.error(`${finding.file}:${finding.line}: ${finding.rule}: ${finding.detail}`);
  for (const id of stale) console.error(`baseline.json:1: stale baseline entry: ${id}`);
  if (added.length || stale.length || growth.length) process.exitCode = 1;
  else console.log(`Guard passed (${unique.length} existing findings).`);
}
