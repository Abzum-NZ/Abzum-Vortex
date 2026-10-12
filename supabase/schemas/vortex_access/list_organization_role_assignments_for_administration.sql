CREATE FUNCTION vortex_access.list_organization_role_assignments_for_administration(p_after_role_assignment_id uuid, p_page_size integer) RETURNS TABLE(organization_id uuid, assignments jsonb, next_after_role_assignment_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  checked_at timestamptz;
  assignment_items jsonb;
  page_assignment_ids uuid[];
  candidate_count integer;
begin
  if p_page_size is null or p_page_size not between 1 and 100
    or p_after_role_assignment_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization role assignment page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_assignment_ledger_administration_scope()
    as authorized;
  checked_at := pg_catalog.clock_timestamp();

  with candidates as (
    select assignment.role_assignment_id, assignment.assignment_kind,
      assignment.revision, assignment.starts_at, assignment.expires_at,
      assignment.state, role.role_id, revision.role_key, revision.label,
      revision.lifecycle, assignment.assignee_kind,
      assignment.organization_account_id, account.display_name,
      assignment.group_id, organization_group.group_key,
      organization_group.label as group_label,
      organization_group.state as group_state,
      case
        when assignment.state = 'revoked' then 'revoked'
        when assignment.starts_at > checked_at then 'scheduled'
        when assignment.expires_at is not null
          and assignment.expires_at <= checked_at then 'expired'
        else 'active'
      end as temporal_state,
      pg_catalog.row_number() over (
        order by assignment.role_assignment_id
      ) as ordinal
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
      and (
        p_after_role_assignment_id is null
        or assignment.role_assignment_id > p_after_role_assignment_id
      )
    order by assignment.role_assignment_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'roleAssignmentId', candidate.role_assignment_id,
          'role', pg_catalog.jsonb_build_object(
            'roleId', candidate.role_id,
            'key', candidate.role_key,
            'label', candidate.label,
            'lifecycle', candidate.lifecycle
          ),
          'assignee', case candidate.assignee_kind
            when 'organization_account' then pg_catalog.jsonb_build_object(
              'kind', 'organization_account',
              'organizationAccountId', candidate.organization_account_id,
              'displayName', candidate.display_name
            )
            else pg_catalog.jsonb_build_object(
              'kind', 'group',
              'groupId', candidate.group_id,
              'key', candidate.group_key,
              'label', candidate.group_label,
              'state', candidate.group_state
            )
          end,
          'assignmentKind', candidate.assignment_kind,
          'revision', candidate.revision,
          'startsAt', candidate.starts_at,
          'expiresAt', candidate.expires_at,
          'state', candidate.state,
          'temporalState', candidate.temporal_state
        )) order by candidate.role_assignment_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.role_assignment_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into assignment_items, page_assignment_ids, candidate_count
  from candidates as candidate;

  return query select scope.organization_id, assignment_items,
    case when candidate_count > p_page_size
      then page_assignment_ids[p_page_size] else null end,
    scope.access_version;
end
$$;


ALTER FUNCTION vortex_access.list_organization_role_assignments_for_administration(p_after_role_assignment_id uuid, p_page_size integer) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.list_organization_role_assignments_for_administration(p_after_role_assignment_id uuid, p_page_size integer) IS 'Returns one bounded role-assignment page with descriptive window state, not effective permission.';

REVOKE ALL ON FUNCTION vortex_access.list_organization_role_assignments_for_administration(p_after_role_assignment_id uuid, p_page_size integer) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.list_organization_role_assignments_for_administration(p_after_role_assignment_id uuid, p_page_size integer) TO vortex_request;
