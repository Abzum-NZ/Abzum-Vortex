import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// The canonical-function convention governs migrations timestamped at or after this value. Every
// earlier migration is historical: it is read to know each function's current definition and
// signature, but it is never reported.
export const CANONICAL_SINCE = "20260925000000";

const migrationPattern = /^(\d{14})_.*\.sql$/;
const identifierPattern = /^[a-z_][a-z0-9_]*$/;
const identifierCharacter = /[A-Za-z0-9_$]/;
const dollarTagPattern = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
const definitionHeader =
  /^create\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_]*)\s*\.\s*([a-z_][a-z0-9_]*)\s*\(/i;
const anyDefinitionHeader = /^create\s+(?:or\s+replace\s+)?function\b/i;
const embeddedDefinition = /\bcreate\s+(?:or\s+replace\s+)?function\b/i;
const dollarQuotedBody = /\bas\s+\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/i;
const dropHeader = /^drop\s+function\s+(?:if\s+exists\s+)?/i;
const qualifiedName = /^\s*([a-z_][a-z0-9_]*)\s*\.\s*([a-z_][a-z0-9_]*)\s*/i;
// Reading a stored function body is the first step of every text patch.
const liveDefinitionRead = /\b(?:pg_get_functiondef|prosrc|routine_definition)\b/i;
// Applied outside persistent function bodies only, because application definitions are product
// data that a function body may legitimately transform with replace().
const definitionPatch =
  /\b(?:regexp_)?replace\s*\(\s*(?:[a-z_][a-z0-9_]*\s*\.\s*)?[a-z0-9_]*(?:definition|functiondef|prosrc|function_source|patched)[a-z0-9_]*\s*,/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBlock(block) {
  return block
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .trim();
}

const argumentModes = new Set(["in", "out", "inout", "variadic"]);
// First words of built-in type names that are written as several words.
const multiWordTypes = new Set([
  "double",
  "timestamp",
  "time",
  "character",
  "char",
  "bit",
  "national",
]);
const typeAliases = new Map([
  ["int", "integer"],
  ["int4", "integer"],
  ["int2", "smallint"],
  ["int8", "bigint"],
  ["bool", "boolean"],
  ["float4", "real"],
  ["float8", "double precision"],
  ["decimal", "numeric"],
  ["varchar", "character varying"],
  ["timestamptz", "timestamp with time zone"],
  ["timetz", "time with time zone"],
]);

function splitTopLevel(list) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === "(") depth += 1;
    else if (list[index] === ")") depth -= 1;
    else if (list[index] === "," && depth === 0) {
      parts.push(list.slice(from, index));
      from = index + 1;
    }
  }
  parts.push(list.slice(from));
  return parts.map((part) => part.trim()).filter(Boolean);
}

