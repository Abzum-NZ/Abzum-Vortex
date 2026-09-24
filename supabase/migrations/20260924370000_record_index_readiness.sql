-- Track desired and observed readiness for each exact field index of a
-- provisioned Record storage contract (#611).
--
-- Three additions, one migration:
--
-- 1. `vortex_record.index_catalogue` records one stable index identity per
--    exact storage contract and field: its owning lineage, purpose
--    (`uniqueness` or `performance`), the desired-definition fingerprint of the
--    exact index DDL the provisioner emits, the observed physical state and an
--    observation revision.
-- 2. The live `vortex_record.provision_exact_module_storage` body is patched in
--    place through `pg_get_functiondef` so every index it emits is created and
--    recorded by `ensure_field_index_internal`, exactly like the DDL it
--    replaced. The function is never re-created from its last `CREATE` text.
-- 3. `vortex_record.read_index_readiness` projects the live physical readiness
--    of every exact field index an activating Application installation owns:
--    uniqueness indexes are activation requirements, performance indexes are
--    advisory.
--
-- Existing provisioned storage is backfilled from its recorded field mappings
-- without changing physical state; a genuinely missing index is recorded as
-- `missing`, never silently created.

begin;

set local role vortex_record_owner;

create table vortex_record.index_catalogue (
  index_contract_id uuid primary key,
  storage_contract_id uuid not null,
  field_id uuid not null,
  purpose text not null check (purpose in ('uniqueness', 'performance')),
  physical_index_token text not null check (
    physical_index_token ~ '^(ux|ix)_[a-f0-9]{32}$'
  ),
  desired_definition_fingerprint text not null check (
    desired_definition_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  observed_state text not null check (
    observed_state in ('missing', 'present', 'invalid')
  ),
  observed_revision bigint not null check (
    observed_revision between 1 and 9007199254740991
  ),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  -- The physical name is the provisioner's exact name for this purpose and
  -- field, so a row can never describe another field's index.
  check (
    physical_index_token = case purpose when 'uniqueness' then 'ux_' else 'ix_' end
      || pg_catalog.replace(pg_catalog.lower(field_id::text), '-', '')
  ),
  -- One index per exact field; uniqueness takes precedence over performance
  -- exactly as the provisioner's own branch order does.
  unique (storage_contract_id, field_id),
  foreign key (storage_contract_id, field_id)
    references vortex_record.field_storage_mappings (storage_contract_id, field_id)
);

alter table vortex_record.index_catalogue enable row level security;
alter table vortex_record.index_catalogue force row level security;
create policy index_catalogue_owner on vortex_record.index_catalogue
  to vortex_record_owner using (true) with check (true);
alter table vortex_record.index_catalogue owner to vortex_record_owner;

revoke all on table vortex_record.index_catalogue
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;

-- The complete scope prefix every lookup index must carry before its business
-- value, per the storage contract's scope. Derived once so provisioning and
-- readiness can never disagree about the exact column list.
create function vortex_record.index_scope_columns(p_storage_scope text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select case p_storage_scope
    when 'organization_shared' then 'organisation_id'
    when 'application_contained' then 'organisation_id, application_root_id'
    else null
  end
$function$;

-- The stable identity of the one index of an exact storage contract and field.
-- It is derived rather than random so readiness can name an index that has no
-- catalogue row yet, and it carries the RFC 9562 version-8 and variant bits so
-- it is a valid UUID for every contract that parses platform identifiers.
create function vortex_record.index_contract_identity(
  p_storage_contract_id uuid,
  p_field_id uuid
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
      pg_catalog.lower(p_storage_contract_id::text) || ':'
        || pg_catalog.lower(p_field_id::text)
    ) as digest_hex
  ) as source
$function$;

create function vortex_record.index_definition(
  p_purpose text,
  p_table_token text,
  p_scope_index_columns text,
  p_column_token text
)
returns jsonb
language sql
immutable
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'schemaToken', 'record_data',
    'tableToken', p_table_token,
    'columns', pg_catalog.string_to_array(p_scope_index_columns, ', ') || p_column_token,
    'unique', p_purpose = 'uniqueness',
    'predicate', case when p_purpose = 'uniqueness'
      then 'lifecycle_state in (active, soft_deleted, removal_pending)' else null end
  )
$function$;

create function vortex_record.index_definition_fingerprint(
  p_purpose text,
  p_table_token text,
  p_scope_index_columns text,
  p_column_token text
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select 'sha256:' || pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        vortex_record.index_definition(
          p_purpose, p_table_token, p_scope_index_columns, p_column_token
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$function$;

-- Physical observation of one exact field index. It never raises: a missing
-- table or index is `invalid`, an absent index is `missing`, and only an index
-- whose every structural fact matches the desired definition is `present`.
create function vortex_record.observe_field_index_internal(
  p_purpose text,
  p_table_token text,
  p_scope_index_columns text,
  p_column_token text
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  table_relation oid;
  index_relation oid;
  index_row record;
  expected_columns text[];
  key_position integer;
begin
  if p_purpose is null or p_purpose not in ('uniqueness', 'performance')
    or p_table_token is null or p_table_token !~ '^rt_[a-f0-9]{32}$'
    or p_column_token is null or p_column_token !~ '^f_[a-f0-9]{32}$' then
    return 'invalid';
  end if;

  expected_columns := pg_catalog.string_to_array(p_scope_index_columns, ', ')
    || p_column_token;
  if pg_catalog.cardinality(expected_columns) < 2 then
    return 'invalid';
  end if;

  table_relation := pg_catalog.to_regclass(
    pg_catalog.format('record_data.%I', p_table_token)
  );
  if table_relation is null then
    return 'invalid';
  end if;

  index_relation := pg_catalog.to_regclass(
    pg_catalog.format(
      'record_data.%I',
      case p_purpose when 'uniqueness' then 'ux_' else 'ix_' end
        || pg_catalog.substr(p_column_token, 3)
    )
  );
  if index_relation is null then
    return 'missing';
  end if;

  select index_value.* into index_row
  from pg_catalog.pg_index as index_value
  where index_value.indexrelid = index_relation;
  if not found
    or index_row.indrelid is distinct from table_relation
    or index_row.indisvalid is not true
    or index_row.indnkeyatts is distinct from pg_catalog.cardinality(expected_columns) then
    return 'invalid';
  end if;

  for key_position in 1 .. index_row.indnkeyatts
  loop
    if pg_catalog.pg_get_indexdef(index_relation, key_position, false)
      is distinct from expected_columns[key_position] then
      return 'invalid';
    end if;
  end loop;

  if (p_purpose = 'uniqueness') <> index_row.indisunique then
    return 'invalid';
  end if;
  if p_purpose = 'uniqueness' then
    if index_row.indpred is null then
      return 'invalid';
    end if;
  elsif index_row.indpred is not null then
    return 'invalid';
  end if;

  return 'present';
end
$function$;

-- Creates the one exact index for a field and records its desired definition
-- and observed state. It is the only writer of index_catalogue for a fresh
-- field, so a provisioned index and its recorded readiness can never diverge.
create function vortex_record.ensure_field_index_internal(
  p_storage_contract_id uuid,
  p_field_id uuid,
  p_purpose text,
  p_storage_scope text,
  p_table_token text,
  p_scope_index_columns text,
  p_column_token text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  index_token text;
  canonical_scope_columns text;
  definition_fingerprint text;
  observed text;
begin
  canonical_scope_columns := vortex_record.index_scope_columns(p_storage_scope);
  if p_storage_contract_id is null
    or p_storage_contract_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_field_id is null
    or p_field_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_purpose is null or p_purpose not in ('uniqueness', 'performance')
    or canonical_scope_columns is null
    or p_scope_index_columns is distinct from canonical_scope_columns
    or p_table_token is null or p_table_token !~ '^rt_[a-f0-9]{32}$'
    or p_column_token is null or p_column_token !~ '^f_[a-f0-9]{32}$' then
    raise exception using errcode = '55000',
      message = 'Record field index provisioning is invalid';
  end if;

  index_token := case p_purpose when 'uniqueness' then 'ux_' else 'ix_' end
    || pg_catalog.substr(p_column_token, 3);
  definition_fingerprint := vortex_record.index_definition_fingerprint(
    p_purpose, p_table_token, p_scope_index_columns, p_column_token
  );

  if p_purpose = 'uniqueness' then
    execute pg_catalog.format(
      'create unique index if not exists %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
      index_token, p_table_token, p_scope_index_columns, p_column_token
    );
  else
    execute pg_catalog.format(
      'create index if not exists %I on record_data.%I (%s, %I)',
      index_token, p_table_token, p_scope_index_columns, p_column_token
    );
  end if;

  observed := vortex_record.observe_field_index_internal(
    p_purpose, p_table_token, p_scope_index_columns, p_column_token
  );
  if observed <> 'present' then
    raise exception using errcode = '55000',
      message = 'Provisioned record field index is not ready';
  end if;

  insert into vortex_record.index_catalogue (
    index_contract_id, storage_contract_id, field_id, purpose, physical_index_token,
    desired_definition_fingerprint, observed_state, observed_revision
  ) values (
    vortex_record.index_contract_identity(p_storage_contract_id, p_field_id),
    p_storage_contract_id, p_field_id, p_purpose, index_token,
    definition_fingerprint, observed, 1
  )
  on conflict (storage_contract_id, field_id) do update
  set purpose = excluded.purpose,
      physical_index_token = excluded.physical_index_token,
      desired_definition_fingerprint = excluded.desired_definition_fingerprint,
      observed_state = excluded.observed_state,
      observed_revision = vortex_record.index_catalogue.observed_revision + 1,
      changed_at = pg_catalog.statement_timestamp()
  where vortex_record.index_catalogue.purpose is distinct from excluded.purpose
    or vortex_record.index_catalogue.physical_index_token
      is distinct from excluded.physical_index_token
    or vortex_record.index_catalogue.desired_definition_fingerprint
      is distinct from excluded.desired_definition_fingerprint
    or vortex_record.index_catalogue.observed_state is distinct from excluded.observed_state;
end
$function$;

-- The live readiness of every exact field index one activating Application
-- installation owns. It derives the desired definition from the recorded
-- lineage, observes the physical index and compares both with the recorded
-- catalogue row, so a stale or absent observation can never read as ready.
create function vortex_record.read_index_readiness(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_storage_contract_ids uuid[];
  target record;
  mapping record;
  purpose text;
  scope_columns text;
  index_token text;
  definition_fingerprint text;
  observed text;
  catalogue_id uuid;
  catalogue_purpose text;
  catalogue_token text;
  catalogue_fingerprint text;
  catalogue_observed text;
  catalogue_revision bigint;
  ready boolean;
  target_count integer := 0;
  indexes jsonb := '[]'::jsonb;
  uniqueness_ready boolean := true;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Index readiness command is invalid';
  end if;

  -- The same protected activation target fact the lifecycle-policy readiness
  -- read uses; the organisation is re-derived from the validated human request
  -- context inside it and is never taken from the caller.
  select pg_catalog.array_agg(distinct targets.storage_contract_id)
    into target_storage_contract_ids
  from vortex_module.read_lifecycle_activation_targets_internal(
    p_organization_id, p_application_root_id, p_application_release_revision,
    p_expected_module_bindings
  ) as targets;

  if target_storage_contract_ids is null
    or pg_catalog.cardinality(target_storage_contract_ids) = 0 then
    raise exception using errcode = '23514',
      message = 'Index activation targets are incomplete';
  end if;

  for target in
    select catalogue.storage_contract_id, catalogue.storage_scope,
      catalogue.physical_table_token
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = any (target_storage_contract_ids)
      and catalogue.state = 'active'
    order by catalogue.storage_contract_id
  loop
    target_count := target_count + 1;

    for mapping in
      select stored.field_id, stored.physical_column_token, stored.field_definition
      from vortex_record.field_storage_mappings as stored
      where stored.storage_contract_id = target.storage_contract_id
        and stored.state = 'active'
        and (
          coalesce((stored.field_definition ->> 'unique')::boolean, false)
          or coalesce((stored.field_definition ->> 'filterable')::boolean, false)
          or coalesce((stored.field_definition ->> 'sortable')::boolean, false)
        )
      order by stored.field_id
    loop
      purpose := case
        when coalesce((mapping.field_definition ->> 'unique')::boolean, false)
          then 'uniqueness'
        else 'performance'
      end;
      scope_columns := vortex_record.index_scope_columns(target.storage_scope);
      index_token := case purpose when 'uniqueness' then 'ux_' else 'ix_' end
        || pg_catalog.substr(mapping.physical_column_token, 3);
      definition_fingerprint := vortex_record.index_definition_fingerprint(
        purpose, target.physical_table_token, scope_columns, mapping.physical_column_token
      );
      observed := vortex_record.observe_field_index_internal(
        purpose, target.physical_table_token, scope_columns, mapping.physical_column_token
      );

      select stored_index.index_contract_id, stored_index.purpose,
        stored_index.physical_index_token, stored_index.desired_definition_fingerprint,
        stored_index.observed_state, stored_index.observed_revision
      into catalogue_id, catalogue_purpose, catalogue_token, catalogue_fingerprint,
        catalogue_observed, catalogue_revision
      from vortex_record.index_catalogue as stored_index
      where stored_index.storage_contract_id = target.storage_contract_id
        and stored_index.field_id = mapping.field_id
      for share;

      ready := observed = 'present'
        and catalogue_id is not null
        and catalogue_purpose = purpose
        and catalogue_token = index_token
        and catalogue_fingerprint = definition_fingerprint;

      if purpose = 'uniqueness' and not ready then
        uniqueness_ready := false;
      end if;

      indexes := indexes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'indexContractId', coalesce(
          catalogue_id,
          vortex_record.index_contract_identity(
            target.storage_contract_id, mapping.field_id
          )
        ),
        'storageContractId', target.storage_contract_id,
        'fieldId', mapping.field_id,
        'purpose', purpose,
        'desiredDefinitionFingerprint', definition_fingerprint,
        'observedState', observed,
        'recordedObservedState', catalogue_observed,
        'observedRevision', catalogue_revision,
        'ready', ready
      ));
    end loop;
  end loop;

  -- Every installation storage contract must be an active catalogue entry; a
  -- target this read cannot account for is an incomplete installation, never an
  -- implicitly unindexed record type.
  if target_count <> pg_catalog.cardinality(target_storage_contract_ids) then
    raise exception using errcode = '23514',
      message = 'Index activation targets are incomplete';
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', p_organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'indexes', indexes,
    'uniquenessReady', uniqueness_ready,
    'performanceAdvisory', true
  );
end
$function$;

revoke all on function vortex_record.index_scope_columns(text),
  vortex_record.index_contract_identity(uuid, uuid),
  vortex_record.index_definition(text, text, text, text),
  vortex_record.index_definition_fingerprint(text, text, text, text),
  vortex_record.observe_field_index_internal(text, text, text, text),
  vortex_record.ensure_field_index_internal(uuid, uuid, text, text, text, text, text),
  vortex_record.read_index_readiness(uuid, uuid, bigint, jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter, vortex_module_owner;

-- The main request-role activation transaction reads the readiness snapshot,
-- exactly like it reads the lifecycle-policy snapshot.
grant execute on function vortex_record.read_index_readiness(uuid, uuid, bigint, jsonb)
  to vortex_request;

comment on table vortex_record.index_catalogue is
  'Record-owned desired and observed readiness for each exact field index of a provisioned storage contract; one stable index identity per storage contract and field.';
comment on function vortex_record.index_definition_fingerprint(
  text, text, text, text
) is 'Canonical sha256 fingerprint of one exact desired field-index definition, using the same convention as record storage content fingerprints.';
comment on function vortex_record.observe_field_index_internal(
  text, text, text, text
) is 'Physical observation of one exact field index: missing, invalid or present from the live catalogs, never raising.';
comment on function vortex_record.ensure_field_index_internal(
  uuid, uuid, text, text, text, text, text
) is 'Private provisioner helper: creates one exact field index and records its desired definition and observed readiness for one storage contract and field.';
comment on function vortex_record.read_index_readiness(
  uuid, uuid, bigint, jsonb
) is 'Live readiness of every exact field index an activating Application installation owns: uniqueness indexes are activation requirements, performance indexes are advisory.';

reset role;

-- 2. Patch the live provisioner in place. The current body is read from the
-- catalog so this migration never re-creates the function from a stale CREATE
-- text, and the assignment is guarded to match exactly once.
set local role vortex_record_owner;

do $migration$
declare
  source_definition text;
  patched_definition text;
  old_block text;
  new_block text;
begin
  select pg_catalog.pg_get_functiondef(
    'vortex_record.provision_exact_module_storage(uuid,bigint)'::pg_catalog.regprocedure
  ) into strict source_definition;

  -- Exactly-once: a body that already routes through the helper is settled.
  if pg_catalog.strpos(source_definition, 'ensure_field_index_internal') > 0 then
    return;
  end if;

  old_block := $old$        if (field_value ->> 'unique')::boolean then
          execute pg_catalog.format(
            'create unique index %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
            'ux_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', ''),
            table_token, scope_index_columns, column_token
          );
        elsif (field_value ->> 'filterable')::boolean or (field_value ->> 'sortable')::boolean then
          execute pg_catalog.format(
            'create index %I on record_data.%I (%s, %I)',
            'ix_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', ''),
            table_token, scope_index_columns, column_token
          );
        end if;$old$;

  new_block := $new$        if (field_value ->> 'unique')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'uniqueness', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        elsif (field_value ->> 'filterable')::boolean or (field_value ->> 'sortable')::boolean then
          perform vortex_record.ensure_field_index_internal(
            storage_id, field_id_value, 'performance', storage_scope_value,
            table_token, scope_index_columns, column_token
          );
        end if;$new$;

  if (pg_catalog.length(source_definition)
      - pg_catalog.length(pg_catalog.replace(source_definition, old_block, '')))
      <> pg_catalog.length(old_block) then
    raise exception using errcode = '55000',
      message = 'Index readiness provisioning patch did not match exactly once';
  end if;

  patched_definition := pg_catalog.replace(source_definition, old_block, new_block);
  if patched_definition = source_definition
    or pg_catalog.strpos(patched_definition, 'ensure_field_index_internal') = 0
    or pg_catalog.strpos(patched_definition, 'create unique index') > 0 then
    raise exception using errcode = '55000',
      message = 'Index readiness provisioning patch generation failed';
  end if;

  execute patched_definition;
end
$migration$;

-- 3. Backfill recorded readiness for already-provisioned storage. This observes
-- the current physical state and records it; it never creates an index and it
-- never overwrites an existing catalogue row.
do $backfill$
declare
  mapping record;
  purpose text;
  scope_columns text;
  index_token text;
  definition_fingerprint text;
  observed text;
begin
  for mapping in
    select stored.storage_contract_id, stored.field_id, stored.physical_column_token,
      stored.field_definition, catalogue.storage_scope, catalogue.physical_table_token
    from vortex_record.field_storage_mappings as stored
    join vortex_record.storage_catalogue as catalogue
      on catalogue.storage_contract_id = stored.storage_contract_id
    where stored.state = 'active'
      and catalogue.state = 'active'
      and (
        coalesce((stored.field_definition ->> 'unique')::boolean, false)
        or coalesce((stored.field_definition ->> 'filterable')::boolean, false)
        or coalesce((stored.field_definition ->> 'sortable')::boolean, false)
      )
    order by stored.storage_contract_id, stored.field_id
  loop
    purpose := case
      when coalesce((mapping.field_definition ->> 'unique')::boolean, false)
        then 'uniqueness'
      else 'performance'
    end;
    scope_columns := vortex_record.index_scope_columns(mapping.storage_scope);
    index_token := case purpose when 'uniqueness' then 'ux_' else 'ix_' end
      || pg_catalog.substr(mapping.physical_column_token, 3);
    definition_fingerprint := vortex_record.index_definition_fingerprint(
      purpose, mapping.physical_table_token, scope_columns, mapping.physical_column_token
    );
    observed := vortex_record.observe_field_index_internal(
      purpose, mapping.physical_table_token, scope_columns, mapping.physical_column_token
    );

    insert into vortex_record.index_catalogue (
      index_contract_id, storage_contract_id, field_id, purpose, physical_index_token,
      desired_definition_fingerprint, observed_state, observed_revision
    ) values (
      vortex_record.index_contract_identity(
        mapping.storage_contract_id, mapping.field_id
      ),
      mapping.storage_contract_id, mapping.field_id, purpose, index_token,
      definition_fingerprint, observed, 1
    )
    on conflict (storage_contract_id, field_id) do nothing;
  end loop;
end
$backfill$;

reset role;

commit;
