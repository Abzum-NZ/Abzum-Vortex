import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, relative, extname, basename, dirname } from "node:path";
import ts from "typescript";
import { createHash } from "node:crypto";
import { guardRules, packageAreas, paths, scannedRuleIds } from "./config.ts";
import { derivedDefinitionId } from "../../packages/platform/src/definition/derived-definition-id.ts";

type Finding = { rule: string; file: string; line: number; detail: string };
const root = resolve(import.meta.dirname, "../..");
// Every shipped definition must compile offline as publication compiles it. The validator is the
// slowest step, so it runs alongside the static scan.
const definitionValidationRun = new Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}>((done) => {
  const child = spawn(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/definition-validation/validate-definitions.ts",
      "--json",
    ],
    { cwd: resolve(root, "apps/web") },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.on("error", (error) => done({ status: null, stdout, stderr, error }));
  child.on("close", (status) => done({ status, stdout, stderr }));
});
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".sql"]);
const findings: Finding[] = [];
const normalize = (value: string) => value.replaceAll("\\", "/");
const ruleTier = (rule: string) =>
  (guardRules as Record<string, { tier: "blocking" | "warning" }>)[rule]?.tier ?? "warning";
const isBlocking = (rule: string) => ruleTier(rule) === "blocking";
// The generated baseline migrations are a frozen snapshot: they may not grow, and per-function
// rules skip them.
const baselineMigrationFiles = new Map([
  ["supabase/migrations/20261014000100_baseline_roles_and_extensions.sql", 168],
  ["supabase/migrations/20261014000200_baseline_schema_and_functions.sql", 105368],
  ["supabase/migrations/20261014000300_baseline_constraints_grants_and_policies.sql", 5241],
  ["supabase/migrations/20261014000400_baseline_system_data_and_storage.sql", 705],
  ["supabase/migrations/20261014001100_collapse_schemas_and_owner_roles.sql", 53870],
]);
const read = (file: string) => readFileSync(resolve(root, file), "utf8").replaceAll("\r\n", "\n");
const lineAt = (content: string, offset: number) => content.slice(0, offset).split("\n").length;
function add(rule: string, file: string, line: number, detail: string): void {
  findings.push({ rule, file, line, detail });
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
    if (file === "packages/platform/src/schema.ts" && target.startsWith("packages/platform/src/"))
      return "schema";
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
function violatesLayering(file: string, specifier: string): boolean {
  const fileArea = area(file);
  const target = importedArea(specifier, file);
  return (
    (target === "web" && fileArea !== "web") ||
    (fileArea === "platform" && (target === "ui" || target === "definitions")) ||
    (fileArea === "schema" && target !== "schema" && target !== "other") ||
    ((fileArea === "ui" || fileArea === "definitions") &&
      (target === "platform" ||
        target === "web" ||
        (target === "definitions" && fileArea === "ui") ||
        (target === "ui" && fileArea === "definitions")))
  );
}
// Platform system applications (IAM, the App Store and the other administration applications) are
// part of the platform, which links to them; only business applications are kept out of engines.
// Their source directories are the ones shipped-sources.ts registers as platform system applications.
const shippedSources = read(`${paths.applicationSources}shipped-sources.ts`);
const sourceDirectories = new Map(
  [...shippedSources.matchAll(/import \{ (\w+) \} from "\.\/([\w-]+)";/g)].map(
    ([, name, directory]) => [name, directory] as const,
  ),
);
const systemApplicationFiles = new Set(
  [
    ...shippedSources.matchAll(
      /source: (\w+),\s*applicationOriginKind: "platform_system_application"/g,
    ),
  ].map(
    ([, name]) =>
      `${paths.applicationSources}${sourceDirectories.get(name ?? "") ?? "?"}/application.json`,
  ),
);
const names = new Set<string>();
for (const file of files.filter(
  (file) =>
    file.startsWith(paths.applicationSources) &&
    /\/application\.json$/.test(file) &&
    !systemApplicationFiles.has(file),
)) {
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
  const lineCount = content.split("\n").length;
  const baselineLineCount = baselineMigrationFiles.get(file);
  if (baselineLineCount !== undefined && lineCount > baselineLineCount)
    throw new Error(`Generated baseline migration grew: ${file}`);
  // Migrations carry every changed function's full body and are one per PR, so only source and
  // canonical schema files are held to the size cap.
  if (lineCount > 1500 && !file.startsWith(paths.migrations))
    add("file-size", file, 1501, `${lineCount} lines`);
  if (/-v[2-9]\d*(?=\.)/i.test(basename(file))) add("versioned-file", file, 1, basename(file));
  const fileArea = area(file);
  if (
    ["platform", "schema", "ui", "web"].includes(fileArea) &&
    !paths.scripts.some((prefix) => file.startsWith(prefix))
  ) {
    for (const match of content.matchAll(businessPattern))
      add("business-name", file, lineAt(content, match.index), match[0].toLowerCase());
  }
  if (file.endsWith(".sql")) {
    // Forward migrations from #2379 on must run object DDL under an explicitly set role. Without one
    // the migration runs as postgres, whose schema privileges are revoked after the baseline, so
    // `supabase db reset` fails with permission denied even though a superuser proof passes. The
    // role must be closed again with `reset role;` as the last statement, so the migration row is
    // not recorded as the owner role.
    const migrationTimestamp = /^\d{14}/.exec(basename(file))?.[0];
    if (
      file.startsWith(paths.migrations) &&
      !baselineMigrationFiles.has(file) &&
      migrationTimestamp !== undefined &&
      migrationTimestamp >= "20261014002300"
    ) {
      // Block and `--` comments are blanked (not removed) so line numbers stay exact.
      const code = content
        .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
        .split("\n")
        .map((line) => line.replace(/--.*$/, (comment) => " ".repeat(comment.length)))
        .join("\n");
      const events = [
        ...[...code.matchAll(/\bset\s+(?:local\s+)?role\s+([\w"]+)\s*;|\breset\s+role\s*;/gi)].map(
          (match) => ({
            index: match.index,
            role: match[1]?.replace(/"/g, "").toLowerCase(),
            ddl: false,
          }),
        ),
        ...[
          ...code.matchAll(
            /\b(?:create\s+(?:or\s+replace\s+|unique\s+)?|alter\s+|drop\s+)(?:function|table|(?:materialized\s+)?view|index|type|sequence|trigger)\b/gi,
          ),
        ].map((match) => ({ index: match.index, role: undefined, ddl: true })),
      ].sort((a, b) => a.index - b.index);
      let activeRole: string | undefined;
      for (const event of events) {
        if (!event.ddl) {
          activeRole = event.role;
          continue;
        }
        if (activeRole === undefined || activeRole === "postgres")
          add(
            "migration-owner-role",
            file,
            lineAt(code, event.index),
            code.slice(event.index).replace(/\s+/g, " ").slice(0, 60).toLowerCase(),
          );
      }
      // A migration that runs DDL must also close the owner role, otherwise Supabase records the
      // migration row as that role and `supabase db reset` fails on the migrations schema.
      const lastCode = code.trimEnd();
      if (events.some((event) => event.ddl) && !/\breset\s+role\s*;$/i.test(lastCode))
        add(
          "migration-owner-role",
          file,
          lineAt(code, lastCode.length - 1),
          "missing closing reset role",
        );
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
  // Renderers compose the official shadcn components, whose per-style variants decide radius,
  // padding and fonts. A literal radius, an arbitrary pixel length or an arbitrary font family in a
  // class name bypasses the theme. The official component sources themselves are exempt.
  const literalStyleScope =
    file.startsWith(paths.uiRenderers) && !file.startsWith(paths.uiComponents);
  const checkLiteralStyle = (text: string, offset: number): void => {
    for (const match of text.matchAll(/\S+/g)) {
      const token = match[0];
      const utility = token.slice(token.lastIndexOf(":") + 1).replace(/^!|!$/g, "");
      // Studio chrome has a fixed theme and uses the radius scale specified by its design.
      // Runtime block renderers still take their radius from the shadcn component variants.
      const studioRadius =
        file.startsWith("packages/ui/src/studio/") && /^rounded-(?:md|lg|xl|full)$/.test(utility);
      if (
        (/^-?rounded(?:-[a-z0-9]+)*$/.test(utility) && !studioRadius) ||
        /^-?[a-z][a-z0-9-]*-\[[^\]]*\d(?:\.\d+)?px[^\]]*\]$/.test(utility) ||
        /^font-\[[^\]]+\]$/.test(utility)
      )
        add("ui-literal-style", file, lineAt(content, offset + (match.index ?? 0)), token);
    }
  };
  // A class-name context: a `className` attribute, or an argument of cn/cva/clsx at any depth.
  const isClassNameContext = (node: ts.Node): boolean => {
    for (let current = node.parent; current !== undefined; current = current.parent) {
      if (ts.isJsxAttribute(current)) return current.name.getText(source) === "className";
      if (
        ts.isCallExpression(current) &&
        /^(?:cn|cva|clsx)$/.test(current.expression.getText(source))
      )
        return true;
      if (ts.isStatement(current) || ts.isFunctionLike(current)) return false;
    }
    return false;
  };
  const checkImport = (specifier: string, offset: number): void => {
    if (violatesLayering(file, specifier))
      add("layering", file, lineAt(content, offset), specifier);
  };
  const visit = (node: ts.Node): void => {
    // An address read keyed by a query input's own key (`parameters[input.key]`,
    // `searchParams.get(declared.key)`) is the deleted name matching.
    const addressNames = [
      "parameters",
      "params",
      "pageParameters",
      "address",
      "search",
      "searchParams",
    ];
    const isInputKey = (argument: ts.Node | undefined): boolean =>
      argument !== undefined &&
      ts.isPropertyAccessExpression(argument) &&
      argument.name.text === "key" &&
      ts.isIdentifier(argument.expression) &&
      ["input", "declared", "declaredInput", "queryInput"].includes(argument.expression.text);
    const addressOf = (expression: ts.Expression): boolean =>
      (ts.isIdentifier(expression) && addressNames.includes(expression.text)) ||
      (ts.isPropertyAccessExpression(expression) && addressNames.includes(expression.name.text));
    if (
      file !== "packages/platform/src/pages/query-binding-resolver.ts" &&
      ((ts.isElementAccessExpression(node) &&
        addressOf(node.expression) &&
        isInputKey(node.argumentExpression)) ||
        (ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ["get", "getAll", "has"].includes(node.expression.name.text) &&
          addressOf(node.expression.expression) &&
          isInputKey(node.arguments[0])))
    )
      add(
        "query-input-name-matching",
        file,
        lineAt(content, node.getStart(source)),
        "Resolve explicit query bindings instead of matching input names to the address",
      );
    if (
      literalStyleScope &&
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      isClassNameContext(node)
    )
      checkLiteralStyle(node.text, node.getStart(source) + 1);
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
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const functionPattern = /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"?\w+"?\.)?"?\w+"?\s*\(/gi;
const dropFunctionPattern =
  /^\s*drop\s+function\s+(?:if\s+exists\s+)?(?:"?\w+"?\.)?"?\w+"?\s*\(/gim;
const renameFunctionPattern = /^\s*alter\s+function\s+(?:"?\w+"?\.)?"?\w+"?\s*\(/gim;
const functionNamePattern = /\bfunction\s+((?:"?\w+"?\.)?"?\w+"?)\s*\(/i;
const typeHeadPattern =
  /^(?:smallint|int2|int|integer|int4|bigint|int8|numeric|decimal|real|float4|float8|double\s+precision|smallserial|serial|bigserial|money|character\s+varying|character|varchar|text|bytea|timestamp|timestamptz|time|date|interval|bool|boolean|uuid|json|jsonb|xml|record|void|trigger|event_trigger|anyarray|anyelement|anyenum|anynonarray|anyrange|name|oid|regclass|regtype|inet|cidr|macaddr|tsvector|tsquery|pg_lsn|bit|varbit|vector|geometry|geography)\b/i;
function closingParenthesis(content: string, open: number): number {
  let depth = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = open; index < content.length; index++) {
    const character = content[index];
    const next = content[index + 1];
    if (singleQuoted) {
      if (character === "'" && next === "'") index++;
      else if (character === "'") singleQuoted = false;
      continue;
    }
    if (doubleQuoted) {
      if (character === '"' && next === '"') index++;
      else if (character === '"') doubleQuoted = false;
      continue;
    }
    if (character === "'") singleQuoted = true;
    else if (character === '"') doubleQuoted = true;
    else if (character === "(") depth++;
    else if (character === ")" && --depth === 0) return index;
  }
  return -1;
}
function splitArguments(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    const next = value[index + 1];
    if (singleQuoted) {
      if (character === "'" && next === "'") index++;
      else if (character === "'") singleQuoted = false;
      continue;
    }
    if (doubleQuoted) {
      if (character === '"' && next === '"') index++;
      else if (character === '"') doubleQuoted = false;
      continue;
    }
    if (character === "'") singleQuoted = true;
    else if (character === '"') doubleQuoted = true;
    else if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (character === "," && parentheses === 0 && brackets === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) result.push(last);
  return result;
}
function normalizedType(value: string): string {
  return value
    .replaceAll('"', "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),.]|\[|\])\s*/g, "$1")
    .toLowerCase()
    .replace(/\btimestamptz\b/g, "timestamp with time zone");
}
function argumentType(argument: string): string | undefined {
  const mode = /^(inout|in|out|variadic)\b\s*/i.exec(argument.trim())?.[1]?.toLowerCase();
  if (mode === "out") return undefined;
  let value = argument.trim().replace(/^(?:inout|in|out|variadic)\b\s*/i, "");
  let parentheses = 0;
  let brackets = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    const next = value[index + 1];
    if (singleQuoted) {
      if (character === "'" && next === "'") index++;
      else if (character === "'") singleQuoted = false;
      continue;
    }
    if (doubleQuoted) {
      if (character === '"' && next === '"') index++;
      else if (character === '"') doubleQuoted = false;
      continue;
    }
    if (character === "'") singleQuoted = true;
    else if (character === '"') doubleQuoted = true;
    else if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (parentheses === 0 && brackets === 0 && character === "=") {
      value = value.slice(0, index).trim();
      break;
    } else if (
      parentheses === 0 &&
      brackets === 0 &&
      /^default\b/i.test(value.slice(index)) &&
      (index === 0 || /\s/.test(value[index - 1]))
    ) {
      value = value.slice(0, index).trim();
      break;
    }
  }
  const firstToken = /^"?([\w$]+)"?/.exec(value)?.[1] ?? "";
  const rest = value.slice(firstToken.length).trim();
  // A first identifier followed by a dot is a schema-qualified type, never an argument name.
  const qualified = /^"?[\w$]+"?\s*\./.test(value);
  if (rest && !qualified && (/^(?:p_|arg_|v_)/i.test(firstToken) || !typeHeadPattern.test(value)))
    value = rest;
  return normalizedType(value);
}
function functions(
  content: string,
): Map<string, { definition: string; offset: number; body: string; identity: string }> {
  const result = new Map<
    string,
    { definition: string; offset: number; body: string; identity: string }
  >();
  for (const match of content.matchAll(functionPattern)) {
    const start = match.index;
    const open = content.indexOf("(", start);
    const close = closingParenthesis(content, open);
    if (close < 0) continue;
    const headerEnd = close + 1;
    const header = content.slice(start, headerEnd).replace(/\s+/g, " ").toLowerCase();
    const name = functionNamePattern.exec(header)?.[1]?.replaceAll('"', "").toLowerCase();
    if (!name) continue;
    const argumentTypes = splitArguments(header.slice(header.indexOf("(") + 1, -1))
      .map(argumentType)
      .filter((argument): argument is string => argument !== undefined);
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
      identity: `${name}(${argumentTypes.join(",")})`,
    });
  }
  return result;
}
const migrationFiles = files
  .filter((file) => file.startsWith(paths.migrations) && file.endsWith(".sql"))
  .sort();
// Supabase keys applied migrations by the leading version, so two files sharing it break a reset.
const migrationVersions = new Map<string, string>();
for (const file of migrationFiles) {
  const version = file.slice(paths.migrations.length).replace(/^\//, "").split("_")[0];
  const first = migrationVersions.get(version);
  if (first) add("migration-version-duplicate", file, 1, `${version} also used by ${first}`);
  else migrationVersions.set(version, file);
}
// A migration added by this branch must sort after every migration already on origin/main, or a
// database that applied the higher version would need an out-of-order apply. Only added files are
// compared, so a branch that is merely behind main, and main itself, never fail.
function gitOutput(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString(
      "utf8",
    );
  } catch {
    return undefined;
  }
}
const mainMigrationList = gitOutput([
  "ls-tree",
  "--name-only",
  "origin/main",
  `${paths.migrations}`,
]);
if (mainMigrationList === undefined)
  console.warn("migration-version-order skipped: origin/main is not available locally");
else {
  const versionOf = (file: string) => basename(file).split("_")[0];
  const mainFiles = new Set(mainMigrationList.split("\n").filter(Boolean).map(normalize));
  const mainVersions = [...mainFiles].filter((file) => file.endsWith(".sql")).map(versionOf);
  const highest = mainVersions.reduce((a, b) => (b > a ? b : a), "");
  const newMigrationFiles = migrationFiles.filter(
    (file) => !mainFiles.has(file) && !baselineMigrationFiles.has(file),
  );
  if (newMigrationFiles.length > 0) {
    const mainCommit = gitOutput(["rev-parse", "origin/main"]);
    const mergeBase = gitOutput(["merge-base", "origin/main", "HEAD"]);
    if (mainCommit === undefined || mergeBase !== mainCommit) {
      for (const file of newMigrationFiles)
        add(
          "migration-version-order",
          file,
          1,
          "branch does not contain the current origin/main commit; update the branch before adding a migration",
        );
    }
  }
  for (const file of newMigrationFiles) {
    const version = versionOf(file);
    if (version > highest) continue;
    const next = (BigInt(highest) + 100n).toString();
    add(
      "migration-version-order",
      file,
      1,
      `version ${version} is not above ${highest}, the highest on origin/main; rebase, then rename to a version above it, for example ${next}_${basename(file).split("_").slice(1).join("_")}`,
    );
  }
}
// Postgres silently truncates identifiers past 63 bytes, so a longer name diverges from its file.
const sqlIdentifier = String.raw`(?:"(?:[^"]|"")+"|[\p{L}_][\p{L}\p{N}_$]*)`;
const createdIdentifierPattern = new RegExp(
  String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:(?:temporary|temp|unlogged|constraint|unique|recursive)\s+)*` +
    String.raw`(?:function|procedure|table|index|view|materialized\s+view|trigger|policy|type|sequence)\s+` +
    String.raw`(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:${sqlIdentifier}\s*\.\s*)?(${sqlIdentifier})`,
  "giu",
);
// Comments and string literals create no objects; blank them while keeping line positions.
const withoutSqlCommentsAndStrings = (sql: string) =>
  sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/gu, (text) => text.replace(/[^\n]/g, " "));
const identifierBytes = (identifier: string) =>
  Buffer.byteLength(
    identifier.startsWith('"')
      ? identifier.slice(1, -1).replaceAll('""', '"')
      : identifier.toLowerCase(),
    "utf8",
  );
for (const file of files.filter(
  (file) =>
    (file.startsWith(paths.migrations) && !baselineMigrationFiles.has(file)) ||
    file.startsWith(paths.canonical),
)) {
  if (!file.endsWith(".sql")) continue;
  const content = withoutSqlCommentsAndStrings(read(file));
  for (const match of content.matchAll(createdIdentifierPattern)) {
    const bytes = identifierBytes(match[1]);
    if (bytes > 63)
      add(
        "sql-identifier-length",
        file,
        lineAt(content, match.index),
        `${match[1]} (${bytes} bytes)`,
      );
  }
}
const latest = new Map<string, { definition: string; file: string }>();
const latestLive = new Map<string, { file: string; line: number; key: string }>();
for (const file of migrationFiles) {
  const content = read(file);
  const migrationFunctions = functions(content);
  for (const [key, value] of migrationFunctions)
    latest.set(key, { definition: value.definition, file });
  const events: Array<
    | {
        kind: "create";
        offset: number;
        key: string;
        value: ReturnType<typeof functions> extends Map<string, infer T> ? T : never;
      }
    | { kind: "drop"; offset: number; identity: string }
    | {
        kind: "rename";
        offset: number;
        fromIdentity: string;
        toIdentity: string;
        toName: string;
      }
  > = [];
  for (const [key, value] of migrationFunctions)
    events.push({ kind: "create", offset: value.offset, key, value });
  for (const match of content.matchAll(dropFunctionPattern)) {
    const start = match.index + match[0].toLowerCase().indexOf("drop");
    const open = content.indexOf("(", start);
    const close = closingParenthesis(content, open);
    const name = functionNamePattern.exec(match[0])?.[1]?.replaceAll('"', "").toLowerCase();
    if (close < 0 || !name) continue;
    const argumentTypes = splitArguments(content.slice(open + 1, close))
      .map(argumentType)
      .filter((type): type is string => type !== undefined);
    events.push({ kind: "drop", offset: start, identity: `${name}(${argumentTypes.join(",")})` });
  }
  for (const match of content.matchAll(renameFunctionPattern)) {
    const start = match.index + match[0].toLowerCase().indexOf("alter");
    const open = content.indexOf("(", start);
    const close = closingParenthesis(content, open);
    const oldName = functionNamePattern.exec(match[0])?.[1]?.replaceAll('"', "").toLowerCase();
    if (close < 0 || !oldName) continue;
    const statementEnd = content.indexOf(";", close + 1);
    const statement = content.slice(close + 1, statementEnd < 0 ? undefined : statementEnd);
    const renamedTo = /\brename\s+to\s+("?\w+"?)/i
      .exec(statement)?.[1]
      ?.replaceAll('"', "")
      .toLowerCase();
    const movedTo = /\bset\s+schema\s+("?\w+"?)/i
      .exec(statement)?.[1]
      ?.replaceAll('"', "")
      .toLowerCase();
    if (!renamedTo && !movedTo) continue;
    const schema = oldName.includes(".") ? `${oldName.slice(0, oldName.lastIndexOf("."))}.` : "";
    const newName = movedTo
      ? `${movedTo}.${oldName.slice(oldName.lastIndexOf(".") + 1)}`
      : `${schema}${renamedTo}`;
    const argumentTypes = splitArguments(content.slice(open + 1, close)).map(normalizedType);
    events.push({
      kind: "rename",
      offset: start,
      fromIdentity: `${oldName}(${argumentTypes.join(",")})`,
      toIdentity: `${newName}(${argumentTypes.join(",")})`,
      toName: newName,
    });
  }
  events.sort((left, right) => left.offset - right.offset);
  for (const event of events) {
    if (event.kind === "drop") {
      latestLive.delete(event.identity);
      continue;
    }
    if (event.kind === "rename") {
      const previous = latestLive.get(event.fromIdentity);
      if (previous) {
        latestLive.delete(event.fromIdentity);
        latestLive.set(event.toIdentity, {
          file,
          line: lineAt(content, event.offset),
          key: previous.key.replace(functionNamePattern, `function ${event.toName}(`),
        });
      }
      continue;
    }
    latestLive.delete(event.value.identity);
    latestLive.set(event.value.identity, {
      file,
      line: lineAt(content, event.value.offset),
      key: event.key,
    });
  }
}
const canonicalFunctions = new Set<string>();
// One name has one signature: two forms of a name make Postgres resolve a call by argument types, so
// no single call shape names the function, and a drop must be repeated for every form.
const canonicalDeclarations = new Map<string, Array<{ file: string; line: number }>>();
// Canonical files still identical to a baseline function inherit its comments, allowances included.
const baselineCopies = new Set<string>();
for (const file of files.filter(
  (file) => file.startsWith(paths.canonical) && file.endsWith(".sql"),
)) {
  const content = read(file);
  for (const [key, value] of functions(content)) {
    canonicalFunctions.add(value.identity);
    const canonicalName = value.identity.slice(0, value.identity.indexOf("("));
    const declarations = canonicalDeclarations.get(canonicalName);
    if (declarations) declarations.push({ file, line: lineAt(content, value.offset) });
    else canonicalDeclarations.set(canonicalName, [{ file, line: lineAt(content, value.offset) }]);
    const migration = latest.get(key);
    const matchesMigration =
      migration !== undefined &&
      migration.definition.replace(/\s+/g, " ") === value.definition.replace(/\s+/g, " ");
    if (!matchesMigration) {
      add(
        "migration-mismatch",
        file,
        lineAt(content, value.offset),
        `${key} vs ${migration?.file ?? "missing migration"}`,
      );
    }
    // The generated baseline is a fixed snapshot; its unchanged function UUIDs are legacy data.
    if (migration && matchesMigration && baselineMigrationFiles.has(migration.file)) {
      baselineCopies.add(file);
      continue;
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
for (const [name, declarations] of canonicalDeclarations)
  if (declarations.length > 1)
    for (const declaration of declarations)
      add(
        "sql-overload",
        declaration.file,
        declaration.line,
        `${name} is declared ${declarations.length} times in the canonical sources; one name has one signature`,
      );
for (const [identity, migration] of latestLive)
  // The generated baseline predates canonical files; every function a forward migration creates needs one.
  if (!canonicalFunctions.has(identity) && !baselineMigrationFiles.has(migration.file))
    add("migration-orphan", migration.file, migration.line, migration.key);
for (const file of files.filter(
  (file) => file.startsWith(paths.migrations) && file.endsWith(".sql"),
)) {
  if (baselineMigrationFiles.has(file)) continue;
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

// The derived Definition identity exists twice: Studio derives in memory what the database will
// record. Both are held to vectors the SQL function produced: the TypeScript derivation must
// reproduce them, and the SQL function must be the exact text they were recorded from, so a
// change to either is refused until the vectors are recorded again from the database.
{
  const vectorsFile = "tooling/guard/derived-definition-id-vectors.json";
  const sqlFile = "supabase/schemas/vortex_definition/derived_definition_id.sql";
  const recorded = JSON.parse(read(vectorsFile)) as {
    sqlFingerprint: string;
    vectors: Array<{ parts: string[]; id: string }>;
  };
  const sqlFingerprint = `sha256:${createHash("sha256")
    .update(read(sqlFile).replace(/\s+/g, " ").trim(), "utf8")
    .digest("hex")}`;
  if (sqlFingerprint !== recorded.sqlFingerprint)
    add(
      "derived-id-parity",
      sqlFile,
      1,
      `SQL changed since the vectors were recorded (${sqlFingerprint})`,
    );
  for (const [index, vector] of recorded.vectors.entries()) {
    const derived = derivedDefinitionId(vector.parts);
    if (derived !== vector.id)
      add(
        "derived-id-parity",
        vectorsFile,
        index + 1,
        `${JSON.stringify(vector.parts)}: TypeScript ${derived}, SQL ${vector.id}`,
      );
  }
}

// Each definition kind accepts exactly one contract version. The SQL function is the single
// source of truth; the TypeScript source and validation constants must equal what it returns, and
// it must return one element per kind.
{
  const sqlFile = "supabase/schemas/vortex_definition/accepted_contract_version.sql";
  const sql = read(sqlFile);
  const accepted = new Map<string, string[]>();
  for (const match of sql.matchAll(/when '(\w+)' then\s+return array\[([^\]]*)\];/g))
    accepted.set(
      match[1]!,
      [...match[2]!.matchAll(/'([^']+)'/g)].map((version) => version[1]!),
    );
  for (const kind of ["application", "module", "record_type"]) {
    const versions = accepted.get(kind);
    if (versions?.length !== 1)
      add(
        "contract-version-parity",
        sqlFile,
        1,
        `${kind} must accept exactly one version, found ${JSON.stringify(versions)}`,
      );
  }
  const constant = (file: string, name: string): string | undefined =>
    new RegExp(`export const ${name} = "([^"]+)"`).exec(read(file))?.[1];
  const definitionDir = "packages/platform/src/definition";
  const expectations: Array<[string, string, string]> = [
    [
      "application",
      `${definitionDir}/application-contract-versions.ts`,
      "applicationSourceContractVersion",
    ],
    [
      "application",
      `${definitionDir}/application-contract-versions.ts`,
      "applicationValidationContractVersion",
    ],
    ["module", `${definitionDir}/module-source-contracts.ts`, "moduleSourceContractVersion"],
    ["module", `${definitionDir}/module-contracts.ts`, "moduleValidationContractVersion"],
    ["record_type", `${definitionDir}/module-contracts.ts`, "moduleValidationContractVersion"],
  ];
  for (const [kind, file, name] of expectations) {
    const value = constant(file, name);
    if (value === undefined || value !== accepted.get(kind)?.[0])
      add(
        "contract-version-parity",
        file,
        1,
        `${name} is ${value}, SQL accepts ${accepted.get(kind)?.[0]} for ${kind}`,
      );
  }
}

// A Records table grid feature exists in exactly three registries: the platform contract (with its
// one capability check), Studio's Features panel and the UI's lazy chunks. All three name the same
// features, and only the UI registry imports a feature's chunk, so there is no second gating path
// (the core header menu and toolbar beside it are imported directly; auto-size is their own chunk).
{
  const registries: Array<[string, RegExp]> = [
    [
      "packages/platform/src/definition/application-composition/records-table-features/index.ts",
      /export const recordsTableFeatureKeys = \[([^\]]*)\]/,
    ],
    [
      "packages/ui/src/studio/grid-features/index.ts",
      /export const studioGridFeatureEditors[^=]*= \{([^;]*)\};/,
    ],
    ["packages/ui/src/display/grid-features/registry.tsx", /const loaders[\s\S]*?> = \{([^;]*)\};/],
  ];
  const keySets = registries.map(([file, pattern]): [string, string[]] => {
    const body = existsSync(resolve(root, file)) ? pattern.exec(read(file))?.[1] : undefined;
    if (body === undefined) {
      add("grid-feature-registry", file, 1, "the grid feature registry could not be read");
      return [file, []];
    }
    const keys = [...body.matchAll(/(?:^|[\s,{])"?([a-z_]+)"?\s*[:,\]]?/g)]
      .map((match) => match[1]!)
      .filter(
        (key) =>
          /^[a-z]+(?:_[a-z]+)*$/.test(key) &&
          !["kind", "settings", "custom", "import"].includes(key),
      );
    return [file, [...new Set(keys)].sort()];
  });
  const [platformFile, platformKeys] = keySets[0]!;
  for (const [file, keys] of keySets.slice(1))
    if (JSON.stringify(keys) !== JSON.stringify(platformKeys))
      add(
        "grid-feature-registry",
        file,
        1,
        `registers ${JSON.stringify(keys)}, ${platformFile} registers ${JSON.stringify(platformKeys)}`,
      );
  const chunkDirectory = "packages/ui/src/display/grid-features/";
  for (const file of codeFiles.filter((candidate) => candidate.startsWith("packages/ui/src/")))
    if (file !== `${chunkDirectory}registry.tsx` && !file.startsWith(chunkDirectory)) {
      const content = read(file);
      // Studio owns its feature editors; runtime feature chunks load through the registry.
      for (const match of content.matchAll(
        /from\s+"([^"]*grid-features\/(?!(?:registry|column-menu|toolbar)")[^"]+)"/g,
      ))
        if (!(file.startsWith("packages/ui/src/studio/") && match[1]!.startsWith("./grid-features/")))
          add("grid-feature-registry", file, lineAt(content, match.index ?? 0), match[0]);
    }
}

// The validator prints a JSON array on stdout and exits 0 (clean) or 1 (failures); anything else
// means it did not run.
const definitionValidation = await definitionValidationRun;
let definitionValidationError: string | undefined;
let validationFailures: Array<{ path: string; line: number; detail: string }> | undefined;
try {
  const parsed: unknown = JSON.parse(definitionValidation.stdout.trim());
  if (Array.isArray(parsed)) validationFailures = parsed;
} catch {
  // Reported below with the validator's own stderr.
}
if (
  validationFailures &&
  (definitionValidation.status === 0 || definitionValidation.status === 1)
) {
  for (const failure of validationFailures)
    add("definition-validation", failure.path, failure.line, failure.detail);
} else {
  const missingInstall = ["apps/web", "packages/platform", "packages/definitions"]
    .filter((workspace) => !existsSync(resolve(root, workspace, "node_modules")))
    .map((workspace) => `${workspace}/node_modules`);
  const cause = (definitionValidation.error?.message ?? definitionValidation.stderr)
    .trim()
    .split("\n")
    .slice(0, 8)
    .join("\n  ");
  definitionValidationError = [
    `Definition validation did not run (exit ${definitionValidation.status ?? "none"}), so the guard cannot pass.`,
    missingInstall.length
      ? `Missing workspace installs: ${missingInstall.join(", ")}. A checkout whose only node_modules is a junction to another checkout lacks them; run \`pnpm install\` in this checkout.`
      : "Run `pnpm --filter @vortex/web exec node --conditions=react-server --import tsx scripts/definition-validation/validate-definitions.ts` to see the full error.",
    `Cause:\n  ${cause || "(no output)"}`,
  ].join("\n");
}

type Allowance = { file: string; line: number; rule: string; reason: string; used: boolean };
const allowances: Allowance[] = [];
for (const file of codeFiles) {
  for (const [index, line] of read(file).split("\n").entries()) {
    const comment = /(?:\/\/|--|\/\*|\*)\s*guard-allow:\s*(.*?)(?:\*\/|$)/.exec(line);
    if (!comment) continue;
    const match = /^([^\s]+)(?:\s+([\s\S]*))?$/.exec(comment[1].trim());
    const lineNumber = index + 1;
    const rule = match?.[1];
    const reason = match?.[2]?.trim() ?? "";
    if (!rule || !scannedRuleIds.has(rule)) {
      add(
        "invalid-guard-allow",
        file,
        lineNumber,
        rule ? `unknown rule ${rule}` : "expected a rule id and reason",
      );
      continue;
    }
    if (reason.length < 10) {
      add("invalid-guard-allow", file, lineNumber, "reason must contain at least 10 characters");
      continue;
    }
    allowances.push({ file, line: lineNumber, rule, reason, used: false });
  }
}

// A directive covers one finding of its rule on its own line or the line directly below.
const reported = findings
  .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  .filter((finding) => {
    const allowance = allowances.find(
      (candidate) =>
        !candidate.used &&
        candidate.file === finding.file &&
        candidate.rule === finding.rule &&
        candidate.line <= finding.line &&
        finding.line - candidate.line <= 1,
    );
    if (allowance) allowance.used = true;
    return !allowance;
  });
for (const allowance of allowances)
  if (
    !allowance.used &&
    !baselineMigrationFiles.has(allowance.file) &&
    !baselineCopies.has(allowance.file)
  )
    reported.push({
      rule: "unused-guard-allow",
      file: allowance.file,
      line: allowance.line,
      detail: `${allowance.rule}: ${allowance.reason}`,
    });

const blocking = reported.filter((finding) => isBlocking(finding.rule));
const warnings = reported.filter((finding) => !isBlocking(finding.rule));
const today = new Date().toISOString().slice(0, 10);
const reviewNotices = Object.entries(guardRules).filter(([, rule]) => today > rule.reviewBy);
const usedAllowances = new Map<string, number>();
for (const allowance of allowances.filter((candidate) => candidate.used))
  usedAllowances.set(allowance.rule, (usedAllowances.get(allowance.rule) ?? 0) + 1);

for (const finding of warnings)
  console.warn(`${finding.file}:${finding.line}: warning ${finding.rule}: ${finding.detail}`);
for (const [ruleId, rule] of reviewNotices)
  console.log(
    `Guard review notice: ${ruleId} is past review-by ${rule.reviewBy} (owner: ${rule.owner})${"reviewNote" in rule && rule.reviewNote ? `; ${rule.reviewNote}` : ""}.`,
  );
for (const finding of blocking)
  console.error(`${finding.file}:${finding.line}: blocking ${finding.rule}: ${finding.detail}`);
if (definitionValidationError) console.error(definitionValidationError);

const summary = [
  "## Guard summary",
  "",
  `- Blocking findings: ${blocking.length}`,
  `- Warning findings: ${warnings.length}`,
  `- Allowances used: ${[...usedAllowances].map(([rule, count]) => `${rule} ${count}`).join(", ") || "none"}`,
  ...(reviewNotices.length
    ? [
        "",
        "### Review dates passed",
        ...reviewNotices.map(
          ([ruleId, rule]) =>
            `- ${ruleId}: owner ${rule.owner}; review-by ${rule.reviewBy}${"reviewNote" in rule && rule.reviewNote ? ` (${rule.reviewNote})` : ""}`,
        ),
      ]
    : []),
];
const summaryText = `${summary.join("\n")}\n`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryText);
console.log(summaryText);

if (blocking.length || definitionValidationError) process.exitCode = 1;
else console.log("Guard passed.");