// Postgres identifies a function by its input argument types, so parameter names, defaults,
// type modifiers and output arguments are left out, and type aliases take their canonical name.
function inputSignature(list) {
  const types = [];
  for (const argument of splitTopLevel(list)) {
    const tokens = argument
      .replace(/\s+default\s[\s\S]*$|=[\s\S]*$/i, "")
      .trim()
      .toLowerCase()
      .split(/\s+/);
    if (argumentModes.has(tokens[0])) {
      if (tokens.shift() === "out") continue;
    }
    if (tokens.length > 1 && !multiWordTypes.has(tokens[0])) tokens.shift();
    const type = tokens
      .join(" ")
      .replace(/^pg_catalog\s*\.\s*/, "")
      .replace(/\s*\([^)]*\)/g, "")
      .replace(/\s*\[/g, "[");
    const base = /^[^[]*/.exec(type)[0];
    types.push((typeAliases.get(base) ?? base) + type.slice(base.length));
  }
  return types.join(",");
}

function skipQuoted(text, index, quote, backslashEscapes) {
  let cursor = index + 1;
  while (cursor < text.length) {
    const character = text[cursor];
    if (backslashEscapes && character === "\\") {
      cursor += 2;
      continue;
    }
    if (character === quote) {
      if (text[cursor + 1] === quote) {
        cursor += 2;
        continue;
      }
      return cursor + 1;
    }
    cursor += 1;
  }
  return text.length;
}

// Splits SQL into top-level statements. Comments, quoted strings, quoted identifiers and
// dollar-quoted bodies are skipped so a semicolon inside them never ends a statement. Each
// statement keeps its original text and a `code` copy in which comments are blanked.
export function splitStatements(text) {
  const statements = [];
  const comments = [];
  let start = -1;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (character === "-" && next === "-") {
      const newline = text.indexOf("\n", index);
      const end = newline === -1 ? text.length : newline;
      comments.push([index, end]);
      index = end;
      continue;
    }
    if (character === "/" && next === "*") {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < text.length && depth > 0) {
        if (text.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (text.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else cursor += 1;
      }
      comments.push([index, cursor]);
      index = cursor;
      continue;
    }
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (start === -1) start = index;
    if (character === "'") {
      const escaped =
        (text[index - 1] === "e" || text[index - 1] === "E") &&
        !identifierCharacter.test(text[index - 2] ?? "");
      index = skipQuoted(text, index, "'", escaped);
      continue;
    }
    if (character === '"') {
      index = skipQuoted(text, index, '"', false);
      continue;
    }
    if (character === "$" && !identifierCharacter.test(text[index - 1] ?? "")) {
      dollarTagPattern.lastIndex = index;
      const tag = dollarTagPattern.exec(text);
      if (tag) {
        const close = text.indexOf(tag[0], index + tag[0].length);
        index = close === -1 ? text.length : close + tag[0].length;
        continue;
      }
    }
    if (character === ";") {
      statements.push([start, index + 1]);
      start = -1;
    }
    index += 1;
  }
  if (start !== -1) statements.push([start, text.length]);

  let code = "";
  let cursor = 0;
  for (const [from, to] of comments) {
    code += text.slice(cursor, from) + text.slice(from, to).replace(/[^\n]/g, " ");
    cursor = to;
  }
  code += text.slice(cursor);

  return statements.map(([from, to]) => ({
    text: text.slice(from, to),
    code: code.slice(from, to),
  }));
}

function closingParenthesis(code, openParenthesis) {
  let depth = 0;
  for (let index = openParenthesis; index < code.length; index += 1) {
    if (code[index] === "(") depth += 1;
    else if (code[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function readDefinition(statement) {
  const header = definitionHeader.exec(statement.code);
  if (!header) return null;
  const openParenthesis = header[0].length - 1;
  const close = closingParenthesis(statement.code, openParenthesis);
  return {
    schema: header[1].toLowerCase(),
    name: header[2].toLowerCase(),
    signature:
      close === -1 ? null : inputSignature(statement.code.slice(openParenthesis + 1, close)),
    dollarQuoted: dollarQuotedBody.test(statement.code),
    block: normalizeBlock(statement.text),
  };
}

// Reads the functions named by `drop function [if exists] a.f(...), b.g(...)`.
function readDrops(statement) {
  const header = dropHeader.exec(statement.code);
  if (!header) return [];
  const drops = [];
  let rest = statement.code.slice(header[0].length);
  for (;;) {
    const name = qualifiedName.exec(rest);
    if (!name) break;
    drops.push({ schema: name[1].toLowerCase(), name: name[2].toLowerCase() });
    rest = rest.slice(name[0].length);
    if (rest.startsWith("(")) {
      const close = closingParenthesis(rest, 0);
      if (close === -1) break;
      rest = rest.slice(close + 1);
    }
    const separator = /^\s*,/.exec(rest);
    if (!separator) break;
    rest = rest.slice(separator[0].length);
  }
  return drops;
}

async function listFiles(directory, recursive) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && recursive) files.push(...(await listFiles(target, recursive)));
    else if (entry.isFile() && entry.name.endsWith(".sql")) files.push(target);
  }
  return files.sort();
}

function functionKey(schema, name) {
  return `${schema}.${name}`;
}

function readCanonical(item, errors) {
  const key = functionKey(item.schema, item.name);
  const statements = splitStatements(item.text);
  const definitions = statements.filter((statement) => anyDefinitionHeader.test(statement.code));
  if (definitions.length !== 1) {
    errors.push(
      `${item.file} must hold exactly one create or replace function ${key}(...) statement, found ${definitions.length}`,
    );
    return null;
  }
  const definition = readDefinition(definitions[0]);
  if (!definition || definition.schema !== item.schema || definition.name !== item.name) {
    errors.push(`${item.file} must define ${key}, named as a lowercase schema-qualified function`);
    return null;
  }
  if (!/^create\s+or\s+replace\s+function\b/i.test(definitions[0].code)) {
    errors.push(`${item.file} must use create or replace function`);
  }
  if (!definition.dollarQuoted) {
    errors.push(`${item.file} must give ${key} a dollar-quoted body`);
  }
  const target = String.raw`function\s+${escapeRegExp(item.schema)}\s*\.\s*${escapeRegExp(item.name)}\s*\(`;
  const comment = new RegExp(String.raw`^comment\s+on\s+${target}`, "i");
  const privilege = new RegExp(String.raw`^(?:grant|revoke)\b[\s\S]*?\bon\s+${target}`, "i");
  let hasComment = false;
  let hasPrivilege = false;
  for (const statement of statements) {
    if (statement === definitions[0]) continue;
    if (comment.test(statement.code)) hasComment = true;
    else if (privilege.test(statement.code)) hasPrivilege = true;
    else {
      errors.push(
        `${item.file} may only hold ${key}'s definition, comment and privileges; found: ${statement.code.trim().split("\n")[0]}`,
      );
    }
  }
  if (!hasComment) errors.push(`${item.file} must carry comment on function ${key}`);
  if (!hasPrivilege) errors.push(`${item.file} must carry the grant and revoke on function ${key}`);
  return definition;
}

export async function validateSqlCanonical(root) {
  const errors = [];
  const migrationsDirectory = path.join(root, "supabase", "migrations");
  const schemasDirectory = path.join(root, "supabase", "schemas");

  const canonicalByKey = new Map();
  for (const file of await listFiles(schemasDirectory, true)) {
    const relative = path.relative(root, file);
    const parts = path.relative(schemasDirectory, file).split(path.sep);
    const name = path.basename(file, ".sql");
    const schema = parts.length === 2 ? parts[0] : null;
    if (!schema || !identifierPattern.test(schema) || !identifierPattern.test(name)) {
      errors.push(
        `${relative} must live at supabase/schemas/<schema>/<function>.sql with lowercase SQL identifiers`,
      );
      continue;
    }
    const item = { file: relative, schema, name, text: await readFile(file, "utf8") };
    item.definition = readCanonical(item, errors);
    canonicalByKey.set(functionKey(schema, name), item);
  }

  // Replays every migration in order so each function's live signatures and latest complete
  // definition are known, whichever era defined them.
  const signatures = new Map();
  const latest = new Map();
  for (const file of await listFiles(migrationsDirectory, false)) {
    const relative = path.relative(root, file);
    const match = migrationPattern.exec(path.basename(file));
    if (!match) {
      errors.push(`${relative} does not start with a 14-digit timestamp`);
      continue;
    }
    const governed = match[1] >= CANONICAL_SINCE;
    const statements = splitStatements(await readFile(file, "utf8"));

    if (governed && statements.some((statement) => liveDefinitionRead.test(statement.code))) {
      errors.push(
        `${relative} reads a stored function definition (pg_get_functiondef, prosrc or routine_definition); carry the complete new body instead`,
      );
    }

    for (const statement of statements) {
      const creates = anyDefinitionHeader.test(statement.code);
      const definition = creates ? readDefinition(statement) : null;
      if (creates && !definition) {
        if (governed) {
          errors.push(
            `${relative} defines a function that is not named as a lowercase schema-qualified function: ${statement.code.trim().split("\n")[0]}`,
          );
        }
        continue;
      }

      if (!definition) {
        for (const drop of readDrops(statement)) {
          const key = functionKey(drop.schema, drop.name);
          signatures.delete(key);
          latest.set(key, { file: relative, governed, dropped: true });
        }
        if (governed && definitionPatch.test(statement.code)) {
          errors.push(
            `${relative} patches a function definition with replace(); carry the complete new body instead`,
          );
        }
        if (governed && embeddedDefinition.test(statement.code)) {
          errors.push(
            `${relative} creates a function inside another statement; write it as a top-level create or replace function`,
          );
        }
        continue;
      }

      // Session-temporary helpers never persist, so they have no canonical source.
      if (definition.schema === "pg_temp") {
        if (governed && definitionPatch.test(statement.code)) {
          errors.push(
            `${relative} patches a function definition with replace(); carry the complete new body instead`,
          );
        }
        continue;
      }

      const key = functionKey(definition.schema, definition.name);
      const live = signatures.get(key) ?? new Set();
      if (governed) {
        if (!definition.dollarQuoted) {
          errors.push(`${relative} must give ${key} a dollar-quoted body`);
        }
        if (live.size > 0 && !live.has(definition.signature)) {
          errors.push(
            `${relative} changes the signature of ${key} without an explicit drop function before it`,
          );
        }
      }
      live.add(definition.signature);
      signatures.set(key, live);
      latest.set(key, { file: relative, governed, dropped: false, block: definition.block });
    }
  }

  // A function whose latest definition is governed must have a canonical file that matches it;
  // every canonical file must match the migration that last installed its function.
  for (const [key, state] of latest) {
    if (!state.governed || state.dropped || canonicalByKey.has(key)) continue;
    const [schema, name] = key.split(".");
    errors.push(
      `${state.file} defines ${key} without a canonical file supabase/schemas/${schema}/${name}.sql`,
    );
  }
  for (const [key, item] of canonicalByKey) {
    if (!item.definition) continue;
    const state = latest.get(key);
    if (!state) {
      errors.push(
        `${item.file} has no migration that installs ${key}; a canonical change needs its migration`,
      );
    } else if (state.dropped) {
      errors.push(`${item.file} describes ${key}, which ${state.file} drops; remove the file`);
    } else if (state.block !== item.definition.block) {
      errors.push(
        `${item.file} differs from ${key} as last installed by ${state.file}; a canonical change needs a migration carrying the identical complete definition`,
      );
    }
  }

  return errors;
}
