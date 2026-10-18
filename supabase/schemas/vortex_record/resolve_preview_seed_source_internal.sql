create or replace function vortex_record.resolve_preview_seed_source_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_module_root_id uuid,
  p_record_type_id uuid,
  p_storage_contract_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  source_catalogue vortex_record.storage_catalogue%rowtype;
  live_type jsonb;
  live_plan jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_platform.is_non_nil_uuid(p_storage_contract_id::text) then
    raise exception using errcode = '42501', message = 'Preview seed source is invalid';
  end if;
  -- Preview storage is private to its builder, even when its UUID is known and its
  -- organisation, Application, Module and record type match the installed ones.
  if exists (
    select 1 from vortex_record.preview_storage_bindings as binding
    where binding.storage_contract_id = p_storage_contract_id
  ) then
    raise exception using errcode = '42501', message = 'Preview seed source is refused';
  end if;
  select catalogue.* into source_catalogue
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id;
  if found and (source_catalogue.module_root_id is distinct from p_module_root_id
    or source_catalogue.record_type_id is distinct from p_record_type_id
    or source_catalogue.physical_schema_token is distinct from 'record_data'
    or source_catalogue.state is distinct from 'active') then
    raise exception using errcode = '42501', message = 'Preview seed source is refused';
  end if;

  -- A new Application or record type has no live records to seed. For an installed
  -- type, resolve the same live plan as record authorization, never the rehearsal.
  if not exists (
    select 1 from vortex_definition.installation_bindings as binding
    where binding.organization_id = p_organization_id
      and binding.application_root_id = p_application_root_id
      and binding.state = 'active'
  ) then
    return null;
  end if;
  live_plan := vortex_record.resolve_installation_access_plan_internal(
    vortex_definition.read_active_installation_for_scope_internal(
      p_organization_id, p_application_root_id
    )
  );
  live_type := live_plan -> 'recordTypes' -> pg_catalog.lower(p_record_type_id::text);
  if live_type is null then
    return null;
  end if;
  if (live_type ->> 'moduleRootId')::uuid is distinct from p_module_root_id
    or (live_type ->> 'storageContractId')::uuid is distinct from p_storage_contract_id
    or (live_type ->> 'isSystemProjection')::boolean is distinct from false then
    raise exception using errcode = '42501', message = 'Preview seed source disagrees with the live installation';
  end if;
  return live_type;
end
$function$;

alter function vortex_record.resolve_preview_seed_source_internal(uuid, uuid, uuid, uuid, uuid)
  owner to vortex_owner;
revoke all on function vortex_record.resolve_preview_seed_source_internal(uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.resolve_preview_seed_source_internal(uuid, uuid, uuid, uuid, uuid)
  to vortex_owner, vortex_record_adapter;
comment on function vortex_record.resolve_preview_seed_source_internal(uuid, uuid, uuid, uuid, uuid) is
  'Validates a preview release storage identity against the installed live record type, refuses every preview storage source, and returns the live access-plan type or null for an uninstalled type.';
