import { createRequire } from "node:module";
import path from "node:path";

/**
 * Seeds a large, repeatable record set on a local database lane for list-paging measurements.
 *
 * By default it fills one record type of the CRM application (opportunities) and one of the
 * Service Desk application (cases); `--kinds` picks another subset (CRM contacts are also known). The fastest write that stays correct is a set-based clone of one record
 * that the normal write path (`apply_record_changes`, through demo setup) already produced:
 *  - every clone is a row of the record type's own storage table, so the field indexes, the unique
 *    reference-number index and the row-level-security policies cover it exactly like a saved record;
 *  - every clone carries the template's owner group, so permission and group-based access decisions
 *    see the same ownership data as a saved record;
 *  - every clone gets its own relationship edges (the template's required links), so the edge table
 *    and the link columns agree;
 *  - reference numbers are taken from the field's counter (`record_reference_counters`), which is
 *    advanced past the last number used, so the next saved record never collides.
 * Not written: activity entries, change notices and attachments (a list read does not touch them).
 *
 * Re-running replaces the previous seed (clones are recognised by their "Seed <type> " name marker;
 * `--count 0` only removes them). Lanes only: the main stack ports are refused.
 *
 * Usage: node tooling/list-paging/seed-list-records.mjs --lane 2 [--count 50000]
 *          [--kinds opportunity,contact,case]
 */

const root = path.resolve(import.meta.dirname, "../..");
const postgres = createRequire(path.join(root, "packages/platform/package.json"))("postgres");

const argument = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};
const fail = (message) => {
  process.stderr.write(`[seed] ${message}\n`);
  process.exit(1);
};

const lane = Number(argument("lane"));
if (![2, 3, 4, 5].includes(lane)) fail("Pass --lane 2, 3, 4 or 5. The main stack is never seeded.");
const port = 54322 + 1000 * (lane - 1);
if (port === 54322) fail("Refusing to run against the main stack.");
const count = Number(argument("count", "50000"));
if (!Number.isInteger(count) || count < 0 || count > 500000)
  fail("--count must be 0 to 500000 (0 only removes the seed).");

const knownKinds = [
  { key: "opportunity", label: "CRM opportunities" },
  { key: "contact", label: "CRM contacts" },
  { key: "case", label: "Service Desk cases" },
];
const kindKeys = argument("kinds", "opportunity,case").split(",");
const kinds = knownKinds.filter((kind) => kindKeys.includes(kind.key));
if (kinds.length !== kindKeys.length)
  fail(`--kinds takes a comma-separated subset of ${knownKinds.map((kind) => kind.key).join(", ")}.`);

