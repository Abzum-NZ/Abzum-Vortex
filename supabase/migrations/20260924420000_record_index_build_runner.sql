-- #612: bounded concurrent index build and recovery.
--
-- #611 records each exact field index of a provisioned Record storage contract
-- in `vortex_record.index_catalogue` (identity, purpose, desired-definition
-- fingerprint, observed state and observation revision) and builds every new
-- index synchronously, non-concurrently, inside provisioning. A populated or
-- interrupted index therefore has no bounded way to converge to `present`
-- without blocking the active field.
--
-- This migration adds the database half of one operational runner, additive
-- only:
--
-- 1. An all-or-nothing build lease on `index_catalogue`: `claim_id` (a fresh
--    RFC 9562 version-4 identity per claim), `claimed_by`, `claimed_at` and
--    `lease_expires_at`. Only the holder of the current `claim_id` may renew
--    or record; an expired lease is an interrupted build that a later run
--    resumes.
-- 2. `index_build_statements_internal` derives the exact standalone
--    `CREATE [UNIQUE] INDEX CONCURRENTLY` statement, and the cleanup
--    `DROP INDEX CONCURRENTLY IF EXISTS` needed to clear an interrupted or
--    invalid physical index, from one catalogue row's stored identity. It is
--    owned by `vortex_record_owner` and never granted above it, so physical SQL
--    and index names never reach a request or runtime role. It never drops a
--    valid unique index, an index of another table, or an index whose table
--    another session is still building or cleaning concurrently.
-- 3. `claim_record_index_build` leases one non-present catalogue row and
--    returns its derived statements, shaped like `claim_record_deadline_refresh`.
-- 4. `renew_record_index_build_lease` confirms and extends the lease before
--    each statement, so a runner whose lease was taken over never executes DDL.
-- 5. `record_index_build_result` re-observes through the #611
--    `observe_field_index_internal` and records `present` only when the live
--    definition still matches the claimed desired-definition fingerprint.
--
-- Nothing here is request-visible: the functions are revoked from every
-- non-owner role. The runner must use a dedicated operational login that is a
-- member of `vortex_record_owner` with INHERIT: that membership executes these
-- owner-only functions and owns the `record_data` tables, which PostgreSQL
-- requires for `CREATE INDEX CONCURRENTLY`. No request, runtime, adapter or
-- module role is granted DDL. No index is dropped or built by this migration.

begin;

set local role vortex_record_owner;

alter table vortex_record.index_catalogue
  add column claim_id uuid,
  add column claimed_by text,
  add column claimed_at timestamptz,
  add column lease_expires_at timestamptz;

-- A lease is all-or-nothing, so a half-written lease can never be mistaken for
-- an idle row.
alter table vortex_record.index_catalogue
  add constraint index_catalogue_lease_consistent check (
    (claim_id is null and claimed_by is null and claimed_at is null
      and lease_expires_at is null)
    or (claim_id is not null and claimed_by is not null and claimed_at is not null
      and lease_expires_at is not null)
  );

