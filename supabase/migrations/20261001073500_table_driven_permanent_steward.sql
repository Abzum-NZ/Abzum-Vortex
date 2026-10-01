begin;

set local role vortex_access_owner;

create or replace function vortex_access.read_guarded_platform_permission_minimum_internal()
returns table (
  permission_id uuid,
  meaning_fingerprint text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select declaration.permission_id, declaration.meaning_fingerprint
  from vortex_access.platform_permission_declarations as declaration
  where declaration.owner_kind = 'platform'
    and declaration.owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
    and declaration.steward_minimum
  order by declaration.permission_id
$function$;

revoke all on function vortex_access.read_guarded_platform_permission_minimum_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_access.read_guarded_platform_permission_minimum_internal()
  to postgres;
comment on function vortex_access.read_guarded_platform_permission_minimum_internal() is
  'Returns the complete guarded platform permanent-steward permission identity and meaning set only to the authorized postgres caller.';
alter function vortex_access.read_guarded_platform_permission_minimum_internal()
  owner to vortex_access_owner;

reset role;

create or replace function vortex_access.organization_has_permanent_steward(
  p_organization_id uuid,
  p_checked_at timestamptz
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $function$
  with stewardship_requirement as (
    select 1
    from vortex_access.organization_stewardship_requirements as requirement
    where requirement.organization_id = p_organization_id
  ), current_platform_registration as (
    select registration.revision, registration.registration_owner_id
    from vortex_access.permission_registrations as registration
    where registration.organization_id = p_organization_id
      and registration.registration_kind = 'platform'
      and registration.registration_owner_id =
        'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
      and registration.state = 'active'
      and vortex_access.platform_permission_catalogue_revision_is_exact(
        p_organization_id, registration.revision
      )
  ), required_declaration as materialized (
    select declaration.permission_id, declaration.meaning_fingerprint
    from vortex_access.read_guarded_platform_permission_minimum_internal() as declaration
  ), required_platform_permission as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry.meaning_fingerprint,
      registration.revision as registration_revision
    from current_platform_registration as registration
    join vortex_access.permission_catalogue_entries as entry
      on entry.organization_id = p_organization_id
      and entry.registration_kind = 'platform'
      and entry.registration_owner_id = registration.registration_owner_id
      and entry.registration_revision = registration.revision
    join required_declaration as required
      on required.permission_id = entry.permission_id
      and required.meaning_fingerprint = entry.meaning_fingerprint
    where entry.application_root_id is null
      and entry.owner_kind = 'platform'
      and entry.owner_id = 'cabe121e-0baf-4084-9471-cce915d460a8'::uuid
  ), candidate_steward as (
    select account.organization_account_id
    from vortex_identity.organization_accounts as account
    join vortex_identity.identity_projections as identity
      on identity.identity_id = account.identity_id
      and identity.state = 'active'
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = account.organization_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = account.organization_account_id
      and assignment.group_id is null
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= p_checked_at
      and assignment.expires_at is null
    join vortex_access.organization_roles as role
      on role.organization_id = assignment.organization_id
      and role.role_id = assignment.role_id
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
      and revision.lifecycle = 'active'
      and revision.assignment_policy = 'standing'
    join vortex_access.organization_delegation_authorities as delegation
      on delegation.organization_id = account.organization_id
      and delegation.holder_kind = 'organization_account'
      and delegation.organization_account_id = account.organization_account_id
      and delegation.group_id is null
      and delegation.scope_kind = 'organization_catalogue'
      and delegation.state = 'live'
      and delegation.starts_at <= p_checked_at
      and delegation.expires_at is null
    where account.organization_id = p_organization_id
      and account.state = 'active'
      and not exists (
        select 1
        from required_platform_permission as required
        where not exists (
          select 1
          from vortex_access.organization_role_permission_entries as permission
          join vortex_access.permission_continuities as continuity
            on continuity.organization_id = permission.organization_id
            and continuity.application_root_id is not distinct from permission.application_root_id
            and continuity.owner_kind = permission.owner_kind
            and continuity.owner_id = permission.owner_id
            and continuity.permission_id = permission.permission_id
            and continuity.state = 'available'
            and continuity.continuity_revision = permission.continuity_revision
            and continuity.meaning_fingerprint = permission.meaning_fingerprint
            and continuity.last_processed_registration_revision =
              required.registration_revision
          where permission.organization_id = role.organization_id
            and permission.role_id = role.role_id
            and permission.role_revision = role.live_revision
            and permission.application_root_id is not distinct from required.application_root_id
            and permission.owner_kind = required.owner_kind
            and permission.owner_id = required.owner_id
            and permission.permission_id = required.permission_id
            and permission.meaning_fingerprint = required.meaning_fingerprint
        )
      )
  )
  select (select pg_catalog.count(*) from required_declaration) > 0
    and (
      select pg_catalog.count(*)
      from (
        select distinct declaration.permission_id
        from required_declaration as declaration
      ) as distinct_declaration
    ) = (select pg_catalog.count(*) from required_declaration)
    and (
      select pg_catalog.count(*)
      from (
        select distinct required.permission_id
        from required_platform_permission as required
      ) as matched_declaration
    ) = (select pg_catalog.count(*) from required_declaration)
    and (select pg_catalog.count(*) from required_platform_permission)
      = (select pg_catalog.count(*) from required_declaration)
    and exists (
      select 1
      from candidate_steward as steward
      cross join stewardship_requirement as requirement
    )
$function$;

revoke execute on function vortex_access.organization_has_permanent_steward(uuid, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_access.organization_has_permanent_steward(uuid, timestamptz) is
  'Checks the direct permanent steward and original platform-permission invariant for an adopted organisation.';
alter function vortex_access.organization_has_permanent_steward(uuid, timestamptz)
  owner to postgres;

reset role;

commit;
