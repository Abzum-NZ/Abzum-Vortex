create or replace function vortex_platform.grid_view_viewer_targets_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_application_root_id uuid
)
returns table (role_ids uuid[], group_ids uuid[])
language sql
stable
security definer
set search_path = ''
as $function$
  with groups as (
    select membership.group_id
    from vortex_access.organization_group_memberships as membership
    join vortex_access.organization_groups as member_group
      on member_group.organization_id = membership.organization_id
      and member_group.group_id = membership.group_id
      and member_group.state = 'active'
    where membership.organization_id = p_organization_id
      and membership.organization_account_id = p_organization_account_id
      and membership.state = 'live'
      and membership.starts_at <= pg_catalog.statement_timestamp()
      and (membership.expires_at is null or membership.expires_at > pg_catalog.statement_timestamp())
  ), roles as (
    select assignment.role_id
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_roles as assigned_role
      on assigned_role.organization_id = assignment.organization_id
      and assigned_role.role_id = assignment.role_id
    where assignment.organization_id = p_organization_id
      and assignment.state = 'live'
      and assignment.assignment_kind = 'standing'
      and assignment.starts_at <= pg_catalog.statement_timestamp()
      and (assignment.expires_at is null or assignment.expires_at > pg_catalog.statement_timestamp())
      and (assigned_role.application_root_id is null
        or assigned_role.application_root_id = p_application_root_id)
      and ((assignment.assignee_kind = 'organization_account'
          and assignment.organization_account_id = p_organization_account_id)
        or (assignment.assignee_kind = 'group'
          and assignment.group_id in (select member.group_id from groups as member)))
  )
  select
    coalesce((select pg_catalog.array_agg(distinct held.role_id) from roles as held), '{}'::uuid[]),
    coalesce((select pg_catalog.array_agg(member.group_id) from groups as member), '{}'::uuid[])
$function$;

revoke all on function vortex_platform.grid_view_viewer_targets_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_platform.grid_view_viewer_targets_internal(uuid, uuid, uuid) is
  'The roles of the application and the groups the account holds now, which decide the shared grid views it sees; owner-only.';

alter function vortex_platform.grid_view_viewer_targets_internal(uuid, uuid, uuid)
  owner to vortex_owner;
