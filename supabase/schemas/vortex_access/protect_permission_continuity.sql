CREATE OR REPLACE FUNCTION vortex_access.protect_permission_continuity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
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
    or new.last_processed_registration_revision <= old.last_processed_registration_revision
    -- The continuity revision is an availability lineage: it advances exactly when the
    -- permission is withdrawn or registered again. Its meaning may change only while it stays
    -- registered, within the lineage.
    or new.continuity_revision not in (
      old.continuity_revision,
      old.continuity_revision + 1
    )
    or (new.continuity_revision = old.continuity_revision + 1) = (new.state is not distinct from old.state)
    or (
      new.meaning_fingerprint is distinct from old.meaning_fingerprint
      and new.state is distinct from 'available'
    ) then
    raise exception using errcode = '23514',
      message = 'Permission continuity transition is invalid';
  end if;

  return new;
end;
$$;

alter function vortex_access.protect_permission_continuity() owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.protect_permission_continuity() FROM PUBLIC;

grant execute on function vortex_access.protect_permission_continuity() to postgres;
