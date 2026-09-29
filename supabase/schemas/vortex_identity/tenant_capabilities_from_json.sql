create or replace function vortex_identity.tenant_capabilities_from_json(p_capabilities jsonb)
returns text[] language plpgsql immutable strict parallel safe security definer set search_path = ''
as $function$
declare result text[];
begin
  if pg_catalog.jsonb_typeof(p_capabilities) <> 'array' then return null; end if;
  select pg_catalog.array_agg(item.value order by item.ordinality) into result
  from pg_catalog.jsonb_array_elements_text(p_capabilities) with ordinality item(value, ordinality);
  if result is null or not vortex_identity.tenant_structural_capability_set_is_canonical(result) then return null; end if;
  return result;
exception when others then return null;
end
$function$;

revoke execute on function vortex_identity.tenant_capabilities_from_json(jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.tenant_capabilities_from_json(jsonb) is null;

alter function vortex_identity.tenant_capabilities_from_json(jsonb) owner to postgres;
