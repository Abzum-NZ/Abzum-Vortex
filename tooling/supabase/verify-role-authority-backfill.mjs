import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_PROJECT_ID = "Abzum-Vortex";
const EXPECTED_CONTAINER = `supabase_db_${EXPECTED_PROJECT_ID}`;
const EXPECTED_IMAGE = "public.ecr.aws/supabase/postgres:17.6.1.165";
const EXPECTED_BASELINE_MIGRATION = "20260905060005";
const CANDIDATE_MIGRATION = "20260905060006";
const MIGRATION_FILENAME = `${CANDIDATE_MIGRATION}_coordinate_application_access_changes.sql`;
const EXPECTED_MIGRATION_SHA256 =
  "03eac60833f963c08ee0c21fe9826410f9a61bc02f21bec5808a29ce83bdb475";
const PROOF_OK = "ROLE_AUTHORITY_BACKFILL_PROOF_OK";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationPath = resolve(root, "supabase/migrations", MIGRATION_FILENAME);

if (process.argv.length !== 2) {
  throw new Error("This proof accepts no target or connection arguments");
}

const config = await readFile(resolve(root, "supabase/config.toml"), "utf8");
const projectId = config.match(/^project_id\s*=\s*"([A-Za-z0-9_-]+)"/m)?.[1];

if (projectId !== EXPECTED_PROJECT_ID) {
  throw new Error(`Refusing project ${projectId ?? "<missing>"}; expected ${EXPECTED_PROJECT_ID}`);
}

const migrationSql = await readFile(migrationPath, "utf8");

if (/^\s*\\/m.test(migrationSql)) {
  throw new Error("The candidate migration must not contain psql meta-commands");
}
if (/^\s*(?:commit|rollback|abort)(?:\s+(?:work|transaction))?\s*;/im.test(migrationSql)) {
  throw new Error("The candidate migration must not end the proof transaction");
}

const migrationSha256 = createHash("sha256").update(migrationSql).digest("hex");

