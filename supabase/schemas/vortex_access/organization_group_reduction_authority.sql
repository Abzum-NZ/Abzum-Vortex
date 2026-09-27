create or replace function vortex_access.organization_group_reduction_authority(
  p_organization_id uuid,
  p_group_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  affected_permissions jsonb;
begin
  -- The protected caller already holds the organization Access-version update
  -- lock used by every supported assignment, delegation and role writer. That
  -- makes this complete retained-fact read stable without another lock order.
  if exists (
    select 1
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    left join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id
      and role_revision.revision = role.live_revision
    where assignment.organization_id = p_organization_id
      and assignment.assignee_kind = 'group'
      and assignment.group_id = p_group_id
      and assignment.state = 'live'
      and (role_revision.lifecycle is null
        or role_revision.lifecycle not in ('unavailable', 'acceptance_required', 'retired'))
      and not exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = role.organization_id
          and permission.role_id = role.role_id
          and permission.role_revision = role.live_revision
      )
  ) then
    raise exception using errcode = '40001',
      message = 'Organization Group retained authority is stale or unavailable';
  end if;

  if exists (
    select 1
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as role_revision
      on role_revision.organization_id = role.organization_id
      and role_revision.role_id = role.role_id
      and role_revision.revision = role.live_revision
    where assignment.organization_id = p_organization_id
      and assignment.assignee_kind = 'group'
      and assignment.group_id = p_group_id
      and assignment.state = 'live'
      and role_revision.lifecycle in ('unavailable', 'acceptance_required', 'retired')
      and not exists (
        select 1
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = role.organization_id
          and permission.role_id = role.role_id
          and permission.role_revision = role.live_revision
      )
  ) then
    return pg_catalog.jsonb_build_object('kind', 'organization_catalogue');
  end if;

  if exists (
    select 1
    from vortex_access.organization_delegation_authorities as delegation
    where delegation.organization_id = p_organization_id
      and delegation.holder_kind = 'group'
      and delegation.group_id = p_group_id
      and delegation.state = 'live'
      and delegation.scope_kind = 'organization_catalogue'
  ) then
    return pg_catalog.jsonb_build_object('kind', 'organization_catalogue');
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'applicationRootId', reference.application_root_id,
      'ownerKind', reference.owner_kind,
      'ownerId', reference.owner_id,
      'permissionId', reference.permission_id
    )) order by reference.application_root_id nulls first,
      reference.owner_kind collate "C", reference.owner_id,
      reference.permission_id
  )
  into affected_permissions
  from (
    select permission.application_root_id, permission.owner_kind,
      permission.owner_id, permission.permission_id
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = role.organization_id
      and permission.role_id = role.role_id
      and permission.role_revision = role.live_revision
    where assignment.organization_id = p_organization_id
      and assignment.assignee_kind = 'group'
      and assignment.group_id = p_group_id
      and assignment.state = 'live'
    union
    select case when permission.value ? 'applicationRootId'
        then (permission.value ->> 'applicationRootId')::uuid else null end,
      permission.value ->> 'ownerKind',
      (permission.value ->> 'ownerId')::uuid,
      (permission.value ->> 'permissionId')::uuid
    from vortex_access.organization_delegation_authorities as delegation
    cross join lateral pg_catalog.jsonb_array_elements(
      delegation.bounded_permissions
    ) as permission(value)
    where delegation.organization_id = p_organization_id
      and delegation.holder_kind = 'group'
      and delegation.group_id = p_group_id
      and delegation.state = 'live'
      and delegation.scope_kind = 'bounded'
  ) as reference;

  if affected_permissions is null then
    return pg_catalog.jsonb_build_object('kind', 'none');
  end if;
  return pg_catalog.jsonb_build_object(
    'kind', 'bounded', 'permissions', affected_permissions
  );
end
$function$;

comment on function
  vortex_access.organization_group_reduction_authority(uuid, uuid) is
  'Private complete retained Group assignment/delegation scope derivation for protected reductions; a zero-permission unavailable, acceptance_required or retired role contributes organisation-catalogue authority.';

revoke execute on function
  vortex_access.organization_group_reduction_authority(uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
