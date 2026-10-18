create or replace function vortex_record.preview_module_record_types_internal(
  p_preview_installation_id uuid,
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  record_types jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Preview storage selector is invalid';
  end if;
  -- The preview's own rehearsed release of an owned Module, or else the stored release.
  select (pg_catalog.jsonb_populate_record(
    null::vortex_definition.releases, preview_release.release
  )).* into release_row
  from vortex_definition.preview_releases as preview_release
  join vortex_definition.roots as root on root.root_id = preview_release.root_id
  where preview_release.preview_installation_id = p_preview_installation_id
    and preview_release.root_id = p_module_root_id
    and preview_release.release_revision = p_module_release_revision
    and root.kind = 'module';
  if not found then
    select release.* into strict release_row
    from vortex_definition.releases as release
    join vortex_definition.roots as root on root.root_id = release.root_id
    where release.root_id = p_module_root_id
      and release.release_revision = p_module_release_revision
      and root.kind = 'module';
  end if;
  if release_row.validation_contract_version <> all (vortex_definition.accepted_contract_version('module'))
    or release_row.source_contract_version
      is distinct from release_row.validation_contract_version
    or release_row.compilation_output #>> '{kind}' is distinct from 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}'
      is distinct from release_row.validation_contract_version then
    raise exception using errcode = '23514', message = 'Exact Module release is incompatible';
  end if;
  record_types := release_row.compilation_output #> '{canonical,content,recordTypes}';
  if pg_catalog.jsonb_typeof(record_types) is distinct from 'array' then
    raise exception using errcode = '23514', message = 'Module record storage definition is incompatible';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    where item.value ->> 'storageContractId' is null
      or item.value ->> 'recordTypeId' is null
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'storageContractId')
      or pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module record storage identities are duplicated';
  end if;
  return record_types;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Exact Module release is ambiguous';
end
$function$;

alter function vortex_record.preview_module_record_types_internal(uuid, uuid, bigint) owner to vortex_owner;

revoke all on function vortex_record.preview_module_record_types_internal(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.preview_module_record_types_internal(uuid, uuid, bigint)
  to vortex_owner;
comment on function vortex_record.preview_module_record_types_internal(uuid, uuid, bigint) is
  'The validated record types of one exact Module release a preview runs: its rehearsed release of an owned Module, or else the stored release.';
