create or replace function vortex_record.detach_exact_module_contributions(
  p_module_root_id uuid,
  p_module_release_revision bigint,
  p_contributions jsonb
)
returns table (
  module_root_id uuid,
  release_revision bigint,
  contribution_ids uuid[],
  changed boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  contribution jsonb;
  contribution_id uuid;
  contribution_kind text;
  contributor_root_id uuid;
  target_module_root_id uuid;
  target_record_type_id uuid;
  field_id_value uuid;
  storage_id uuid;
  storage_ids uuid[] := array[]::uuid[];
  stored_catalogue vortex_record.storage_catalogue%rowtype;
  stored_field vortex_record.field_storage_mappings%rowtype;
  contribution_ids uuid[] := array[]::uuid[];
  any_change boolean := false;
begin
  if not vortex_context.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_contributions) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_contributions) < 1
    or pg_catalog.jsonb_array_length(p_contributions) > 100 then
    raise exception using errcode = '22023',
      message = 'Module contribution storage command is invalid';
  end if;

  select release.* into strict release_row
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision
    and root.kind = 'module';
  if release_row.validation_contract_version
      <> all (vortex_definition.accepted_contract_version('module'))
    or release_row.source_contract_version
      is distinct from release_row.validation_contract_version
    or release_row.compilation_output #>> '{kind}' is distinct from 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}'
      is distinct from release_row.validation_contract_version then
    raise exception using errcode = '23514',
      message = 'Exact contributor Module release is incompatible';
  end if;

  for contribution in
    select item.value
    from pg_catalog.jsonb_array_elements(p_contributions) as item(value)
    order by pg_catalog.lower(item.value ->> 'targetModuleRootId'),
      pg_catalog.lower(item.value ->> 'targetRecordTypeId'),
      pg_catalog.lower(item.value ->> 'contributionId')
  loop
    if pg_catalog.jsonb_typeof(contribution) is distinct from 'object'
      or pg_catalog.jsonb_typeof(contribution -> 'contributorModuleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(contribution -> 'targetModuleRootId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(contribution -> 'targetRecordTypeId') is distinct from 'string' then
      raise exception using errcode = '22023', message = 'Module contribution identity is invalid';
    end if;
    begin
      contributor_root_id := (contribution ->> 'contributorModuleRootId')::uuid;
      target_module_root_id := (contribution ->> 'targetModuleRootId')::uuid;
      target_record_type_id := (contribution ->> 'targetRecordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Module contribution identity is invalid';
    end;
    if not vortex_context.is_non_nil_uuid(contributor_root_id::text)
      or not vortex_context.is_non_nil_uuid(target_module_root_id::text)
      or not vortex_context.is_non_nil_uuid(target_record_type_id::text)
      or contributor_root_id <> p_module_root_id then
      raise exception using errcode = '22023', message = 'Module contribution binding is invalid';
    end if;
    select catalogue.storage_contract_id into storage_id
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = target_module_root_id
      and catalogue.record_type_id = target_record_type_id
      and catalogue.state = 'active';
    if storage_id is null then
      raise exception using errcode = '55000',
        message = 'Target record storage is unavailable';
    end if;
    storage_ids := storage_ids || storage_id;
  end loop;

  for storage_id in
    select distinct item.value
    from pg_catalog.unnest(storage_ids) as item(value)
    order by item.value
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || storage_id::text, 0)
    );
  end loop;

  for contribution in
    select item.value
    from pg_catalog.jsonb_array_elements(p_contributions) as item(value)
    order by pg_catalog.lower(item.value ->> 'targetModuleRootId'),
      pg_catalog.lower(item.value ->> 'targetRecordTypeId'),
      pg_catalog.lower(item.value ->> 'contributionId')
  loop
    begin
      contribution_id := (contribution ->> 'contributionId')::uuid;
      target_module_root_id := (contribution ->> 'targetModuleRootId')::uuid;
      target_record_type_id := (contribution ->> 'targetRecordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Module contribution identity is invalid';
    end;
    contribution_kind := contribution ->> 'kind';
    if contribution_id is null
      or contribution_kind is null
      or not vortex_context.is_non_nil_uuid(contribution_id::text)
      or contribution_kind not in ('field', 'action') then
      raise exception using errcode = '22023', message = 'Module contribution binding is invalid';
    end if;

    if contribution_kind = 'action' then
      contribution_ids := contribution_ids || contribution_id;
      continue;
    end if;

    begin
      field_id_value := (contribution ->> 'fieldId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Contributed field identity is invalid';
    end;
    if not vortex_context.is_non_nil_uuid(field_id_value::text)
      or field_id_value <> contribution_id then
      raise exception using errcode = '22023', message = 'Contributed field identity is invalid';
    end if;

    select catalogue.* into strict stored_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.module_root_id = target_module_root_id
      and catalogue.record_type_id = target_record_type_id
      and catalogue.state = 'active';
    select mapping.* into stored_field
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = stored_catalogue.storage_contract_id
      and mapping.field_id = field_id_value
    for update;
    if found then
      if stored_field.introduced_by_module_root_id <> p_module_root_id then
        raise exception using errcode = '55000',
          message = 'Contributed field storage belongs to another Module';
      end if;
      if stored_field.state = 'active' then
        -- Detachment retires the mapping only. The physical column and every
        -- stored value stay, so a reinstall reactivates the same lineage.
        update vortex_record.field_storage_mappings as mapping
        set state = 'retired',
            retired_by_module_root_id = p_module_root_id,
            retired_at_release_revision = p_module_release_revision
        where mapping.storage_contract_id = stored_catalogue.storage_contract_id
          and mapping.field_id = field_id_value;
        any_change := true;
      end if;
    end if;

    contribution_ids := contribution_ids || contribution_id;
  end loop;

  return query select p_module_root_id, p_module_release_revision, contribution_ids, any_change;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module contribution evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Module contribution evidence is ambiguous';
end
$function$;

revoke all on function vortex_record.detach_exact_module_contributions(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.detach_exact_module_contributions(uuid, bigint, jsonb)
  to vortex_module_owner;
comment on function vortex_record.detach_exact_module_contributions(uuid, bigint, jsonb) is
  'Private exact-release contributor storage teardown: retires each contributed field mapping without dropping its column or overwriting retained values, so a reinstall can reactivate the same lineage.';
