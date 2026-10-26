-- The permission lookups the page reads call once per statement are plpgsql, so each session
-- keeps their query plans instead of planning the same join on every call.

set role vortex_owner;

create or replace function vortex_access.accepted_permission_meaning_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_owner_kind text,
  p_owner_id uuid,
  p_permission_id uuid,
  p_continuity_revision bigint,
  p_accepted_registration_revision bigint,
  p_meaning_fingerprint text
)
returns setof vortex_access.permission_catalogue_entries
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  -- A grant keeps its accepted meaning while the permission remains available in its original
  -- availability lineage. Explicit role acceptance or delegation scope change moves that meaning.
  return query
    select accepted.*
    from vortex_access.permission_registrations as registration
    join vortex_access.permission_catalogue_entries as current_entry
      on current_entry.organization_id = registration.organization_id
      and current_entry.registration_kind = registration.registration_kind
      and current_entry.registration_owner_id is not distinct from registration.registration_owner_id
      and current_entry.registration_revision = registration.revision
      and current_entry.application_root_id is not distinct from p_application_root_id
      and current_entry.owner_kind = p_owner_kind
      and current_entry.owner_id = p_owner_id
      and current_entry.permission_id = p_permission_id
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = current_entry.organization_id
      and continuity.application_scope_id = coalesce(current_entry.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and continuity.owner_kind = current_entry.owner_kind
      and continuity.owner_id = current_entry.owner_id
      and continuity.permission_id = current_entry.permission_id
      and continuity.registration_kind = current_entry.registration_kind
      and continuity.registration_owner_id is not distinct from current_entry.registration_owner_id
      and continuity.last_processed_registration_revision = registration.revision
      and continuity.state = 'available'
      and continuity.continuity_revision = p_continuity_revision
      and continuity.meaning_fingerprint = current_entry.meaning_fingerprint
    join vortex_access.permission_catalogue_entries as accepted
      on accepted.organization_id = current_entry.organization_id
      and accepted.registration_kind = current_entry.registration_kind
      and accepted.registration_owner_id is not distinct from current_entry.registration_owner_id
      and accepted.registration_revision = p_accepted_registration_revision
      and accepted.application_root_id is not distinct from current_entry.application_root_id
      and accepted.owner_kind = current_entry.owner_kind
      and accepted.owner_id = current_entry.owner_id
      and accepted.permission_id = current_entry.permission_id
      and accepted.meaning_fingerprint = p_meaning_fingerprint
    where registration.organization_id = p_organization_id
      and registration.state = 'active'
      and p_accepted_registration_revision <= registration.revision
    limit 1;
end
$function$;

create or replace function vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
  p_identity_id uuid,
  p_checked_at timestamptz
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return (
    select assignment.assignment_id
    from vortex_identity.vortex_super_administrator_assignments as assignment
    join vortex_identity.identity_projections as identity
      on identity.identity_id = assignment.identity_id
      and identity.state = 'active'
    where assignment.identity_id = p_identity_id
      and (assignment.revoked_at is null or assignment.revoked_at > p_checked_at)
      and assignment.granted_at <= p_checked_at
    limit 1
  );
end
$function$;

create or replace function vortex_access.read_application_permission_snapshot(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns table (
  organization_id uuid,
  application_root_id uuid,
  registration_revision bigint,
  release_revision bigint,
  definition_key text,
  release_version text,
  validation_contract_version text,
  content_fingerprint text,
  resolution_fingerprint text,
  catalogue_fingerprint text,
  permission_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return query
    select registration.organization_id, registration.registration_owner_id,
      registration.revision, registration.source_revision, registration.source_definition_key,
      registration.source_version,
      registration.validation_contract_version, release.content_fingerprint,
      release.resolution_fingerprint, registration.permission_catalogue_fingerprint,
      coalesce(
        pg_catalog.array_agg(entry.permission_id order by
          entry.permission_key collate "C", entry.permission_id)
          filter (where entry.permission_id is not null),
        array[]::uuid[]
      )
    from vortex_access.permission_registrations as registration
    join vortex_definition.releases as release
      on release.root_id = registration.registration_owner_id
      and release.release_revision = registration.source_revision
      and release.release_version = registration.source_version
      and release.validation_contract_version = registration.validation_contract_version
    left join vortex_access.permission_catalogue_entries as entry
      on entry.organization_id = registration.organization_id
      and entry.registration_kind = registration.registration_kind
      and entry.registration_owner_id = registration.registration_owner_id
      and entry.registration_revision = registration.revision
      and entry.owner_kind = 'application'
      and entry.administrative = false
    where registration.organization_id = p_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = p_application_root_id
      and registration.state = 'active'
    group by registration.organization_id, registration.registration_owner_id,
      registration.revision, registration.source_revision, registration.source_definition_key,
      registration.source_version,
      registration.validation_contract_version, release.content_fingerprint,
      release.resolution_fingerprint, registration.permission_catalogue_fingerprint;
end
$function$;

create or replace function vortex_platform.grid_view_viewer_targets_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_application_root_id uuid
)
returns table (role_ids uuid[], group_ids uuid[])
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return query
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
      join vortex_access.organization_role_revisions as revision
        on revision.organization_id = assigned_role.organization_id
        and revision.role_id = assigned_role.role_id
        and revision.revision = assigned_role.live_revision
        and revision.lifecycle in ('active', 'acceptance_required')
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
      coalesce((select pg_catalog.array_agg(member.group_id) from groups as member), '{}'::uuid[]);
end
$function$;

reset role;
