create or replace function vortex_identity.protect_super_administrator_account_provenance()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.provisioning_kind is distinct from old.provisioning_kind
    or new.provisioning_assignment_id is distinct from old.provisioning_assignment_id
    or new.provisioned_by_identity_id is distinct from old.provisioned_by_identity_id then
    raise exception using errcode = '23514',
      message = 'Super-administrator account provenance is immutable';
  end if;
  return new;
end
$function$;

revoke all on function vortex_identity.protect_super_administrator_account_provenance()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.protect_super_administrator_account_provenance() is
  'Keeps the assignment evidence for super-administrator-provisioned accounts immutable.';
