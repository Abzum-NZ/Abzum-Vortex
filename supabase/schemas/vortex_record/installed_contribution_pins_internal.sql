create or replace function vortex_record.installed_contribution_pins_internal(
  p_organization_id uuid,
  p_module_root_ids uuid[]
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_module_root_ids is null then
    raise exception using errcode = '22023',
      message = 'Installed contribution selector is invalid';
  end if;

  -- The exact pins of every installed field contribution on the given Modules' storage, in one
  -- canonical string: the contributing Module, its active binding and the contributed field. An
  -- access plan keyed by it can never outlive the contributions it was built from.
  return coalesce((
    select pg_catalog.string_agg(pin.value, ',' order by pin.value collate "C")
    from (
      select distinct mapping.storage_contract_id::text || ':' || mapping.field_id::text || ':'
        || binding.application_root_id::text || ':' || binding.module_release_revision::text
        || ':' || binding.binding_revision::text as value
      from vortex_record.storage_catalogue as catalogue
      join vortex_record.field_storage_mappings as mapping
        on mapping.storage_contract_id = catalogue.storage_contract_id
        and mapping.state = 'active'
        and mapping.introduced_by_module_root_id <> catalogue.module_root_id
      join vortex_definition.installation_bindings as binding
        on binding.organization_id = p_organization_id
        and binding.module_root_id = mapping.introduced_by_module_root_id
        and binding.state = 'active'
      where catalogue.module_root_id = any (p_module_root_ids)
        and catalogue.state = 'active'
    ) as pin
  ), '');
end
$function$;

alter function vortex_record.installed_contribution_pins_internal(uuid,uuid[]) owner to vortex_owner;

revoke all on function vortex_record.installed_contribution_pins_internal(uuid, uuid[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.installed_contribution_pins_internal(uuid, uuid[])
  to vortex_record_adapter, vortex_owner;

comment on function vortex_record.installed_contribution_pins_internal(uuid, uuid[]) is
  'Private canonical pin string of the installed field contributions on the given Modules'' storage in one organisation; part of the installation access plan key. Owner-only except for the fixed record adapter.';
