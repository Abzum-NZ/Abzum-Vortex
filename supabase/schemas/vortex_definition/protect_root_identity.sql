create or replace function vortex_definition.protect_root_identity() returns trigger
    language plpgsql
    set search_path to ''
    as $$
begin
  if new.root_id is distinct from old.root_id
    or new.organization_id is distinct from old.organization_id
    or new.kind is distinct from old.kind
    or new.key is distinct from old.key
    or new.owner_application_root_id is distinct from old.owner_application_root_id
    or new.created_at is distinct from old.created_at
    or new.created_by is distinct from old.created_by then
    raise exception using
      errcode = '23514',
      message = 'Definition root identity, ownership, kind, key, owning Application and creation evidence are permanent';
  end if;

  return new;
end
$$;

alter function vortex_definition.protect_root_identity() owner to vortex_owner;

revoke all on function vortex_definition.protect_root_identity() from public;

grant execute on function vortex_definition.protect_root_identity() to postgres;