const sql = postgres(`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, {
  max: 1,
  onnotice: () => {},
});

/** A deterministic version-5 style UUID so every identity is accepted by the strict UUID parser. */
const seedId = (storageContractId, ordinal) =>
  `(select substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-5' || substr(h, 14, 3) || '-a' || substr(h, 18, 3) || '-' || substr(h, 21, 12)
     from (select md5('vortex-list-seed/${storageContractId}/' || ${ordinal}::text) as h) as hashed)::uuid`;

const seedKind = async (transaction, kind) => {
  const [contract] = await transaction`
    select storage_contract_id, physical_table_token, record_type_definition
    from vortex_record.storage_catalogue
    where state = 'active' and record_type_definition ->> 'key' = ${kind.key}
    order by first_compatible_release_revision desc`;
  if (contract === undefined) fail(`No active ${kind.key} storage; run pnpm demo:setup first.`);
  const table = contract.physical_table_token;
  const contractId = contract.storage_contract_id;
  const fields = contract.record_type_definition.fields;
  const mappings = await transaction`
    select field_id, physical_column_token, database_value_type
    from vortex_record.field_storage_mappings
    where storage_contract_id = ${contractId} and state = 'active'`;
  const columnOf = new Map(mappings.map((row) => [row.field_id.toLowerCase(), row]));

  const [template] = await transaction`
    select record_id, organisation_id, application_root_id
    from record_data.${transaction(table)}
    order by created_at, record_id limit 1`;
  if (template === undefined) fail(`No ${kind.key} record to clone; run pnpm demo:setup first.`);

  // The first required text field carries the marker "Seed <key> ", so a re-run removes every
  // earlier clone (whatever its ordinal), then allocates fresh reference numbers.
  const markerField = fields.find((field) => field.type === "text" && field.required);
  const markerColumn = columnOf.get(markerField?.fieldId.toLowerCase())?.physical_column_token;
  if (markerColumn === undefined) fail(`The ${kind.key} type has no required text field to mark.`);
  const clones = `select record_id from record_data.${table} where "${markerColumn}" like 'Seed ${kind.key} %'`;
  await transaction.unsafe(`
    delete from vortex_record.relationship_edges
    where from_storage_contract_id = '${contractId}' and from_record_id in (${clones})`);
  await transaction.unsafe(`delete from record_data.${table} where record_id in (${clones})`);

  const expressions = new Map();
  const textKeys = [];
  let referenceField;
  for (const field of fields) {
    const mapping = columnOf.get(field.fieldId.toLowerCase());
    if (mapping === undefined) continue;
    const column = `"${mapping.physical_column_token}"`;
    if (field.type === "reference_number") {
      referenceField = { field, column };
    } else if (field.type === "text" && field.required && textKeys.length === 0) {
      textKeys.push(field.key);
      expressions.set(
        column,
        `'Seed ${kind.key} ' || substr(md5(g.n::text), 1, 8) || ' ' || g.n::text`,
      );
    } else if (field.unique === true && mapping.database_value_type === "text") {
      // A unique text value (a contact's email address) gets a per-clone prefix that keeps its form.
      expressions.set(column, `'seed' || g.n::text || '.' || t.${column}`);
    } else if (field.type === "choice") {
      const values = field.settings.options.map((option) => option.value);
      const list = values.map((value) => `'${String(value).replaceAll("'", "''")}'`).join(",");
      expressions.set(column, `(array[${list}])[1 + (g.n % ${values.length})]`);
    } else if (mapping.database_value_type === "timestamp_with_time_zone") {
      expressions.set(column, `t.${column} + ((g.n % 1000) * interval '1 hour')`);
    } else if (mapping.database_value_type === "date") {
      expressions.set(column, `t.${column} + (g.n % 365)::integer`);
    }
  }

  let firstNumber = 1;
  if (referenceField !== undefined) {
    const [counter] = await transaction`
      select next_number from vortex_record.record_reference_counters
      where organization_id = ${template.organisation_id}
        and storage_contract_id = ${contractId}
        and field_id = ${referenceField.field.fieldId}::uuid
        and application_root_id is not distinct from ${template.application_root_id}`;
    firstNumber = counter === undefined ? 1 : Number(counter.next_number);
    const { prefix = "", suffix = "", digits } = referenceField.field.settings;
    expressions.set(
      referenceField.column,
      `'${prefix}' || lpad((${firstNumber} + g.n - 1)::text, ${digits}, '0') || '${suffix}'`,
    );
  }

  const columns = await transaction`
    select attname from pg_attribute
    where attrelid = ${`record_data.${table}`}::regclass and attnum > 0 and not attisdropped
    order by attnum`;
  const names = columns.map((row) => row.attname);
  const select = names.map((name) => {
    const quoted = `"${name}"`;
    if (name === "record_id") return seedId(contractId, "g.n");
    if (name === "created_at" || name === "updated_at")
      return `t.created_at + (g.n * interval '1 second')`;
    return expressions.get(quoted) ?? `t.${quoted}`;
  });
  await transaction.unsafe(`
    insert into record_data.${table} (${names.map((name) => `"${name}"`).join(", ")})
    select ${select.join(", ")}
    from generate_series(1, ${count}) as g(n)
    cross join (select * from record_data.${table} where record_id = '${template.record_id}') as t`);

  // Each clone repeats the template's relationship edges, so the link columns and edges agree.
  await transaction.unsafe(`
    insert into vortex_record.relationship_edges (
      relationship_id, from_organisation_id, to_organisation_id, from_application_root_id,
      to_application_root_id, from_storage_contract_id, from_record_id, to_storage_contract_id,
      to_record_id
    )
    select e.relationship_id, e.from_organisation_id, e.to_organisation_id,
      e.from_application_root_id, e.to_application_root_id, e.from_storage_contract_id,
      ${seedId(contractId, "g.n")}, e.to_storage_contract_id, e.to_record_id
    from generate_series(1, ${count}) as g(n)
    cross join vortex_record.relationship_edges as e
    where e.from_storage_contract_id = '${contractId}' and e.from_record_id = '${template.record_id}'`);

  if (referenceField !== undefined)
    await transaction`
      insert into vortex_record.record_reference_counters
        (organization_id, storage_contract_id, field_id, application_root_id, next_number)
      values (${template.organisation_id}, ${contractId}, ${referenceField.field.fieldId}::uuid,
        ${template.application_root_id}, ${firstNumber + count})
      on conflict (organization_id, storage_contract_id, field_id, application_root_id)
        do update set next_number = excluded.next_number, changed_at = statement_timestamp()`;
  return { kind, table, contractId };
};

const started = Date.now();
const seeded = await sql.begin(async (transaction) => {
  await transaction`set local role vortex_owner`;
  const done = [];
  for (const kind of kinds) done.push(await seedKind(transaction, kind));
  return done;
});
for (const { kind, table, contractId } of seeded) {
  await sql.unsafe(`analyze record_data.${table}`);
  await sql.unsafe(`analyze vortex_record.relationship_edges`);
  const [{ total }] = await sql.begin(async (transaction) => {
    await transaction`set local role vortex_owner`;
    return transaction.unsafe(`select count(*)::int as total from record_data.${table}`);
  });
  process.stdout.write(
    `[seed] ${kind.label}: ${total} rows in record_data.${table} (${contractId})\n`,
  );
}
process.stdout.write(`[seed] done in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
await sql.end();
