CREATE FUNCTION vortex_access.record_share_grantor_authority_until_internal(p_declaration jsonb, p_record_id uuid, p_facts jsonb, p_context jsonb) RETURNS timestamp with time zone
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  horizon constant timestamptz := '9999-01-01T00:00:00Z';
  horizon_context jsonb := p_context
    || pg_catalog.jsonb_build_object('expiresAt', '9999-01-01T00:00:00.000000Z');
  checked_at timestamptz := pg_catalog.clock_timestamp();
  eligibility jsonb;
  auth_deadline timestamptz;
  earliest timestamptz;
begin
  eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
    p_declaration, horizon_context, checked_at
  );
  if eligibility ->> 'outcome' is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant authority is unavailable';
  end if;
  auth_deadline := vortex_access.recent_authentication_deadline_internal(
    horizon_context, checked_at, p_declaration -> 'recentAuthentication'
  );
  select pg_catalog.min((contribution.value ->> 'validUntil')::timestamptz)
  into earliest
  from pg_catalog.jsonb_array_elements(eligibility -> 'eligiblePermissions')
    as alt(value)
  cross join lateral pg_catalog.jsonb_array_elements(
    vortex_access.evaluate_record_permission_row_scope_internal(
      horizon_context,
      checked_at,
      auth_deadline,
      (p_declaration -> 'target' ->> 'applicationRootId')::uuid,
      p_declaration -> 'action',
      alt.value,
      p_record_id,
      p_facts,
      array[(alt.value -> 'permission' ->> 'permissionId')::uuid]
    )
  ) as contribution(value);
  if earliest is null then
    raise exception using errcode = '42501',
      message = 'Protected record-share grant authority is unavailable';
  end if;
  if earliest >= horizon then
    return null;
  end if;
  return earliest;
end
$$;

ALTER FUNCTION vortex_access.record_share_grantor_authority_until_internal(p_declaration jsonb, p_record_id uuid, p_facts jsonb, p_context jsonb) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.record_share_grantor_authority_until_internal(p_declaration jsonb, p_record_id uuid, p_facts jsonb, p_context jsonb) IS 'Private: when an already-admitted grantor''s exact-record authority for the declaration ends, excluding the request context''s own expiry; null when it does not expire. Never admits.';

REVOKE ALL ON FUNCTION vortex_access.record_share_grantor_authority_until_internal(p_declaration jsonb, p_record_id uuid, p_facts jsonb, p_context jsonb) FROM PUBLIC;
