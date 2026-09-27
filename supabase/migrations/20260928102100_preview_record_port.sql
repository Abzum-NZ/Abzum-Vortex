-- Keep Record command receipts and generated reference numbers inside the exact
-- preview installation. Preview writes must not change the live Record ledgers.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

grant references on vortex_module.preview_installations to vortex_record_adapter;
set local role vortex_record_adapter;

create table vortex_record.preview_command_receipts (
  preview_installation_id uuid not null
    references vortex_module.preview_installations (preview_installation_id) on delete cascade,
  organization_id uuid not null,
  application_root_id uuid not null,
  actor_organization_account_id uuid not null,
  command_kind text not null check (command_kind = 'record_save'),
  command_id uuid not null check (
    command_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  operation text not null check (operation in ('create', 'update')),
  command_fingerprint text not null,
  record_type_id uuid not null check (
    record_type_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  record_id uuid,
  state text not null check (state in ('pending', 'completed')),
  concurrency_number bigint,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  completed_at timestamptz,
  constraint preview_command_receipts_pk primary key (
    preview_installation_id, command_kind, command_id
  ),
  constraint preview_command_receipts_state_valid check (
    (state = 'pending' and record_id is null and concurrency_number is null
      and completed_at is null)
    or (state = 'completed' and record_id is not null
      and record_id <> '00000000-0000-0000-0000-000000000000'::uuid
      and concurrency_number is not null
      and concurrency_number between 1 and 9007199254740991
      and completed_at is not null)
  )
);
alter table vortex_record.preview_command_receipts enable row level security;
alter table vortex_record.preview_command_receipts force row level security;
create policy preview_command_receipts_adapter
  on vortex_record.preview_command_receipts to vortex_record_adapter
  using (true) with check (true);
revoke all on table vortex_record.preview_command_receipts
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
comment on table vortex_record.preview_command_receipts is
  'Per-preview idempotency receipts for ordinary create and update commands; deleting a preview deletes its receipts.';

create table vortex_record.preview_reference_counters (
  preview_installation_id uuid not null
    references vortex_module.preview_installations (preview_installation_id) on delete cascade,
  storage_contract_id uuid not null,
  field_id uuid not null,
  next_number numeric(78,0) not null check (next_number >= 2),
  constraint preview_reference_counters_pk primary key (
    preview_installation_id, storage_contract_id, field_id
  )
);
alter table vortex_record.preview_reference_counters enable row level security;
alter table vortex_record.preview_reference_counters force row level security;
create policy preview_reference_counters_adapter
  on vortex_record.preview_reference_counters to vortex_record_adapter
  using (true) with check (true);
revoke all on table vortex_record.preview_reference_counters
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
comment on table vortex_record.preview_reference_counters is
  'Reference-number sequences isolated by preview and storage identity; deleting a preview deletes its counters.';

reset role;
revoke references on vortex_module.preview_installations from vortex_record_adapter;

set local role vortex_module_owner;

create or replace function vortex_module.read_preview_record_installation_internal(
  p_preview_installation_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  preview_row vortex_module.preview_installations%rowtype;
  module_bindings_value jsonb;
begin
  if not vortex_context.is_non_nil_uuid(p_preview_installation_id::text) then
    return null;
  end if;

  begin
    context_value := vortex_module.assert_preview_installation_authority_internal();
  exception when insufficient_privilege then
    return null;
  end;
  select preview.* into preview_row
  from vortex_module.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (context_value ->> 'organizationId')::uuid
    and preview.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and preview.previewer_identity_id = (context_value ->> 'identityId')::uuid
    and preview.previewer_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
  for key share;
  if not found then
    return null;
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'moduleRootId', item.value -> 'moduleRootId',
      'moduleReleaseRevision', item.value -> 'moduleReleaseRevision',
      'bindingRevision', 1,
      'state', 'active'
    ) order by item.value ->> 'moduleRootId' collate "C"
  ), '[]'::jsonb)
  into module_bindings_value
  from pg_catalog.jsonb_array_elements(preview_row.resolved_modules) as item(value);

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', preview_row.preview_installation_id,
    'organizationId', preview_row.organization_id,
    'applicationRootId', preview_row.application_root_id,
    'applicationReleaseRevision', preview_row.draft_revision,
    'moduleBindings', module_bindings_value,
    'candidate', preview_row.candidate,
    'resolvedModules', preview_row.resolved_modules,
    'storageIdentities', preview_row.storage_identities
  );
end
$function$;

alter function vortex_module.read_preview_record_installation_internal(uuid)
  owner to vortex_module_owner;

revoke all on function vortex_module.read_preview_record_installation_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;
grant execute on function vortex_module.read_preview_record_installation_internal(uuid)
  to vortex_record_owner, vortex_record_adapter;
comment on function vortex_module.read_preview_record_installation_internal(uuid) is
  'Private owner-only preview installation reader for the protected Record port, restricted to the exact human identity, organisation account and Application context until expiry.';

reset role;

set local role vortex_record_adapter;

create or replace function vortex_record.read_current_preview_installation_internal()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  address_value text;
  preview_value jsonb;
begin
  address_value := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  if address_value is null then
    return null;
  end if;
  if not pg_catalog.pg_input_is_valid(address_value, 'uuid') then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  preview_value := vortex_module.read_preview_record_installation_internal(
    address_value::uuid
  );
  if preview_value is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  return preview_value;
end
$function$;

alter function vortex_record.read_current_preview_installation_internal()
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_current_preview_installation_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;
grant execute on function vortex_record.read_current_preview_installation_internal()
  to vortex_record_owner, vortex_record_adapter;
comment on function vortex_record.read_current_preview_installation_internal() is
  'Resolves the transaction-local preview address only after the module ledger validates the same human identity, organisation account and Application context and confirms the preview is unexpired.';

create or replace function vortex_record.preview_scoped_command_id_internal(
  p_command_id uuid
)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  preview_value jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Record command identity is invalid';
  end if;
  preview_value := vortex_record.read_current_preview_installation_internal();
  if preview_value is null then
    return p_command_id;
  end if;
  if preview_value ->> 'outcome' is distinct from 'refused' then
    return (pg_catalog.md5(
      (preview_value ->> 'previewInstallationId') || ':' || p_command_id::text
    ))::uuid;
  end if;
  return null;
end
$function$;

alter function vortex_record.preview_scoped_command_id_internal(uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.preview_scoped_command_id_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;
grant execute on function vortex_record.preview_scoped_command_id_internal(uuid)
  to vortex_record_owner, vortex_record_adapter;
comment on function vortex_record.preview_scoped_command_id_internal(uuid) is
  'Derives a deterministic receipt identity inside one validated preview installation so retries stay isolated from live and other preview record commands.';

create or replace function vortex_record.preview_record_field_bounds_internal(
  p_record_type_id uuid,
  p_storage_contract_id uuid,
  p_record_type jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  preview_value jsonb;
begin
  preview_value := vortex_record.read_current_preview_installation_internal();
  if preview_value is null or preview_value ->> 'outcome' = 'refused'
    or pg_catalog.jsonb_typeof(p_record_type) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_record_type -> 'fields') is distinct from 'array'
    or not vortex_context.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_context.is_non_nil_uuid(p_storage_contract_id::text)
    or (p_record_type ->> 'recordTypeId')::uuid is distinct from p_record_type_id
    or p_record_type ? 'systemProjection' then
    return null;
  end if;

  if not exists (
    select 1
    from pg_catalog.jsonb_array_elements(preview_value -> 'storageIdentities')
      as binding(value)
    where (binding.value ->> 'previewStorageContractId')::uuid = p_storage_contract_id
      and (binding.value ->> 'recordTypeId')::uuid = p_record_type_id
  ) then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'readableFieldIds', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.lower(field.value ->> 'fieldId') order by
          pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      )
      from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as field(value)
    ), '[]'::jsonb),
    'changeableFieldIds', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.lower(field.value ->> 'fieldId') order by
          pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      )
      from pg_catalog.jsonb_array_elements(p_record_type -> 'fields') as field(value)
      where field.value ->> 'type' not in (
        'calculation', 'total', 'reference_number', 'link',
        'link_to_one_of_several', 'link_to_person', 'attachment'
      )
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;
grant execute on function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb)
  to vortex_record_owner, vortex_record_adapter;
comment on function vortex_record.preview_record_field_bounds_internal(uuid, uuid, jsonb) is
  'Field bounds for a record already proven to use the exact owner-only preview storage identity; generated and derived fields remain non-changeable.';

create or replace function vortex_record.allocate_preview_reference_number_internal(
  p_preview_installation_id uuid,
  p_storage_contract_id uuid,
  p_field_id uuid,
  p_settings jsonb
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  preview_value jsonb;
  start_number numeric(78,0);
  allocated numeric(78,0);
  digit_width integer;
  prefix_value text;
  suffix_value text;
begin
  if not vortex_context.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_context.is_non_nil_uuid(p_storage_contract_id::text)
    or not vortex_context.is_non_nil_uuid(p_field_id::text)
    or pg_catalog.jsonb_typeof(p_settings) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_settings -> 'digits') is distinct from 'number'
    or (p_settings ->> 'digits')::integer not between 1 and 20
    or (p_settings ? 'startingNumber' and (
      pg_catalog.jsonb_typeof(p_settings -> 'startingNumber') <> 'number'
      or (p_settings ->> 'startingNumber')::numeric < 1
      or pg_catalog.trunc((p_settings ->> 'startingNumber')::numeric)
        <> (p_settings ->> 'startingNumber')::numeric
    )) then
    raise exception using errcode = '22023', message = 'Preview reference-number settings are invalid';
  end if;

  preview_value := vortex_record.read_current_preview_installation_internal();
  if preview_value is null
    or preview_value ->> 'outcome' = 'refused'
    or (preview_value ->> 'previewInstallationId')::uuid
      is distinct from p_preview_installation_id
    or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(preview_value -> 'storageIdentities')
        as binding(value)
      where (binding.value ->> 'previewStorageContractId')::uuid = p_storage_contract_id
    )
    or not exists (
      select 1
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = p_storage_contract_id
        and mapping.field_id = p_field_id
        and mapping.state = 'active'
    ) then
    raise exception using errcode = '42501', message = 'Preview reference-number storage is unavailable';
  end if;

  digit_width := (p_settings ->> 'digits')::integer;
  start_number := coalesce((p_settings ->> 'startingNumber')::numeric, 1);
  prefix_value := coalesce(p_settings ->> 'prefix', '');
  suffix_value := coalesce(p_settings ->> 'suffix', '');

  insert into vortex_record.preview_reference_counters (
    preview_installation_id, storage_contract_id, field_id, next_number
  ) values (
    p_preview_installation_id, p_storage_contract_id, p_field_id, start_number + 1
  )
  on conflict (preview_installation_id, storage_contract_id, field_id)
    do update set next_number =
      vortex_record.preview_reference_counters.next_number + 1
  returning next_number - 1 into allocated;

  return prefix_value
    || pg_catalog.lpad(
      allocated::text,
      case when pg_catalog.length(allocated::text) > digit_width
        then pg_catalog.length(allocated::text) else digit_width end,
      '0'
    )
    || suffix_value;
end
$function$;

