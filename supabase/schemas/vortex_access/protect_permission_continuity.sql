CREATE OR REPLACE FUNCTION vortex_access.protect_permission_continuity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  meaning_changed boolean := false;
  must_advance boolean;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514', message = 'Permission continuity cannot be deleted';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.application_root_id is distinct from old.application_root_id
    or new.owner_kind is distinct from old.owner_kind
    or new.owner_id is distinct from old.owner_id
    or new.permission_id is distinct from old.permission_id
    or new.registration_kind is distinct from old.registration_kind
    or new.registration_owner_id is distinct from old.registration_owner_id
    or old.last_processed_registration_revision = 9007199254740991
    or new.last_processed_registration_revision <= old.last_processed_registration_revision then
    raise exception using errcode = '23514', message = 'Permission continuity transition is invalid';
  end if;

  if old.state = 'available' and new.state = 'available' then
    select not vortex_access.permission_meaning_is_same_internal(previous, current_entry)
    into meaning_changed
    from vortex_access.permission_catalogue_entries as previous
    join vortex_access.permission_catalogue_entries as current_entry
      on current_entry.organization_id = previous.organization_id
      and current_entry.registration_kind = previous.registration_kind
      and current_entry.registration_owner_id = previous.registration_owner_id
      and current_entry.application_root_id is not distinct from previous.application_root_id
      and current_entry.owner_kind = previous.owner_kind
      and current_entry.owner_id = previous.owner_id
      and current_entry.permission_id = previous.permission_id
      and current_entry.registration_revision = new.last_processed_registration_revision
    where previous.organization_id = old.organization_id
      and previous.registration_kind = old.registration_kind
      and previous.registration_owner_id = old.registration_owner_id
      and previous.registration_revision = old.last_processed_registration_revision
      and previous.application_root_id is not distinct from old.application_root_id
      and previous.owner_kind = old.owner_kind and previous.owner_id = old.owner_id
      and previous.permission_id = old.permission_id;
    if not found then
      raise exception using errcode = '23514', message = 'Permission continuity meaning is unavailable';
    end if;
  end if;

  must_advance := old.state is distinct from new.state or meaning_changed;
  if (must_advance and (old.continuity_revision = 9007199254740991
      or new.continuity_revision <> old.continuity_revision + 1))
    or (not must_advance and new.continuity_revision <> old.continuity_revision) then
    raise exception using errcode = '23514', message = 'Permission continuity transition is invalid';
  end if;
  return new;
end;
$$;

alter function vortex_access.protect_permission_continuity() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.protect_permission_continuity() FROM PUBLIC;

grant execute on function vortex_access.protect_permission_continuity() to postgres;
