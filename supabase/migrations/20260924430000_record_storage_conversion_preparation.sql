-- #625: bounded Record storage conversion preparation (the migrate step of
-- add, migrate, switch and retire).
--
-- A non-widening stored-meaning change never retypes a field in place. It adds
-- a new field, migrates values through this explicit database change, and only
-- then (#626) switches every dependant and retires the old field. This
-- migration prepares and runs the migrate step and nothing of the switch:
--
-- 1. `vortex_record.storage_conversion_catalogue` is a protected catalogue
--    keyed by the exact source/target storage contract and field pair and the
--    exact source/target Module release revisions. Its conversion semantic is
--    derived from the live source mapping's database value type and the target
--    field definition in the exact target release, restricted to the closed,
--    lossless set the orchestrator approved. Every other pair is refused.
-- 2. `vortex_record.register_storage_conversion_plan` records one catalogue
--    entry from already-published evidence. It never accepts a caller-authored
--    type, field definition or semantic.
-- 3. `vortex_record.allocate_storage_conversion_plan` inserts the target
--    `field_storage_mappings` row as `planned` (never `active`) and creates its
--    nullable physical column. The active source mapping is untouched, so every
--    reader and writer keeps using it.
-- 4. `vortex_record.convert_record_storage_batch` copies and converts a bounded
--    batch of records into the planned target column, and
--    `vortex_record.read_storage_conversion_corrections` projects the records
--    converted under an older revision than their current one. Each converted
--    record's source concurrency revision is recorded, so #626 can detect and
--    revalidate concurrent writes before any switch.
--
-- Reader and writer visibility stays with the active mapping. A `planned`
-- mapping is invisible to record reads (they select `state = 'active'`), so a
-- planned target value can never become the active field early.
--
-- Record rows live behind forced RLS policies that only
-- `vortex_record_adapter` satisfies (20260908122641_record_storage_provisioning
-- .sql:638-668), so the two operations that read or write record rows are
-- adapter-owned definers exactly like the record lifecycle writers. The
-- catalogue, plan and progress tables a request may not touch directly are
-- Record-owner-owned with one policy per role. Nothing here activates or
-- retires a mapping, deletes a column or changes a permission or protection.

begin;

-- The protected operations below call the same Access helpers the Module
-- installation provisioner already calls
-- (20260908122641_record_storage_provisioning.sql:936-938). The Record owner
-- needs its own copy because the catalogue, plan and progress writers are
-- Record-owner definers.
grant execute on function vortex_access.evaluate_organization_permission_eligibility(jsonb)
  to vortex_record_owner;
grant execute on function vortex_access.validated_human_request_context()
  to vortex_record_owner;

set local role vortex_record_owner;

-- ============================================================================
-- 1. Pure helpers: the closed conversion set and its exact value assignment.
--    These are the only definitions of what a supported conversion is, so the
--    catalogue, the batch and any future switch all read one table.
-- ============================================================================

-- The closed, lossless conversion semantics. Every other pair returns null and
-- can never be registered.
create function vortex_record.conversion_semantic_for_types(
  p_source_database_value_type text,
  p_target_database_value_type text
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case
    when p_source_database_value_type = 'integer'
      and p_target_database_value_type = 'decimal' then 'integer_to_decimal'
    when p_source_database_value_type = 'integer'
      and p_target_database_value_type = 'text' then 'integer_to_text'
    when p_source_database_value_type = 'decimal'
      and p_target_database_value_type = 'text' then 'decimal_to_text'
    when p_source_database_value_type = 'boolean'
      and p_target_database_value_type = 'text' then 'boolean_to_text'
    when p_source_database_value_type = 'uuid'
      and p_target_database_value_type = 'text' then 'uuid_to_text'
    when p_source_database_value_type = 'date'
      and p_target_database_value_type = 'text' then 'date_to_text'
    when p_source_database_value_type = 'date'
      and p_target_database_value_type = 'timestamp_with_time_zone'
      then 'date_to_timestamp_with_time_zone'
    else null
  end
$function$;

-- The exact assignment that migrates one source column into one target column.
-- Each branch is a total, lossless widening; a date becomes midnight UTC.
create function vortex_record.conversion_value_assignment(
  p_conversion_semantic text,
  p_source_column_token text,
  p_target_column_token text
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case p_conversion_semantic
    when 'integer_to_decimal' then
      pg_catalog.format('%I = %I::numeric', p_target_column_token, p_source_column_token)
    when 'integer_to_text' then
      pg_catalog.format('%I = %I::text', p_target_column_token, p_source_column_token)
    when 'decimal_to_text' then
      pg_catalog.format('%I = %I::text', p_target_column_token, p_source_column_token)
    when 'boolean_to_text' then
      pg_catalog.format('%I = %I::text', p_target_column_token, p_source_column_token)
    when 'uuid_to_text' then
      pg_catalog.format('%I = %I::text', p_target_column_token, p_source_column_token)
    when 'date_to_text' then
      pg_catalog.format('%I = %I::text', p_target_column_token, p_source_column_token)
    when 'date_to_timestamp_with_time_zone' then
      pg_catalog.format(
        '%I = (%I::timestamp without time zone at time zone ''UTC'')',
        p_target_column_token, p_source_column_token
      )
    else null
  end
$function$;

-- The stable conversion identity of one exact source/target field pair. Derived
-- rather than random, with the RFC 9562 version-8 and variant bits (the same
-- convention as `vortex_record.index_contract_identity`), so the name never
-- depends on insert order.
create function vortex_record.storage_conversion_contract_identity(
  p_source_storage_contract_id uuid,
  p_source_field_id uuid,
  p_target_field_id uuid
)
returns uuid
language sql
immutable
security invoker
set search_path = ''
as $function$
  select (
    pg_catalog.substr(source.digest_hex, 1, 12)
    || '8'
    || pg_catalog.substr(source.digest_hex, 14, 3)
    || pg_catalog.substr(
      '89ab',
      (pg_catalog.strpos(
        '0123456789abcdef', pg_catalog.substr(source.digest_hex, 17, 1)
      ) - 1) % 4 + 1,
      1
    )
    || pg_catalog.substr(source.digest_hex, 18, 15)
  )::uuid
  from (
    select pg_catalog.md5(
      pg_catalog.lower(p_source_storage_contract_id::text) || ':'
        || pg_catalog.lower(p_source_field_id::text) || ':'
        || pg_catalog.lower(p_target_field_id::text)
    ) as digest_hex
  ) as source
$function$;

-- ============================================================================
-- 2. The conversion-plan catalogue keyed by exact source/target contract and
--    field and exact release revisions.
-- ============================================================================

create table vortex_record.storage_conversion_catalogue (
  conversion_contract_id uuid primary key,
  source_storage_contract_id uuid not null,
  target_storage_contract_id uuid not null,
  source_field_id uuid not null,
  target_field_id uuid not null,
  source_database_value_type text not null check (source_database_value_type in (
    'boolean', 'date', 'decimal', 'integer', 'json', 'text',
    'timestamp_with_time_zone', 'uuid'
  )),
  target_database_value_type text not null check (target_database_value_type in (
    'boolean', 'date', 'decimal', 'integer', 'json', 'text',
    'timestamp_with_time_zone', 'uuid'
  )),
  conversion_semantic text not null check (conversion_semantic in (
    'integer_to_decimal', 'integer_to_text', 'decimal_to_text', 'boolean_to_text',
    'uuid_to_text', 'date_to_text', 'date_to_timestamp_with_time_zone'
  )),
  source_release_revision bigint not null check (
    source_release_revision between 1 and 9007199254740991
  ),
  target_release_revision bigint not null check (
    target_release_revision between 1 and 9007199254740991
  ),
  target_field_definition jsonb not null check (
    pg_catalog.jsonb_typeof(target_field_definition) = 'object'
  ),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  check (conversion_contract_id = vortex_record.storage_conversion_contract_identity(
    source_storage_contract_id, source_field_id, target_field_id
  )),
  -- The bounded migrate step adds the target field inside the same storage
  -- lineage; a genuinely new lineage is a new storage contract, not a
  -- conversion of this one.
  check (source_storage_contract_id = target_storage_contract_id),
  check (source_field_id <> target_field_id),
  check (target_release_revision > source_release_revision),
  -- The semantic is exactly the one the declared database types allow, so a
  -- row can never claim an unsupported pair. `is not distinct from` makes a
  -- null derivation a refusal rather than a silently passing check.
  check (vortex_record.conversion_semantic_for_types(
    source_database_value_type, target_database_value_type
  ) is not distinct from conversion_semantic),
  check (vortex_record.database_value_type(target_field_definition)
    is not distinct from target_database_value_type),
  unique (source_storage_contract_id, source_field_id, target_field_id),
  foreign key (source_storage_contract_id, source_field_id)
    references vortex_record.field_storage_mappings (storage_contract_id, field_id)
);

-- One conversion plan per exact catalogue entry and tenant scope. The scope is
-- the organisation for shared storage, and the organisation plus Application
-- for application-contained storage.
create table vortex_record.storage_conversion_plans (
  conversion_contract_id uuid not null
    references vortex_record.storage_conversion_catalogue,
  organisation_id uuid not null references vortex_identity.organizations (organization_id),
  application_root_id uuid,
  state text not null check (state in ('planned', 'converting', 'converted', 'failed')),
  plan_revision bigint not null check (plan_revision between 1 and 9007199254740991),
  converted_count bigint not null default 0 check (
    converted_count between 0 and 9007199254740991
  ),
  cursor_record_id uuid,
  started_at timestamptz not null default pg_catalog.statement_timestamp(),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  unique nulls not distinct (conversion_contract_id, organisation_id, application_root_id)
);

-- One row per converted record, carrying the source concurrency revision the
-- conversion observed. A later mismatch with the live revision is exactly a
-- concurrent write that #626 must revalidate before switching.
create table vortex_record.storage_conversion_progress (
  conversion_contract_id uuid not null
    references vortex_record.storage_conversion_catalogue,
  organisation_id uuid not null references vortex_identity.organizations (organization_id),
  application_root_id uuid,
  record_id uuid not null,
  source_concurrency_number bigint not null check (
    source_concurrency_number between 1 and 9007199254740991
  ),
  converted_at timestamptz not null default pg_catalog.statement_timestamp(),
  unique nulls not distinct (
    conversion_contract_id, organisation_id, application_root_id, record_id
  )
);

alter table vortex_record.storage_conversion_catalogue enable row level security;
alter table vortex_record.storage_conversion_catalogue force row level security;
alter table vortex_record.storage_conversion_plans enable row level security;
alter table vortex_record.storage_conversion_plans force row level security;
alter table vortex_record.storage_conversion_progress enable row level security;
alter table vortex_record.storage_conversion_progress force row level security;

create policy storage_conversion_catalogue_owner
  on vortex_record.storage_conversion_catalogue
  to vortex_record_owner using (true) with check (true);
create policy storage_conversion_plans_owner on vortex_record.storage_conversion_plans
  to vortex_record_owner using (true) with check (true);
create policy storage_conversion_progress_owner on vortex_record.storage_conversion_progress
  to vortex_record_owner using (true) with check (true);

alter table vortex_record.storage_conversion_catalogue owner to vortex_record_owner;
alter table vortex_record.storage_conversion_plans owner to vortex_record_owner;
alter table vortex_record.storage_conversion_progress owner to vortex_record_owner;

revoke all on table vortex_record.storage_conversion_catalogue,
  vortex_record.storage_conversion_plans,
  vortex_record.storage_conversion_progress
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter, vortex_module_owner;

create index storage_conversion_plans_contract_idx
  on vortex_record.storage_conversion_plans (conversion_contract_id);
create index storage_conversion_progress_scope_idx
  on vortex_record.storage_conversion_progress (
    conversion_contract_id, organisation_id, application_root_id
  );

-- ============================================================================
-- 3. Protected authority and the physical target column.
-- ============================================================================

-- The single authority check for every conversion operation. It reuses the
-- exact Application-management permission the Module installation provisioner
-- already requires (20260908122641_record_storage_provisioning.sql:987-1040);
-- installation and conversion are the same administrative capability. It
-- returns the validated organisation, account, Access version and Application
-- context, never caller-authored identities.
create function vortex_record.authorize_storage_conversion_internal()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  permission_decision record;
  checked_context jsonb;
begin
  select evaluated.* into strict permission_decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.applications.install',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '7ecd3304-f16c-47d4-94db-0964980091ba'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if permission_decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Storage conversion authority is unavailable';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if (checked_context ->> 'organizationId')::uuid <> permission_decision.organization_id
    or (checked_context ->> 'organizationAccountId')::uuid <>
      permission_decision.organization_account_id
    or (checked_context ->> 'accessVersion')::bigint <> permission_decision.access_version
    or (checked_context ->> 'correlationId')::uuid <> permission_decision.correlation_id then
    raise exception using errcode = '40001',
      message = 'Storage conversion context changed';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', permission_decision.organization_id,
    'organizationAccountId', permission_decision.organization_account_id,
    'accessVersion', permission_decision.access_version,
    'correlationId', permission_decision.correlation_id,
    'applicationRootId', checked_context -> 'applicationRootId'
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '42501',
      message = 'Storage conversion authority is unavailable';
end
$function$;

-- Creates the nullable target column when it is absent, and refuses a physical
-- column that disagrees with the catalogue's target type. This is the physical
-- `add` of add/migrate/switch/retire; the active source column is untouched.
-- It is a Record-owner definer because only the table owner may alter it.
create function vortex_record.ensure_storage_conversion_column_internal(
  p_table_token text,
  p_column_token text,
  p_database_value_type text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  sql_type text;
  existing_type text;
  table_relation oid;
begin
  if p_table_token is null or p_table_token !~ '^rt_[a-f0-9]{32}$'
    or p_column_token is null or p_column_token !~ '^f_[a-f0-9]{32}$'
    or p_database_value_type is null then
    raise exception using errcode = '55000',
      message = 'Storage conversion column request is invalid';
  end if;

  table_relation := pg_catalog.to_regclass(
    pg_catalog.format('record_data.%I', p_table_token)
  );
  if table_relation is null then
    raise exception using errcode = '55000',
      message = 'Storage conversion table is unavailable';
  end if;

  sql_type := vortex_record.sql_value_type(p_database_value_type);
  if sql_type is null then
    raise exception using errcode = '23514',
      message = 'Storage conversion target type is unsupported';
  end if;

  select pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
  into existing_type
  from pg_catalog.pg_attribute as attribute
  where attribute.attrelid = table_relation
    and attribute.attname = p_column_token
    and attribute.attnum > 0
    and not attribute.attisdropped;

  if existing_type is null then
    execute pg_catalog.format(
      'alter table record_data.%I add column %I %s',
      p_table_token, p_column_token, sql_type
    );
    return sql_type;
  end if;

  if existing_type <> sql_type then
    raise exception using errcode = '55000',
      message = 'Existing storage conversion target column is incompatible';
  end if;
  return sql_type;
end
$function$;

-- ============================================================================
-- 4. Protected operations.
-- ============================================================================

-- Records a catalogue entry from exact published evidence. The source type
-- comes from the live active source mapping; the target type comes from the
-- target field in the exact target Module release. The semantic is derived, so
-- an unsupported pair is refused rather than stored.
create function vortex_record.register_storage_conversion_plan(
  p_source_storage_contract_id uuid,
  p_source_field_id uuid,
  p_target_field_id uuid,
  p_source_release_revision bigint,
  p_target_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  source_mapping vortex_record.field_storage_mappings%rowtype;
  source_release vortex_definition.releases%rowtype;
  target_release vortex_definition.releases%rowtype;
  source_record_types jsonb;
  target_record_types jsonb;
  source_field jsonb;
  target_field jsonb;
  semantic text;
  conversion_id uuid;
  stored vortex_record.storage_conversion_catalogue%rowtype;
begin
  authority := vortex_record.authorize_storage_conversion_internal();

  if p_source_storage_contract_id is null
    or p_source_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_source_field_id is null
    or p_source_field_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_target_field_id is null
    or p_target_field_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_source_field_id = p_target_field_id
    or p_source_release_revision not between 1 and 9007199254740991
    or p_target_release_revision not between 1 and 9007199254740991
    or p_target_release_revision <= p_source_release_revision then
    raise exception using errcode = '22023',
      message = 'Storage conversion registration command is invalid';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_source_storage_contract_id;
  if not found or catalogue_row.state <> 'active'
    or p_source_release_revision < catalogue_row.first_compatible_release_revision
    or (
      catalogue_row.last_compatible_release_revision is not null
      and p_source_release_revision > catalogue_row.last_compatible_release_revision
    ) then
    raise exception using errcode = '55000',
      message = 'Storage conversion source contract is unavailable';
  end if;

  select mapping.* into source_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = p_source_storage_contract_id
    and mapping.field_id = p_source_field_id;
  if not found or source_mapping.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Storage conversion source field is not active';
  end if;

  select release.* into source_release
  from vortex_definition.releases as release
  where release.root_id = catalogue_row.module_root_id
    and release.release_revision = p_source_release_revision;
  if not found
    or source_release.validation_contract_version <> '2.0.0'
    or source_release.compilation_output #>> '{kind}' <> 'module'
    or source_release.compilation_output #>> '{canonical,envelope,rootId}'
      <> catalogue_row.module_root_id::text
    or source_release.compilation_output #>> '{validationContractVersion}' <> '2.0.0' then
    raise exception using errcode = '23514',
      message = 'Exact storage conversion source release is incompatible';
  end if;

  select release.* into target_release
  from vortex_definition.releases as release
  where release.root_id = catalogue_row.module_root_id
    and release.release_revision = p_target_release_revision;
  if not found
    or target_release.validation_contract_version <> '2.0.0'
    or target_release.compilation_output #>> '{kind}' <> 'module'
    or target_release.compilation_output #>> '{canonical,envelope,rootId}'
      <> catalogue_row.module_root_id::text
    or target_release.compilation_output #>> '{validationContractVersion}' <> '2.0.0' then
    raise exception using errcode = '23514',
      message = 'Exact storage conversion target release is incompatible';
  end if;

  source_record_types := source_release.compilation_output
    #> '{canonical,content,recordTypes}';
  target_record_types := target_release.compilation_output
    #> '{canonical,content,recordTypes}';
  if pg_catalog.jsonb_typeof(source_record_types) <> 'array'
    or pg_catalog.jsonb_typeof(target_record_types) <> 'array' then
    raise exception using errcode = '23514',
      message = 'Storage conversion release content is incompatible';
  end if;

  select field_item.value into source_field
  from pg_catalog.jsonb_array_elements(source_record_types) as record_item(value)
  cross join lateral pg_catalog.jsonb_array_elements(
    record_item.value -> 'fields'
  ) as field_item(value)
  where (record_item.value ->> 'storageContractId')::uuid = p_source_storage_contract_id
    and (field_item.value ->> 'fieldId')::uuid = p_source_field_id;
  if source_field is null
    or vortex_record.database_value_type(source_field)
      is distinct from source_mapping.database_value_type then
    raise exception using errcode = '55000',
      message = 'Storage conversion source field evidence is incompatible';
  end if;

  select field_item.value into target_field
  from pg_catalog.jsonb_array_elements(target_record_types) as record_item(value)
  cross join lateral pg_catalog.jsonb_array_elements(
    record_item.value -> 'fields'
  ) as field_item(value)
  where (record_item.value ->> 'storageContractId')::uuid = p_source_storage_contract_id
    and (field_item.value ->> 'fieldId')::uuid = p_target_field_id;
  if target_field is null then
    raise exception using errcode = '55000',
      message = 'Storage conversion target field is not published';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(source_record_types) as record_item(value)
    cross join lateral pg_catalog.jsonb_array_elements(
      record_item.value -> 'fields'
    ) as field_item(value)
    where (record_item.value ->> 'storageContractId')::uuid = p_source_storage_contract_id
      and (field_item.value ->> 'fieldId')::uuid = p_target_field_id
  ) then
    raise exception using errcode = '23514',
      message = 'Storage conversion target field already exists in the source release';
  end if;

  semantic := vortex_record.conversion_semantic_for_types(
    source_mapping.database_value_type,
    vortex_record.database_value_type(target_field)
  );
  if semantic is null then
    raise exception using errcode = '23514',
      message = 'Storage conversion pair is unsupported';
  end if;

  conversion_id := vortex_record.storage_conversion_contract_identity(
    p_source_storage_contract_id, p_source_field_id, p_target_field_id
  );

  insert into vortex_record.storage_conversion_catalogue (
    conversion_contract_id, source_storage_contract_id, target_storage_contract_id,
    source_field_id, target_field_id, source_database_value_type,
    target_database_value_type, conversion_semantic, source_release_revision,
    target_release_revision, target_field_definition
  ) values (
    conversion_id, p_source_storage_contract_id, p_source_storage_contract_id,
    p_source_field_id, p_target_field_id, source_mapping.database_value_type,
    vortex_record.database_value_type(target_field), semantic,
    p_source_release_revision, p_target_release_revision, target_field
  )
  on conflict (conversion_contract_id) do update
  set source_database_value_type = excluded.source_database_value_type,
      target_database_value_type = excluded.target_database_value_type,
      conversion_semantic = excluded.conversion_semantic,
      source_release_revision = excluded.source_release_revision,
      target_release_revision = excluded.target_release_revision,
      target_field_definition = excluded.target_field_definition,
      changed_at = pg_catalog.statement_timestamp()
  where vortex_record.storage_conversion_catalogue.source_database_value_type
      is distinct from excluded.source_database_value_type
    or vortex_record.storage_conversion_catalogue.target_database_value_type
      is distinct from excluded.target_database_value_type
    or vortex_record.storage_conversion_catalogue.conversion_semantic
      is distinct from excluded.conversion_semantic
    or vortex_record.storage_conversion_catalogue.source_release_revision
      is distinct from excluded.source_release_revision
    or vortex_record.storage_conversion_catalogue.target_release_revision
      is distinct from excluded.target_release_revision
    or vortex_record.storage_conversion_catalogue.target_field_definition
      is distinct from excluded.target_field_definition;

  select stored_entry.* into stored
  from vortex_record.storage_conversion_catalogue as stored_entry
  where stored_entry.conversion_contract_id = conversion_id;
  if not found then
    raise exception using errcode = '55000',
      message = 'Storage conversion catalogue write failed';
  end if;

  return pg_catalog.jsonb_build_object(
    'conversionContractId', stored.conversion_contract_id,
    'storageContractId', stored.source_storage_contract_id,
    'sourceFieldId', stored.source_field_id,
    'targetFieldId', stored.target_field_id,
    'conversionSemantic', stored.conversion_semantic,
    'sourceDatabaseValueType', stored.source_database_value_type,
    'targetDatabaseValueType', stored.target_database_value_type,
    'sourceReleaseRevision', stored.source_release_revision,
    'targetReleaseRevision', stored.target_release_revision,
    'changed', true
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '55000',
      message = 'Storage conversion release evidence is unavailable';
end
$function$;

-- Allocates one tenant-scoped plan: stages the target mapping as `planned` and
-- creates its nullable physical column. It never touches the active source
-- mapping, so the current installed release stays fully usable.
create function vortex_record.allocate_storage_conversion_plan(
  p_conversion_contract_id uuid,
  p_expected_plan_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority jsonb;
  organisation_id_value uuid;
  conversion vortex_record.storage_conversion_catalogue%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  source_mapping vortex_record.field_storage_mappings%rowtype;
  target_mapping vortex_record.field_storage_mappings%rowtype;
  plan_row vortex_record.storage_conversion_plans%rowtype;
  mapping_lock record;
  scope_application_root_id uuid;
  target_column_token text;
  plan_exists boolean;
  next_revision bigint;
  current_state text;
  current_count bigint;
begin
  authority := vortex_record.authorize_storage_conversion_internal();
  organisation_id_value := (authority ->> 'organizationId')::uuid;

  if p_conversion_contract_id is null
    or p_conversion_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (
      p_expected_plan_revision is not null
      and p_expected_plan_revision not between 1 and 9007199254740991
    ) then
    raise exception using errcode = '22023',
      message = 'Storage conversion allocation command is invalid';
  end if;

  select catalogue.* into conversion
  from vortex_record.storage_conversion_catalogue as catalogue
  where catalogue.conversion_contract_id = p_conversion_contract_id;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Storage conversion plan is unavailable';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = conversion.source_storage_contract_id;
  if not found or catalogue_row.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Storage conversion contract is unavailable';
  end if;

  if catalogue_row.storage_scope = 'application_contained' then
    if authority ->> 'applicationRootId' is null
      or (authority ->> 'applicationRootId')::uuid
        = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '42501',
        message = 'Storage conversion requires an application context';
    end if;
    scope_application_root_id := (authority ->> 'applicationRootId')::uuid;
  else
    scope_application_root_id := null;
  end if;

  -- Lock both mappings in canonical field-id order, the same order the
  -- provisioner uses, so a concurrent provision and this allocation cannot
  -- deadlock.
  for mapping_lock in
    select mapping.field_id
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = conversion.source_storage_contract_id
      and mapping.field_id in (conversion.source_field_id, conversion.target_field_id)
    order by mapping.field_id
    for update
  loop
    null;
  end loop;

  select mapping.* into source_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.source_field_id;
  if not found or source_mapping.state <> 'active'
    or source_mapping.database_value_type <> conversion.source_database_value_type then
    raise exception using errcode = '55000',
      message = 'Storage conversion source mapping is incompatible';
  end if;

  target_column_token := 'f_' || pg_catalog.replace(
    pg_catalog.lower(conversion.target_field_id::text), '-', ''
  );

  select mapping.* into target_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.target_field_id;
  if found then
    if target_mapping.physical_column_token <> target_column_token
      or target_mapping.database_value_type <> conversion.target_database_value_type
      or target_mapping.state <> 'planned'
      or vortex_record.field_storage_meaning(target_mapping.field_definition)
        is distinct from vortex_record.field_storage_meaning(
          conversion.target_field_definition
        ) then
      raise exception using errcode = '55000',
        message = 'Existing storage conversion target mapping is incompatible';
    end if;
  else
    insert into vortex_record.field_storage_mappings (
      storage_contract_id, field_id, physical_column_token, database_value_type,
      field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
    ) values (
      conversion.source_storage_contract_id, conversion.target_field_id,
      target_column_token, conversion.target_database_value_type,
      conversion.target_field_definition, catalogue_row.module_root_id,
      conversion.target_release_revision, 'planned'
    );
  end if;

  -- Physical `add`. The column is nullable; no active reader or writer selects
  -- it because its mapping is `planned`.
  perform vortex_record.ensure_storage_conversion_column_internal(
    catalogue_row.physical_table_token, target_column_token,
    conversion.target_database_value_type
  );

  select plan.* into plan_row
  from vortex_record.storage_conversion_plans as plan
  where plan.conversion_contract_id = p_conversion_contract_id
    and plan.organisation_id = organisation_id_value
    and plan.application_root_id is not distinct from scope_application_root_id
  for update;
  plan_exists := found;

  if plan_exists then
    if p_expected_plan_revision is not null
      and plan_row.plan_revision <> p_expected_plan_revision then
      raise exception using errcode = '40001',
        message = 'Storage conversion plan changed';
    end if;
    if plan_row.state = 'converted' then
      current_state := plan_row.state;
      current_count := plan_row.converted_count;
      next_revision := plan_row.plan_revision;
    else
      next_revision := plan_row.plan_revision + 1;
      update vortex_record.storage_conversion_plans as plan
      set state = 'converting',
          plan_revision = next_revision,
          changed_at = pg_catalog.statement_timestamp()
      where plan.conversion_contract_id = p_conversion_contract_id
        and plan.organisation_id = organisation_id_value
        and plan.application_root_id is not distinct from scope_application_root_id;
      current_state := 'converting';
      current_count := plan_row.converted_count;
    end if;
  else
    if p_expected_plan_revision is not null then
      raise exception using errcode = '40001',
        message = 'Storage conversion plan is unavailable';
    end if;
    next_revision := 1;
    current_state := 'converting';
    current_count := 0;
    insert into vortex_record.storage_conversion_plans (
      conversion_contract_id, organisation_id, application_root_id, state,
      plan_revision, converted_count, cursor_record_id
    ) values (
      p_conversion_contract_id, organisation_id_value, scope_application_root_id,
      'converting', 1, 0, null
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'conversionContractId', conversion.conversion_contract_id,
    'storageContractId', conversion.source_storage_contract_id,
    'sourceFieldId', conversion.source_field_id,
    'targetFieldId', conversion.target_field_id,
    'conversionSemantic', conversion.conversion_semantic,
    'sourceDatabaseValueType', conversion.source_database_value_type,
    'targetDatabaseValueType', conversion.target_database_value_type,
    'sourceColumnToken', source_mapping.physical_column_token,
    'targetColumnToken', target_column_token,
    'organisationId', organisation_id_value,
    'applicationRootId', scope_application_root_id,
    'state', current_state,
    'planRevision', next_revision,
    'convertedCount', current_count,
    'changed', true
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '55000',
      message = 'Storage conversion plan evidence is unavailable';
end
$function$;

revoke all on function vortex_record.conversion_semantic_for_types(text, text),
  vortex_record.conversion_value_assignment(text, text, text),
  vortex_record.storage_conversion_contract_identity(uuid, uuid, uuid),
  vortex_record.authorize_storage_conversion_internal(),
  vortex_record.ensure_storage_conversion_column_internal(text, text, text),
  vortex_record.register_storage_conversion_plan(uuid, uuid, uuid, bigint, bigint),
  vortex_record.allocate_storage_conversion_plan(uuid, bigint)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_record.register_storage_conversion_plan(
  uuid, uuid, uuid, bigint, bigint
) to vortex_request;
grant execute on function vortex_record.allocate_storage_conversion_plan(uuid, bigint)
  to vortex_request;

-- The adapter-owned record-row operations call these private helpers.
grant execute on function vortex_record.authorize_storage_conversion_internal()
  to vortex_record_adapter;
grant execute on function vortex_record.ensure_storage_conversion_column_internal(
  text, text, text
) to vortex_record_adapter;
grant execute on function vortex_record.conversion_value_assignment(text, text, text)
  to vortex_record_adapter;

comment on table vortex_record.storage_conversion_catalogue is
  'Protected conversion-plan catalogue keyed by exact source/target storage contract and field pair and exact Module release revisions; the closed lossless conversion semantic is derived from live types.';
comment on table vortex_record.storage_conversion_plans is
  'One tenant-scoped migrate plan per conversion catalogue entry tracking cursor, converted count and plan revision; never the switch.';
comment on table vortex_record.storage_conversion_progress is
  'One row per converted record carrying the source concurrency revision observed by the migrate step, so a later concurrent write is detectable before switch.';
comment on function vortex_record.conversion_semantic_for_types(text, text) is
  'Closed, lossless conversion semantic for an exact source/target database value type pair, or null when the pair is unsupported.';
comment on function vortex_record.conversion_value_assignment(text, text, text) is
  'Exact SQL assignment migrating one source column into one planned target column for a supported conversion semantic.';
comment on function vortex_record.storage_conversion_contract_identity(uuid, uuid, uuid) is
  'Stable derived conversion identity for one exact storage contract and source/target field pair.';
comment on function vortex_record.authorize_storage_conversion_internal() is
  'Validated organisation, account, Access version and Application context for a storage conversion request under the Application-management permission; raises for any other request.';
comment on function vortex_record.ensure_storage_conversion_column_internal(text, text, text) is
  'Private Record-owner helper: creates the nullable planned target column when absent and refuses a conflicting physical column; never touches the active source column.';
comment on function vortex_record.register_storage_conversion_plan(uuid, uuid, uuid, bigint, bigint) is
  'Records one conversion catalogue entry from exact published source mapping and target release evidence; refuses any caller-authored type or unsupported pair.';
comment on function vortex_record.allocate_storage_conversion_plan(uuid, bigint) is
  'Stages the planned target field mapping and column without touching the active source mapping, so the installed release remains usable.';

-- ============================================================================
-- 5. The two record-row operations, owned by the Record adapter so the forced
--    row-level security policies on `record_data` scope every row to the
--    validated request context.
-- ============================================================================

reset role;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

-- Converts at most `p_batch_size` records in canonical record-id order. It
-- writes only the planned target column, never the source column, never the
-- concurrency number and never the active mapping, so a stopped or failed call
-- is rolled back whole and leaves the installed release usable. Row visibility
-- is the adapter's forced RLS policies, scoped to the request context.
create function vortex_record.convert_record_storage_batch(
  p_conversion_contract_id uuid,
  p_batch_size integer,
  p_expected_plan_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority jsonb;
  organisation_id_value uuid;
  conversion vortex_record.storage_conversion_catalogue%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  source_mapping vortex_record.field_storage_mappings%rowtype;
  target_mapping vortex_record.field_storage_mappings%rowtype;
  plan_row vortex_record.storage_conversion_plans%rowtype;
  scope_application_root_id uuid;
  source_column_token text;
  target_column_token text;
  assignment text;
  select_sql text;
  update_sql text;
  record_row record;
  batch_limit integer;
  candidate_count integer := 0;
  processed integer := 0;
  last_record_id uuid;
  next_revision bigint;
  has_more boolean := false;
  current_state text;
begin
  authority := vortex_record.authorize_storage_conversion_internal();
  organisation_id_value := (authority ->> 'organizationId')::uuid;

  if p_conversion_contract_id is null
    or p_conversion_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_batch_size is null
    or p_batch_size not between 1 and 10000
    or p_expected_plan_revision is null
    or p_expected_plan_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Storage conversion batch command is invalid';
  end if;

  select catalogue.* into conversion
  from vortex_record.storage_conversion_catalogue as catalogue
  where catalogue.conversion_contract_id = p_conversion_contract_id;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Storage conversion plan is unavailable';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = conversion.source_storage_contract_id;
  if not found or catalogue_row.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Storage conversion contract is unavailable';
  end if;

  if catalogue_row.storage_scope = 'application_contained' then
    if authority ->> 'applicationRootId' is null
      or (authority ->> 'applicationRootId')::uuid
        = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '42501',
        message = 'Storage conversion requires an application context';
    end if;
    scope_application_root_id := (authority ->> 'applicationRootId')::uuid;
  else
    scope_application_root_id := null;
  end if;

  select plan.* into plan_row
  from vortex_record.storage_conversion_plans as plan
  where plan.conversion_contract_id = p_conversion_contract_id
    and plan.organisation_id = organisation_id_value
    and plan.application_root_id is not distinct from scope_application_root_id
  for update;
  if not found then
    raise exception using errcode = '55000',
      message = 'Storage conversion plan is not allocated';
  end if;
  if plan_row.plan_revision <> p_expected_plan_revision then
    raise exception using errcode = '40001',
      message = 'Storage conversion plan changed';
  end if;

  select mapping.* into source_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.source_field_id;
  if not found or source_mapping.state <> 'active'
    or source_mapping.database_value_type <> conversion.source_database_value_type then
    raise exception using errcode = '55000',
      message = 'Storage conversion source mapping is incompatible';
  end if;

  target_column_token := 'f_' || pg_catalog.replace(
    pg_catalog.lower(conversion.target_field_id::text), '-', ''
  );
  select mapping.* into target_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.target_field_id;
  if not found or target_mapping.state <> 'planned'
    or target_mapping.physical_column_token <> target_column_token
    or target_mapping.database_value_type <> conversion.target_database_value_type then
    raise exception using errcode = '55000',
      message = 'Storage conversion target mapping is not allocated';
  end if;

  perform vortex_record.ensure_storage_conversion_column_internal(
    catalogue_row.physical_table_token, target_column_token,
    conversion.target_database_value_type
  );

  source_column_token := source_mapping.physical_column_token;
  assignment := vortex_record.conversion_value_assignment(
    conversion.conversion_semantic, source_column_token, target_column_token
  );
  if assignment is null then
    raise exception using errcode = '23514',
      message = 'Storage conversion semantic is unsupported';
  end if;

  batch_limit := p_batch_size + 1;

  -- Every record with a source value that is not yet converted, or that was
  -- converted under an older concurrency revision, is a candidate. Selecting by
  -- the recorded progress rather than a moving cursor means a record written
  -- after a previous batch, including one whose UUID orders before the cursor,
  -- is never stranded unconverted.
  select_sql := pg_catalog.format(
    'select stored.record_id, stored.concurrency_number'
      || ' from record_data.%I as stored'
      || ' left join vortex_record.storage_conversion_progress as progress'
      || ' on progress.conversion_contract_id = $1::uuid'
      || ' and progress.organisation_id = stored.organisation_id'
      || ' and progress.application_root_id is not distinct from stored.application_root_id'
      || ' and progress.record_id = stored.record_id'
      || ' where stored.organisation_id = $2::uuid'
      || ' and stored.application_root_id is not distinct from $3::uuid'
      || ' and stored.%I is not null'
      || ' and (progress.record_id is null'
      || ' or progress.source_concurrency_number <> stored.concurrency_number)'
      || ' order by stored.record_id'
      || ' limit $4::bigint'
      || ' for update of stored',
    catalogue_row.physical_table_token, source_column_token
  );
  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %s'
      || ' where stored.organisation_id = $1::uuid'
      || ' and stored.application_root_id is not distinct from $2::uuid'
      || ' and stored.record_id = $3::uuid',
    catalogue_row.physical_table_token, assignment
  );

  for record_row in execute select_sql
    using p_conversion_contract_id, organisation_id_value,
      scope_application_root_id, batch_limit
  loop
    candidate_count := candidate_count + 1;
    if candidate_count > p_batch_size then
      has_more := true;
      exit;
    end if;

    execute update_sql
      using organisation_id_value, scope_application_root_id, record_row.record_id;

    update vortex_record.storage_conversion_progress as progress
    set source_concurrency_number = record_row.concurrency_number,
        converted_at = pg_catalog.statement_timestamp()
    where progress.conversion_contract_id = p_conversion_contract_id
      and progress.organisation_id = organisation_id_value
      and progress.application_root_id is not distinct from scope_application_root_id
      and progress.record_id = record_row.record_id;
    if not found then
      insert into vortex_record.storage_conversion_progress (
        conversion_contract_id, organisation_id, application_root_id, record_id,
        source_concurrency_number
      ) values (
        p_conversion_contract_id, organisation_id_value, scope_application_root_id,
        record_row.record_id, record_row.concurrency_number
      );
    end if;

    processed := processed + 1;
    last_record_id := record_row.record_id;
  end loop;

  if has_more then
    current_state := 'converting';
  else
    current_state := 'converted';
  end if;
  next_revision := plan_row.plan_revision + 1;

  -- An already-complete plan with nothing new to convert is returned unchanged
  -- rather than burning a revision.
  if processed = 0 and plan_row.state = 'converted' then
    next_revision := plan_row.plan_revision;
  else
    update vortex_record.storage_conversion_plans as plan
    set state = current_state,
        converted_count = plan.converted_count + processed,
        cursor_record_id = coalesce(last_record_id, plan.cursor_record_id),
        plan_revision = next_revision,
        changed_at = pg_catalog.statement_timestamp()
    where plan.conversion_contract_id = p_conversion_contract_id
      and plan.organisation_id = organisation_id_value
      and plan.application_root_id is not distinct from scope_application_root_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'conversionContractId', conversion.conversion_contract_id,
    'organisationId', organisation_id_value,
    'applicationRootId', scope_application_root_id,
    'state', current_state,
    'planRevision', next_revision,
    'convertedCount', plan_row.converted_count + processed,
    'batchConverted', processed,
    'hasMore', has_more,
    'changed', processed > 0
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '55000',
      message = 'Storage conversion batch evidence is unavailable';
end
$function$;

-- Projects only the authorised correction facts for one plan: records already
-- converted whose source concurrency revision no longer matches the live one.
-- It returns no field values and no physical names, so #626 can decide what to
-- revalidate before any switch.
create function vortex_record.read_storage_conversion_corrections(
  p_conversion_contract_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority jsonb;
  organisation_id_value uuid;
  conversion vortex_record.storage_conversion_catalogue%rowtype;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  source_mapping vortex_record.field_storage_mappings%rowtype;
  scope_application_root_id uuid;
  source_column_token text;
  count_sql text;
  list_sql text;
  correction_row record;
  changed_count bigint := 0;
  corrections jsonb := '[]'::jsonb;
begin
  authority := vortex_record.authorize_storage_conversion_internal();
  organisation_id_value := (authority ->> 'organizationId')::uuid;

  if p_conversion_contract_id is null
    or p_conversion_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_limit is null or p_limit not between 1 and 1000 then
    raise exception using errcode = '22023',
      message = 'Storage conversion correction command is invalid';
  end if;

  select catalogue.* into conversion
  from vortex_record.storage_conversion_catalogue as catalogue
  where catalogue.conversion_contract_id = p_conversion_contract_id;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Storage conversion plan is unavailable';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = conversion.source_storage_contract_id;
  if not found or catalogue_row.state <> 'active' then
    raise exception using errcode = '55000',
      message = 'Storage conversion contract is unavailable';
  end if;

  if catalogue_row.storage_scope = 'application_contained' then
    if authority ->> 'applicationRootId' is null
      or (authority ->> 'applicationRootId')::uuid
        = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '42501',
        message = 'Storage conversion requires an application context';
    end if;
    scope_application_root_id := (authority ->> 'applicationRootId')::uuid;
  else
    scope_application_root_id := null;
  end if;

  select mapping.* into source_mapping
  from vortex_record.field_storage_mappings as mapping
  where mapping.storage_contract_id = conversion.source_storage_contract_id
    and mapping.field_id = conversion.source_field_id;
  if not found then
    raise exception using errcode = '55000',
      message = 'Storage conversion source mapping is unavailable';
  end if;
  source_column_token := source_mapping.physical_column_token;

  count_sql := pg_catalog.format(
    'select pg_catalog.count(*)'
      || ' from record_data.%I as stored'
      || ' join vortex_record.storage_conversion_progress as progress'
      || ' on progress.conversion_contract_id = $1::uuid'
      || ' and progress.organisation_id = stored.organisation_id'
      || ' and progress.application_root_id is not distinct from stored.application_root_id'
      || ' and progress.record_id = stored.record_id'
      || ' where stored.organisation_id = $2::uuid'
      || ' and stored.application_root_id is not distinct from $3::uuid'
      || ' and progress.source_concurrency_number <> stored.concurrency_number',
    catalogue_row.physical_table_token
  );
  execute count_sql into changed_count
    using p_conversion_contract_id, organisation_id_value, scope_application_root_id;

  list_sql := pg_catalog.format(
    'select stored.record_id, progress.source_concurrency_number,'
      || ' stored.concurrency_number'
      || ' from record_data.%I as stored'
      || ' join vortex_record.storage_conversion_progress as progress'
      || ' on progress.conversion_contract_id = $1::uuid'
      || ' and progress.organisation_id = stored.organisation_id'
      || ' and progress.application_root_id is not distinct from stored.application_root_id'
      || ' and progress.record_id = stored.record_id'
      || ' where stored.organisation_id = $2::uuid'
      || ' and stored.application_root_id is not distinct from $3::uuid'
      || ' and progress.source_concurrency_number <> stored.concurrency_number'
      || ' order by stored.record_id'
      || ' limit $4::integer',
    catalogue_row.physical_table_token
  );
  for correction_row in execute list_sql
    using p_conversion_contract_id, organisation_id_value,
      scope_application_root_id, p_limit
  loop
    corrections := corrections || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordId', correction_row.record_id,
        'sourceConcurrencyNumber', correction_row.source_concurrency_number,
        'currentConcurrencyNumber', correction_row.concurrency_number
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'conversionContractId', conversion.conversion_contract_id,
    'organisationId', organisation_id_value,
    'applicationRootId', scope_application_root_id,
    'conversionSemantic', conversion.conversion_semantic,
    'changedCount', changed_count,
    'corrections', corrections
  );
exception
  when no_data_found or too_many_rows then
    raise exception using errcode = '55000',
      message = 'Storage conversion correction evidence is unavailable';
end
$function$;

revoke all on function vortex_record.convert_record_storage_batch(uuid, integer, bigint),
  vortex_record.read_storage_conversion_corrections(uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

grant execute on function vortex_record.convert_record_storage_batch(uuid, integer, bigint)
  to vortex_request;
grant execute on function vortex_record.read_storage_conversion_corrections(uuid, integer)
  to vortex_request;

comment on function vortex_record.convert_record_storage_batch(uuid, integer, bigint) is
  'Converts a bounded record batch into the planned target column under the adapter row-level security scope, recording each source concurrency revision; never bumps concurrency, writes the source column or activates the target.';
comment on function vortex_record.read_storage_conversion_corrections(uuid, integer) is
  'Authorised correction facts: converted records whose live concurrency revision differs from the recorded source revision, with no field values or physical names.';

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;

-- The two record-row operations read and write the catalogue, plan and
-- progress rows through explicit adapter policies and grants.
create policy storage_conversion_catalogue_adapter
  on vortex_record.storage_conversion_catalogue
  to vortex_record_adapter using (true) with check (true);
create policy storage_conversion_plans_adapter on vortex_record.storage_conversion_plans
  to vortex_record_adapter using (true) with check (true);
create policy storage_conversion_progress_adapter on vortex_record.storage_conversion_progress
  to vortex_record_adapter using (true) with check (true);

grant select on vortex_record.storage_conversion_catalogue to vortex_record_adapter;
grant select, update on vortex_record.storage_conversion_plans to vortex_record_adapter;
grant select, insert, update on vortex_record.storage_conversion_progress
  to vortex_record_adapter;

reset role;

commit;