-- Derives the exact statements one catalogue row needs to reach a physically
-- matching index. It returns `settled` when the index already matches, `busy`
-- while another session holds or awaits the table's concurrent-DDL lock (an
-- earlier build or cleanup is still running), `refused` for a row that must
-- not be rebuilt (a drifted identity, a name held by another table's index or
-- a valid unique index still enforcing uniqueness), and `claimed` with the
-- ordered statements otherwise. It never executes DDL: `CREATE INDEX
-- CONCURRENTLY` cannot run inside a transaction block, so the operational
-- runner executes each returned statement on its own.
create function vortex_record.index_build_statements_internal(
  p_storage_contract_id uuid,
  p_field_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  catalogue_row vortex_record.index_catalogue%rowtype;
  storage_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  mapping_purpose text;
  scope_columns text;
  expected_fingerprint text;
  observed text;
  table_relation oid;
  physical_relation oid;
  physical_owner_relation oid;
  physical_valid boolean;
  physical_unique boolean;
  statements jsonb := '[]'::jsonb;
begin
  select catalogue.* into catalogue_row
  from vortex_record.index_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.field_id = p_field_id;
  if catalogue_row.index_contract_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'index_unknown'
    );
  end if;

  select storage.* into storage_row
  from vortex_record.storage_catalogue as storage
  where storage.storage_contract_id = p_storage_contract_id;
  if storage_row.storage_contract_id is null
    or storage_row.state <> 'active'
    or storage_row.physical_schema_token <> 'record_data' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'storage_contract_unavailable'
    );
  end if;

  select stored.* into mapping_row
  from vortex_record.field_storage_mappings as stored
  where stored.storage_contract_id = p_storage_contract_id
    and stored.field_id = p_field_id;
  if mapping_row.storage_contract_id is null or mapping_row.state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'field_unavailable'
    );
  end if;

  scope_columns := vortex_record.index_scope_columns(storage_row.storage_scope);
  table_relation := pg_catalog.to_regclass(
    pg_catalog.format('record_data.%I', storage_row.physical_table_token)
  );
  if scope_columns is null or table_relation is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'storage_contract_unavailable'
    );
  end if;

  -- The same purpose `read_index_readiness` derives, so the runner builds
  -- exactly the index activation will require.
  mapping_purpose := case
    when coalesce((mapping_row.field_definition ->> 'unique')::boolean, false)
      then 'uniqueness'
    when coalesce((mapping_row.field_definition ->> 'filterable')::boolean, false)
      or coalesce((mapping_row.field_definition ->> 'sortable')::boolean, false)
      then 'performance'
    else null
  end;
  expected_fingerprint := vortex_record.index_definition_fingerprint(
    catalogue_row.purpose, storage_row.physical_table_token, scope_columns,
    mapping_row.physical_column_token
  );
  -- The recorded identity must still describe exactly this physical index; a
  -- drifted row is never built against a definition it does not name.
  if mapping_purpose is distinct from catalogue_row.purpose
    or expected_fingerprint is distinct from catalogue_row.desired_definition_fingerprint
    or catalogue_row.physical_index_token is distinct from
      (case catalogue_row.purpose when 'uniqueness' then 'ux_' else 'ix_' end
        || pg_catalog.substr(mapping_row.physical_column_token, 3)) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'index_definition_drifted'
    );
  end if;

  observed := vortex_record.observe_field_index_internal(
    catalogue_row.purpose, storage_row.physical_table_token, scope_columns,
    mapping_row.physical_column_token
  );
  if observed = 'present' then
    return pg_catalog.jsonb_build_object('outcome', 'settled');
  end if;

  -- A concurrent index build or cleanup holds SHARE UPDATE EXCLUSIVE on the
  -- table for its whole duration, including one orphaned by a worker that
  -- died or whose lease expired mid-build. While any other session holds or
  -- awaits that lock the row is left alone, so a cleanup can never drop an
  -- index another session is about to complete. Autovacuum takes the same
  -- lock; the row is simply offered again by a later run.
  if exists (
    select 1
    from pg_catalog.pg_locks as held
    where held.locktype = 'relation'
      and held.database = (
        select database_value.oid
        from pg_catalog.pg_database as database_value
        where database_value.datname = pg_catalog.current_database()
      )
      and held.relation = table_relation
      and held.mode = 'ShareUpdateExclusiveLock'
      and held.pid <> pg_catalog.pg_backend_pid()
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'busy');
  end if;

  physical_relation := pg_catalog.to_regclass(
    pg_catalog.format('record_data.%I', catalogue_row.physical_index_token)
  );
  if physical_relation is not null then
    select index_value.indrelid, index_value.indisvalid, index_value.indisunique
      into physical_owner_relation, physical_valid, physical_unique
    from pg_catalog.pg_index as index_value
    where index_value.indexrelid = physical_relation;
    -- The name is held by something other than an index of this table (the
    -- index namespace is shared across every record table). It is never
    -- dropped from here.
    if not found or physical_owner_relation is distinct from table_relation then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'index_name_conflict'
      );
    end if;
    -- A valid unique index is still enforcing whatever uniqueness it provides,
    -- whatever its purpose or definition. Dropping it would remove that
    -- enforcement, so the row is refused rather than replaced; only an index
    -- that enforces nothing (invalid, or valid but not unique) is recreated.
    if physical_valid and physical_unique then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'uniqueness_enforcement_present'
      );
    end if;
    statements := statements || pg_catalog.jsonb_build_array(
      pg_catalog.format(
        'drop index concurrently if exists record_data.%I',
        catalogue_row.physical_index_token
      )
    );
  end if;

  statements := statements || pg_catalog.jsonb_build_array(
    case catalogue_row.purpose
      when 'uniqueness' then pg_catalog.format(
        'create unique index concurrently %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
        catalogue_row.physical_index_token, storage_row.physical_table_token,
        scope_columns, mapping_row.physical_column_token
      )
      else pg_catalog.format(
        'create index concurrently %I on record_data.%I (%s, %I)',
        catalogue_row.physical_index_token, storage_row.physical_table_token,
        scope_columns, mapping_row.physical_column_token
      )
    end
  );

  return pg_catalog.jsonb_build_object(
    'outcome', 'claimed',
    'indexContractId', catalogue_row.index_contract_id,
    'storageContractId', catalogue_row.storage_contract_id,
    'fieldId', catalogue_row.field_id,
    'purpose', catalogue_row.purpose,
    'desiredDefinitionFingerprint', expected_fingerprint,
    'statements', statements
  );