alter function vortex_record.allocate_preview_reference_number_internal(uuid, uuid, uuid, jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.allocate_preview_reference_number_internal(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.allocate_preview_reference_number_internal(uuid, uuid, uuid, jsonb)
  to vortex_record_adapter;
comment on function vortex_record.allocate_preview_reference_number_internal(uuid, uuid, uuid, jsonb) is
  'Allocates a reference number from the exact preview installation''s private counter, after revalidating its owner, expiry and storage identity.';

create or replace function vortex_record.resolve_installation_access_plan_internal(
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  none_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  plan_key_value text;
  cached_plan jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  application_release_revision_value bigint;
  preview_installation_id_value uuid;
  binding_item jsonb;
  release_content jsonb;
  release_revision_value bigint;
  release_validation_contract_version text;
  record_type_item jsonb;
  field_item jsonb;
  relationship_item jsonb;
  condition_item jsonb;
  permission_item jsonb;
  module_root_value uuid;
  record_type_id_value uuid;
  release_storage_contract_value uuid;
  storage_contract_value uuid;
  type_meta jsonb := '{}'::jsonb;
  relationship_by_id jsonb := '{}'::jsonb;
  condition_list jsonb := '[]'::jsonb;
  permission_by_id jsonb := '{}'::jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  columns_value jsonb;
  value_expression text;
  plan jsonb;
  cacheable boolean;
begin
  -- The plan is keyed by the exact installation pins. A binding revision is
  -- advanced by every installation lifecycle transition, and a release revision
  -- is immutable, so any change to definitions, bindings, permissions or saved
  -- conditions yields a different key and therefore a different plan. A plan
  -- that no longer matches the live pins can never be selected. The plan holds
  -- declared requirements only: role grants and every other decision input are
  -- read live by Access, never from the plan.
  if p_installation is null
    or pg_catalog.jsonb_typeof(p_installation) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_installation -> 'moduleBindings') is distinct from 'array'
    or (p_installation ->> 'organizationId') is null
    or (p_installation ->> 'applicationRootId') is null
    or (p_installation ->> 'applicationReleaseRevision') is null
    or (p_installation ? 'previewInstallationId'
      and pg_catalog.jsonb_typeof(p_installation -> 'storageIdentities') is distinct from 'array')
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not item.value ?& array[
          'moduleRootId', 'moduleReleaseRevision', 'bindingRevision', 'state'
        ]
    ) then
    raise exception using errcode = '42501',
      message = 'Record installation is unavailable';
  end if;

  organization_id_value := (p_installation ->> 'organizationId')::uuid;
  application_root_id_value := (p_installation ->> 'applicationRootId')::uuid;
  application_release_revision_value :=
    (p_installation ->> 'applicationReleaseRevision')::bigint;
  preview_installation_id_value := case
    when p_installation ? 'previewInstallationId'
      then (p_installation ->> 'previewInstallationId')::uuid
    else null
  end;
  if organization_id_value = none_uuid
    or application_root_id_value = none_uuid
    or application_release_revision_value not between 1 and 9007199254740991 then
    raise exception using errcode = '42501',
      message = 'Record installation is unavailable';
  end if;

  plan_key_value := 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      organization_id_value::text || '|' || application_root_id_value::text || '|'
        || application_release_revision_value::text || '|'
        || case when preview_installation_id_value is null then ''
          else preview_installation_id_value::text || '|' end || coalesce((
          select pg_catalog.string_agg(
            (item.value ->> 'moduleRootId') || ':'
              || (item.value ->> 'moduleReleaseRevision') || ':'
              || (item.value ->> 'bindingRevision') || ':'
              || (item.value ->> 'state'),
            ',' order by (item.value ->> 'moduleRootId') collate "C"
          )
          from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
        ), ''),
      'UTF8'
    )),
    'hex'
  );

  -- Only an all-active pin set is cached. The storage catalogue and field
  -- mappings the plan resolves are not part of the key; storage adoption can
  -- retire a field mapping only while no provisioned or active binding pins a
  -- release that declares the field, so an active plan's mappings cannot
  -- change under it. A detached binding is not counted there, so a detached
  -- pin set is resolved afresh on every call and still refuses a retired
  -- mapping exactly as before.
  cacheable := preview_installation_id_value is null and not exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
    where (item.value ->> 'state') is distinct from 'active'
  );

  if cacheable then
    select stored.plan into cached_plan
    from vortex_record.installation_access_plans as stored
    where stored.plan_key = plan_key_value;
    if cached_plan is not null then
      return cached_plan;
    end if;
  end if;

  -- Step 1: the pinned definitions. Record types, relationships and saved
  -- conditions of every bound Module, plus the declared permissions of the
  -- Application release and of each Module release. Physical tokens are
  -- resolved here too, and every disagreement refuses.
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_installation -> 'moduleBindings') as item(value)
    -- Canonical binding order, so the plan content never depends on the order
    -- a caller happened to supply and always matches the plan key's order.
    order by (item.value ->> 'moduleRootId') collate "C"
  loop
    module_root_value := (binding_item ->> 'moduleRootId')::uuid;
    release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;

    select release.compilation_output #> '{canonical,content}',
      release.validation_contract_version
    into strict release_content, release_validation_contract_version
    from vortex_definition.releases as release
    where release.root_id = module_root_value
      and release.release_revision = release_revision_value;

    if pg_catalog.jsonb_typeof(release_content -> 'recordTypes') <> 'array' then
      raise exception using errcode = '55000',
        message = 'Installed Module definition is unavailable';
    end if;

    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(release_content -> 'recordTypes') as item(value)
    loop
      record_type_id_value := (record_type_item ->> 'recordTypeId')::uuid;
      release_storage_contract_value := (record_type_item ->> 'storageContractId')::uuid;
      if preview_installation_id_value is null then
        storage_contract_value := release_storage_contract_value;
      else
        select (binding.value ->> 'previewStorageContractId')::uuid
        into strict storage_contract_value
        from pg_catalog.jsonb_array_elements(p_installation -> 'storageIdentities')
          as binding(value)
        where (binding.value ->> 'moduleRootId')::uuid = module_root_value
          and (binding.value ->> 'moduleReleaseRevision')::bigint = release_revision_value
          and (binding.value ->> 'recordTypeId')::uuid = record_type_id_value
          and (binding.value ->> 'releaseStorageContractId')::uuid = release_storage_contract_value;
        if not found then
          raise exception using errcode = '55000',
            message = 'Preview Record storage disagrees with its exact Module release';
        end if;
      end if;

      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = storage_contract_value;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> module_root_value
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token not in ('record_data', 'system_projection')
        -- A system projection is read only through the protected reader
        -- registered for exactly the key its installed definition declares (the
        -- catalogue key references the closed registry); a generated record
        -- type is never read through a projection, and a disagreeing key
        -- refuses.
        or (catalogue_row.physical_schema_token = 'system_projection')
          is distinct from (record_type_item ? 'systemProjection')
        or (catalogue_row.physical_schema_token = 'system_projection'
          and catalogue_row.protected_read_model_key
            is distinct from (record_type_item #>> '{systemProjection,protectedView}'))
        or (preview_installation_id_value is null and not exists (
          select 1
          from vortex_record.release_provisions as provision
          where provision.module_root_id = module_root_value
            and provision.release_revision = release_revision_value
            and release_storage_contract_value = any (provision.storage_contract_ids)
        )) then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;

      -- The column map and the one value expression that reads this record
      -- type's row, built once here and reused by every load below.
      columns_value := '{}'::jsonb;
      for field_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        select mapping.* into mapping_row
        from vortex_record.field_storage_mappings as mapping
        where mapping.storage_contract_id = storage_contract_value
          and mapping.field_id = (field_item ->> 'fieldId')::uuid;
        if not found or mapping_row.state <> 'active' then
          raise exception using errcode = '55000',
            message = 'Record storage disagrees with the installed definition';
        end if;
        columns_value := columns_value || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), pg_catalog.jsonb_build_object(
            'token', mapping_row.physical_column_token,
            'databaseValueType', mapping_row.database_value_type,
            'type', field_item ->> 'type'
          )
        );
      end loop;

      select pg_catalog.string_agg(
        field_chunk.pairs_text,
        ') || pg_catalog.jsonb_build_object(' order by field_chunk.chunk_index
      )
      into value_expression
      from (
        select (ordered_fields.field_number - 1) / 50 as chunk_index,
          pg_catalog.string_agg(
            pg_catalog.format(
              '%L, %s',
              ordered_fields.key,
              case ordered_fields.value ->> 'databaseValueType'
                when 'decimal' then
                  pg_catalog.format('pg_catalog.to_jsonb(%I::text)', ordered_fields.value ->> 'token')
                when 'timestamp_with_time_zone' then
                  pg_catalog.format(
                    'pg_catalog.to_jsonb(vortex_context.format_timestamp_utc(%I))',
                    ordered_fields.value ->> 'token'
                  )
                when 'date' then
                  pg_catalog.format(
                    'pg_catalog.to_jsonb(pg_catalog.to_char(%I, ''YYYY-MM-DD''))',
                    ordered_fields.value ->> 'token'
                  )
                else pg_catalog.format('pg_catalog.to_jsonb(%I)', ordered_fields.value ->> 'token')
              end
            ),
            ', ' order by ordered_fields.key collate "C"
          ) as pairs_text
        from (
          select column_entry.key, column_entry.value,
            pg_catalog.row_number() over (
              order by column_entry.key collate "C"
            ) as field_number
          from pg_catalog.jsonb_each(columns_value) as column_entry(key, value)
        ) as ordered_fields
        group by (ordered_fields.field_number - 1) / 50
      ) as field_chunk;

      type_meta := type_meta || pg_catalog.jsonb_build_object(
        pg_catalog.lower(record_type_id_value::text),
        pg_catalog.jsonb_build_object(
          'moduleRootId', module_root_value,
          'recordTypeId', record_type_id_value,
          'storageContractId', storage_contract_value,
          'storageScope', record_type_item ->> 'storageScope',
          'ownershipMode', record_type_item ->> 'ownershipMode',
          'releaseRevision', release_revision_value,
          'validationContractVersion', release_validation_contract_version,
          'table', catalogue_row.physical_table_token,
          'columns', columns_value,
          'valueExpression', value_expression,
          'fields', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'fieldId', declared.value -> 'fieldId',
                'type', declared.value -> 'type'
              ) || case
                when pg_catalog.jsonb_typeof(declared.value -> 'settings') = 'object'
                  then pg_catalog.jsonb_build_object('settings', declared.value -> 'settings')
                else '{}'::jsonb
              end
              order by declared.ordinality
            )
            from pg_catalog.jsonb_array_elements(record_type_item -> 'fields')
              with ordinality as declared(value, ordinality)
          ), '[]'::jsonb)
        ) || case
          when record_type_item ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', record_type_item -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
      );

      for relationship_item in
        select item.value
        from pg_catalog.jsonb_array_elements(record_type_item -> 'relationships') as item(value)
      loop
        -- Every declared target, single or polymorphic, as one uniform list;
        -- Access proves a concrete edge target a member of it.
        relationship_by_id := relationship_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(relationship_item ->> 'relationshipId'),
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_item -> 'relationshipId',
            'fromModuleRootId', module_root_value,
            'fromRecordTypeId', record_type_item -> 'recordTypeId',
            'toRecordTypes', coalesce((
              select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'moduleRootId', target.value -> 'moduleRootId',
                'recordTypeId', target.value -> 'recordTypeId'
              ) order by target.ordinality)
              from pg_catalog.jsonb_array_elements(
                case when relationship_item ? 'toRecordType'
                  then pg_catalog.jsonb_build_array(relationship_item -> 'toRecordType')
                  else relationship_item -> 'toRecordTypes'
                end
              ) with ordinality as target(value, ordinality)
            ), '[]'::jsonb)
          )
        );
      end loop;
    end loop;

    for condition_item in
      select item.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'sharingConditions') = 'array'
            then release_content -> 'sharingConditions'
          else '[]'::jsonb
        end
      ) as item(value)
    loop
      condition_list := condition_list || pg_catalog.jsonb_build_array(condition_item);
    end loop;

    for permission_item in
      select item.value
      from pg_catalog.jsonb_array_elements(
        case
          when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
            then release_content -> 'permissions'
          else '[]'::jsonb
        end
      ) as item(value)
    loop
      if pg_catalog.jsonb_typeof(permission_item -> 'recordScope') = 'object' then
        permission_by_id := permission_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(permission_item ->> 'permissionId'),
          pg_catalog.jsonb_build_object(
            'ownerKind', 'module',
            'ownerId', module_root_value,
            'recordTypeId', permission_item -> 'recordTypeId',
            'actionKind', permission_item -> 'actionKind',
            'namedAction', permission_item -> 'namedAction',
            'recordScope', permission_item -> 'recordScope'
          )
        );
      end if;
    end loop;
  end loop;

  if preview_installation_id_value is null then
    select release.compilation_output #> '{canonical,content}'
    into strict release_content
    from vortex_definition.releases as release
    where release.root_id = application_root_id_value
      and release.release_revision = application_release_revision_value;
  else
    release_content := p_installation #> '{candidate,compilation,canonical,content}';
    if pg_catalog.jsonb_typeof(release_content) is distinct from 'object' then
      raise exception using errcode = '55000',
        message = 'Preview Application candidate is unavailable';
    end if;
  end if;

  for permission_item in
    select item.value
    from pg_catalog.jsonb_array_elements(
      case
        when pg_catalog.jsonb_typeof(release_content -> 'permissions') = 'array'
          then release_content -> 'permissions'
        else '[]'::jsonb
      end
    ) as item(value)
  loop
    if pg_catalog.jsonb_typeof(permission_item -> 'recordScope') = 'object' then
      permission_by_id := permission_by_id || pg_catalog.jsonb_build_object(
        pg_catalog.lower(permission_item ->> 'permissionId'),
        pg_catalog.jsonb_build_object(
          'ownerKind', 'application',
          'ownerId', application_root_id_value,
          'recordTypeId', permission_item -> 'recordTypeId',
          'actionKind', permission_item -> 'actionKind',
          'namedAction', permission_item -> 'namedAction',
          'recordScope', permission_item -> 'recordScope'
        )
      );
    end if;
  end loop;

  plan := pg_catalog.jsonb_build_object(
    'organizationId', organization_id_value,
    'applicationRootId', application_root_id_value,
    'applicationReleaseRevision', application_release_revision_value,
    'recordTypes', type_meta,
    'relationships', relationship_by_id,
    'sharingConditions', condition_list,
    'permissions', permission_by_id
  ) || case when preview_installation_id_value is not null
    then pg_catalog.jsonb_build_object(
      'previewInstallationId', preview_installation_id_value
    )
    else '{}'::jsonb end;

  if not cacheable then
    return plan;
  end if;

  -- A concurrent builder may have stored the same plan first. Both were built
  -- from the same immutable pins, so either row is the same plan; this call's
  -- own plan is returned when that row is not yet visible to its snapshot.
  insert into vortex_record.installation_access_plans (
    plan_key, organization_id, application_root_id,
    application_release_revision, plan
  ) values (
    plan_key_value, organization_id_value, application_root_id_value,
    application_release_revision_value, plan
  )
  on conflict (plan_key) do nothing;

  select stored.plan into cached_plan
  from vortex_record.installation_access_plans as stored
  where stored.plan_key = plan_key_value;
  return coalesce(cached_plan, plan);
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.resolve_installation_access_plan_internal(jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.resolve_installation_access_plan_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.resolve_installation_access_plan_internal(jsonb)
  to vortex_record_adapter;

comment on function vortex_record.resolve_installation_access_plan_internal(jsonb) is
  'Private installation access plan builder and cache: resolves definitions, column maps, permission alternatives and saved conditions once per all-active installation binding revision; a detached pin set is resolved afresh.';

create or replace function vortex_record.load_record_access_facts_from_installation_internal(
  p_record_type_id uuid,
  p_action_kind text,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  plan jsonb;
  type_meta jsonb := '{}'::jsonb;
  relationship_by_id jsonb := '{}'::jsonb;
  condition_list jsonb := '[]'::jsonb;
  permission_by_id jsonb := '{}'::jsonb;
  required_permissions jsonb;
  declaration jsonb;
  target_meta jsonb;
  target_table text;
  target_scope text;
  target_module_root_id uuid;
  target_release_revision bigint;
  records_by_id jsonb := '{}'::jsonb;
  candidate_edges jsonb := '[]'::jsonb;
  load_contracts uuid[] := array[]::uuid[];
  load_records uuid[] := array[]::uuid[];
  pair_records uuid[] := array[]::uuid[];
  pair_permissions uuid[] := array[]::uuid[];
  seen_pairs text[] := array[]::text[];
  pair_identity text;
  current_contract uuid;
  current_record uuid;
  current_permission uuid;
  current_meta jsonb;
  current_scope jsonb;
  route_item jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  load_sql text;
  record_fact jsonb;
  target_fact jsonb;
  target_concurrency_number bigint;
  target_definition_revision bigint;
  facts jsonb;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore', 'transfer')
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740991) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  -- Step 1: the verified request context. The adapter never reads
  -- `current_user`, which is its own owner inside a definer function.
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  -- Step 2: the exact installation supplied by the trusted caller. Its reader
  -- owns the pin-set rules; this adapter consumes them and adds none.
  -- Step 3: the cached access plan. Definitions, column maps, permission
  -- alternatives and saved conditions are resolved once per installation
  -- binding revision and reused by every load below.
  plan := vortex_record.resolve_installation_access_plan_internal(p_installation);
  if (plan ->> 'organizationId')::uuid is distinct from context_organization_id
    or (plan ->> 'applicationRootId')::uuid is distinct from context_application_root_id then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  type_meta := plan -> 'recordTypes';
  relationship_by_id := plan -> 'relationships';
  condition_list := plan -> 'sharingConditions';
  permission_by_id := plan -> 'permissions';

  target_meta := type_meta -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  target_table := target_meta ->> 'table';
  target_scope := target_meta ->> 'storageScope';
  target_module_root_id := (target_meta ->> 'moduleRootId')::uuid;
  target_release_revision := (target_meta ->> 'releaseRevision')::bigint;

  -- Step 4: the declaration. Every record-scoped permission of this action
  -- kind declared for this exact record type, owned by the context Application
  -- or by the record type's own Module, in the canonical order the eligibility
  -- core requires.
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'applicationRootId', context_application_root_id,
      'ownerKind', declared.value ->> 'ownerKind',
      'ownerId', (declared.value ->> 'ownerId')::uuid,
      'permissionId', declared.key::uuid
    )
    order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
  )
  into required_permissions
  from pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
  where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and declared.value ->> 'actionKind' = p_action_kind
    -- `->>` and not `->`: a permission that declares no named action is stored
    -- here as JSON null, which `-> 'namedAction' is null` would never match, so
    -- that test would leave every declaration empty and refuse every record.
    and (declared.value ->> 'namedAction') is null
    and (
      (declared.value ->> 'ownerKind') = 'application'
      or (declared.value ->> 'ownerId')::uuid = target_module_root_id
    );

  declaration := case
    when required_permissions is null
      and not (p_installation ? 'previewInstallationId') then null
    else pg_catalog.jsonb_build_object(
      'operationKey', 'record.' || p_action_kind,
      'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
      'target', pg_catalog.jsonb_build_object(
        'kind', 'application', 'applicationRootId', context_application_root_id
      ),
      'requiredPermissions', coalesce(required_permissions, '[]'::jsonb),
      'recordBinding', pg_catalog.jsonb_build_object(
        'moduleRootId', target_module_root_id,
        'recordTypeId', p_record_type_id,
        'storageContractId', (target_meta ->> 'storageContractId')::uuid,
        'storageScope', target_scope
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', case when p_installation ? 'previewInstallationId'
          then 'preview_owner' else 'permission' end
      )
    )
  end;

  -- Step 5: the target row. The change path locks it here, before any other
  -- row is read, and refuses a stale number without doing the closure work.
  -- Organisation and application isolation is the scope policy's, which is what
  -- makes a foreign row indistinguishable from a missing one.
  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_build_object(
       ''recordScope'', pg_catalog.jsonb_build_object(
         ''storageScope'', %L,
         ''organizationId'', stored.organisation_id,
         ''moduleRootId'', %L::uuid,
         ''recordTypeId'', %L::uuid,
         ''storageContractId'', %L::uuid,
         ''recordId'', stored.record_id
       ) || case when %L = ''application_contained''
         then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
         else ''{}''::jsonb end,
       ''lifecycleState'', stored.lifecycle_state,
       ''fieldValues'', pg_catalog.jsonb_build_object(%s)
     ) || case
       when stored.owner_organisation_account_id is not null
         then pg_catalog.jsonb_build_object(
           ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
       when stored.owner_group_id is not null
         then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
       else ''{}''::jsonb end,
     stored.concurrency_number, stored.definition_revision
     from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2%s',
    target_scope, target_module_root_id, p_record_type_id,
    (target_meta ->> 'storageContractId')::uuid, target_scope,
    target_meta ->> 'valueExpression', target_table,
    case when p_expected_concurrency_number is null then '' else ' for update' end
  );

  execute load_sql
  into record_fact, target_concurrency_number, target_definition_revision
  using context_organization_id, p_record_id;

  if record_fact is null then
    return pg_catalog.jsonb_build_object('outcome', 'missing');
  end if;

  if p_expected_concurrency_number is not null
    and target_concurrency_number <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', target_concurrency_number
    );
  end if;

  records_by_id := pg_catalog.jsonb_build_object(
    pg_catalog.lower(p_record_id::text), record_fact
  );
  target_fact := record_fact;

  -- Step 6: the fact closure. Two queues drain into one loop: rows still to
  -- load, and (record, permission) pairs still to expand. A pair is expanded at
  -- most once, which bounds the walk; an inherited-ownership chain is expanded
  -- by pushing the parent under the same permission, so the chase and the
  -- relationship routes use the same mechanism.
  if declaration is not null then
    for route_item in
      select item.value from pg_catalog.jsonb_array_elements(required_permissions) as item(value)
    loop
      pair_records := pg_catalog.array_append(pair_records, p_record_id);
      pair_permissions := pg_catalog.array_append(
        pair_permissions, (route_item ->> 'permissionId')::uuid
      );
    end loop;
  end if;

  while coalesce(pg_catalog.array_length(load_records, 1), 0) > 0
    or coalesce(pg_catalog.array_length(pair_records, 1), 0) > 0
  loop
    if coalesce(pg_catalog.array_length(load_records, 1), 0) > 0 then
      current_contract := load_contracts[pg_catalog.array_length(load_contracts, 1)];
      current_record := load_records[pg_catalog.array_length(load_records, 1)];
      load_contracts := load_contracts[1:pg_catalog.array_length(load_contracts, 1) - 1];
      load_records := load_records[1:pg_catalog.array_length(load_records, 1) - 1];

      if records_by_id ? pg_catalog.lower(current_record::text) then
        continue;
      end if;

      select meta.value into current_meta
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
      where (meta.value ->> 'storageContractId')::uuid = current_contract
      limit 1;
      if current_meta is null then
        continue;
      end if;

      load_sql := pg_catalog.format(
        'select pg_catalog.jsonb_build_object(
           ''recordScope'', pg_catalog.jsonb_build_object(
             ''storageScope'', %L,
             ''organizationId'', stored.organisation_id,
             ''moduleRootId'', %L::uuid,
             ''recordTypeId'', %L::uuid,
             ''storageContractId'', %L::uuid,
             ''recordId'', stored.record_id
           ) || case when %L = ''application_contained''
             then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
             else ''{}''::jsonb end,
           ''lifecycleState'', stored.lifecycle_state,
           ''fieldValues'', pg_catalog.jsonb_build_object(%s)
         ) || case
           when stored.owner_organisation_account_id is not null
             then pg_catalog.jsonb_build_object(
               ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
           when stored.owner_group_id is not null
             then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
           else ''{}''::jsonb end
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = $2',
        current_meta ->> 'storageScope', (current_meta ->> 'moduleRootId')::uuid,
        (current_meta ->> 'recordTypeId')::uuid, current_contract,
        current_meta ->> 'storageScope', current_meta ->> 'valueExpression',
        current_meta ->> 'table'
      );

      execute load_sql into record_fact using context_organization_id, current_record;
      if record_fact is not null then
        records_by_id := records_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(current_record::text), record_fact
        );
      end if;
      continue;
    end if;

    current_record := pair_records[pg_catalog.array_length(pair_records, 1)];
    current_permission := pair_permissions[pg_catalog.array_length(pair_permissions, 1)];
    pair_records := pair_records[1:pg_catalog.array_length(pair_records, 1) - 1];
    pair_permissions := pair_permissions[1:pg_catalog.array_length(pair_permissions, 1) - 1];

    pair_identity := pg_catalog.lower(current_record::text) || ':'
      || pg_catalog.lower(current_permission::text);
    if pair_identity = any (seen_pairs) then
      continue;
    end if;
    seen_pairs := pg_catalog.array_append(seen_pairs, pair_identity);

    record_fact := records_by_id -> pg_catalog.lower(current_record::text);
    if record_fact is null then
      continue;
    end if;
    current_meta := type_meta -> pg_catalog.lower(
      record_fact -> 'recordScope' ->> 'recordTypeId'
    );
    current_scope := permission_by_id -> pg_catalog.lower(current_permission::text)
      -> 'recordScope';
    if current_meta is null or current_scope is null then
      continue;
    end if;

    -- Inherited ownership: push the declared parent under the same permission,
    -- which repeats for the grandparent when that pair is expanded.
    if current_meta ->> 'ownershipMode' = 'inherited'
      and current_meta ? 'ownershipRelationshipId'
      and exists (
        select 1 from pg_catalog.jsonb_array_elements(current_scope -> 'routes') as route(value)
        where route.value ->> 'kind' = 'ownership'
      ) then
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (current_meta ->> 'ownershipRelationshipId')::uuid
          and edge.from_storage_contract_id = (current_meta ->> 'storageContractId')::uuid
          and edge.from_record_id = current_record
      loop
        load_contracts := pg_catalog.array_append(load_contracts, edge_row.to_storage_contract_id);
        load_records := pg_catalog.array_append(load_records, edge_row.to_record_id);
        pair_records := pg_catalog.array_append(pair_records, edge_row.to_record_id);
        pair_permissions := pg_catalog.array_append(pair_permissions, current_permission);
        candidate_edges := candidate_edges || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', edge_row.relationship_id,
            'fromRecordId', edge_row.from_record_id,
            'toRecordId', edge_row.to_record_id
          )
        );
      end loop;
    end if;

    -- Relationship routes: the target is always the `to` endpoint, so the
    -- sources this permission can reach it through are the `from` rows of that
    -- relationship's edges, each expanded under its own source permission.
    for route_item in
      select route.value
      from pg_catalog.jsonb_array_elements(current_scope -> 'routes') as route(value)
      where route.value ->> 'kind' = 'relationship'
    loop
      if not (relationship_by_id ? pg_catalog.lower(route_item ->> 'relationshipId')) then
        continue;
      end if;
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (route_item ->> 'relationshipId')::uuid
          and edge.to_storage_contract_id = (current_meta ->> 'storageContractId')::uuid
          and edge.to_record_id = current_record
      loop
        load_contracts := pg_catalog.array_append(
          load_contracts, edge_row.from_storage_contract_id
        );
        load_records := pg_catalog.array_append(load_records, edge_row.from_record_id);
        pair_records := pg_catalog.array_append(pair_records, edge_row.from_record_id);
        pair_permissions := pg_catalog.array_append(
          pair_permissions, (route_item ->> 'sourcePermissionId')::uuid
        );
        candidate_edges := candidate_edges || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', edge_row.relationship_id,
            'fromRecordId', edge_row.from_record_id,
            'toRecordId', edge_row.to_record_id
          )
        );
      end loop;
    end loop;
  end loop;

  -- Step 7: the facts. Every record type, relationship and saved condition of
  -- the installed definitions; the records the closure reached; and exactly the
  -- edges whose endpoints are both present, deduplicated.
  facts := pg_catalog.jsonb_build_object(
    'binding', declaration -> 'recordBinding',
    'recordTypes', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'moduleRootId', meta.value -> 'moduleRootId',
          'recordTypeId', meta.value -> 'recordTypeId',
          'storageContractId', meta.value -> 'storageContractId',
          'storageScope', meta.value -> 'storageScope',
          'ownershipMode', meta.value -> 'ownershipMode',
          'validationContractVersion', meta.value -> 'validationContractVersion',
          'fields', meta.value -> 'fields'
        ) || case
          when meta.value ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', meta.value -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
        order by meta.key collate "C"
      )
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
    ), '[]'::jsonb),
    'relationships', coalesce((
      select pg_catalog.jsonb_agg(declared.value order by declared.key collate "C")
      from pg_catalog.jsonb_each(relationship_by_id) as declared(key, value)
    ), '[]'::jsonb),
    'sharingConditions', condition_list,
    'records', coalesce((
      select pg_catalog.jsonb_agg(stored.value order by stored.key collate "C")
      from pg_catalog.jsonb_each(records_by_id) as stored(key, value)
    ), '[]'::jsonb),
    'edges', coalesce((
      select pg_catalog.jsonb_agg(distinct edge.value)
      from pg_catalog.jsonb_array_elements(candidate_edges) as edge(value)
      where records_by_id ? pg_catalog.lower(edge.value ->> 'fromRecordId')
        and records_by_id ? pg_catalog.lower(edge.value ->> 'toRecordId')
    ), '[]'::jsonb)
  );

  return pg_catalog.jsonb_build_object(
    'outcome', 'loaded',
    'context', context_value,
    'declaration', declaration,
    'facts', facts,
    'table', target_table,
    'columns', target_meta -> 'columns',
    'concurrencyNumber', target_concurrency_number,
    'definitionRevision', target_definition_revision,
    'moduleReleaseRevision', target_release_revision,
    'fieldValues', target_fact -> 'fieldValues'
  ) || case when p_installation ? 'previewInstallationId'
    then pg_catalog.jsonb_build_object(
      'previewInstallationId', p_installation -> 'previewInstallationId'
    )
    else '{}'::jsonb end;
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.load_record_access_facts_from_installation_internal(uuid,text,uuid,bigint,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_from_installation_internal(
  uuid, text, uuid, bigint, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.load_record_access_facts_from_installation_internal(
  uuid, text, uuid, bigint, jsonb
) to vortex_record_adapter;

comment on function vortex_record.load_record_access_facts_from_installation_internal(
  uuid, text, uuid, bigint, jsonb
) is
  'Private adapter fact loader over one exact trusted installation or owner-validated preview, resolving definitions from the cached installation access plan.';

create or replace function vortex_record.load_record_access_facts_internal(
  p_record_type_id uuid,
  p_action_kind text,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_application_root_id uuid;
  installation jsonb;
  preview_installation jsonb;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore')
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740991) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  -- Step 1: the verified request context, checked here so the active reader
  -- and the shared loader refuse an absent Application context identically.
  context_value := vortex_access.validated_human_request_context();
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  -- Step 2: resolve only the explicitly addressed preview for its owner, or
  -- preserve the active installation reader for an ordinary live request.
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  installation := case when preview_installation is null
    then vortex_module.read_current_active_installation()
    else preview_installation end;

  return vortex_record.load_record_access_facts_from_installation_internal(
    p_record_type_id, p_action_kind, p_record_id, p_expected_concurrency_number, installation
  );
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

alter function vortex_record.load_record_access_facts_internal(uuid,text,uuid,bigint) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_internal(
  uuid, text, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

comment on function vortex_record.load_record_access_facts_internal(
  uuid, text, uuid, bigint
) is
  'Private adapter fact loader over the exact active installation or the current owner-validated preview, including each pinned Module validation contract version.';

create or replace function vortex_record.resolve_record_action_context_internal(
  p_record_type_id uuid,
  p_action_kind text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  application_root_id_value uuid;
  installation jsonb;
  preview_installation jsonb;
  preview_installation_id_value uuid;
  binding_item jsonb;
  module_content jsonb;
  application_content jsonb;
  module_root_id_value uuid;
  module_release_revision_value bigint;
  record_type_value jsonb;
  candidate_record_type_value jsonb;
  release_storage_contract_id uuid;
  target_module_root_id uuid;
  target_release_revision bigint;
  target_storage_contract_id uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  field_item jsonb;
  field_mapping vortex_record.field_storage_mappings%rowtype;
  columns_value jsonb := '{}'::jsonb;
  required_permissions jsonb := '[]'::jsonb;
  permission_item jsonb;
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore') then
    raise exception using errcode = '22023', message = 'Record action selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record action requires an application context';
  end if;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null then
    if preview_installation ->> 'outcome' = 'refused'
      or p_action_kind not in ('create', 'read', 'update') then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    installation := preview_installation;
    preview_installation_id_value :=
      (preview_installation ->> 'previewInstallationId')::uuid;
  else
    installation := vortex_module.read_current_active_installation();
  end if;

  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  loop
    module_root_id_value := (binding_item ->> 'moduleRootId')::uuid;
    module_release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;
    select release.compilation_output #> '{canonical,content}' into strict module_content
    from vortex_definition.releases as release
    where release.root_id = module_root_id_value
      and release.release_revision = module_release_revision_value;

    select item.value into candidate_record_type_value
    from pg_catalog.jsonb_array_elements(module_content -> 'recordTypes') as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
    if found then
      if target_module_root_id is not null then
        raise exception using errcode = '55000',
          message = 'Installed record type identity is ambiguous';
      end if;
      target_module_root_id := module_root_id_value;
      target_release_revision := module_release_revision_value;
      record_type_value := candidate_record_type_value;
      release_storage_contract_id := (record_type_value ->> 'storageContractId')::uuid;
      target_storage_contract_id := release_storage_contract_id;
      if preview_installation_id_value is not null then
        select (binding.value ->> 'previewStorageContractId')::uuid
        into strict target_storage_contract_id
        from pg_catalog.jsonb_array_elements(installation -> 'storageIdentities')
          as binding(value)
        where (binding.value ->> 'moduleRootId')::uuid = target_module_root_id
          and (binding.value ->> 'moduleReleaseRevision')::bigint = target_release_revision
          and (binding.value ->> 'recordTypeId')::uuid = p_record_type_id
          and (binding.value ->> 'releaseStorageContractId')::uuid = release_storage_contract_id;
        if not found then
          return pg_catalog.jsonb_build_object('outcome', 'refused');
        end if;
      end if;
      for permission_item in
        select item.value
        from pg_catalog.jsonb_array_elements(
          coalesce(module_content -> 'permissions', '[]'::jsonb)
        ) as item(value)
        where (item.value ->> 'recordTypeId')::uuid = p_record_type_id
          and item.value ->> 'actionKind' = p_action_kind
          and (item.value ->> 'namedAction') is null
      loop
        required_permissions := required_permissions || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'applicationRootId', application_root_id_value,
            'ownerKind', 'module', 'ownerId', target_module_root_id,
            'permissionId', (permission_item ->> 'permissionId')::uuid
          )
        );
      end loop;
    end if;
  end loop;

  if target_module_root_id is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = target_storage_contract_id;
  if not found or catalogue_row.state <> 'active'
    or catalogue_row.module_root_id <> target_module_root_id
    or catalogue_row.record_type_id <> p_record_type_id
    or catalogue_row.storage_scope is distinct from (record_type_value ->> 'storageScope')
    or catalogue_row.physical_schema_token <> 'record_data'
    or (preview_installation_id_value is null and not exists (
      select 1 from vortex_record.release_provisions as provision
      where provision.module_root_id = target_module_root_id
        and provision.release_revision = target_release_revision
        and release_storage_contract_id = any (provision.storage_contract_ids)
    )) then
    raise exception using errcode = '55000',
      message = 'Record storage disagrees with the active installation';
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
  loop
    select mapping.* into field_mapping
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = target_storage_contract_id
      and mapping.field_id = (field_item ->> 'fieldId')::uuid;
    if not found or field_mapping.state <> 'active' then
      raise exception using errcode = '55000',
        message = 'Record field storage disagrees with the active installation';
    end if;
    columns_value := columns_value || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'),
      pg_catalog.jsonb_build_object(
        'token', field_mapping.physical_column_token,
        'databaseValueType', field_mapping.database_value_type,
        'type', field_item ->> 'type',
        'required', field_item -> 'required',
        'settings', field_item -> 'settings'
      )
    );
  end loop;

  if preview_installation_id_value is null then
    select release.compilation_output #> '{canonical,content}' into strict application_content
    from vortex_definition.releases as release
    where release.root_id = application_root_id_value
      and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;
  else
    application_content :=
      installation #> '{candidate,compilation,canonical,content}';
    if pg_catalog.jsonb_typeof(application_content) is distinct from 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
  end if;
  for permission_item in
    select item.value
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'permissions', '[]'::jsonb)
    ) as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id
      and item.value ->> 'actionKind' = p_action_kind
      and (item.value ->> 'namedAction') is null
  loop
    required_permissions := required_permissions || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', application_root_id_value,
        'ownerKind', 'application', 'ownerId', application_root_id_value,
        'permissionId', (permission_item ->> 'permissionId')::uuid
      )
    );
  end loop;

  required_permissions := coalesce((
    select pg_catalog.jsonb_agg(item.value order by
      item.value ->> 'ownerKind' collate "C", item.value ->> 'permissionId' collate "C")
    from pg_catalog.jsonb_array_elements(required_permissions) as item(value)
  ), '[]'::jsonb);

  return pg_catalog.jsonb_build_object(
    'context', context_value,
    'recordType', record_type_value,
    'moduleRootId', target_module_root_id,
    'moduleReleaseRevision', target_release_revision,
    'storageContractId', target_storage_contract_id,
    'storageScope', record_type_value ->> 'storageScope',
    'table', catalogue_row.physical_table_token,
    'columns', columns_value,
    'declaration', case when preview_installation_id_value is not null
      then pg_catalog.jsonb_build_object(
        'operationKey', 'record.' || p_action_kind,
        'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
        'target', pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', application_root_id_value
        ),
        'requiredPermissions', required_permissions,
        'recordBinding', pg_catalog.jsonb_build_object(
          'moduleRootId', target_module_root_id,
          'recordTypeId', p_record_type_id,
          'storageContractId', target_storage_contract_id,
          'storageScope', record_type_value ->> 'storageScope'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'preview_owner')
      )
      when pg_catalog.jsonb_array_length(required_permissions) = 0 then null
      else pg_catalog.jsonb_build_object(
        'operationKey', 'record.' || p_action_kind,
        'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
        'target', pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', application_root_id_value
        ),
        'requiredPermissions', required_permissions,
        'recordBinding', pg_catalog.jsonb_build_object(
          'moduleRootId', target_module_root_id,
          'recordTypeId', p_record_type_id,
          'storageContractId', target_storage_contract_id,
          'storageScope', record_type_value ->> 'storageScope'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      ) end
  ) || case when preview_installation_id_value is not null
    then pg_catalog.jsonb_build_object(
      'previewInstallationId', preview_installation_id_value
    )
    else '{}'::jsonb end;
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed definition evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed definition evidence is ambiguous';
end
$function$;