if (migrationSha256 !== EXPECTED_MIGRATION_SHA256) {
  throw new Error(`Refusing unreviewed 060006 bytes; expected sha256:${EXPECTED_MIGRATION_SHA256}`);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function resultDetail(result) {
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return detail.length > 4000 ? detail.slice(-4000) : detail;
}

function requireSuccess(result, description) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${description} failed: ${resultDetail(result)}`);
  }
  return result;
}

function inspectExactContainer() {
  const result = requireSuccess(
    run("docker", [
      "inspect",
      "--type",
      "container",
      "--format",
      "{{.Name}}\t{{.Config.Image}}\t{{.State.Running}}\t{{.State.Health.Status}}",
      EXPECTED_CONTAINER,
    ]),
    "Exact Local container inspection",
  );
  const [name, image, running, health, ...unexpected] = result.stdout.trim().split("\t");

  if (
    unexpected.length !== 0 ||
    name !== `/${EXPECTED_CONTAINER}` ||
    image !== EXPECTED_IMAGE ||
    running !== "true" ||
    health !== "healthy"
  ) {
    throw new Error(
      `Refusing container state; expected running healthy ${EXPECTED_CONTAINER} on ${EXPECTED_IMAGE}`,
    );
  }
}

function runPsql(sql) {
  return run(
    "docker",
    [
      "exec",
      "--interactive",
      "--user",
      "postgres",
      EXPECTED_CONTAINER,
      "psql",
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--set=ON_ERROR_STOP=1",
      "--dbname=postgres",
      "--username=postgres",
    ],
    { input: sql },
  );
}

const baselineQuery = String.raw`
select pg_catalog.jsonb_build_object(
  'serverVersion', pg_catalog.current_setting('server_version'),
  'maxMigration', (
    select pg_catalog.max(version)
    from supabase_migrations.schema_migrations
  ),
  'candidateMigrationCount', (
    select pg_catalog.count(*)
    from supabase_migrations.schema_migrations
    where version = '${CANDIDATE_MIGRATION}'
  ),
  'roleCount', (
    select pg_catalog.count(*) from vortex_access.organization_roles
  ),
  'roleRevisionCount', (
    select pg_catalog.count(*) from vortex_access.organization_role_revisions
  ),
  'rolePermissionCount', (
    select pg_catalog.count(*)
    from vortex_access.organization_role_permission_entries
  ),
  'authorityColumnCount', (
    select pg_catalog.count(*)
    from pg_catalog.pg_attribute
    where attrelid = 'vortex_access.organization_role_revisions'::regclass
      and attname = 'authority_continuity_revision'
      and not attisdropped
  ),
  'immutableTriggerState', (
    select trigger.tgenabled::text
    from pg_catalog.pg_trigger as trigger
    where trigger.tgrelid =
        'vortex_access.organization_role_revisions'::regclass
      and trigger.tgname = 'organization_role_revisions_immutable'
      and not trigger.tgisinternal
  ),
  'roleEvidenceTriggerState', (
    select trigger.tgenabled::text
    from pg_catalog.pg_trigger as trigger
    where trigger.tgrelid =
        'vortex_access.organization_role_revisions'::regclass
      and trigger.tgname = 'organization_role_revisions_evidence'
      and not trigger.tgisinternal
  ),
  'permissionEvidenceTriggerState', (
    select trigger.tgenabled::text
    from pg_catalog.pg_trigger as trigger
    where trigger.tgrelid =
        'vortex_access.organization_role_permission_entries'::regclass
      and trigger.tgname = 'organization_role_permission_entries_evidence'
      and not trigger.tgisinternal
  ),
  'roleRevisionSchemaHash', (
    select pg_catalog.md5(pg_catalog.string_agg(
      pg_catalog.concat_ws('|', attribute.attnum::text, attribute.attname,
        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
        attribute.attnotnull::text), E'\n' order by attribute.attnum
    ))
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid =
        'vortex_access.organization_role_revisions'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
  ),
  'validatorHash', pg_catalog.md5(pg_catalog.pg_get_functiondef(
    'vortex_access.validate_organization_role_revision_evidence()'::regprocedure
  )),
  'rolePermissionForeignKeyHash', (
    select pg_catalog.md5(pg_catalog.pg_get_constraintdef(constraint_row.oid, true))
    from pg_catalog.pg_constraint as constraint_row
    where constraint_row.conrelid =
        'vortex_access.organization_role_permission_entries'::regclass
      and constraint_row.conname =
        'organization_role_permission_entries_role_revision_fk'
  ),
  'originalApplyExists', pg_catalog.to_regprocedure(
    'vortex_access.apply_application_permission_registration(text,bigint,jsonb,uuid,uuid)'
  ) is not null,
  'internalApplyExists', pg_catalog.to_regprocedure(
    'vortex_access.apply_application_permission_registration_v1_internal(text,bigint,jsonb,uuid,uuid)'
  ) is not null,
  'originalWithdrawExists', pg_catalog.to_regprocedure(
    'vortex_access.withdraw_application_permission_registration(uuid,uuid,bigint,uuid,uuid)'
  ) is not null,
  'internalWithdrawExists', pg_catalog.to_regprocedure(
    'vortex_access.withdraw_application_permission_registration_v1_internal(uuid,uuid,bigint,uuid,uuid)'
  ) is not null
)::text;
`;

function readBaseline() {
  const result = requireSuccess(runPsql(baselineQuery), "Local baseline read");
  const lines = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length !== 1) {
    throw new Error(`Expected one baseline row, received ${lines.length}`);
  }
  return JSON.parse(lines[0]);
}

function requireExactBaseline(snapshot) {
  if (
    typeof snapshot.serverVersion !== "string" ||
    !snapshot.serverVersion.startsWith("17.6") ||
    snapshot.maxMigration !== EXPECTED_BASELINE_MIGRATION ||
    snapshot.candidateMigrationCount !== 0 ||
    snapshot.roleCount !== 0 ||
    snapshot.roleRevisionCount !== 0 ||
    snapshot.rolePermissionCount !== 0 ||
    snapshot.authorityColumnCount !== 0 ||
    snapshot.immutableTriggerState !== "O" ||
    snapshot.roleEvidenceTriggerState !== "O" ||
    snapshot.permissionEvidenceTriggerState !== "O" ||
    snapshot.originalApplyExists !== true ||
    snapshot.internalApplyExists !== false ||
    snapshot.originalWithdrawExists !== true ||
    snapshot.internalWithdrawExists !== false ||
    typeof snapshot.validatorHash !== "string" ||
    typeof snapshot.roleRevisionSchemaHash !== "string" ||
    typeof snapshot.rolePermissionForeignKeyHash !== "string"
  ) {
    throw new Error(`Refusing non-060005 or non-empty Local baseline: ${JSON.stringify(snapshot)}`);
  }
}

function verifyTargetAndBaseline() {
  inspectExactContainer();
  const snapshot = readBaseline();
  requireExactBaseline(snapshot);
  return snapshot;
}

const TENANT_ID = "11baccf1-0000-4000-8000-000000000006";
const ORGANIZATION_ID = "21baccf1-0000-4000-8000-000000000006";
const ROLE_ID = "51baccf1-0000-4000-8000-000000000006";
const ACTOR_ID = "91baccf1-0000-4000-8000-000000000006";
const ACCESS_CORRELATION_ID = "71baccf1-0000-4000-8000-000000000006";
const PLATFORM_CORRELATION_ID = "72baccf1-0000-4000-8000-000000000006";
const PERMISSION_A = "687d5649-62ee-43dd-b684-b8af3a5394c1";
const PERMISSION_B = "ca5f56d4-5382-4bf8-9a91-fbfdc77642b2";

function fixtureSql({ invalidGap }) {
  const revisionRows = invalidGap
    ? `
    (1, 'Role authority revision one',
      '73baccf1-0000-4000-8000-000000000001'::uuid),
    (3, 'Role authority deliberately gapped revision',
      '73baccf1-0000-4000-8000-000000000003'::uuid)`
    : `
    (1, 'Role authority revision one',
      '73baccf1-0000-4000-8000-000000000001'::uuid),
    (2, 'Role authority metadata-only revision',
      '73baccf1-0000-4000-8000-000000000002'::uuid),
    (3, 'Role authority broadened revision',
      '73baccf1-0000-4000-8000-000000000003'::uuid),
    (4, 'Role authority narrowed revision',
      '73baccf1-0000-4000-8000-000000000004'::uuid),
    (5, 'Role authority restored revision',
      '73baccf1-0000-4000-8000-000000000005'::uuid)`;
  const permissionRows = invalidGap
    ? `
    (1, 1, '${PERMISSION_A}'::uuid),
    (3, 1, '${PERMISSION_A}'::uuid)`
    : `
    (1, 1, '${PERMISSION_A}'::uuid),
    (2, 1, '${PERMISSION_A}'::uuid),
    (3, 1, '${PERMISSION_A}'::uuid),
    (3, 2, '${PERMISSION_B}'::uuid),
    (4, 1, '${PERMISSION_B}'::uuid),
    (5, 1, '${PERMISSION_A}'::uuid),
    (5, 2, '${PERMISSION_B}'::uuid)`;
  const liveRevision = invalidGap ? 3 : 5;
  const disabledEvidence = invalidGap
    ? `
alter table vortex_access.organization_role_revisions
  disable trigger organization_role_revisions_evidence;
alter table vortex_access.organization_role_permission_entries
  disable trigger organization_role_permission_entries_evidence;
`
    : "";

  return String.raw`
${disabledEvidence}
insert into vortex_identity.tenants (
  tenant_id, short_name, display_name, state, created_at, created_by,
  state_changed_at, revision
) values (
  '${TENANT_ID}', 'role_authority_backfill', 'Role authority backfill proof',
  'active', pg_catalog.statement_timestamp(), '${ACTOR_ID}',
  pg_catalog.statement_timestamp(), 1
);

insert into vortex_identity.organizations (
  organization_id, tenant_id, parent_organization_id, short_name, display_name,
  state, created_at, created_by, state_changed_at, revision
) values (
  '${ORGANIZATION_ID}', '${TENANT_ID}', null, 'role_authority_backfill',
  'Role authority backfill proof', 'active',
  pg_catalog.statement_timestamp(), '${ACTOR_ID}',
  pg_catalog.statement_timestamp(), 1
);

do $fixture$
begin
  perform * from vortex_access.initialize_organization_access_version(
    '${ORGANIZATION_ID}', '${ACTOR_ID}', '${ACCESS_CORRELATION_ID}'
  );
  perform * from vortex_access.initialize_platform_permission_catalogue(
    '${ORGANIZATION_ID}', '${ACTOR_ID}', '${PLATFORM_CORRELATION_ID}'
  );
end
$fixture$;

insert into vortex_access.organization_roles (
  organization_id, role_id, role_kind, role_key, live_revision,
  created_by, created_at
) values (
  '${ORGANIZATION_ID}', '${ROLE_ID}', 'custom', 'backfill_proof',
  ${liveRevision}, '${ACTOR_ID}', pg_catalog.statement_timestamp()
);

insert into vortex_access.organization_role_revisions (
  organization_id, role_id, revision, role_kind, lifecycle,
  privilege_classification, assignment_policy, policy_continuity_revision,
  role_key, label, description, changed_by, changed_at,
  change_correlation_id
)
select
  '${ORGANIZATION_ID}'::uuid, '${ROLE_ID}'::uuid, fixture.revision,
  'custom', 'active', 'privileged', 'standing', 1, 'backfill_proof',
  'Backfill proof', fixture.description, '${ACTOR_ID}'::uuid,
  pg_catalog.statement_timestamp(), fixture.correlation_id
from (values ${revisionRows}) as fixture(revision, description, correlation_id);

insert into vortex_access.organization_role_permission_entries (
  organization_id, role_id, role_revision, entry_ordinal, role_kind,
  application_root_id, owner_kind, owner_id, permission_id,
  registration_kind, registration_owner_id, accepted_registration_revision,
  catalogue_fingerprint, continuity_revision, meaning_fingerprint
)
select
  '${ORGANIZATION_ID}'::uuid, '${ROLE_ID}'::uuid, fixture.role_revision,
  fixture.entry_ordinal, 'custom', null, catalogue.owner_kind,
  catalogue.owner_id, catalogue.permission_id, catalogue.registration_kind,
  catalogue.registration_owner_id, catalogue.registration_revision,
  registration.permission_catalogue_fingerprint, 1,
  catalogue.meaning_fingerprint
from (values ${permissionRows})
  as fixture(role_revision, entry_ordinal, permission_id)
join vortex_access.permission_catalogue_entries as catalogue
  on catalogue.organization_id = '${ORGANIZATION_ID}'::uuid
  and catalogue.registration_kind = 'platform'
  and catalogue.permission_id = fixture.permission_id
join vortex_access.permission_registration_revisions as registration
  on registration.organization_id = catalogue.organization_id
  and registration.registration_kind = catalogue.registration_kind
  and registration.registration_owner_id = catalogue.registration_owner_id
  and registration.revision = catalogue.registration_revision;
`;
}

const validPreMigrationSql = String.raw`
set constraints all immediate;
set constraints all deferred;

do $precheck$
begin
  if (select pg_catalog.count(*) from vortex_access.organization_roles) <> 1
    or (select pg_catalog.count(*)
        from vortex_access.organization_role_revisions) <> 5
    or (select pg_catalog.count(*)
        from vortex_access.organization_role_permission_entries) <> 7 then
    raise exception using errcode = 'P0001',
      message = 'Valid role-authority fixture is incomplete';
  end if;
end
$precheck$;

create temporary table role_authority_backfill_before on commit drop as
select
  (
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(role_snapshot.*)
      order by role_snapshot.revision)
    from vortex_access.organization_role_revisions as role_snapshot
    where role_snapshot.organization_id = '${ORGANIZATION_ID}'::uuid
      and role_snapshot.role_id = '${ROLE_ID}'::uuid
  ) as role_history,
  (
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(permission_snapshot.*)
      order by permission_snapshot.role_revision,
        permission_snapshot.entry_ordinal)
    from vortex_access.organization_role_permission_entries as permission_snapshot
    where permission_snapshot.organization_id = '${ORGANIZATION_ID}'::uuid
      and permission_snapshot.role_id = '${ROLE_ID}'::uuid
  ) as permission_history;
