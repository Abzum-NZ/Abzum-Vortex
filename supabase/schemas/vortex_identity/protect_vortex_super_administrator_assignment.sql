create or replace function vortex_identity.protect_vortex_super_administrator_assignment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Vortex super-administrator assignment evidence is permanent';
  end if;

  if new.assignment_id is distinct from old.assignment_id
    or new.identity_id is distinct from old.identity_id
    or new.granted_at is distinct from old.granted_at
    or new.granted_by_kind is distinct from old.granted_by_kind
    or new.granted_by_id is distinct from old.granted_by_id
    or new.grant_correlation_id is distinct from old.grant_correlation_id then
    raise exception using errcode = '23514',
      message = 'Vortex super-administrator assignment grant evidence is immutable';
  end if;

  if old.revoked_at is not null
    or new.revoked_at is null
    or new.revision <> old.revision + 1
    or new.revision > 9007199254740991
    or new.changed_at < old.changed_at
    or new.revoked_at < old.granted_at
    or new.changed_by_kind <> 'identity'
    or new.changed_by_id is distinct from new.revoked_by_id
    or new.change_correlation_id is distinct from new.revocation_correlation_id
    or new.revoked_by_id is null
    or new.revocation_correlation_id is null then
    raise exception using errcode = '23514',
      message = 'Vortex super-administrator assignment transition is invalid';
  end if;

  return new;
end
$function$;

revoke all on function vortex_identity.protect_vortex_super_administrator_assignment()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.protect_vortex_super_administrator_assignment() is
  'Keeps super-administrator grants immutable and permits only one attributed, revisioned revocation.';
