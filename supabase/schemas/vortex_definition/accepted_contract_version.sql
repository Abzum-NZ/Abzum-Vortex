create or replace function vortex_definition.accepted_contract_version(
  p_kind text
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $function$
begin
  case p_kind
    when 'application' then
      return array['2.0.0'];
    when 'module' then
      return array['2.0.0', '3.0.0'];
    when 'module_storage_conversion' then
      return array['2.0.0'];
    when 'record_type' then
      return array['1.0.0', '2.0.0', '3.0.0'];
    else
      raise exception using errcode = '22023',
        message = 'Accepted contract version kind is unknown';
  end case;
end
$function$;

revoke all on function vortex_definition.accepted_contract_version(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
grant execute on function vortex_definition.accepted_contract_version(text)
  to vortex_module_owner, vortex_record_owner;
comment on function vortex_definition.accepted_contract_version(text) is
  'One accepted definition contract-version set per contract kind. application: vortex_module.provision_module_installation_storage and vortex_module.activate/detach_application_installation. module: vortex_record.provision_exact_module_storage. module_storage_conversion: vortex_record.register_storage_conversion_plan. record_type: vortex_access.evaluate_organization_record_access_internal.';
