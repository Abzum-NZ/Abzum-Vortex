CREATE FUNCTION vortex_access.expire_stale_capability_reservations(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text) RETURNS TABLE(result jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  protected_context record;
  affected_count integer;
begin
  if not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit) then
    raise exception using errcode = '22023', message = 'Capability expiry scope is invalid';
  end if;
  select context.* into strict protected_context
  from vortex_access.capability_reservation_request_context(
    p_tenant_id, p_organization_id
  ) as context;
  update vortex_access.capability_reservations as reservation
  set state = 'expired', expired_at = evaluated_at, updated_at = evaluated_at
  where reservation.tenant_id = p_tenant_id
    and reservation.request_organization_id
      is not distinct from protected_context.request_organization_id
    and reservation.capability_key = p_capability_key and reservation.unit = p_unit
    and reservation.state = 'active' and reservation.expires_at <= evaluated_at;
  get diagnostics affected_count = row_count;
  return query select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'tenantId', p_tenant_id,
    'organizationId', protected_context.request_organization_id,
    'capabilityKey', p_capability_key, 'unit', p_unit,
    'expiredCount', affected_count,
    'expiredAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'correlationId', protected_context.correlation_id
  ));
end
$$;

ALTER FUNCTION vortex_access.expire_stale_capability_reservations(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.expire_stale_capability_reservations(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text) IS 'Expires only the established request-scope capability reservations past their server deadline.';

REVOKE ALL ON FUNCTION vortex_access.expire_stale_capability_reservations(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.expire_stale_capability_reservations(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text) TO vortex_request;
