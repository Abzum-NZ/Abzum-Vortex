CREATE FUNCTION vortex_access.protect_application_role_template_continuity() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Application role template continuity cannot be deleted';
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.application_root_id is distinct from old.application_root_id
    or new.source_role_id is distinct from old.source_role_id
    or old.last_processed_registration_revision = 9007199254740991
    or new.last_processed_registration_revision <= old.last_processed_registration_revision
    or new.continuity_revision not in (
      old.continuity_revision,
      old.continuity_revision + 1
    )
    or (
      new.continuity_revision = old.continuity_revision
      and new.state is distinct from old.state
    )
    or (
      new.continuity_revision = old.continuity_revision + 1
      and new.state is not distinct from old.state
    ) then
    raise exception using errcode = '23514',
      message = 'Application role template continuity transition is invalid';
  end if;

  return new;
end;
$$;

ALTER FUNCTION vortex_access.protect_application_role_template_continuity() OWNER TO postgres;

REVOKE ALL ON FUNCTION vortex_access.protect_application_role_template_continuity() FROM PUBLIC;
