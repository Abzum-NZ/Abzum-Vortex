CREATE FUNCTION vortex_identity.start_disabled_identity_projection_suspended() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_identity.projection:' || new.identity_id::text, 0
    )
  );

  if new.state = 'active' and vortex_identity.identity_is_disabled(new.identity_id) then
    new.state := 'suspended';
  end if;

  return new;
end
$$;

alter function vortex_identity.start_disabled_identity_projection_suspended() owner to vortex_owner;

COMMENT ON FUNCTION vortex_identity.start_disabled_identity_projection_suspended() IS 'Private insert trigger: a new cluster-local projection of a disabled identity starts suspended.';

REVOKE ALL ON FUNCTION vortex_identity.start_disabled_identity_projection_suspended() FROM PUBLIC;

grant execute on function vortex_identity.start_disabled_identity_projection_suspended() to postgres;
