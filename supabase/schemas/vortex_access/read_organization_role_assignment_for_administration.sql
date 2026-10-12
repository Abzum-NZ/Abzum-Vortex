CREATE FUNCTION vortex_access.read_organization_role_assignment_for_administration(p_role_assignment_id uuid) RETURNS TABLE(organization_id uuid, outcome text, assignment_summary jsonb, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  checked_at timestamptz;
  assignment_value jsonb;
begin
  if p_role_assignment_id is null
    or p_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role assignment detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_assignment_ledger_administration_scope()
    as authorized;
  checked_at := pg_catalog.clock_timestamp();

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'roleAssignmentId', assignment.role_assignment_id,
    'role', pg_catalog.jsonb_build_object(
      'roleId', role.role_id,
      'key', revision.role_key,
      'label', revision.label,
      'lifecycle', revision.lifecycle
    ),
    'assignee', case assignment.assignee_kind
      when 'organization_account' then pg_catalog.jsonb_build_object(
        'kind', 'organization_account',
        'organizationAccountId', assignment.organization_account_id,
        'displayName', account.display_name
      )
      else pg_catalog.jsonb_build_object(
        'kind', 'group',
        'groupId', assignment.group_id,
        'key', organization_group.group_key,
        'label', organization_group.label,
        'state', organization_group.state
      )
    end,
    'assignmentKind', assignment.assignment_kind,
    'revision', assignment.revision,
    'startsAt', assignment.starts_at,
    'expiresAt', assignment.expires_at,
    'state', assignment.state,
    'temporalState', case
      when assignment.state = 'revoked' then 'revoked'
      when assignment.starts_at > checked_at then 'scheduled'
      when assignment.expires_at is not null
        and assignment.expires_at <= checked_at then 'expired'
      else 'active'
    end
  ))
  into assignment_value
  from vortex_access.organization_role_assignments as assignment
  join vortex_access.organization_roles as role
    on role.organization_id = assignment.organization_id
    and role.role_id = assignment.role_id
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  left join vortex_identity.organization_accounts as account
    on assignment.assignee_kind = 'organization_account'
    and account.organization_id = assignment.organization_id
    and account.organization_account_id = assignment.organization_account_id
  left join vortex_access.organization_groups as organization_group
    on assignment.assignee_kind = 'group'
    and organization_group.organization_id = assignment.organization_id
    and organization_group.group_id = assignment.group_id
  where assignment.organization_id = scope.organization_id
    and assignment.role_assignment_id = p_role_assignment_id;

  return query select scope.organization_id,
    case when assignment_value is null then 'unavailable' else 'available' end,
    assignment_value, scope.access_version;
end
$$;


ALTER FUNCTION vortex_access.read_organization_role_assignment_for_administration(p_role_assignment_id uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.read_organization_role_assignment_for_administration(p_role_assignment_id uuid) IS 'Returns one safe exact role-assignment detail without grant audit or effective-access evidence.';

REVOKE ALL ON FUNCTION vortex_access.read_organization_role_assignment_for_administration(p_role_assignment_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.read_organization_role_assignment_for_administration(p_role_assignment_id uuid) TO vortex_request;
