create or replace function vortex_access.read_first_install_member_role(
  p_application_root_id uuid,
  p_source_role_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installer record;
  member_role record;
  held boolean := false;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_source_role_id is null
    or p_source_role_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'First-install member role read input is invalid',
      detail = 'vortex_access.read_first_install_member_role';
  end if;

  -- The installation authority (applications.install plus delegated management over the whole
  -- organisation catalogue) is what entitles this read; it needs no separate roles.read grant.
  select locked.* into strict installer
  from vortex_access.lock_application_installation_authority() as locked;

  if not exists (
    select 1
    from vortex_access.application_role_template_continuities as continuity
    where continuity.organization_id = installer.organization_id
      and continuity.application_root_id = p_application_root_id
      and continuity.source_role_id = p_source_role_id
  ) then
    raise exception using errcode = '42704',
      message = 'First-install member role template is not registered',
      detail = 'vortex_access.read_first_install_member_role';
  end if;

  -- The one organisation role accepted from this template, if any; a retired one is history.
  select role.role_id, role.live_revision, revision.lifecycle, revision.assignment_policy
  into member_role
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as revision
    on revision.organization_id = role.organization_id
    and revision.role_id = role.role_id
    and revision.revision = role.live_revision
  where role.organization_id = installer.organization_id
    and role.role_kind = 'application'
    and role.application_root_id = p_application_root_id
    and role.source_role_id = p_source_role_id
    and revision.lifecycle <> 'retired'
  order by role.created_at, role.role_id
  limit 1;

  if member_role.role_id is not null then
    held := exists (
      select 1
      from vortex_access.organization_role_assignments as assignment
      where assignment.organization_id = installer.organization_id
        and assignment.role_id = member_role.role_id
        and assignment.assignee_kind = 'organization_account'
        and assignment.organization_account_id = installer.organization_account_id
        and assignment.assignment_kind = 'standing'
        and assignment.state = 'live'
        and assignment.starts_at <= pg_catalog.clock_timestamp()
        and (assignment.expires_at is null
          or assignment.expires_at > pg_catalog.clock_timestamp())
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'organizationId', installer.organization_id,
    'organizationAccountId', installer.organization_account_id,
    'role', case when member_role.role_id is null then null else pg_catalog.jsonb_build_object(
      'roleId', member_role.role_id,
      'liveRevision', member_role.live_revision,
      'lifecycle', member_role.lifecycle,
      'assignmentPolicy', member_role.assignment_policy
    ) end,
    'installerHoldsRole', held
  );
end
$function$;

alter function vortex_access.read_first_install_member_role(uuid, uuid) owner to vortex_owner;

revoke all on function vortex_access.read_first_install_member_role(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_access.read_first_install_member_role(uuid, uuid)
  to vortex_request;

comment on function vortex_access.read_first_install_member_role(uuid, uuid) is
  'First-install member role read under the installation authority: whether the organisation already accepted the one Application role template the installer is accepting, and whether the installer already holds it. Reads only that template''s role and the installer''s own assignment; needs no roles.read grant.';
