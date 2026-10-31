create or replace function vortex_identity.protect_identity_projection()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.identity_id is distinct from old.identity_id
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '23514', message = 'Identity projection identity is permanent';
  end if;

  if old.state = 'closed' and new.state <> 'closed' then
    raise exception using errcode = '23514', message = 'A closed identity projection cannot be reactivated';
  end if;

  if new.revision <> old.revision + 1
    or new.revision > 9007199254740991
    or new.state_changed_at < old.state_changed_at then
    raise exception using errcode = '40001', message = 'Identity projection revision is stale or invalid';
  end if;

  return new;
end
$function$;

alter function vortex_identity.protect_identity_projection() owner to vortex_owner;

revoke all on function vortex_identity.protect_identity_projection() from public;

grant execute on function vortex_identity.protect_identity_projection() to postgres;
