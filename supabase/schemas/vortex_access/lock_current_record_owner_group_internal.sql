CREATE FUNCTION vortex_access.lock_current_record_owner_group_internal(p_group_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  context_value jsonb;
  matched boolean;
begin
  if p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;
  context_value := vortex_access.validated_human_request_context();
  select true into matched
  from vortex_access.organization_groups as organization_group
  join vortex_access.organization_group_memberships as membership
    on membership.organization_id = organization_group.organization_id
    and membership.group_id = organization_group.group_id
  where organization_group.organization_id = (context_value ->> 'organizationId')::uuid
    and organization_group.group_id = p_group_id
    and organization_group.state = 'active'
    and membership.organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and membership.state = 'live'
    and membership.starts_at <= pg_catalog.statement_timestamp()
    and (membership.expires_at is null
      or membership.expires_at > pg_catalog.statement_timestamp())
  for share of organization_group, membership;
  return coalesce(matched, false);
end
$$;


ALTER FUNCTION vortex_access.lock_current_record_owner_group_internal(p_group_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.lock_current_record_owner_group_internal(p_group_id uuid) IS 'Private current Group-membership check used only by the Record create primitive; locks the exact active Group and live membership for the transaction.';

REVOKE ALL ON FUNCTION vortex_access.lock_current_record_owner_group_internal(p_group_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.lock_current_record_owner_group_internal(p_group_id uuid) TO vortex_record_adapter;
