-- #843: allow Group changes and role assignment revocation/retirement when a
-- role has no remaining permissions.
--
-- Withdrawing an application's permissions, or an upgrade that keeps none of a
-- role's permissions, writes a live role revision with zero permission entries
-- and leaves live assignments in place. Protected Group reduction refused to
-- derive retained authority for such a role ("Organization Group retained
-- authority is stale or unavailable"), assignment revocation recognised only
-- the `unavailable` lifecycle, and role retirement refused every zero-entry role
-- with live assignments. A zero-permission `acceptance_required` role therefore
-- had no escape: revoking the assignment, retiring the role and accepting the
-- revision all failed.
--
-- A zero-permission `unavailable` or `acceptance_required` role now contributes
-- organisation-catalogue authority exactly as assignment revocation already
-- treated an `unavailable` zero-entry role, so a Group holding one can be
-- retired or have a member removed, that role's assignment can be revoked and
-- the role itself can be retired. Retiring such a role keeps its live
-- assignments and zero entries, so a zero-permission `retired` role is treated
-- the same way by Group reduction and assignment revocation; otherwise the
-- retirement would recreate the deadlock it resolves. Custom and `active` roles
-- always have accepted permissions, so a zero-entry `active` role or a missing
-- live revision still fails closed. Delegated-authority rules for roles that
-- still grant permissions are unchanged.
--
-- The three live function bodies are patched in place from their current
-- definitions with an exactly-once guard, so ownership, grants and dependencies
-- are untouched and drift fails the migration instead of silently editing an
-- unexpected body. The function comments are replaced below.
do $migration$
declare
  group_guard_old constant text := $q$  if exists (
    select 1
    from vortex_access.organization_role_assignments as assignment
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    where assignment.organization_id = p_organization_id
      and assignment.assignee_kind = 'group'
      and assignment.group_id = p_group_id
      and assignment.state = 'live'
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
  end if;$q$;
  group_guard_new constant text := $q$  if exists (
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
  end if;$q$;

  assignment_lifecycle_old constant text :=
    $q$  elsif current_role_lifecycle = 'unavailable' then$q$;
  assignment_lifecycle_new constant text :=
    $q$  elsif current_role_lifecycle in ('unavailable', 'acceptance_required', 'retired') then$q$;

  retirement_guard_old constant text := $q$  if affected_permissions is null and exists (
    select 1
    from vortex_access.organization_role_assignments as assignment
    where assignment.organization_id = context_organization_id
      and assignment.role_id = p_role_id
      and assignment.state = 'live'
  ) then
    raise exception using errcode = '40001',
      message = 'Organization role retained authority is stale or unavailable';
  end if;

  authority_requirement := case when affected_permissions is null
    then pg_catalog.jsonb_build_object('kind', 'permission')
    else pg_catalog.jsonb_build_object(
      'kind', 'delegated_management',
      'before', pg_catalog.jsonb_build_object(
        'kind', 'bounded', 'permissions', affected_permissions
      ),
      'after', pg_catalog.jsonb_build_object('kind', 'none')
    )
  end;$q$;
  retirement_guard_new constant text := $q$  if affected_permissions is null
    and revision_fact.lifecycle not in ('unavailable', 'acceptance_required')
    and exists (
      select 1
      from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = context_organization_id
        and assignment.role_id = p_role_id
        and assignment.state = 'live'
  ) then
    raise exception using errcode = '40001',
      message = 'Organization role retained authority is stale or unavailable';
  end if;

  authority_requirement := case
    when affected_permissions is not null
      then pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object(
          'kind', 'bounded', 'permissions', affected_permissions
        ),
        'after', pg_catalog.jsonb_build_object('kind', 'none')
      )
    when revision_fact.lifecycle in ('unavailable', 'acceptance_required')
      and exists (
        select 1
        from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id = context_organization_id
          and assignment.role_id = p_role_id
          and assignment.state = 'live'
      )
      then pg_catalog.jsonb_build_object(
        'kind', 'delegated_management',
        'before', pg_catalog.jsonb_build_object(
          'kind', 'organization_catalogue'
        ),
        'after', pg_catalog.jsonb_build_object('kind', 'none')
      )
    else pg_catalog.jsonb_build_object('kind', 'permission')
  end;$q$;

  definition text;
  patched text;
begin
  definition := pg_catalog.pg_get_functiondef(
    'vortex_access.organization_group_reduction_authority(uuid,uuid)'
      ::pg_catalog.regprocedure);
  if (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, group_guard_old, '')))
      <> pg_catalog.length(group_guard_old) then
    raise exception using errcode = '55000',
      message = 'Group reduction authority patch does not match exactly once';
  end if;
  patched := pg_catalog.replace(definition, group_guard_old, group_guard_new);
  execute patched;

  definition := pg_catalog.pg_get_functiondef(
    'vortex_access.revoke_organization_role_assignment_for_administration(uuid,bigint,uuid)'
      ::pg_catalog.regprocedure);
  if (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, assignment_lifecycle_old, '')))
      <> pg_catalog.length(assignment_lifecycle_old) then
    raise exception using errcode = '55000',
      message = 'Role-assignment revocation patch does not match exactly once';
  end if;
  patched := pg_catalog.replace(
    definition, assignment_lifecycle_old, assignment_lifecycle_new);
  execute patched;

  definition := pg_catalog.pg_get_functiondef(
    'vortex_access.retire_organization_role_for_administration(uuid,bigint,jsonb,uuid)'
      ::pg_catalog.regprocedure);
  if (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, retirement_guard_old, '')))
      <> pg_catalog.length(retirement_guard_old) then
    raise exception using errcode = '55000',
      message = 'Role retirement patch does not match exactly once';
  end if;
  patched := pg_catalog.replace(
    definition, retirement_guard_old, retirement_guard_new);
  execute patched;
end
$migration$;

comment on function
  vortex_access.organization_group_reduction_authority(uuid, uuid) is
  'Private complete retained Group assignment/delegation scope derivation for protected reductions; a zero-permission unavailable, acceptance_required or retired role contributes organisation-catalogue authority.';
comment on function
  vortex_access.revoke_organization_role_assignment_for_administration(uuid, bigint, uuid) is
  'Standalone request entry: performs revoke_role_assignment after fixed protected checks; a current zero-entry unavailable, acceptance_required or retired role uses catalogue delegation, with one atomic completed Activity or one content-free refused Activity row; no SQL function composes this result.';
comment on function
  vortex_access.retire_organization_role_for_administration(uuid, bigint, jsonb, uuid) is
  'Standalone request entry: performs retire_role after fixed protected checks; a zero-entry unavailable or acceptance_required role with live assignments uses catalogue delegation, with one atomic completed Activity or one content-free refused Activity row; no SQL function composes this result.';