end
$function$;

-- Leases one buildable catalogue row and returns its derived statements with a
-- fresh claim identity. A row is offered only when it is not `present`, its
-- storage and mapping are active, and it is unleased or its previous lease has
-- expired (an interrupted build). Every candidate is considered, so rows that
-- must not be rebuilt or are still busy are skipped and can never starve a
-- later row, exactly as the #857 deadline claim recovery does.
create function vortex_record.claim_record_index_build(
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  candidate record;
  derivation jsonb;
  refusal_reason text;
  claim_value uuid;
begin
  if p_lease_seconds is null or p_lease_seconds not between 1 and 86400 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  for candidate in
    select catalogue.storage_contract_id, catalogue.field_id
    from vortex_record.index_catalogue as catalogue
    join vortex_record.storage_catalogue as storage
      on storage.storage_contract_id = catalogue.storage_contract_id
      and storage.state = 'active'
      and storage.physical_schema_token = 'record_data'
    join vortex_record.field_storage_mappings as stored
      on stored.storage_contract_id = catalogue.storage_contract_id
      and stored.field_id = catalogue.field_id
      and stored.state = 'active'
    where catalogue.observed_state <> 'present'
      and (catalogue.lease_expires_at is null
        or catalogue.lease_expires_at <= pg_catalog.statement_timestamp())
    order by catalogue.changed_at asc, catalogue.storage_contract_id asc,
      catalogue.field_id asc
    for update of catalogue skip locked
  loop
    derivation := vortex_record.index_build_statements_internal(
      candidate.storage_contract_id, candidate.field_id
    );
    if derivation ->> 'outcome' = 'claimed' then
      claim_value := pg_catalog.gen_random_uuid();
      update vortex_record.index_catalogue as catalogue
      set claim_id = claim_value,
        claimed_by = session_user::text,
        claimed_at = pg_catalog.statement_timestamp(),
        lease_expires_at = pg_catalog.statement_timestamp()
          + pg_catalog.make_interval(secs => p_lease_seconds)
      where catalogue.storage_contract_id = candidate.storage_contract_id
        and catalogue.field_id = candidate.field_id;
      return derivation || pg_catalog.jsonb_build_object('claimId', claim_value);
    elsif derivation ->> 'outcome' = 'settled' then
      -- The live index already matches but the recorded observation is stale
      -- (for example the runner recorded before a crash). Converge the row and
      -- clear any expired lease without rebuilding anything.
      update vortex_record.index_catalogue as catalogue
      set observed_state = 'present',
        observed_revision = catalogue.observed_revision + 1,
        claim_id = null,
        claimed_by = null,
        claimed_at = null,
        lease_expires_at = null,
        changed_at = pg_catalog.statement_timestamp()
      where catalogue.storage_contract_id = candidate.storage_contract_id
        and catalogue.field_id = candidate.field_id;
    elsif derivation ->> 'outcome' = 'refused' and refusal_reason is null then
      refusal_reason := derivation ->> 'reasonCode';
    end if;
  end loop;

  if refusal_reason is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', refusal_reason
    );
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'none');
end
$function$;