alter function vortex_record.resolve_record_action_context_internal(uuid, text)
  owner to vortex_record_adapter;

revoke all on function vortex_record.resolve_record_action_context_internal(uuid, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
comment on function vortex_record.resolve_record_action_context_internal(uuid, text) is
  'Private Record metadata resolver over one exact live installation or an owner-validated, unexpired preview storage binding; preview contexts support only reads and base record changes.';

create or replace function vortex_record.prepare_base_record_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  installation jsonb;
  module_content jsonb;
  application_content jsonb;
  unsupported boolean := false;
  context_value jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  effective_command_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  fingerprint_value text;
  receipt_claim jsonb;
  projection jsonb;
  decision jsonb;
  bounds jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    )) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  fingerprint_value := vortex_record.base_save_command_fingerprint_internal(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_submitted_values, p_selected_group_id
  );

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', effective_command_id, p_operation, fingerprint_value,
    p_record_type_id, null, '{}'::jsonb, '{}'::jsonb, true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_id_value
      );
    end if;
    projection := vortex_record.read_record(
      p_record_type_id, (receipt_claim ->> 'recordId')::uuid
    );
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', correlation_id_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  );
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
    or (preview_installation is not null and meta ? 'recordType'
      and meta -> 'recordType' ? 'systemProjection') then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  installation := case when preview_installation is null
    then vortex_module.read_current_active_installation()
    else preview_installation end;

  select release.compilation_output #> '{canonical,content}'
  into strict module_content
  from vortex_definition.releases as release
  where release.root_id = (meta ->> 'moduleRootId')::uuid
    and release.release_revision = (meta ->> 'moduleReleaseRevision')::bigint;

  if preview_installation is null then
    select release.compilation_output #> '{canonical,content}'
    into strict application_content
    from vortex_definition.releases as release
    where release.root_id = (meta -> 'context' ->> 'applicationRootId')::uuid
      and release.release_revision =
        (installation ->> 'applicationReleaseRevision')::bigint;
  else
    application_content :=
      installation #> '{candidate,compilation,canonical,content}';
    if pg_catalog.jsonb_typeof(application_content) is distinct from 'object' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
  end if;

  unsupported := exists (
    select 1
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as field(value)
    where field.value ->> 'type' = 'total'
  ) or exists (
    -- #578: Record evaluates the owning Module release's rules (`beforeSaveRules`);
    -- an Application rule on this record type cannot be evaluated and refuses.
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'rules', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
      pg_catalog.lower(p_record_type_id::text)
  );

  if unsupported then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported',
      'correlationId', meta -> 'context' -> 'correlationId'
    );
  end if;

  if meta -> 'recordType' ? 'systemProjection' then
    if p_operation <> 'update'
      or meta #>> '{recordType,key}' <> 'organization_settings'
      or meta #>> '{recordType,systemProjection,protectedView}' <>
        'organization_runtime_settings'
      or not coalesce(
        (meta #> '{recordType,standardActions}') ? 'update', false
      )
      or not exists (
        select 1
        from vortex_definition.roots as root
        where root.root_id = (meta ->> 'moduleRootId')::uuid
          and root.kind = 'module'
          and root.key = 'vortex.organisation_administration'
      )
      or p_record_id is distinct from
        (meta -> 'context' ->> 'organizationId')::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;

    -- Do not execute application before-save rules for this projection until
    -- the platform settings-manage permission has passed its own current check.
    if not vortex_access.organization_runtime_settings_manage_is_current() then
      perform vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', organization_id_value,
        array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded',
        'correlationId', correlation_id_value
      );
    end if;

    -- The one writable system projection is prepared through its protected
    -- read model. The final write still goes only through the closed settings
    -- writer registered by Record; ordinary projected records remain refused.
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'read', p_record_id, null
    );
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_base_save_activity_internal(
          p_activity_id, 'update', organization_id_value,
          array[]::uuid[], 'refused'
        );
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    end if;
    bounds := bounds || pg_catalog.jsonb_build_object(
      'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
        loaded -> 'facts' -> 'recordTypes', p_record_type_id,
        bounds -> 'readableFieldIds'
      )
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'recordType', meta -> 'recordType',
      'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
        (meta ->> 'moduleRootId')::uuid,
        (meta ->> 'moduleReleaseRevision')::bigint,
        p_record_type_id
      ),
      'correlationId', correlation_id_value,
      'readableFieldIds', bounds -> 'readableFieldIds',
      'existingValues', loaded -> 'fieldValues'
    );
  end if;

  if p_operation = 'update' then
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if loaded ? 'previewInstallationId' then
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    else
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_base_save_activity_internal(
          p_activity_id, 'update', organization_id_value,
          array[]::uuid[], 'refused'
        );
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    end if;
    bounds := bounds || pg_catalog.jsonb_build_object(
      'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
        loaded -> 'facts' -> 'recordTypes', p_record_type_id,
        bounds -> 'readableFieldIds'
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'recordType', meta -> 'recordType',
    -- #578: the owning Module release's rules for this record type, evaluated by Record.
    'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'correlationId', meta -> 'context' -> 'correlationId',
    'readableFieldIds', case when p_operation = 'update'
      then bounds -> 'readableFieldIds' else '[]'::jsonb end,
    'existingValues', case when p_operation = 'update'
      then loaded -> 'fieldValues' else '{}'::jsonb end
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_base_record_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Server-only operation-scoped preparation read for one exact active installed or owner-validated preview base Record save.';

create or replace function vortex_record.read_record(
  p_record_type_id uuid,
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  columns_value jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
  read_time_fields jsonb;
  read_time_clock jsonb;
  read_time_expression jsonb;
  read_time_value jsonb;
  preview_meta jsonb;
  preview_bounds jsonb;
  due_key text;
  status_key text;
  due_value jsonb;
  status_value jsonb;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  loaded := vortex_record.load_record_access_facts_internal(p_record_type_id, 'read', p_record_id, null);
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  if loaded ? 'previewInstallationId' then
    preview_meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'read'
    );
    preview_bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (preview_meta ->> 'storageContractId')::uuid,
      preview_meta -> 'recordType'
    );
    if preview_bounds is null then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    bounds := preview_bounds;
  else
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  end if;
  bounds := bounds || pg_catalog.jsonb_build_object('readableFieldIds',
    vortex_record.project_derived_readable_field_ids_internal(
      loaded, p_record_type_id, p_record_id, bounds -> 'readableFieldIds',
      bounds -> 'readableFieldIds', '[]'::jsonb
    )
  );
  columns_value := loaded -> 'columns';
  -- Read-time calculations are worked out here, at one statement timestamp in
  -- the organisation's time zone, from the record's stored values. They are
  -- never read from storage.
  select coalesce(pg_catalog.jsonb_object_agg(pg_catalog.lower(field.value ->> 'fieldId'), field.value), '{}'::jsonb)
  into read_time_fields
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as record_type(value)
  cross join lateral pg_catalog.jsonb_array_elements(record_type.value -> 'fields') as field(value)
  where pg_catalog.lower(record_type.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and field.value ->> 'type' = 'calculation'
    and (field.value #>> '{settings,evaluation}' = 'read_time'
      or field.value #>> '{settings,expression,kind}' = 'deadline_passed');
  if read_time_fields <> '{}'::jsonb then
    read_time_clock := vortex_record.read_time_clock_internal();
  end if;
  for field_id in
    select item.value #>> '{}' from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if not (columns_value ? field_id) then
      continue;
    end if;
    if read_time_fields ? pg_catalog.lower(field_id) then
      read_time_expression := read_time_fields -> pg_catalog.lower(field_id) #> '{settings,expression}';
      -- Only the deadline-passed form is defined; another read-time form is
      -- withheld rather than disclosed from a stored column.
      if read_time_expression ->> 'kind' is distinct from 'deadline_passed' then
        continue;
      end if;
      due_key := pg_catalog.lower(read_time_expression ->> 'dueFieldId');
      status_key := pg_catalog.lower(read_time_expression ->> 'statusFieldId');
      due_value := loaded -> 'fieldValues' -> due_key;
      status_value := case when status_key is null then null else loaded -> 'fieldValues' -> status_key end;
      if status_value is not null and status_value <> 'null'::jsonb and exists (
        select 1
        from pg_catalog.jsonb_array_elements(coalesce(read_time_expression -> 'terminalStatusValues', '[]'::jsonb))
          as terminal(value)
        where terminal.value = status_value
      ) then
        read_time_value := 'false'::jsonb;
      elsif pg_catalog.jsonb_typeof(due_value) = 'string'
        and loaded -> 'columns' -> due_key ->> 'databaseValueType' = 'date' then
        -- Without the organisation's time zone the local date is unknown.
        if read_time_clock ->> 'organizationLocalDate' is null then
          continue;
        end if;
        read_time_value := pg_catalog.to_jsonb((read_time_clock ->> 'organizationLocalDate') > (due_value #>> '{}'));
      elsif pg_catalog.jsonb_typeof(due_value) = 'string'
        and loaded -> 'columns' -> due_key ->> 'databaseValueType' = 'timestamp_with_time_zone' then
        read_time_value := pg_catalog.to_jsonb(
          (read_time_clock ->> 'instant')::timestamp with time zone
            >= (due_value #>> '{}')::timestamp with time zone
        );
      else
        read_time_value := 'null'::jsonb;
      end if;
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, read_time_value);
    else
      values_value := values_value || pg_catalog.jsonb_build_object(field_id, loaded -> 'fieldValues' -> field_id);
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'allowed', 'recordId', p_record_id,
    'concurrencyNumber', loaded -> 'concurrencyNumber', 'values', values_value);
end
$function$;

alter function vortex_record.read_record(uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record(uuid, uuid) to vortex_request;

comment on function vortex_record.read_record(uuid, uuid) is
  'Fixed record read adapter: returns the readable field projection of one live record under the caller''s current authority or one preview record for its validated preview owner, or an identical refusal for a missing, foreign or unreachable record.';

create or replace function vortex_record.change_record(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_submitted_field_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  meta jsonb;
  context_value jsonb;
  columns_value jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_values jsonb;
  proposed_facts jsonb;
  proposed_records jsonb;
  entry_key text;
  entry_value jsonb;
  column_entry jsonb;
  field_type text;
  storage_type text;
  submitted_id uuid;
  assignments text[] := array[]::text[];
  update_sql text;
  changed_rows integer;
  new_concurrency_number bigint;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_final_values is null
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or (not (loaded ? 'previewInstallationId')
      and pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  context_value := loaded -> 'context';
  columns_value := loaded -> 'columns';

  if loaded ? 'previewInstallationId' then
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'update'
    );
    bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (meta ->> 'storageContractId')::uuid,
      meta -> 'recordType'
    );
    if bounds is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
  else
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  end if;
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);

  foreach submitted_id in array p_submitted_field_ids loop
    if not (columns_value ? pg_catalog.lower(submitted_id::text)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  proposed_values := loaded -> 'fieldValues';
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    column_entry := columns_value -> entry_key;
    if column_entry is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    field_type := column_entry ->> 'type';
    storage_type := column_entry ->> 'databaseValueType';
    if field_type in ('link', 'link_to_one_of_several') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'link_change_unsupported'
      );
    end if;
    if not vortex_record.canonical_record_value_matches(
      entry_value, field_type, storage_type
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'value_invalid'
      );
    end if;

    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
    assignments := pg_catalog.array_append(
      assignments,
      pg_catalog.format(
        '%I = %s',
        column_entry ->> 'token',
        case
          when pg_catalog.jsonb_typeof(entry_value) = 'null' then 'null'
          else case storage_type
            when 'decimal' then pg_catalog.format('%L::numeric', entry_value #>> '{}')
            when 'timestamp_with_time_zone' then
              pg_catalog.format('%L::timestamptz', entry_value #>> '{}')
            when 'date' then pg_catalog.format('%L::date', entry_value #>> '{}')
            when 'integer' then pg_catalog.format('%L::bigint', entry_value #>> '{}')
            when 'boolean' then pg_catalog.format('%L::boolean', entry_value #>> '{}')
            when 'json' then pg_catalog.format('%L::jsonb', entry_value::text)
            else pg_catalog.format('%L::text', entry_value #>> '{}')
          end
        end
      )
    );
  end loop;

  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  proposed_facts := (loaded -> 'facts')
    || pg_catalog.jsonb_build_object('records', proposed_records);

  if not (loaded ? 'previewInstallationId') then
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, proposed_facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'proposed_record_refused'
      );
    end if;
    bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  end if;

  update_sql := pg_catalog.format(
    'update record_data.%I as stored set %s%sconcurrency_number = stored.concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       definition_revision = $4
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.concurrency_number = $5
     returning stored.concurrency_number',
    loaded ->> 'table',
    pg_catalog.array_to_string(assignments, ','),
    case when pg_catalog.cardinality(assignments) = 0 then '' else ', ' end
  );

  execute update_sql
  into new_concurrency_number
  using (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (loaded ->> 'moduleReleaseRevision')::bigint,
    p_expected_concurrency_number;

  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001',
      message = 'Record change did not apply to exactly one row';
  end if;

  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, proposed_values -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', p_record_id,
    'concurrencyNumber', new_concurrency_number,
    'values', values_value
  );
end
$function$;

alter function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[])
  owner to vortex_record_adapter;

revoke all on function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
comment on function vortex_record.change_record(uuid, uuid, bigint, jsonb, uuid[]) is
  'Fixed owner-only record update primitive. It checks one live record decision or the exact owner preview address, validates values and field bounds before writing, enforces concurrency, and returns only its permitted field projection.';

create or replace function vortex_record.create_record_internal(
  p_record_type_id uuid,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
  p_selected_group_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  context_value jsonb;
  record_type_value jsonb;
  record_id_value uuid := pg_catalog.gen_random_uuid();
  ownership_mode text;
  owner_account_id uuid;
  owner_group_id uuid;
  field_item jsonb;
  field_id_value uuid;
  column_value jsonb;
  input_value jsonb;
  final_values jsonb := coalesce(p_final_values, '{}'::jsonb);
  column_names text[] := array[]::text[];
  column_values text[] := array[]::text[];
  insert_sql text;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  bounds jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  changeable text[];
  submitted_id uuid;
  relationship_value jsonb;
  app_scope uuid;
  refusal_reason text := 'record_create_refused';
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null
    or pg_catalog.cardinality(p_submitted_field_ids) <>
      (select pg_catalog.count(distinct value) from pg_catalog.unnest(p_submitted_field_ids) as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  begin
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'create');
    preview_installation :=
      vortex_record.read_current_preview_installation_internal();
    if pg_catalog.jsonb_typeof(meta -> 'recordType') <> 'object'
      or (preview_installation is null
        and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object')
      or (preview_installation is not null
        and (preview_installation ->> 'outcome' = 'refused'
          or meta -> 'recordType' ? 'systemProjection')) then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    context_value := meta -> 'context';
    record_type_value := meta -> 'recordType';
    ownership_mode := record_type_value ->> 'ownershipMode';
    app_scope := case when meta ->> 'storageScope' = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end;

    if ownership_mode = 'organization_account' then
      if p_selected_group_id is not null then
        refusal_reason := 'owner_invalid';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_account_id := (context_value ->> 'organizationAccountId')::uuid;
    elsif ownership_mode = 'group' then
      if not vortex_access.lock_current_record_owner_group_internal(p_selected_group_id) then
        refusal_reason := 'owner_unavailable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_group_id := p_selected_group_id;
    elsif p_selected_group_id is not null then
      refusal_reason := 'owner_invalid';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;

    -- Every supplied value names one exact field.  Reference numbers are
    -- generated here and cannot be supplied by a form or caller.
    if exists (
      select 1 from pg_catalog.jsonb_object_keys(final_values) as supplied(key)
      where not (meta -> 'columns' ? pg_catalog.lower(supplied.key))
    ) then
      refusal_reason := 'unknown_field';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;

    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      field_id_value := (field_item ->> 'fieldId')::uuid;
      column_value := meta -> 'columns' -> pg_catalog.lower(field_id_value::text);
      if field_item ->> 'type' = 'reference_number' then
        if final_values ? pg_catalog.lower(field_id_value::text)
          or field_id_value = any (p_submitted_field_ids) then
          refusal_reason := 'generated_field_not_submittable';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        input_value := pg_catalog.to_jsonb(case when preview_installation is null
          then vortex_record.allocate_reference_number_internal(
            (context_value ->> 'organizationId')::uuid,
            (meta ->> 'storageContractId')::uuid,
            field_id_value, app_scope, field_item -> 'settings'
          )
          else vortex_record.allocate_preview_reference_number_internal(
            (preview_installation ->> 'previewInstallationId')::uuid,
            (meta ->> 'storageContractId')::uuid,
            field_id_value, field_item -> 'settings'
          ) end);
        final_values := final_values || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_id_value::text), input_value
        );
      elsif final_values ? pg_catalog.lower(field_id_value::text) then
        input_value := final_values -> pg_catalog.lower(field_id_value::text);
        if (field_item ->> 'required')::boolean
          and pg_catalog.jsonb_typeof(input_value) = 'null' then
          refusal_reason := 'required_field_missing';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        if not vortex_record.canonical_record_value_matches(
          input_value, field_item ->> 'type', column_value ->> 'databaseValueType'
        ) then
          refusal_reason := 'value_invalid';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
      else
        if (field_item ->> 'required')::boolean then
          refusal_reason := 'required_field_missing';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        continue;
      end if;

      column_names := pg_catalog.array_append(
        column_names, pg_catalog.format('%I', column_value ->> 'token')
      );
      column_values := pg_catalog.array_append(column_values,
        case when pg_catalog.jsonb_typeof(input_value) = 'null' then 'null'
        else case column_value ->> 'databaseValueType'
          when 'decimal' then pg_catalog.format('%L::numeric', input_value #>> '{}')
          when 'timestamp_with_time_zone' then
            pg_catalog.format('%L::timestamptz', input_value #>> '{}')
          when 'date' then pg_catalog.format('%L::date', input_value #>> '{}')
          when 'integer' then pg_catalog.format('%L::bigint', input_value #>> '{}')
          when 'boolean' then pg_catalog.format('%L::boolean', input_value #>> '{}')
          when 'json' then pg_catalog.format('%L::jsonb', input_value::text)
          else pg_catalog.format('%L::text', input_value #>> '{}')
        end end
      );
    end loop;

    insert_sql := pg_catalog.format(
      'insert into record_data.%I (
         organisation_id, module_root_id, record_type_id, storage_contract_id,
         record_id, application_root_id, definition_revision,
         owner_organisation_account_id, owner_group_id, lifecycle_state,
         concurrency_number, created_at, created_by, updated_at, updated_by%s
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, ''active'', 1,
         pg_catalog.statement_timestamp(), $10, pg_catalog.statement_timestamp(), $10%s)',
      meta ->> 'table',
      case when pg_catalog.cardinality(column_names) = 0 then ''
        else ', ' || pg_catalog.array_to_string(column_names, ', ') end,
      case when pg_catalog.cardinality(column_values) = 0 then ''
        else ', ' || pg_catalog.array_to_string(column_values, ', ') end
    );
    execute insert_sql using
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'moduleRootId')::uuid, p_record_type_id,
      (meta ->> 'storageContractId')::uuid, record_id_value, app_scope,
      (meta ->> 'moduleReleaseRevision')::bigint,
      owner_account_id, owner_group_id,
      (context_value ->> 'organizationAccountId')::uuid;

    -- #1061: the canonical link-target share-lock prelude is written once in
    -- lock_record_change_targets_internal. Every created link's target row is
    -- locked here, before the data-version bump and edge pass below, so a
    -- multi-link create takes all its row locks before its data version and any
    -- edge identity, as the update writer does. A malformed or undeclared link
    -- is left to the writer's own validation.
    perform vortex_record.lock_record_change_targets_internal(
      record_type_value, (context_value ->> 'organizationId')::uuid, final_values
    );
    -- The new record's data version is taken before any relationship edge
    -- identity, as every other relationship writer takes it.
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (meta ->> 'storageContractId')::uuid, app_scope
    );
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'relationships') as item(value)
      order by (item.value ->> 'relationshipId')::uuid
    loop
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      if final_values ? pg_catalog.lower(field_id_value::text) then
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, record_id_value,
          (relationship_value ->> 'relationshipId')::uuid,
          final_values -> pg_catalog.lower(field_id_value::text), false
        );
      elsif ownership_mode = 'inherited'
        and (record_type_value ->> 'ownershipRelationshipId')::uuid =
          (relationship_value ->> 'relationshipId')::uuid then
        refusal_reason := 'required_owner_relationship_missing';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'create', record_id_value, null
    );
    if loaded ->> 'outcome' <> 'loaded' then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta -> 'declaration' -> 'recordBinding'
    );
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        meta -> 'declaration', record_id_value, facts
      );
      if decision ->> 'outcome' <> 'allowed' then
        refusal_reason := 'access_refused';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        refusal_reason := 'record_unavailable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      bounds := preview_bounds;
    end if;
    select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
    into changeable
    from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);
    foreach submitted_id in array p_submitted_field_ids loop
      if not (meta -> 'columns' ? pg_catalog.lower(submitted_id::text)) then
        refusal_reason := 'unknown_field';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
        refusal_reason := 'field_not_changeable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    return pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', record_id_value,
      'concurrencyNumber', 1, 'values', final_values
    );
  exception
    when sqlstate 'P4020' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', refusal_reason
      );
    when no_data_found or too_many_rows or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
  end;
end
$function$;

alter function vortex_record.create_record_internal(uuid,jsonb,uuid[],uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.create_record_internal(uuid, jsonb, uuid[], uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.create_record_internal(uuid, jsonb, uuid[], uuid) is
  'Private fixed create primitive: derives scope, definition and human ownership, generates references, writes typed values and relationships, and decides create authority over the proposed record in one rollback-safe transaction.';

create or replace function vortex_record.bump_record_data_version_internal(
  p_organization_id uuid,
  p_storage_contract_id uuid,
  p_application_root_id uuid
)
returns bigint
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  record_type_id uuid;
  version_value bigint;
  preview_installation jsonb;
begin
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null then
    if preview_installation ->> 'outcome' = 'refused' then
      raise exception using errcode = '42501',
        message = 'Preview Record context is unavailable';
    end if;
    return 0;
  end if;

  version_value := pg_catalog.nextval(
    'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
  );
  -- The shared per-record-type counter is gone. A save now tells open pages to
  -- re-read through the existing content-free post-commit private channel. That
  -- channel is application scoped, so an organisation-shared scope (no
  -- application root) has no topic; the bounded query-cache lifetime still
  -- bounds how long any result may be reused.
  if p_organization_id is null
    or p_storage_contract_id is null
    or p_application_root_id is null then
    return version_value;
  end if;
  select catalogue.record_type_id into record_type_id
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.state = 'active';
  if record_type_id is null then
    return version_value;
  end if;
  begin
    perform vortex_invalidation.publish_change_notice(
      p_organization_id,
      p_application_root_id,
      record_type_id,
      null,
      null,
      'changed',
      version_value,
      version_value,
      pg_catalog.gen_random_uuid()
    );
  exception
    when others then
      -- Invalidation is an advisory refresh signal, never a save condition; the
      -- query-cache policy bounds reuse, so a lost notice only delays a refresh.
      null;
  end;
  return version_value;
end
$function$;

alter function vortex_record.bump_record_data_version_internal(uuid,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.bump_record_data_version_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.bump_record_data_version_internal(uuid, uuid, uuid)
  to vortex_record_adapter;

comment on function vortex_record.bump_record_data_version_internal(uuid, uuid, uuid) is
  'Private live Record change signal: takes one non-blocking monotonic version and, for an application-contained scope, publishes the existing content-free post-commit invalidation notice; preview writes return without changing live invalidation state.';

create or replace function vortex_record.claim_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid,
  p_operation text,
  p_fingerprint text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_identity jsonb,
  p_details jsonb,
  p_replay_only boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  identity_value jsonb := coalesce(p_identity, '{}'::jsonb);
  inserted_command_id uuid;
  receipt vortex_record.command_receipts%rowtype;
  preview_value jsonb;
  preview_installation_id_value uuid;
  inserted_preview_command_id uuid;
  preview_receipt vortex_record.preview_command_receipts%rowtype;
begin
  context_value := vortex_access.validated_human_request_context();
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  preview_value := vortex_record.read_current_preview_installation_internal();
  if preview_value is not null then
    if preview_value ->> 'outcome' = 'refused' then
      raise exception using errcode = '42501',
        message = 'Preview Record command is unavailable';
    end if;
    if p_command_kind <> 'record_save'
      or p_operation not in ('create', 'update')
      or p_record_id is not null
      or identity_value is distinct from '{}'::jsonb then
      return pg_catalog.jsonb_build_object('status', 'identity_conflict');
    end if;
    preview_installation_id_value :=
      (preview_value ->> 'previewInstallationId')::uuid;
    if not p_replay_only then
      insert into vortex_record.preview_command_receipts (
        preview_installation_id, organization_id, application_root_id,
        actor_organization_account_id, command_kind, command_id, operation,
        command_fingerprint, record_type_id, state
      ) values (
        preview_installation_id_value, organization_id_value,
        application_root_id_value, actor_id_value, p_command_kind, p_command_id,
        p_operation, p_fingerprint, p_record_type_id, 'pending'
      )
      on conflict do nothing
      returning command_id into inserted_preview_command_id;
      if inserted_preview_command_id is not null then
        return pg_catalog.jsonb_build_object('status', 'claimed');
      end if;
    end if;
    if p_replay_only then
      select stored.* into preview_receipt
      from vortex_record.preview_command_receipts as stored
      where stored.preview_installation_id = preview_installation_id_value
        and stored.command_kind = p_command_kind
        and stored.command_id = p_command_id
        and stored.organization_id = organization_id_value
        and stored.application_root_id = application_root_id_value
        and stored.actor_organization_account_id = actor_id_value;
    else
      select stored.* into preview_receipt
      from vortex_record.preview_command_receipts as stored
      where stored.preview_installation_id = preview_installation_id_value
        and stored.command_kind = p_command_kind
        and stored.command_id = p_command_id
        and stored.organization_id = organization_id_value
        and stored.application_root_id = application_root_id_value
        and stored.actor_organization_account_id = actor_id_value
      for update;
    end if;
    if not found then
      return pg_catalog.jsonb_build_object('status', 'none');
    end if;
    if preview_receipt.command_fingerprint is distinct from p_fingerprint
      or preview_receipt.operation is distinct from p_operation
      or preview_receipt.record_type_id is distinct from p_record_type_id then
      return pg_catalog.jsonb_build_object('status', 'identity_conflict');
    end if;
    if preview_receipt.state is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('status', 'pending');
    end if;
    return pg_catalog.jsonb_build_object(
      'status', 'completed',
      'recordId', preview_receipt.record_id,
      'concurrencyNumber', preview_receipt.concurrency_number
    );
  end if;

  -- The command identity is claimed as pending. A claim that finds an existing
  -- receipt locks it and classifies it; a replay-only read classifies without
  -- inserting or locking.
  if not p_replay_only then
    insert into vortex_record.command_receipts (
      organization_id, application_root_id, actor_organization_account_id,
      command_kind, command_id, operation, command_fingerprint, record_type_id,
      record_id, command_identity, expected_concurrency_number, recovery_policy_revision,
      activity_id, occurrence_id, state
    ) values (
      organization_id_value, application_root_id_value, actor_id_value,
      p_command_kind, p_command_id, p_operation, p_fingerprint, p_record_type_id,
      p_record_id, identity_value,
      (p_details ->> 'expectedConcurrencyNumber')::bigint,
      (p_details ->> 'recoveryPolicyRevision')::bigint,
      (p_details ->> 'activityId')::uuid,
      (p_details ->> 'occurrenceId')::uuid,
      'pending'
    )
    on conflict do nothing
    returning command_id into inserted_command_id;
    if inserted_command_id is not null then
      return pg_catalog.jsonb_build_object('status', 'claimed');
    end if;
    select stored.* into receipt
    from vortex_record.command_receipts as stored
    where stored.organization_id = organization_id_value
      and stored.application_root_id = application_root_id_value
      and stored.actor_organization_account_id = actor_id_value
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id
    for update;
  else
    select stored.* into receipt
    from vortex_record.command_receipts as stored
    where stored.organization_id = organization_id_value
      and stored.application_root_id = application_root_id_value
      and stored.actor_organization_account_id = actor_id_value
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id;
    if not found then
      return pg_catalog.jsonb_build_object('status', 'none');
    end if;
  end if;

  if not found
    or receipt.command_fingerprint is distinct from p_fingerprint
    or receipt.operation is distinct from p_operation
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.command_identity is distinct from identity_value
    or (p_record_id is not null and receipt.record_id is distinct from p_record_id) then
    return pg_catalog.jsonb_build_object('status', 'identity_conflict');
  end if;
  if receipt.state is distinct from 'completed' then
    return pg_catalog.jsonb_build_object('status', 'pending');
  end if;
  return pg_catalog.jsonb_build_object(
    'status', 'completed',
    'recordId', receipt.record_id,
    'concurrencyNumber', receipt.concurrency_number
  );
end
$function$;

alter function vortex_record.claim_command_receipt_internal(text,uuid,text,text,uuid,uuid,jsonb,jsonb,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.claim_command_receipt_internal(
  text, uuid, text, text, uuid, uuid, jsonb, jsonb, boolean
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.claim_command_receipt_internal(
  text, uuid, text, text, uuid, uuid, jsonb, jsonb, boolean
) to vortex_record_adapter;
comment on function vortex_record.claim_command_receipt_internal(
  text, uuid, text, text, uuid, uuid, jsonb, jsonb, boolean
) is
  'The one command-receipt claim and replay classifier. Claims the request actor''s live or preview-local command identity as pending, or classifies its receipt as identity_conflict, pending or completed with its stored result; with p_replay_only it only reads, returning none when there is no receipt.';

create or replace function vortex_record.command_receipt_exists_internal(
  p_command_kind text,
  p_command_id uuid
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  preview_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  preview_value := vortex_record.read_current_preview_installation_internal();
  if preview_value is not null then
    if preview_value ->> 'outcome' = 'refused' then
      raise exception using errcode = '42501',
        message = 'Preview Record command is unavailable';
    end if;
    return exists (
      select 1 from vortex_record.preview_command_receipts as receipt
      where receipt.preview_installation_id =
          (preview_value ->> 'previewInstallationId')::uuid
        and receipt.organization_id = (context_value ->> 'organizationId')::uuid
        and receipt.application_root_id = (context_value ->> 'applicationRootId')::uuid
        and receipt.actor_organization_account_id =
          (context_value ->> 'organizationAccountId')::uuid
        and receipt.command_kind = p_command_kind
        and receipt.command_id = p_command_id
    );
  end if;
  return exists (
    select 1 from vortex_record.command_receipts as receipt
    where receipt.organization_id = (context_value ->> 'organizationId')::uuid
      and receipt.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_kind = p_command_kind
      and receipt.command_id = p_command_id
  );
end
$function$;

alter function vortex_record.command_receipt_exists_internal(text,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.command_receipt_exists_internal(
  text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.command_receipt_exists_internal(
  text, uuid
) to vortex_record_adapter;
comment on function vortex_record.command_receipt_exists_internal(
  text, uuid
) is
  'True when the request actor already holds a receipt for this command identity and kind, whatever its state or content. Preparation reads use it to leave replay and identity-conflict classification to the receipt owner.';

create or replace function vortex_record.release_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  preview_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  preview_value := vortex_record.read_current_preview_installation_internal();
  if preview_value is not null then
    if preview_value ->> 'outcome' = 'refused' then
      raise exception using errcode = '42501',
        message = 'Preview Record command is unavailable';
    end if;
    delete from vortex_record.preview_command_receipts as stored
    where stored.preview_installation_id =
        (preview_value ->> 'previewInstallationId')::uuid
      and stored.organization_id = (context_value ->> 'organizationId')::uuid
      and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and stored.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id
      and stored.state = 'pending';
    return;
  end if;
  delete from vortex_record.command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
      and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and stored.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id
    and stored.state = 'pending';
end
$function$;

alter function vortex_record.release_command_receipt_internal(text,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.release_command_receipt_internal(
  text, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.release_command_receipt_internal(
  text, uuid
) to vortex_record_adapter;
comment on function vortex_record.release_command_receipt_internal(
  text, uuid
) is
  'Releases the request actor''s pending live or preview-local command receipt when its command is refused before any change, so the identity can be used again.';

create or replace function vortex_record.complete_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid,
  p_record_id uuid,
  p_concurrency_number bigint,
  p_stale_message text
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  preview_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  preview_value := vortex_record.read_current_preview_installation_internal();
  if preview_value is not null then
    if preview_value ->> 'outcome' = 'refused' then
      raise exception using errcode = '42501',
        message = 'Preview Record command is unavailable';
    end if;
    update vortex_record.preview_command_receipts as stored
    set state = 'completed',
      record_id = p_record_id,
      concurrency_number = p_concurrency_number,
      completed_at = pg_catalog.statement_timestamp()
    where stored.preview_installation_id =
        (preview_value ->> 'previewInstallationId')::uuid
      and stored.organization_id = (context_value ->> 'organizationId')::uuid
      and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and stored.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id
      and stored.state = 'pending';
    if not found then
      raise exception using errcode = '40001', message = p_stale_message;
    end if;
    return;
  end if;
  update vortex_record.command_receipts as stored
  set state = 'completed',
    record_id = coalesce(p_record_id, stored.record_id),
    concurrency_number = p_concurrency_number,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
      and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and stored.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and stored.command_kind = p_command_kind
      and stored.command_id = p_command_id
    and stored.state = 'pending';
  if not found then
    raise exception using errcode = '40001', message = p_stale_message;
  end if;
end
$function$;

alter function vortex_record.complete_command_receipt_internal(text,uuid,uuid,bigint,text) owner to vortex_record_adapter;

revoke all on function vortex_record.complete_command_receipt_internal(
  text, uuid, uuid, bigint, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.complete_command_receipt_internal(
  text, uuid, uuid, bigint, text
) to vortex_record_adapter;
comment on function vortex_record.complete_command_receipt_internal(
  text, uuid, uuid, bigint, text
) is
  'Completes the request actor''s pending live or preview-local command receipt with its result, or raises a 40001 stale-receipt error carrying the caller''s message when no pending receipt is left.';

create or replace function vortex_record.apply_record_changes(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_action jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  action_mode boolean := p_action is not null;
  receipt_kind text := case when p_action is not null then 'named_action' else 'record_save' end;
  action_owner_kind text;
  action_owner_id uuid;
  action_release_revision bigint;
  action_id_value uuid;
  action_inputs jsonb;
  action_context jsonb;
  action_final_values jsonb := '{}'::jsonb;
  action_creations jsonb := '[]'::jsonb;
  action_creation_occurrence_ids jsonb := '[]'::jsonb;
  action_parents jsonb := '[]'::jsonb;
  action_declared_occurrence_ids jsonb := '[]'::jsonb;
  action_set_field_ids jsonb;
  action_set_fields_seen boolean := false;
  action_events_seen boolean := false;
  subject_write boolean := true;
  subject_written boolean := false;
  result_value jsonb;
  event_loaded jsonb;
  creation_plan jsonb;
  create_targets jsonb;
  creation_count integer := 0;
  preparation_value jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  reduced_final_values jsonb;
  catalogue jsonb;
  closure_value jsonb;
  root_type jsonb;
  root_snapshot jsonb;
  target_type jsonb;
  total_field jsonb;
  dependency_contract jsonb;
  dependency_field_id text;
  relationship_field_id text;
  old_relationship_target jsonb;
  proposed_relationship_target jsonb;
  contributes_to_total boolean := false;
  creation jsonb;
  created_records jsonb := '{}'::jsonb;
  inserted_value jsonb;
  submitted_field_ids uuid[];
  edge_plan jsonb;
  edge_entry jsonb;
  created_record_id uuid;
  occurrence_id_value uuid;
  copy_plan jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  effective_command_id uuid;
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  command_fingerprint_value text;
  receipt_claim jsonb;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  mutation jsonb;
  mutation_value jsonb;
  projection jsonb;
  field_value jsonb;
  relationship_value jsonb;
  relationship_changes jsonb := '[]'::jsonb;
  final_values jsonb := '{}'::jsonb;
  value_final_values jsonb := '{}'::jsonb;
  value_submitted_field_ids uuid[] := array[]::uuid[];
  entry_key text;
  entry_value jsonb;
  submitted_field_id uuid;
  relationship_change jsonb;
  increment_for_relationship boolean;
  update_bounds jsonb;
  proposed_field_values jsonb;
  proposed_records jsonb;
  proposed_edges jsonb;
  proposed_facts jsonb;
  target_record_type_id uuid;
  target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  saved_record_id uuid;
  saved_concurrency_number bigint;
  changed_field_ids uuid[];
  activity_time timestamptz := pg_catalog.statement_timestamp();
  event_kind text;
  event_payload jsonb;
  event_result jsonb;
begin
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  if preview_installation is not null
    and (p_action is not null
      or p_operation in ('delete', 'restore', 'transfer_ownership')) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'preview_effect_refused'
    );
  end if;

  -- A lifecycle command is the terminal delete, restore or ownership transfer.
  -- Delete and restore reach here only after their protected preflight has
  -- already run and claimed the record_lifecycle receipt; this operation owns
  -- the one terminal write and completes it. The request role reaches these
  -- branches only through apply_lifecycle_record_changes: a lifecycle command
  -- carries no submitted values, selected group or action, so the named-action
  -- entry can never reach a lifecycle write under an action identity.
  if p_operation in ('delete', 'restore', 'transfer_ownership') then
    if p_action is not null
      or p_selected_group_id is not null
      or p_submitted_values is distinct from '{}'::jsonb then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    return vortex_record.apply_lifecycle_record_changes_internal(
      p_operation, p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_mutations, p_activity_id, p_occurrence_id
    );
  end if;

  -- The command is closed: one operation, one subject, one ordered mutation list
  -- of the kinds this operation supports. A create is one create_subject; an
  -- update is one or more set_fields applied in list order.
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_mutations) = 0
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_occurrence_id is null
    or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    ))
    or (p_action is not null and p_operation is distinct from 'update') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  if p_action is not null then
    -- A named action names its exact installed action and carries its typed
    -- inputs; the receipt fingerprint, the field rules and the facts all follow
    -- from that identity. Nothing about the actor or the organization is read
    -- from it: both come from the verified request context below.
    if pg_catalog.jsonb_typeof(p_action) is distinct from 'object'
      or not (p_action ?& array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs'])
      or p_action - array['ownerKind', 'ownerId', 'releaseRevision', 'actionId', 'inputs']::text[]
        <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_action -> 'ownerKind') is distinct from 'string'
      or (p_action ->> 'ownerKind') not in ('application', 'module')
      or pg_catalog.jsonb_typeof(p_action -> 'ownerId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'ownerId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'actionId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'actionId', 'uuid')
      or pg_catalog.jsonb_typeof(p_action -> 'releaseRevision') is distinct from 'number'
      or not pg_catalog.pg_input_is_valid(p_action ->> 'releaseRevision', 'bigint')
      or pg_catalog.jsonb_typeof(p_action -> 'inputs') is distinct from 'object' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    action_owner_kind := p_action ->> 'ownerKind';
    action_owner_id := (p_action ->> 'ownerId')::uuid;
    action_id_value := (p_action ->> 'actionId')::uuid;
    action_release_revision := (p_action ->> 'releaseRevision')::bigint;
    action_inputs := p_action -> 'inputs';
    if action_release_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  end if;

  if p_action is null then
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or not (mutation ?& array['kind', 'values'])
        or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string'
        or (mutation ->> 'kind') not in ('create_subject', 'set_fields')
        or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;

    if p_operation = 'create' then
      if pg_catalog.jsonb_array_length(p_mutations) <> 1
        or (p_mutations -> 0 ->> 'kind') is distinct from 'create_subject' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    elsif exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
      where item.value ->> 'kind' = 'create_subject'
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  else
    -- A named action's mutation list is closed too: exactly one set_fields on
    -- the subject (possibly empty), the action's creations in authored order,
    -- its relationship copies, the revision-checked derived-total updates of
    -- the other records it moves, and its declared Event identities. Only the
    -- subject-write, creation and parent mutations carry values; a relationship
    -- copy is a statement of intent the database re-derives from the installed
    -- action and its inputs, never an authority it trusts.
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      if pg_catalog.jsonb_typeof(mutation) is distinct from 'object'
        or pg_catalog.jsonb_typeof(mutation -> 'kind') is distinct from 'string' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
      if mutation ->> 'kind' = 'set_fields' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or action_set_fields_seen then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_set_fields_seen := true;
        action_final_values := mutation -> 'values';
      elsif mutation ->> 'kind' = 'create_record' then
        if not (mutation ?& array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ])
          or mutation - array[
            'kind', 'ordinal', 'recordTypeId', 'values', 'finalValues', 'occurrenceId'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'ordinal') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'ordinal', 'integer')
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'occurrenceId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'values') is distinct from 'object'
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_creations := action_creations || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'ordinal', mutation -> 'ordinal',
            'recordTypeId', mutation -> 'recordTypeId',
            'values', mutation -> 'values',
            'finalValues', mutation -> 'finalValues'
          )
        );
        action_creation_occurrence_ids := action_creation_occurrence_ids
          || pg_catalog.jsonb_build_array(mutation -> 'occurrenceId');
      elsif mutation ->> 'kind' = 'copy_relationships' then
        if not (mutation ?& array['kind', 'values'])
          or mutation - array['kind', 'values']::text[] <> '{}'::jsonb
          or mutation -> 'values' is distinct from '{}'::jsonb then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
      elsif mutation ->> 'kind' = 'set_derived_fields' then
        if not (mutation ?& array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ])
          or mutation - array[
            'kind', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'recordTypeId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordTypeId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'recordId') is distinct from 'string'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'recordId', 'uuid')
          or pg_catalog.jsonb_typeof(mutation -> 'expectedConcurrencyNumber') is distinct from 'number'
          or not pg_catalog.pg_input_is_valid(mutation ->> 'expectedConcurrencyNumber', 'bigint')
          or pg_catalog.jsonb_typeof(mutation -> 'finalValues') is distinct from 'object' then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_parents := action_parents || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'recordTypeId', mutation -> 'recordTypeId',
            'recordId', mutation -> 'recordId',
            'expectedConcurrencyNumber', mutation -> 'expectedConcurrencyNumber',
            'finalValues', mutation -> 'finalValues'
          )
        );
      elsif mutation ->> 'kind' = 'announce_events' then
        if not (mutation ?& array['kind', 'occurrenceIds'])
          or mutation - array['kind', 'occurrenceIds']::text[] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(mutation -> 'occurrenceIds') is distinct from 'array'
          or action_events_seen
          or exists (
            select 1
            from pg_catalog.jsonb_array_elements(mutation -> 'occurrenceIds') as item(value)
            where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
              or not pg_catalog.pg_input_is_valid(item.value #>> '{}', 'uuid')
          ) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'command_invalid'
          );
        end if;
        action_events_seen := true;
        action_declared_occurrence_ids := mutation -> 'occurrenceIds';
      else
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_invalid'
        );
      end if;
    end loop;
    if not action_set_fields_seen then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;

  creation_count := pg_catalog.jsonb_array_length(action_creations);

  if action_mode then
    -- A replay never re-prepares: an existing receipt short-circuits the
    -- creation plan, the relationship-total preparation and the copy plan, and
    -- the subject step below answers from the stored receipt.
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      creation_plan := vortex_record.named_action_creation_plan_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, action_creations
      );
      if creation_plan ->> 'outcome' = 'unsupported' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode'
        );
      end if;
      if creation_plan ->> 'outcome' <> 'planned' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused',
          'reasonCode', coalesce(creation_plan ->> 'reasonCode', 'command_invalid')
        );
      end if;
      create_targets := creation_plan -> 'createTargets';

      preparation_value := vortex_record.prepare_named_action_command_totals(
        p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
        p_submitted_values, action_creations, p_activity_id, action_owner_kind,
        action_owner_id, action_release_revision, action_id_value
      );
      if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
        return preparation_value;
      end if;
      if preparation_value ->> 'outcome' = 'defer'
        and vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
        preparation_value := null;
      elsif preparation_value ->> 'outcome' = 'defer' then
        -- With an installed Rule the closure is not computed, so a command that
        -- would move a total must refuse rather than silently skip it. A
        -- create-bearing command already refused inside the preparation, so only
        -- the set/announce shape reaches here.
        catalogue := vortex_record.relationship_total_catalogue_internal();
        if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
          closure_value := vortex_record.discover_relationship_total_closure_internal(
            catalogue, 'update', p_record_type_id, p_record_id, p_submitted_values
          );
          select item.value into root_type
          from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
          where pg_catalog.lower(item.value ->> 'recordTypeId') =
            pg_catalog.lower(p_record_type_id::text);
          select item.value into root_snapshot
          from pg_catalog.jsonb_array_elements(closure_value -> 'records') item(value)
          where item.value ->> 'recordKey' = 'root';
          if root_type is null or root_snapshot is null then
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
            );
          end if;
          for relationship_value, target_type in
            select item.value, target.value
            from pg_catalog.jsonb_array_elements(root_type -> 'relationships') item(value)
            join pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') target(value)
              on vortex_record.relationship_declares_target_internal(
                item.value, (target.value ->> 'recordTypeId')::uuid
              )
            where item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
            order by item.value ->> 'relationshipId', target.value ->> 'recordTypeId'
          loop
            relationship_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
            old_relationship_target := root_snapshot -> 'existingValues' -> relationship_field_id;
            proposed_relationship_target := old_relationship_target;
            if p_submitted_values ? relationship_field_id then
              proposed_relationship_target := p_submitted_values -> relationship_field_id;
            end if;
            if not (
              (pg_catalog.jsonb_typeof(old_relationship_target) = 'object' and
                pg_catalog.lower(old_relationship_target ->> 'recordTypeId') =
                  pg_catalog.lower(target_type ->> 'recordTypeId'))
              or
              (pg_catalog.jsonb_typeof(proposed_relationship_target) = 'object' and
                pg_catalog.lower(proposed_relationship_target ->> 'recordTypeId') =
                  pg_catalog.lower(target_type ->> 'recordTypeId'))
            ) then
              continue;
            end if;
            for total_field in
              select field.value
              from pg_catalog.jsonb_array_elements(target_type -> 'fields') field(value)
              where field.value ->> 'type' = 'total'
                and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
                  pg_catalog.lower(relationship_value ->> 'relationshipId')
            loop
              if p_submitted_values ? relationship_field_id and
                p_submitted_values -> relationship_field_id is distinct from
                  coalesce(root_snapshot -> 'existingValues' -> relationship_field_id, 'null'::jsonb) then
                contributes_to_total := true;
                exit;
              end if;
              dependency_contract := vortex_record.total_dependency_contract_internal(
                catalogue -> 'recordTypes',
                pg_catalog.jsonb_build_array(relationship_value),
                (target_type ->> 'recordTypeId')::uuid, total_field
              );
              for dependency_field_id in
                select item.value
                from pg_catalog.jsonb_array_elements_text(
                  dependency_contract -> 'sourceFieldIds'
                ) item(value)
              loop
                if action_final_values ? dependency_field_id and
                  action_final_values -> dependency_field_id is distinct from
                    coalesce(root_snapshot -> 'existingValues' -> dependency_field_id, 'null'::jsonb) then
                  contributes_to_total := true;
                  exit;
                end if;
              end loop;
              exit when contributes_to_total;
            end loop;
            exit when contributes_to_total;
          end loop;
          if contributes_to_total then
            return pg_catalog.jsonb_build_object(
              'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
            );
          end if;
        end if;
      end if;

      if preparation_value ->> 'outcome' is distinct from 'prepared' then
        if pg_catalog.jsonb_array_length(action_parents) = 0 then
          preparation_value := null;
        else
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      else
        select coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'recordTypeId', item.value -> 'recordTypeId',
            'recordId', item.value -> 'recordId',
            'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
            'finalFieldIds', coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.lower(field.value ->> 'fieldId')
                order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
              )
              from pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
              where field.value ->> 'type' in ('total', 'calculation')
            ), '[]'::jsonb)
          ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
        ), '[]'::jsonb) into expected_parents
        from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
        where item.value ->> 'recordKey' <> 'root'
          and pg_catalog.left(item.value ->> 'recordKey', 7) <> 'create:';
        select coalesce(pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'recordTypeId', item.value -> 'recordTypeId',
            'recordId', item.value -> 'recordId',
            'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
            'finalFieldIds', coalesce((
              select pg_catalog.jsonb_agg(field_id order by field_id collate "C")
              from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') field(field_id)
            ), '[]'::jsonb)
          ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
        ), '[]'::jsonb) into supplied_parents
        from pg_catalog.jsonb_array_elements(action_parents) item(value)
        where pg_catalog.jsonb_typeof(item.value) = 'object'
          and item.value ?& array[
            'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
          ]
          and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
        if supplied_parents is distinct from expected_parents
          or pg_catalog.jsonb_array_length(supplied_parents) <>
            pg_catalog.jsonb_array_length(action_parents) then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      end if;
    end if;

    -- The target row and every linked row of a relationship copy are locked
    -- here, before the counters and data versions below and before any edge
    -- identity, so the lock classes keep their order. A replay copies nothing.
    if not vortex_record.command_receipt_exists_internal('named_action', effective_command_id) then
      copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, action_inputs
      );
      if copy_plan ->> 'outcome' = 'refused' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode'
        );
      end if;
    end if;
    -- Take every created record's reference-number counter (L4), then the data
    -- version of the subject's and every created record's storage scope, before
    -- the subject step writes the subject's relationship edges (L6), matching
    -- ordinary create's row, counter, data version, edge order.
    if creation_count > 0 and create_targets is not null then
      perform vortex_record.reserve_named_action_creation_locks_internal(
        p_record_type_id, action_creations
      );
    end if;

    action_context := vortex_record.resolve_named_action_context_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id
    );
    if coalesce((action_context ->> 'rulesUnsupported')::boolean, false)
      or pg_catalog.jsonb_typeof(action_context -> 'action' -> 'tasks') is distinct from 'array'
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(
          action_context -> 'action' -> 'tasks'
        ) task(value)
        where task.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')
      ) then
      return pg_catalog.jsonb_build_object('outcome', 'unsupported');
    end if;
    select coalesce(pg_catalog.jsonb_agg(field_id order by field_id collate "C"), '[]'::jsonb)
    into action_set_field_ids
    from (
      select distinct pg_catalog.lower(key.field_key) as field_id
      from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'tasks') task(value)
      cross join lateral pg_catalog.jsonb_object_keys(
        task.value -> 'properties' -> 'values'
      ) key(field_key)
      where task.value ->> 'type' = 'record.set_fields'
    ) fields;
    if action_set_field_ids is distinct from coalesce((
        select pg_catalog.jsonb_agg(key order by key collate "C")
        from pg_catalog.jsonb_object_keys(p_submitted_values) key
      ), '[]'::jsonb)
      or pg_catalog.jsonb_array_length(action_context -> 'eventDescriptors') <>
        pg_catalog.jsonb_array_length(action_declared_occurrence_ids)
      or pg_catalog.jsonb_array_length(action_creation_occurrence_ids) <> creation_count then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    -- A create-only action whose created record moves one of the subject's own
    -- totals still has to write the subject, so the subject is written whenever
    -- a record.set_fields task exists or the final-value map is non-empty.
    subject_write := pg_catalog.jsonb_array_length(action_set_field_ids) > 0
      or action_final_values <> '{}'::jsonb;
  end if;

  <<subject_step>>
  begin
  if action_mode and not subject_write then
    -- The announce-only shape: the action writes nothing to the subject, so its
    -- receipt, Activity and declared Events are the whole subject step.
    loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      perform vortex_record.append_named_action_activity_internal(
        p_activity_id, p_record_id, array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded');
    end if;
    command_fingerprint_value := vortex_record.named_action_command_fingerprint_internal(
      p_command_id, action_owner_kind, action_owner_id,
      action_release_revision, action_id_value, p_record_type_id, p_record_id,
      p_expected_concurrency_number, action_inputs
    );
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, 'named_action', command_fingerprint_value,
      p_record_type_id, p_record_id, pg_catalog.jsonb_build_object(
        'actionOwnerKind', action_owner_kind,
        'actionOwnerId', action_owner_id,
        'actionReleaseRevision', action_release_revision,
        'actionId', action_id_value
      ), '{}'::jsonb, false
    );
    if receipt_claim ->> 'status' is distinct from 'claimed' then
      if receipt_claim ->> 'status' = 'identity_conflict' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
        );
      end if;
      if receipt_claim ->> 'status' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object('outcome', 'conflict');
      end if;
      return vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end if;
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'completed'
    );
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_array_length(event_result) <>
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
    perform vortex_record.complete_command_receipt_internal(
      'named_action', effective_command_id, null, p_expected_concurrency_number,
      'Named action receipt is stale'
    );
    result_value := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id
    );
    if result_value ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    result_value := result_value || pg_catalog.jsonb_build_object('replayed', false);
    exit subject_step;
  end if;

  if action_mode then
    command_fingerprint_value := vortex_record.named_action_command_fingerprint_internal(
      p_command_id, action_owner_kind, action_owner_id,
      action_release_revision, action_id_value, p_record_type_id, p_record_id,
      p_expected_concurrency_number, action_inputs
    );
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'named_action', effective_command_id, 'named_action', command_fingerprint_value,
      p_record_type_id, p_record_id, pg_catalog.jsonb_build_object(
        'actionOwnerKind', action_owner_kind,
        'actionOwnerId', action_owner_id,
        'actionReleaseRevision', action_release_revision,
        'actionId', action_id_value
      ), '{}'::jsonb, false
    );
  else
    command_fingerprint_value := vortex_record.base_save_command_fingerprint_internal(
      p_command_id, p_operation, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values, p_selected_group_id
    );
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', effective_command_id, p_operation, command_fingerprint_value,
      p_record_type_id, null, '{}'::jsonb, '{}'::jsonb, false
    );
  end if;
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
    end if;
    if action_mode then
      projection := vortex_record.project_named_action_record_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if projection ->> 'outcome' <> 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    else
      projection := vortex_record.read_record(
        p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if projection ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  if action_mode then
    meta := action_context;
  else
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, p_operation
    );
  end if;
  if pg_catalog.jsonb_typeof(meta -> 'recordType') <> 'object' then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  -- Collapse the ordered mutation list into one final value map. A create_subject
  -- starts the map; each set_fields in list order overrides the fields it names.
  -- A named action already carries its single subject set_fields as the map.
  if action_mode then
    final_values := action_final_values;
  else
    for mutation in
      select item.value
      from pg_catalog.jsonb_array_elements(p_mutations)
        with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      mutation_value := mutation -> 'values';
      if mutation ->> 'kind' = 'create_subject' then
        final_values := mutation_value;
      else
        final_values := final_values || mutation_value;
      end if;
    end loop;
  end if;

  -- Classify every final value against the exact installed Record definition.
  -- Link values remain relationship changes; only ordinary value fields reach
  -- the fixed column writer on update. Each supported link has exactly one
  -- declared fixed to-one relationship owned by this source Record type.
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(final_values) as entry(key, value)
  loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where pg_catalog.lower(item.value ->> 'fieldId') = entry_key;
    if not found then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'relationships') as item(value)
      where (item.value ->> 'fromRecordTypeId')::uuid = p_record_type_id
        and pg_catalog.lower(item.value ->> 'fromFieldId') = entry_key;
      if not found
        or not (relationship_value ? case field_value ->> 'type'
          when 'link' then 'toRecordType' else 'toRecordTypes' end)
        or relationship_value ->> 'cardinality' not in ('one_to_one', 'many_to_one') then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_shape_unsupported'
        );
      end if;
      relationship_changes := relationship_changes || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'fieldId', entry_key,
          'relationshipId', relationship_value -> 'relationshipId',
          'relationship', relationship_value,
          'value', entry_value
        )
      );
    else
      value_final_values := value_final_values
        || pg_catalog.jsonb_build_object(entry_key, entry_value);
    end if;
  end loop;

  foreach submitted_field_id in array array(
    select key::uuid
    from pg_catalog.jsonb_object_keys(p_submitted_values) as key
    order by key::uuid
  ) loop
    select item.value into field_value
    from pg_catalog.jsonb_array_elements(meta -> 'recordType' -> 'fields') as item(value)
    where (item.value ->> 'fieldId')::uuid = submitted_field_id;
    if not found then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
      value_submitted_field_ids := pg_catalog.array_append(
        value_submitted_field_ids, submitted_field_id
      );
    elsif not exists (
      select 1
      from pg_catalog.jsonb_array_elements(relationship_changes) as change(value)
      where (change.value ->> 'fieldId')::uuid = submitted_field_id
    ) then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_value_unavailable'
      );
    end if;
  end loop;

  if preview_installation is not null
    and pg_catalog.jsonb_array_length(relationship_changes) > 0 then
    perform vortex_record.release_command_receipt_internal(
      receipt_kind, effective_command_id
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'preview_relationship_refused'
    );
  end if;

  if p_operation = 'update' then
    if action_mode then
      loaded := vortex_record.load_named_action_facts_internal(
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
      );
    else
      loaded := vortex_record.load_record_access_facts_internal(
        p_record_type_id, 'update', p_record_id, p_expected_concurrency_number
      );
    end if;
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded'
      or (preview_installation is null
        and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object') then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        meta -> 'declaration', p_record_id,
        (loaded -> 'facts') || pg_catalog.jsonb_build_object(
          'binding', meta -> 'declaration' -> 'recordBinding'
        )
      );
      if decision ->> 'outcome' = 'refused' then
        if action_mode then
          activity_time := vortex_record.append_named_action_activity_internal(
            p_activity_id, p_record_id, array[]::uuid[], 'refused'
          );
        else
          activity_time := vortex_record.append_base_save_activity_internal(
            p_activity_id, 'update', organization_id_value,
            array[]::uuid[], 'refused'
          );
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable'
        );
      elsif decision ->> 'outcome' <> 'allowed' then
        raise exception using errcode = '42501',
          message = 'Record save authority is unavailable';
      end if;
      update_bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      update_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if update_bounds is null then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable'
        );
      end if;
    end if;
    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if not exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(
          update_bounds -> 'changeableFieldIds'
        ) as allowed(value)
        where pg_catalog.lower(allowed.value) =
          pg_catalog.lower(relationship_change ->> 'fieldId')
      ) then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'field_not_changeable'
        );
      end if;
    end loop;

    -- Build the complete proposed source facts before the first mutation. A
    -- changed fixed relationship replaces its old edge; the exact validated
    -- target's private facts are loaded only inside this operation and are
    -- never returned. The same current update declaration must still allow the
    -- source under the complete proposed values and graph.
    proposed_field_values := (loaded -> 'fieldValues') || final_values;
    proposed_records := loaded -> 'facts' -> 'records';
    proposed_edges := loaded -> 'facts' -> 'edges';

    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by item.value ->> 'fieldId'
    loop
      if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'null' then
        if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'object'
          or not ((relationship_change -> 'value') ?& array['recordTypeId', 'recordId'])
          or (relationship_change -> 'value') - array['recordTypeId', 'recordId'] <> '{}'::jsonb
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordTypeId', 'uuid'
          )
          or not pg_catalog.pg_input_is_valid(
            relationship_change -> 'value' ->> 'recordId', 'uuid'
          )
          or (relationship_change -> 'value' ->> 'recordTypeId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid
          or (relationship_change -> 'value' ->> 'recordId')::uuid =
            '00000000-0000-0000-0000-000000000000'::uuid then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_record_type_id := (relationship_change -> 'value' ->> 'recordTypeId')::uuid;
        target_record_id := (relationship_change -> 'value' ->> 'recordId')::uuid;
        if not vortex_record.relationship_declares_target_internal(
          relationship_change -> 'relationship', target_record_type_id
        ) then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        target_loaded := vortex_record.load_record_access_facts_internal(
          target_record_type_id, 'read', target_record_id, null
        );
        if target_loaded ->> 'outcome' <> 'loaded'
          or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_decision := vortex_access.evaluate_organization_record_access_internal(
          target_loaded -> 'declaration', target_record_id, target_loaded -> 'facts'
        );
        if target_decision ->> 'outcome' <> 'allowed' then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;

        proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
        proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');
      end if;
    end loop;

    -- The one canonical lock prelude: every changed link's target row is
    -- share-locked in relationship identity order here, after each target has
    -- passed the same access decision the writer re-checks and before any
    -- source data version or relationship edge identity is taken. Keeping all
    -- target row locks in one place replaces the per-writer #858 corrections.
    perform vortex_record.lock_record_change_targets_internal(
      meta -> 'recordType', organization_id_value, final_values
    );

    -- Target closures may reach the source through a currently permitted
    -- relationship route. Assemble all trusted closures first, then make the
    -- source authoritative exactly once so an old source copy cannot compete
    -- with the proposed values. Other repeated closure records are collapsed by
    -- their permanent Record identity.
    proposed_records := coalesce((
      select pg_catalog.jsonb_agg(
        case when unique_record.record_id = p_record_id
          then unique_record.value || pg_catalog.jsonb_build_object(
            'fieldValues', proposed_field_values
          )
          else unique_record.value end
        order by unique_record.record_id
      )
      from (
        select distinct on (
          (record.value -> 'recordScope' ->> 'recordId')::uuid
        )
          (record.value -> 'recordScope' ->> 'recordId')::uuid as record_id,
          record.value
        from pg_catalog.jsonb_array_elements(proposed_records) as record(value)
        order by (record.value -> 'recordScope' ->> 'recordId')::uuid,
          record.value::text collate "C"
      ) as unique_record
    ), '[]'::jsonb);

    -- Apply every changed fixed relationship after closure assembly. This one
    -- replacement pass removes old source edges even when a target closure
    -- contained them, then adds only the submitted non-null replacements.
    proposed_edges := coalesce((
      with retained_edges as (
        select edge.value
        from pg_catalog.jsonb_array_elements(proposed_edges) as edge(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
          where (changed.value ->> 'relationshipId')::uuid =
              (edge.value ->> 'relationshipId')::uuid
            and (edge.value ->> 'fromRecordId')::uuid = p_record_id
        )
      ), replacement_edges as (
        select pg_catalog.jsonb_build_object(
          'relationshipId', changed.value -> 'relationshipId',
          'fromRecordId', p_record_id,
          'toRecordId', (changed.value -> 'value' ->> 'recordId')::uuid
        ) as value
        from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
        where pg_catalog.jsonb_typeof(changed.value -> 'value') <> 'null'
      ), unique_edges as (
        select distinct candidate.value
        from (
          select retained.value from retained_edges as retained
          union all
          select replacement.value from replacement_edges as replacement
        ) as candidate(value)
      )
      select pg_catalog.jsonb_agg(unique_edge.value order by unique_edge.value)
      from unique_edges as unique_edge
    ), '[]'::jsonb);

    proposed_facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'records', proposed_records,
      'edges', proposed_edges
    );
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, proposed_facts
      );
      if decision ->> 'outcome' <> 'allowed' then
        if action_mode then
          activity_time := vortex_record.append_named_action_activity_internal(
            p_activity_id, p_record_id, array[]::uuid[], 'refused'
          );
        else
          activity_time := vortex_record.append_base_save_activity_internal(
            p_activity_id, 'update', organization_id_value,
            array[]::uuid[], 'refused'
          );
        end if;
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded', 'reasonCode', 'proposed_record_refused'
        );
      end if;
    end if;
  end if;

  if p_operation = 'create' then
    mutation := vortex_record.create_record_internal(
      p_record_type_id, final_values,
      array(
        select key::uuid from pg_catalog.jsonb_object_keys(p_submitted_values) as key
        order by key::uuid
      ), p_selected_group_id
    );
  else
    if final_values = '{}'::jsonb then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'empty_base_update'
      );
    end if;
    if value_final_values <> '{}'::jsonb then
      if action_mode then
        mutation := vortex_record.change_record_by_named_action_internal(
          p_record_type_id, p_record_id, p_expected_concurrency_number,
          value_final_values, value_submitted_field_ids,
          action_owner_kind, action_owner_id, action_release_revision, action_id_value
        );
      else
        mutation := vortex_record.change_record(
          p_record_type_id, p_record_id, p_expected_concurrency_number,
          value_final_values, value_submitted_field_ids
        );
      end if;
      increment_for_relationship := false;
    else
      mutation := pg_catalog.jsonb_build_object(
        'outcome', 'completed', 'recordId', p_record_id,
        'concurrencyNumber', p_expected_concurrency_number + 1
      );
      increment_for_relationship := true;
    end if;

    if mutation ->> 'outcome' in ('completed', 'allowed') then
      for relationship_change in
        select item.value
        from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
        order by (item.value ->> 'relationshipId')::uuid
      loop
        perform vortex_record.write_relationship_value_internal(
          p_record_type_id, p_record_id,
          (relationship_change ->> 'relationshipId')::uuid,
          relationship_change -> 'value', increment_for_relationship
        );
        increment_for_relationship := false;
      end loop;
    end if;
  end if;

  if mutation ->> 'outcome' not in ('completed', 'allowed') then
    if preview_installation is null
      and p_operation = 'create' and mutation ->> 'reasonCode' = 'access_refused' then
      activity_time := vortex_record.append_base_save_activity_internal(
        p_activity_id, 'create', organization_id_value,
        array[]::uuid[], 'refused'
      );
      mutation := mutation || pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded'
      );
    end if;
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return mutation;
  end if;

  saved_record_id := (mutation ->> 'recordId')::uuid;
  saved_concurrency_number := (mutation ->> 'concurrencyNumber')::bigint;
  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(
    case when p_operation = 'create' then mutation -> 'values'
      else final_values end
  ) as key;

  if action_mode then
    activity_time := vortex_record.append_named_action_activity_internal(
      p_activity_id, saved_record_id, changed_field_ids, 'completed'
    );
  elsif preview_installation is null then
    activity_time := vortex_record.append_base_save_activity_internal(
      p_activity_id, p_operation, saved_record_id,
      changed_field_ids, 'completed'
    );
  end if;

  if preview_installation is null then
    event_kind := case when p_operation = 'create' then 'created' else 'changed' end;
    event_payload := case when p_operation = 'create'
      then pg_catalog.jsonb_build_object('kind', 'created')
      else pg_catalog.jsonb_build_object(
        'kind', 'changed',
        'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      ) end;
    event_result := vortex_event.append_record_occurrences(
      (meta ->> 'storageContractId')::uuid,
      saved_record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', event_kind,
          'recordTypeId', p_record_type_id
        ),
        'payload', event_payload
      ))
    );
    if pg_catalog.jsonb_array_length(event_result) <> 1 then
      raise exception using errcode = '55000', message = 'Record save Event append failed';
    end if;
  end if;

  perform vortex_record.complete_command_receipt_internal(
    receipt_kind, effective_command_id, saved_record_id, saved_concurrency_number,
    'Record save receipt is stale'
  );

  if action_mode then
    projection := vortex_record.project_named_action_record_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, saved_record_id
    );
    if projection ->> 'outcome' <> 'completed' then
      raise exception using errcode = '55000',
        message = 'Named action Record projection is unavailable';
    end if;
    subject_written := true;
  else
    projection := vortex_record.read_record(p_record_type_id, saved_record_id);
    if projection ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '55000',
        message = 'Saved Record projection is unavailable';
    end if;
  end if;
  result_value := pg_catalog.jsonb_build_object(
    'outcome', 'saved',
    'recordId', projection -> 'recordId',
    'concurrencyNumber', projection -> 'concurrencyNumber',
    'values', projection -> 'values',
    'correlationId', correlation_id_value,
    'backgroundDelivery', case when preview_installation is null
      then 'pending' else 'none' end,
    'replayed', false
  );
  end subject_step;

  if not action_mode then
    return result_value;
  end if;

  -- The declared Events of a subject-writing action are appended against the
  -- values the subject was left with; an announce-only action appended its own
  -- in its subject step.
  if subject_written then
    event_loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id,
      (result_value ->> 'concurrencyNumber')::bigint
    );
    if event_loaded ->> 'outcome' <> 'loaded' then
      raise exception using errcode = '55000',
        message = 'Named action Event values are unavailable';
    end if;
    event_result := vortex_record.append_declared_named_action_occurrences_internal(
      (action_context ->> 'storageContractId')::uuid, p_record_id,
      action_context -> 'eventDescriptors', action_declared_occurrence_ids,
      event_loaded -> 'fieldValues'
    );
    if pg_catalog.jsonb_array_length(event_result) <>
      pg_catalog.jsonb_array_length(action_declared_occurrence_ids) then
      raise exception using errcode = '55000',
        message = 'Named action declared Event append failed';
    end if;
  end if;

  if creation_count > 0 then
    if create_targets is null then
      raise exception using errcode = '55000',
        message = 'Named action creation plan is unavailable';
    end if;

    -- Every insert, in authored task order, before any edge. Each allocates
    -- its reference numbers (L4); keeping the whole set ahead of the edge pass
    -- is what matches ordinary create's counter-before-edge order.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(action_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_field_ids
      from pg_catalog.jsonb_object_keys(creation -> 'values') as key;
      inserted_value := vortex_record.insert_named_action_record_internal(
        (creation ->> 'recordTypeId')::uuid, creation -> 'finalValues', submitted_field_ids
      );
      created_records := created_records || pg_catalog.jsonb_build_object(
        creation ->> 'ordinal', inserted_value
      );
    end loop;

    -- Every edge, in one canonical order across all creations: by relationship,
    -- then target, matching the ascending relationship edge identity order every
    -- ordinary writer loop uses.
    select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ordinal', entry.ordinal,
        'sourceRecordTypeId', entry.source_record_type_id,
        'relationshipId', entry.relationship_id,
        'value', entry.target_value
      )
      order by entry.relationship_id, entry.target_record_id, entry.ordinal
    ), '[]'::jsonb)
    into edge_plan
    from (
      select (creation_item.value ->> 'ordinal')::integer as ordinal,
        (creation_item.value ->> 'recordTypeId')::uuid as source_record_type_id,
        (relationship_item.value ->> 'relationshipId')::uuid as relationship_id,
        pg_catalog.lower(relationship_item.value ->> 'fromFieldId') as from_field_id,
        (creation_item.value -> 'values'
          -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId')) as target_value,
        (creation_item.value -> 'values'
          -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId') ->> 'recordId')::uuid
          as target_record_id
      from pg_catalog.jsonb_array_elements(action_creations) creation_item(value)
      join pg_catalog.jsonb_array_elements(create_targets) target_item(value)
        on (target_item.value ->> 'ordinal')::integer =
          (creation_item.value ->> 'ordinal')::integer
      join pg_catalog.jsonb_array_elements(
        target_item.value -> 'recordType' -> 'relationships'
      ) relationship_item(value) on true
      where (creation_item.value -> 'values') ?
        pg_catalog.lower(relationship_item.value ->> 'fromFieldId')
        and pg_catalog.jsonb_typeof(
          creation_item.value -> 'values'
            -> pg_catalog.lower(relationship_item.value ->> 'fromFieldId')
        ) = 'object'
    ) entry;

    for edge_entry in
      select item.value
      from pg_catalog.jsonb_array_elements(edge_plan) with ordinality item(value, ordinality)
      order by item.ordinality
    loop
      perform vortex_record.write_named_action_relationship_value_internal(
        (edge_entry ->> 'sourceRecordTypeId')::uuid,
        (created_records -> (edge_entry ->> 'ordinal') ->> 'recordId')::uuid,
        (edge_entry ->> 'relationshipId')::uuid,
        edge_entry -> 'value',
        action_owner_kind, action_owner_id, action_release_revision,
        action_id_value, p_record_type_id, p_record_id
      );
    end loop;

    -- The exact create decision only exists now, with the derived owner and the
    -- complete new graph in place. A denial raises, rolling the whole command
    -- back with no post-rollback refusal Activity.
    for creation in
      select item.value
      from pg_catalog.jsonb_array_elements(action_creations) with ordinality item(value, ordinality)
      order by (item.value ->> 'ordinal')::integer
    loop
      inserted_value := created_records -> (creation ->> 'ordinal');
      created_record_id := (inserted_value ->> 'recordId')::uuid;
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_field_ids
      from pg_catalog.jsonb_object_keys(creation -> 'values') as key;
      perform vortex_record.authorize_named_action_created_record_internal(
        (creation ->> 'recordTypeId')::uuid, created_record_id, submitted_field_ids
      );
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into changed_field_ids
      from pg_catalog.jsonb_object_keys(inserted_value -> 'values') as key;
      perform vortex_record.append_named_action_activity_internal(
        pg_catalog.gen_random_uuid(), created_record_id, changed_field_ids, 'completed'
      );
      select (item.value #>> '{}')::uuid into occurrence_id_value
      from pg_catalog.jsonb_array_elements(action_creation_occurrence_ids)
        with ordinality item(value, ordinality)
      where item.ordinality = (
        select position.ordinality
        from pg_catalog.jsonb_array_elements(action_creations) with ordinality position(value, ordinality)
        where (position.value ->> 'ordinal')::integer = (creation ->> 'ordinal')::integer
      );
      if occurrence_id_value is null then
        raise exception using errcode = '22023',
          message = 'Named action creation occurrence is invalid';
      end if;
      event_result := vortex_event.append_record_occurrences(
        (inserted_value ->> 'storageContractId')::uuid, created_record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', occurrence_id_value,
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard', 'eventKind', 'created',
            'recordTypeId', (creation ->> 'recordTypeId')::uuid
          ),
          'payload', pg_catalog.jsonb_build_object('kind', 'created')
        ))
      );
      if pg_catalog.jsonb_array_length(event_result) <> 1 then
        raise exception using errcode = '55000',
          message = 'Named action creation Event append failed';
      end if;
    end loop;
  end if;

  if copy_plan is not null then
    perform vortex_record.apply_named_action_relationship_copies_internal(copy_plan);
  end if;

  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(action_parents) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    select item.value into strict prepared_parent
    from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
    where item.value ->> 'recordTypeId' = parent_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = parent_value ->> 'recordId';
    select coalesce(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into reduced_final_values
    from pg_catalog.jsonb_each(parent_value -> 'finalValues') entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_parent -> 'existingValues' -> entry.key, 'null'::jsonb
    );
    perform vortex_record.apply_relationship_total_parent_internal(
      (parent_value ->> 'recordTypeId')::uuid,
      (parent_value ->> 'recordId')::uuid,
      (parent_value ->> 'expectedConcurrencyNumber')::bigint,
      reduced_final_values
    );
  end loop;
  return result_value || pg_catalog.jsonb_build_object('createdRecords', created_records);
