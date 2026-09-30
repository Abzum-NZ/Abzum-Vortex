create or replace function vortex_access.protect_platform_permission_declarations()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    if old.steward_minimum then
      raise exception using errcode = '23514',
        message = 'Guarded platform permission declarations cannot be deleted';
    end if;
    return old;
  end if;

  if row(new.permission_id, new.permission_key)
    is distinct from row(old.permission_id, old.permission_key) then
    raise exception using errcode = '23514',
      message = 'Platform permission declaration identity is immutable';
  end if;

  if new.first_revision is distinct from old.first_revision then
    raise exception using errcode = '23514',
      message = 'Platform permission declaration first revision is immutable';
  end if;

  if old.steward_minimum then
    if not new.steward_minimum then
      raise exception using errcode = '23514',
        message = 'Guarded platform permission minimum cannot be cleared';
    end if;
    if row(
      new.owner_kind,
      new.owner_id,
      new.action_kind,
      new.label,
      new.description,
      new.meaning_fingerprint,
      new.source_module_key,
      new.steward_minimum,
      new.first_revision
    ) is distinct from row(
      old.owner_kind,
      old.owner_id,
      old.action_kind,
      old.label,
      old.description,
      old.meaning_fingerprint,
      old.source_module_key,
      old.steward_minimum,
      old.first_revision
    ) then
      raise exception using errcode = '23514',
        message = 'Guarded platform permission declarations are immutable';
    end if;
  end if;

  return new;
end
$function$;

revoke all on function
  vortex_access.protect_platform_permission_declarations()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.protect_platform_permission_declarations() is
  'Rejects removal or silent substitution of a guarded platform permission declaration.';

alter function vortex_access.protect_platform_permission_declarations()
  owner to vortex_access_owner;