-- Confirms the caller still holds this exact claim and extends its lease. The
-- runner calls it before every statement, so a runner whose lease expired and
-- was claimed again never executes DDL for a build it no longer owns.
create function vortex_record.renew_record_index_build_lease(
  p_storage_contract_id uuid,
  p_field_id uuid,
  p_claim_id uuid,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_storage_contract_id is null
    or p_field_id is null
    or p_claim_id is null
    or p_lease_seconds is null
    or p_lease_seconds not between 1 and 86400 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  update vortex_record.index_catalogue as catalogue
  set lease_expires_at = pg_catalog.statement_timestamp()
    + pg_catalog.make_interval(secs => p_lease_seconds)
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.field_id = p_field_id
    and catalogue.claim_id = p_claim_id;
  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'lease_not_owned'
    );
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'renewed');
end
$function$;

-- Re-observes one leased row after the runner has executed its statements and
-- marks it present only when the live definition still matches the claimed
-- fingerprint. A lease the caller does not hold is refused untouched; a
-- superseded desired definition, drifted identity or unavailable
-- storage/mapping is refused without recording readiness and releases the
-- lease, so the next run resumes from the current definition.
create function vortex_record.record_index_build_result(
  p_storage_contract_id uuid,
  p_field_id uuid,
  p_claim_id uuid,
  p_expected_definition_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  catalogue_row vortex_record.index_catalogue%rowtype;
  storage_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  mapping_purpose text;
  scope_columns text;
  derived_fingerprint text;
  observed text;
  refusal_reason text;
begin
  if p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_field_id is null
    or p_field_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_claim_id is null
    or p_expected_definition_fingerprint is null
    or p_expected_definition_fingerprint !~ '^sha256:[a-f0-9]{64}$' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.index_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.field_id = p_field_id
  for update;
  if catalogue_row.index_contract_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'index_unknown'
    );
  end if;
  if catalogue_row.claim_id is distinct from p_claim_id then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'lease_not_owned'
    );
  end if;

  -- A newer or different desired definition superseded this build.
  if catalogue_row.desired_definition_fingerprint
      is distinct from p_expected_definition_fingerprint then
    refusal_reason := 'desired_definition_changed';
  end if;

  if refusal_reason is null then
    select storage.* into storage_row
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = p_storage_contract_id;
    select stored.* into mapping_row
    from vortex_record.field_storage_mappings as stored
    where stored.storage_contract_id = p_storage_contract_id
      and stored.field_id = p_field_id;
    scope_columns := vortex_record.index_scope_columns(storage_row.storage_scope);
    if storage_row.storage_contract_id is null
      or storage_row.state <> 'active'
      or storage_row.physical_schema_token <> 'record_data'
      or mapping_row.storage_contract_id is null
      or mapping_row.state <> 'active'
      or scope_columns is null then
      refusal_reason := 'storage_contract_unavailable';
    end if;
  end if;

  if refusal_reason is null then
    mapping_purpose := case
      when coalesce((mapping_row.field_definition ->> 'unique')::boolean, false)
        then 'uniqueness'
      when coalesce((mapping_row.field_definition ->> 'filterable')::boolean, false)
        or coalesce((mapping_row.field_definition ->> 'sortable')::boolean, false)
        then 'performance'
      else null
    end;
    derived_fingerprint := vortex_record.index_definition_fingerprint(
      catalogue_row.purpose, storage_row.physical_table_token, scope_columns,
      mapping_row.physical_column_token
    );
    if mapping_purpose is distinct from catalogue_row.purpose
      or derived_fingerprint is distinct from p_expected_definition_fingerprint
      or catalogue_row.physical_index_token is distinct from
        (case catalogue_row.purpose when 'uniqueness' then 'ux_' else 'ix_' end
          || pg_catalog.substr(mapping_row.physical_column_token, 3)) then
      refusal_reason := 'definition_mismatch';
    end if;
  end if;

  if refusal_reason is not null then
    update vortex_record.index_catalogue as catalogue
    set claim_id = null, claimed_by = null, claimed_at = null, lease_expires_at = null
    where catalogue.storage_contract_id = p_storage_contract_id
      and catalogue.field_id = p_field_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', refusal_reason
    );
  end if;

  observed := vortex_record.observe_field_index_internal(
    catalogue_row.purpose, storage_row.physical_table_token, scope_columns,
    mapping_row.physical_column_token
  );

  update vortex_record.index_catalogue as catalogue
  set observed_state = observed,
    observed_revision = case when observed is distinct from catalogue_row.observed_state
      then catalogue_row.observed_revision + 1
      else catalogue_row.observed_revision end,
    claim_id = null,
    claimed_by = null,
    claimed_at = null,
    lease_expires_at = null,
    changed_at = pg_catalog.statement_timestamp()
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.field_id = p_field_id;

  return pg_catalog.jsonb_build_object(
    'outcome', observed,
    'indexContractId', catalogue_row.index_contract_id,
    'storageContractId', catalogue_row.storage_contract_id,
    'fieldId', catalogue_row.field_id,
    'purpose', catalogue_row.purpose,
    'desiredDefinitionFingerprint', derived_fingerprint,
    'observedState', observed
  );
