create or replace function vortex_access.read_application_roles_for_installation(
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installer record;
  roles_value jsonb;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Installation role read input is invalid',
      detail = 'vortex_access.read_application_roles_for_installation';
  end if;

  -- The installation authority (applications.manage plus delegated management over the whole
  -- organisation catalogue) is what entitles this read; it needs no separate roles.read grant.
  select locked.* into strict installer
  from vortex_access.lock_application_installation_authority() as locked;

  -- One organisation role per role template of this application: a live one before a retired
  -- one, so a retired role is reported instead of being accepted a second time. Each carries the
  -- permissions it accepted (with the meaning it accepted), how many live assignments hold it,
  -- and the installer's own live standing assignment of it.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'roleId', selected.role_id,
      'sourceRoleId', selected.source_role_id,
      'label', selected.label,
      'liveRevision', selected.live_revision,
      'lifecycle', selected.lifecycle,
      'assignmentPolicy', selected.assignment_policy,
      'liveAssignmentCount', (
        select pg_catalog.count(*)
        from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id = installer.organization_id
          and assignment.role_id = selected.role_id
          and assignment.state = 'live'
      ),
      'installerAssignment', (
        select pg_catalog.jsonb_build_object(
          'roleAssignmentId', assignment.role_assignment_id,
          'revision', assignment.revision,
          'selfGranted', assignment.granted_by = installer.organization_account_id
        )
        from vortex_access.organization_role_assignments as assignment
        where assignment.organization_id = installer.organization_id
          and assignment.role_id = selected.role_id
          and assignment.assignee_kind = 'organization_account'
          and assignment.organization_account_id = installer.organization_account_id
          and assignment.assignment_kind = 'standing'
          and assignment.state = 'live'
          and assignment.starts_at <= pg_catalog.clock_timestamp()
          and (assignment.expires_at is null
            or assignment.expires_at > pg_catalog.clock_timestamp())
        order by assignment.granted_at, assignment.role_assignment_id
        limit 1
      ),
      'acceptedPermissions', (
        select coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_strip_nulls(
              pg_catalog.jsonb_build_object(
                'reference', pg_catalog.jsonb_strip_nulls(
                  pg_catalog.jsonb_build_object(
                    'applicationRootId', permission.application_root_id,
                    'ownerKind', permission.owner_kind,
                    'ownerId', permission.owner_id,
                    'permissionId', permission.permission_id
                  )
                ),
                'key', catalogue.permission_key,
                'label', catalogue.label,
                'description', catalogue.description,
                'recordTypeId', catalogue.record_type_id,
                'action', pg_catalog.jsonb_strip_nulls(
                  pg_catalog.jsonb_build_object(
                    'actionKind', catalogue.action_kind,
                    'namedAction', catalogue.named_action
                  )
                ),
                'administrative', catalogue.administrative,
                -- The meaning the role accepted, which may be older than the registered one.
                'recordScope', catalogue.record_scope,
                'fieldPolicy', catalogue.field_policy
              )
            ) order by permission.entry_ordinal
          ),
          '[]'::jsonb
        )
        from vortex_access.organization_role_permission_entries as permission
        join vortex_access.permission_catalogue_entries as catalogue
          on catalogue.organization_id = permission.organization_id
          and catalogue.registration_kind = permission.registration_kind
          and catalogue.registration_owner_id = permission.registration_owner_id
          and catalogue.registration_revision = permission.accepted_registration_revision
          and catalogue.owner_kind = permission.owner_kind
          and catalogue.owner_id = permission.owner_id
          and catalogue.permission_id = permission.permission_id
        where permission.organization_id = installer.organization_id
          and permission.role_id = selected.role_id
          and permission.role_revision = selected.live_revision
      )
    ) order by selected.source_role_id), '[]'::jsonb)
  into roles_value
  from (
    select distinct on (role.source_role_id)
      role.role_id, role.source_role_id, role.live_revision, revision.label,
      revision.lifecycle, revision.assignment_policy
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = installer.organization_id
      and role.role_kind = 'application'
      and role.application_root_id = p_application_root_id
    order by role.source_role_id, (revision.lifecycle = 'retired'), role.created_at desc,
      role.role_id
  ) as selected;

  return pg_catalog.jsonb_build_object(
    'organizationId', installer.organization_id,
    'organizationAccountId', installer.organization_account_id,
    'roles', roles_value
  );
end
$function$;

alter function vortex_access.read_application_roles_for_installation(uuid) owner to vortex_owner;

revoke all on function vortex_access.read_application_roles_for_installation(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_access.read_application_roles_for_installation(uuid)
  to vortex_request;

comment on function vortex_access.read_application_roles_for_installation(uuid) is
  'Installation role read under the installation authority: for each role template of one application, the organisation role accepted from it (a live one before a retired one) with its accepted permissions and their accepted meaning, its live assignment count and the installer''s own live standing assignment. Reads only that application''s roles; needs no roles.read grant.';
