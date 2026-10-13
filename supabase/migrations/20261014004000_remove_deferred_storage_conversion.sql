set local role vortex_owner;

-- These three are owned by the restricted record adapter role, so they are dropped under it.
set local role vortex_record_adapter;
drop function vortex_record.adopt_storage_conversion(uuid,bigint,uuid,uuid);
drop function vortex_record.convert_record_storage_batch(uuid,integer,bigint);
drop function vortex_record.read_storage_conversion_corrections(uuid,integer);
set local role vortex_owner;

drop function vortex_record.allocate_storage_conversion_plan(uuid,bigint);
drop function vortex_record.register_storage_conversion_plan(uuid,uuid,uuid,bigint,bigint);
drop function vortex_record.switch_storage_conversion_mappings_internal(uuid,boolean);
drop function vortex_record.lock_storage_adoption_internal(uuid,uuid,uuid);
drop function vortex_record.authorize_storage_conversion_internal(uuid,bigint);
drop function vortex_record.ensure_storage_conversion_column_internal(text,text,text);
drop function vortex_record.conversion_value_assignment(text,text,text);
drop function vortex_definition.count_storage_adoption_dependents_internal(uuid,uuid,bigint[]);
drop function vortex_definition.lock_storage_adoption_binding_internal(uuid,uuid,uuid,uuid,bigint);
drop function vortex_definition.storage_conversion_is_installed_internal(uuid,uuid,uuid,uuid,bigint);

drop policy storage_conversion_progress_adapter on vortex_record.storage_conversion_progress;
drop policy storage_conversion_progress_owner on vortex_record.storage_conversion_progress;
drop policy storage_conversion_plans_adapter on vortex_record.storage_conversion_plans;
drop policy storage_conversion_plans_owner on vortex_record.storage_conversion_plans;
drop policy storage_conversion_catalogue_adapter on vortex_record.storage_conversion_catalogue;
drop policy storage_conversion_catalogue_owner on vortex_record.storage_conversion_catalogue;

drop table vortex_record.storage_conversion_progress;
drop table vortex_record.storage_conversion_plans;
drop table vortex_record.storage_conversion_catalogue;

drop function vortex_record.conversion_semantic_for_fields(jsonb,jsonb);
drop function vortex_record.conversion_semantic_for_types(text,text);
drop function vortex_record.storage_conversion_contract_identity(uuid,uuid,uuid);

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
    when 'record_type' then
      return array['1.0.0', '2.0.0', '3.0.0'];
    else
      raise exception using errcode = '22023',
        message = 'Accepted contract version kind is unknown';
  end case;
end
$function$;

revoke all on function vortex_definition.accepted_contract_version(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_definition.accepted_contract_version(text)
  to vortex_owner;
comment on function vortex_definition.accepted_contract_version(text) is
  'One accepted definition contract-version set per contract kind. application: vortex_definition.provision_module_installation_storage and vortex_definition.activate/detach_application_installation. module: vortex_record.provision_exact_module_storage. record_type: vortex_access.evaluate_organization_record_access_internal.';

alter function vortex_definition.accepted_contract_version(p_kind text) owner to vortex_owner;

grant execute on function vortex_definition.accepted_contract_version(p_kind text) to postgres;

reset role;
