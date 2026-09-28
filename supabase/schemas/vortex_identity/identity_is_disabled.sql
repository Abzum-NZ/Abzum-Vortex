create or replace function vortex_identity.identity_is_disabled(p_identity_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from vortex_identity.identity_disablement_commands as command
    where command.subject_identity_id = p_identity_id
      and command.outcome = 'disabled'
  )
$function$;

revoke all on function vortex_identity.identity_is_disabled(uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.identity_is_disabled(uuid) is
  'Private environment-wide disabled fact: true only after a completed identity disablement.';

alter function vortex_identity.identity_is_disabled(uuid) owner to vortex_identity_owner;
grant execute on function vortex_identity.identity_is_disabled(uuid) to postgres;