end
$function$;

alter function vortex_record.apply_record_changes(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) to vortex_record_adapter;

comment on function vortex_record.apply_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, jsonb, uuid, uuid, jsonb
) is
  'The one protected Record-change operation: claims one live or preview-local receipt and applies an ordered mutation list under one canonical lock order. Live changes keep their access decisions, Activity, Event and background effects; preview changes belong only to the validated preview owner and append no live effects. Named-action and lifecycle commands are refused in previews.';

create or replace function vortex_record.save_base_record_with_relationship_totals(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_parent_mutations jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  preparation_value jsonb;
  reduced_final_values jsonb;
  context_value jsonb;
  catalogue jsonb;
  closure_value jsonb;
  root_type jsonb;
  root_snapshot jsonb;
  relationship_value jsonb;
  target_type jsonb;
  total_field jsonb;
  dependency_contract jsonb;
  dependency_field_id text;
  relationship_field_id text;
  old_relationship_target jsonb;
  proposed_relationship_target jsonb;
  contributes_to_total boolean := false;
  expected_parents jsonb;
  supplied_parents jsonb;
  preview_installation jsonb;
begin
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null then
    if preview_installation ->> 'outcome' = 'refused'
      or p_parent_mutations is distinct from '[]'::jsonb then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
      );
    end if;
    return vortex_record.save_base_record(
      p_command_id, p_operation, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values, p_final_values,
      p_selected_group_id, p_activity_id, p_occurrence_id
    );
  end if;
  if pg_catalog.jsonb_typeof(p_parent_mutations) <> 'array' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  -- Receipt identity remains authoritative for replay and changed-input
  -- duplicate classification. A completed command must reach that owner even
  -- if a caller supplies no longer-current relationship mutations.
  if not vortex_record.command_receipt_exists_internal('record_save', p_command_id) then
    -- The writer repeats the protected preparation itself.  Closure identity,
    -- revisions and the complete generated-field set therefore never depend
    -- on caller-controlled transaction state or a replayable preparation token.
    preparation_value := vortex_record.prepare_relationship_total_save(
      p_command_id, p_operation, p_record_type_id, p_record_id,
      p_expected_concurrency_number, p_submitted_values, p_selected_group_id,
      p_activity_id
    );
    if preparation_value ->> 'outcome' in ('restart', 'conflict', 'refused', 'refused_recorded') then
      return preparation_value;
    end if;
    if preparation_value ->> 'outcome' = 'defer' and vortex_record.command_receipt_exists_internal('record_save', p_command_id) then
      preparation_value := null;
    elsif preparation_value ->> 'outcome' = 'defer' then
      catalogue := vortex_record.relationship_total_catalogue_internal();
      if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) then
        closure_value := vortex_record.discover_relationship_total_closure_internal(
          catalogue, p_operation, p_record_type_id, p_record_id, p_submitted_values
        );
        select item.value into root_type
        from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') item(value)
        where pg_catalog.lower(item.value ->> 'recordTypeId') =
          pg_catalog.lower(p_record_type_id::text);
        select item.value into root_snapshot
        from pg_catalog.jsonb_array_elements(closure_value -> 'records') item(value)
        where item.value ->> 'recordKey' = 'root';
        if root_type is null or root_snapshot is null then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
        for relationship_value, target_type in
          select item.value, target.value
          from pg_catalog.jsonb_array_elements(root_type -> 'relationships') item(value)
          join pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') target(value)
            on vortex_record.relationship_declares_target_internal(
              item.value, (target.value ->> 'recordTypeId')::uuid
            )
          where item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
          order by item.value ->> 'relationshipId', target.value ->> 'recordTypeId'
        loop
          relationship_field_id := pg_catalog.lower(relationship_value ->> 'fromFieldId');
          old_relationship_target := root_snapshot -> 'existingValues' -> relationship_field_id;
          proposed_relationship_target := old_relationship_target;
          if p_submitted_values ? relationship_field_id then
            proposed_relationship_target := p_submitted_values -> relationship_field_id;
          end if;
          if not (
            (pg_catalog.jsonb_typeof(old_relationship_target) = 'object' and
              pg_catalog.lower(old_relationship_target ->> 'recordTypeId') =
                pg_catalog.lower(target_type ->> 'recordTypeId'))
            or
            (pg_catalog.jsonb_typeof(proposed_relationship_target) = 'object' and
              pg_catalog.lower(proposed_relationship_target ->> 'recordTypeId') =
                pg_catalog.lower(target_type ->> 'recordTypeId'))
          ) then
            continue;
          end if;
          for total_field in
            select field.value
            from pg_catalog.jsonb_array_elements(target_type -> 'fields') field(value)
            where field.value ->> 'type' = 'total'
              and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
                pg_catalog.lower(relationship_value ->> 'relationshipId')
          loop
            if p_submitted_values ? relationship_field_id and
              p_submitted_values -> relationship_field_id is distinct from
                coalesce(root_snapshot -> 'existingValues' -> relationship_field_id, 'null'::jsonb) then
              contributes_to_total := true;
              exit;
            end if;
            dependency_contract := vortex_record.total_dependency_contract_internal(
              catalogue -> 'recordTypes',
              pg_catalog.jsonb_build_array(relationship_value),
              (target_type ->> 'recordTypeId')::uuid, total_field
            );
            for dependency_field_id in
              select item.value
              from pg_catalog.jsonb_array_elements_text(
                dependency_contract -> 'sourceFieldIds'
              ) item(value)
            loop
              if p_final_values ? dependency_field_id and
                p_final_values -> dependency_field_id is distinct from
                  coalesce(root_snapshot -> 'existingValues' -> dependency_field_id, 'null'::jsonb) then
                contributes_to_total := true;
                exit;
              end if;
            end loop;
            exit when contributes_to_total;
          end loop;
          exit when contributes_to_total;
        end loop;
        if contributes_to_total then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
          );
        end if;
      end if;
    end if;
    if preparation_value ->> 'outcome' <> 'prepared' then
      if pg_catalog.jsonb_array_length(p_parent_mutations) = 0 then
        preparation_value := null;
      else
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
        );
      end if;
    else
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'recordTypeId', item.value -> 'recordTypeId',
          'recordId', item.value -> 'recordId',
          'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
          'finalFieldIds', coalesce((
            select pg_catalog.jsonb_agg(
              pg_catalog.lower(field.value ->> 'fieldId')
              order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
            )
            from pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') field(value)
            where field.value ->> 'type' in ('total', 'calculation')
          ), '[]'::jsonb)
        ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
      ), '[]'::jsonb) into expected_parents
      from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
      where item.value ->> 'recordKey' <> 'root';
      select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'recordTypeId', item.value -> 'recordTypeId',
          'recordId', item.value -> 'recordId',
          'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
          'finalFieldIds', coalesce((
            select pg_catalog.jsonb_agg(field_id order by field_id collate "C")
            from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') field(field_id)
          ), '[]'::jsonb)
        ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
      ), '[]'::jsonb) into supplied_parents
      from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
      where pg_catalog.jsonb_typeof(item.value) = 'object'
        and item.value ?& array[
          'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
        ]
        and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
      if supplied_parents is distinct from expected_parents
        or pg_catalog.jsonb_array_length(supplied_parents) <>
          pg_catalog.jsonb_array_length(p_parent_mutations) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
        );
      end if;
    end if;
  end if;
  result_value := vortex_record.save_base_record(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_submitted_values, p_final_values,
    p_selected_group_id, p_activity_id, p_occurrence_id
  );
  if result_value ->> 'outcome' <> 'saved' or coalesce((result_value ->> 'replayed')::boolean, false) then
    return result_value;
  end if;
  for parent_value in
    select item.value from pg_catalog.jsonb_array_elements(p_parent_mutations) item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    if not (parent_value ?& array[
      'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
    ]) then
      raise exception using errcode = '22023', message = 'Relationship total parent mutation is incomplete';
    end if;
    select item.value into strict prepared_parent
    from pg_catalog.jsonb_array_elements(preparation_value -> 'records') item(value)
    where item.value ->> 'recordTypeId' = parent_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = parent_value ->> 'recordId';
    select coalesce(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into reduced_final_values
    from pg_catalog.jsonb_each(parent_value -> 'finalValues') entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_parent -> 'existingValues' -> entry.key, 'null'::jsonb
    );
    perform vortex_record.apply_relationship_total_parent_internal(
      (parent_value ->> 'recordTypeId')::uuid,
      (parent_value ->> 'recordId')::uuid,
      (parent_value ->> 'expectedConcurrencyNumber')::bigint,
      reduced_final_values
    );
  end loop;
  return result_value;