end
$function$;

-- Physical SQL and index names stay with the record owner: no request, runtime,
-- adapter or module role may derive, lease or record an index build.
revoke all on function vortex_record.index_build_statements_internal(uuid, uuid),
  vortex_record.claim_record_index_build(integer),
  vortex_record.renew_record_index_build_lease(uuid, uuid, uuid, integer),
  vortex_record.record_index_build_result(uuid, uuid, uuid, text)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter, vortex_module_owner;

comment on column vortex_record.index_catalogue.claim_id is
  'Identity of the current index build claim; only its holder may renew or record the lease.';
comment on column vortex_record.index_catalogue.claimed_by is
  'Worker login that currently leases this index build, or null when unleased.';
comment on column vortex_record.index_catalogue.lease_expires_at is
  'Instant the current build lease expires; an expired lease is an interrupted build.';
comment on function vortex_record.index_build_statements_internal(uuid, uuid) is
  'Private derivation of the ordered drop/create statements one catalogue row needs; never granted above vortex_record_owner.';
comment on function vortex_record.claim_record_index_build(integer) is
  'Operational claim leasing one non-present, buildable index catalogue row for a bounded concurrent build.';
comment on function vortex_record.renew_record_index_build_lease(uuid, uuid, uuid, integer) is
  'Confirms the caller still holds one index build claim and extends its lease before the next statement.';
comment on function vortex_record.record_index_build_result(uuid, uuid, uuid, text) is
  'Records the observed physical state of a leased index build, marking present only when the live definition matches the claimed fingerprint.';

reset role;

commit;