`;

const validPostMigrationSql = String.raw`
do $proof$
declare
  actual_periods bigint[];
  before_role_history jsonb;
  before_permission_history jsonb;
  after_role_history jsonb;
  after_permission_history jsonb;
begin
  select pg_catalog.array_agg(revision.authority_continuity_revision
    order by revision.revision)
  into actual_periods
  from vortex_access.organization_role_revisions as revision
  where revision.organization_id = '${ORGANIZATION_ID}'::uuid
    and revision.role_id = '${ROLE_ID}'::uuid;

  if actual_periods <> array[1, 1, 2, 2, 3]::bigint[] then
    raise exception using errcode = 'P0001',
      message = 'Role-authority backfill derived unexpected periods';
  end if;

  select before.role_history, before.permission_history
  into before_role_history, before_permission_history
  from role_authority_backfill_before as before;

  select pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(role_snapshot.*) - 'authority_continuity_revision'
      order by role_snapshot.revision)
  into after_role_history
  from vortex_access.organization_role_revisions as role_snapshot
  where role_snapshot.organization_id = '${ORGANIZATION_ID}'::uuid
    and role_snapshot.role_id = '${ROLE_ID}'::uuid;

  select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(permission_snapshot.*)
      order by permission_snapshot.role_revision,
        permission_snapshot.entry_ordinal)
  into after_permission_history
  from vortex_access.organization_role_permission_entries as permission_snapshot
  where permission_snapshot.organization_id = '${ORGANIZATION_ID}'::uuid
    and permission_snapshot.role_id = '${ROLE_ID}'::uuid;

  if after_role_history is distinct from before_role_history
    or after_permission_history is distinct from before_permission_history then
    raise exception using errcode = 'P0001',
      message = 'Role-authority backfill changed immutable provenance';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid =
        'vortex_access.organization_role_revisions'::regclass
      and attribute.attname = 'authority_continuity_revision'
      and attribute.attnotnull
      and not attribute.attisdropped
  ) or not exists (
    select 1
    from pg_catalog.pg_constraint as constraint_row
    where constraint_row.conrelid =
        'vortex_access.organization_role_revisions'::regclass
      and constraint_row.conname =
        'organization_role_revisions_authority_continuity_range'
      and constraint_row.contype = 'c'
      and constraint_row.convalidated
  ) then
    raise exception using errcode = 'P0001',
      message = 'Role-authority column guards are incomplete';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_trigger as trigger
    where trigger.tgrelid =
        'vortex_access.organization_role_revisions'::regclass
      and trigger.tgname = 'organization_role_revisions_immutable'
      and trigger.tgenabled = 'O'
      and not trigger.tgisinternal
  ) then
    raise exception using errcode = 'P0001',
      message = 'Role-history immutable trigger was not restored';
  end if;

  begin
    update vortex_access.organization_role_revisions
    set label = 'Tampered backfill proof'
    where organization_id = '${ORGANIZATION_ID}'::uuid
      and role_id = '${ROLE_ID}'::uuid
      and revision = 1;
    raise exception using errcode = 'P0001',
      message = 'Role-history immutable trigger allowed mutation';
  exception
    when check_violation then
      if sqlerrm <> 'Organization role history is immutable' then
        raise;
      end if;
  end;

  if exists (
    select 1 from supabase_migrations.schema_migrations
    where version = '${CANDIDATE_MIGRATION}'
  ) then
    raise exception using errcode = 'P0001',
      message = 'Rollback proof must not write migration history';
  end if;