end
$function$;

alter function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb)
to vortex_runtime;
comment on function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb) is
  'Existing protected base save composed with revision-checked generated parent totals, Activity and standard Events in the same transaction.';

create or replace function vortex_record.read_record_capabilities(
  p_record_type_id uuid,
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  read_loaded jsonb;
  read_decision jsonb;
  read_bounds jsonb;
  preview_bounds jsonb;
  readable_field_ids jsonb;
  meta jsonb;
  changeable_field_ids jsonb := '[]'::jsonb;
  actions text[] := array[]::text[];
  action_kind text;
  action_loaded jsonb;
  action_decision jsonb;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid then
    return null;
  end if;

  -- The row must be readable under the exact decision read_record applies, over
  -- the same fact loader; an unreadable row has no capabilities to report.
  read_loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'read', p_record_id, null
  );
  if read_loaded ->> 'outcome' <> 'loaded'
    or (not (read_loaded ? 'previewInstallationId')
      and pg_catalog.jsonb_typeof(read_loaded -> 'declaration') <> 'object') then
    return null;
  end if;
  if read_loaded ? 'previewInstallationId' then
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
    preview_bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (meta ->> 'storageContractId')::uuid,
      meta -> 'recordType'
    );
    if preview_bounds is null then
      return null;
    end if;
    read_bounds := preview_bounds;
  else
    read_decision := vortex_access.evaluate_organization_record_access_internal(
      read_loaded -> 'declaration', p_record_id, read_loaded -> 'facts'
    );
    if read_decision ->> 'outcome' <> 'allowed' then
      return null;
    end if;
    read_bounds := vortex_access.resolve_record_field_bounds_internal(read_decision);
  end if;
  readable_field_ids := vortex_record.project_derived_readable_field_ids_internal(
    read_loaded, p_record_type_id, p_record_id,
    read_bounds -> 'readableFieldIds', read_bounds -> 'readableFieldIds', '[]'::jsonb
  );

  if read_loaded ? 'previewInstallationId' then
    select coalesce(
      pg_catalog.jsonb_agg(projected.value order by projected.value), '[]'::jsonb
    )
    into changeable_field_ids
    from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
    where exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        preview_bounds -> 'changeableFieldIds'
      ) as changeable(value)
      where pg_catalog.lower(changeable.value) = pg_catalog.lower(projected.value)
    );
    if pg_catalog.jsonb_array_length(changeable_field_ids) > 0 then
      actions := array['update'];
    end if;
    return pg_catalog.jsonb_build_object(
      'changeableFieldIds', changeable_field_ids,
      'actions', pg_catalog.to_jsonb(actions)
    );
  end if;

  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
  if meta #>> '{recordType,key}' = 'organization_settings'
    and meta #>> '{recordType,systemProjection,protectedView}' =
      'organization_runtime_settings'
    and coalesce((meta #> '{recordType,standardActions}') ? 'update', false)
    and exists (
      select 1
      from vortex_definition.roots as root
      where root.root_id = (meta ->> 'moduleRootId')::uuid
        and root.kind = 'module'
        and root.key = 'vortex.organisation_administration'
    ) then
    if vortex_access.organization_runtime_settings_manage_is_current() then
      select coalesce(
        pg_catalog.jsonb_agg(projected.value order by projected.value), '[]'::jsonb
      )
      into changeable_field_ids
      from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
      join pg_catalog.jsonb_array_elements(meta #> '{recordType,fields}') as field(value)
        on pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(projected.value)
      where field.value ->> 'key' not in ('organization_id', 'revision')
        and field.value ->> 'type' not in (
          'reference_number', 'table', 'link', 'link_to_one_of_several', 'total',
          'attachment', 'calculation'
        );
      if pg_catalog.jsonb_array_length(changeable_field_ids) > 0 then
        actions := array['update'];
      end if;
    end if;
    return pg_catalog.jsonb_build_object(
      'changeableFieldIds', changeable_field_ids,
      'actions', pg_catalog.to_jsonb(actions)
    );
  end if;

  -- Each record action kind is decided exactly as its own writer decides it: the
  -- same fact loader for that action kind and the same complete exact-record
  -- evaluation. An action is reported only when its own decision allows this
  -- exact record; a missing declaration contributes no action.
  foreach action_kind in array array['update', 'delete', 'restore'] loop
    action_loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, action_kind, p_record_id, null
    );
    if action_loaded ->> 'outcome' = 'loaded'
      and pg_catalog.jsonb_typeof(action_loaded -> 'declaration') = 'object' then
      action_decision := vortex_access.evaluate_organization_record_access_internal(
        action_loaded -> 'declaration', p_record_id, action_loaded -> 'facts'
      );
      if action_decision ->> 'outcome' = 'allowed' then
        actions := pg_catalog.array_append(actions, action_kind);
        -- The changeable fields are the update decision's own field bounds, the
        -- set the record save enforces, narrowed to the fields read_record
        -- projects for this row, so no hidden field is ever reported.
        if action_kind = 'update' then
          changeable_field_ids := coalesce((
            select pg_catalog.jsonb_agg(projected.value order by projected.value)
            from pg_catalog.jsonb_array_elements_text(readable_field_ids) as projected(value)
            where exists (
              select 1
              from pg_catalog.jsonb_array_elements_text(
                vortex_access.resolve_record_field_bounds_internal(action_decision)
                  -> 'changeableFieldIds'
              ) as changeable(value)
              where pg_catalog.lower(changeable.value) = pg_catalog.lower(projected.value)
            )
          ), '[]'::jsonb);
        end if;
      end if;
    end if;
  end loop;

  -- Changing a row needs at least one field it may change, so update is never
  -- reported without one.
  if pg_catalog.jsonb_array_length(changeable_field_ids) = 0 then
    actions := pg_catalog.array_remove(actions, 'update');
  end if;

  return pg_catalog.jsonb_build_object(
    'changeableFieldIds', changeable_field_ids,
    'actions', pg_catalog.to_jsonb(actions)
  );
end
$function$;

alter function vortex_record.read_record_capabilities(uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_capabilities(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.read_record_capabilities(uuid, uuid) to vortex_request;

comment on function vortex_record.read_record_capabilities(uuid, uuid) is
  'Fixed record capabilities adapter: for one live record readable under the caller''s current authority or one owner-readable preview record, returns only permitted update, delete and restore actions and changeable fields; preview capabilities are limited to supported updates, and missing, foreign or unreadable records return null.';

reset role;

set local role vortex_record_owner;

revoke create on schema vortex_record from vortex_record_adapter;

reset role;

commit;
