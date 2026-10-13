CREATE FUNCTION vortex_access.assert_organization_has_permanent_steward(p_organization_id uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  checked_at timestamptz;
begin
  if not exists (
    select 1
    from vortex_access.organization_stewardship_requirements as requirement
    where requirement.organization_id = p_organization_id
  ) then
    return;
  end if;

  checked_at := pg_catalog.clock_timestamp();
  if not vortex_access.organization_has_permanent_steward(
    p_organization_id, checked_at
  ) then
    raise exception using errcode = '23514',
      message = 'An adopted organization requires a permanent steward';
  end if;
end
$$;

ALTER FUNCTION vortex_access.assert_organization_has_permanent_steward(p_organization_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.assert_organization_has_permanent_steward(p_organization_id uuid) IS 'Refuses a completed owner mutation that would leave an adopted organisation without a qualifying permanent steward.';

REVOKE ALL ON FUNCTION vortex_access.assert_organization_has_permanent_steward(p_organization_id uuid) FROM PUBLIC;
