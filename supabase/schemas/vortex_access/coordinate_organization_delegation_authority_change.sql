CREATE FUNCTION vortex_access.coordinate_organization_delegation_authority_change(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) RETURNS TABLE(outcome text, operation text, delegation jsonb, access_version bigint, correlation_id uuid)
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
declare
  changed record;
begin
  select result.* into strict changed
  from vortex_access.coordinate_delegation_change_without_stewardship_v1_internal(
      p_operation, p_organization_id, p_delegation_authority_id,
      p_expected_delegation_revision, p_holder_kind,
      p_organization_account_id, p_group_id, p_scope_kind,
      p_bounded_permissions, p_starts_at,
      p_expires_at, p_changed_by, p_correlation_id
    ) as result;

  perform vortex_access.assert_organization_has_permanent_steward(
    (changed.delegation ->> 'organizationId')::uuid
  );

  return query select changed.outcome, changed.operation,
    changed.delegation, changed.access_version, changed.correlation_id;
end
$$;

alter function vortex_access.coordinate_organization_delegation_authority_change(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.coordinate_organization_delegation_authority_change(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) FROM PUBLIC;

grant execute on function vortex_access.coordinate_organization_delegation_authority_change(p_operation text, p_organization_id uuid, p_delegation_authority_id uuid, p_expected_delegation_revision bigint, p_holder_kind text, p_organization_account_id uuid, p_group_id uuid, p_scope_kind text, p_bounded_permissions jsonb, p_starts_at timestamp with time zone, p_expires_at timestamp with time zone, p_changed_by uuid, p_correlation_id uuid) to postgres;