end
$proof$;
`;

function validProofSql() {
  return String.raw`\set VERBOSITY verbose
begin;
${fixtureSql({ invalidGap: false })}
${validPreMigrationSql}
${migrationSql}
${validPostMigrationSql}
rollback;
select '${PROOF_OK}';
`;
}

function invalidProofSql() {
  return String.raw`\set VERBOSITY verbose
begin;
${fixtureSql({ invalidGap: true })}
set constraints all immediate;
set constraints all deferred;
${migrationSql}
`;
}

const originalBaseline = verifyTargetAndBaseline();
process.stdout.write(
  `Verified observed pre-060006 Local target; migration sha256:${migrationSha256}\n`,
);

const validResult = requireSuccess(
  runPsql(validProofSql()),
  "Valid role-authority backfill rollback proof",
);
if (!validResult.stdout.split(/\r?\n/u).includes(PROOF_OK)) {
  throw new Error("Valid role-authority proof did not reach its rollback sentinel");
}

const afterValid = verifyTargetAndBaseline();
if (JSON.stringify(afterValid) !== JSON.stringify(originalBaseline)) {
  throw new Error("Valid proof did not restore the exact Local baseline");
}
process.stdout.write("Valid history backfill and rollback verified\n");

const beforeInvalid = verifyTargetAndBaseline();
if (JSON.stringify(beforeInvalid) !== JSON.stringify(originalBaseline)) {
  throw new Error("Local baseline changed before the invalid-history proof");
}

const invalidResult = runPsql(invalidProofSql());
if (invalidResult.error) throw invalidResult.error;
const invalidDetail = resultDetail(invalidResult);
if (
  invalidResult.status === 0 ||
  !/ERROR:\s+23514: Existing organization role history is incomplete/u.test(invalidDetail)
) {
  throw new Error(`Invalid history did not produce the exact migration refusal: ${invalidDetail}`);
}

const afterInvalid = verifyTargetAndBaseline();
if (JSON.stringify(afterInvalid) !== JSON.stringify(originalBaseline)) {
  throw new Error("Invalid proof did not restore the exact Local baseline");
}

process.stdout.write("Gapped history refusal and rollback verified\n");
process.stdout.write(
  "One-time role-authority proof against the observed Local 060005 baseline passed\n",
);
