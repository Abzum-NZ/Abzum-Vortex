create or replace function vortex_identity.tenant_structural_capability_set_is_canonical(
  p_capability_keys text[]
)
returns boolean
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = ''
as $function$
declare
  capability_key text;
  previous_key text;
begin
  if pg_catalog.array_ndims(p_capability_keys) <> 1
    or pg_catalog.array_lower(p_capability_keys, 1) <> 1
    or pg_catalog.cardinality(p_capability_keys) not between 1 and 9 then
    return false;
  end if;

  foreach capability_key in array p_capability_keys loop
    if capability_key is null
      or capability_key not in (
        'platform.tenant.administrators.manage',
        'platform.tenant.administrators.read',
        'platform.tenant.capability_limits.allocate',
        'platform.tenant.capability_limits.read',
        'platform.tenant.hierarchy.read',
        'platform.tenant.organizations.create',
        'platform.tenant.organizations.lifecycle',
        'platform.tenant.organizations.rename',
        'platform.tenant.organizations.reparent'
      )
      or (previous_key is not null and previous_key >= capability_key) then
      return false;
    end if;
    previous_key := capability_key;
  end loop;

  return true;
end
$function$;

revoke all on function vortex_identity.tenant_structural_capability_set_is_canonical(text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.tenant_structural_capability_set_is_canonical(text[]) is
  'Validates a canonical nonempty set of tenant capability permissions against the single closed permission set.';
