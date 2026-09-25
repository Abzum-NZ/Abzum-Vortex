-- Keep the organisation's exact default application reference with its
-- Identity-owned execution settings. A later protected installation operation
-- sets it; this migration supplies only the storage and read side.

-- The postgres-owned functions below are created in vortex_module, which needs
-- the schema CREATE privilege that only the schema owner can lend. Revoked again
-- at the end of this migration.
set local role vortex_module_owner;
grant create on schema vortex_module to postgres;
reset role;

alter table vortex_definition.roots
  add constraint roots_organization_root_id_unique unique (organization_id, root_id);

alter table vortex_identity.organization_runtime_settings
  add column default_application_root_id uuid,
  add constraint organization_runtime_settings_default_application_non_nil check (
    default_application_root_id is null or
    default_application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  add constraint organization_runtime_settings_default_application_scope_fk
    foreign key (organization_id, default_application_root_id)
    references vortex_definition.roots (organization_id, root_id);

create function vortex_access.read_current_organization_default_application_for_application()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  selected_application_root_id uuid;
begin
  context_value := vortex_access.validated_human_request_context();
  select settings.default_application_root_id into selected_application_root_id
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = (context_value ->> 'organizationId')::uuid;
  return selected_application_root_id;
end
$function$;

revoke execute on function vortex_access.read_current_organization_default_application_for_application()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.read_current_organization_default_application_for_application()
  to vortex_request;

comment on function vortex_access.read_current_organization_default_application_for_application() is
  'Reads only the exact default application root of the validated human organisation context; absence is null and does not grant application access.';

-- Home-page selection needs the account's current application-role identities.
-- The page itself is still checked by the ordinary Access decision. These
-- routes mirror the standing and activated direct/group paths of the central
-- permission evaluator, including current role and policy continuity.
create function vortex_access.read_current_application_role_ids_for_launcher()
returns table (source_role_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  checked_at timestamptz := pg_catalog.clock_timestamp();
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId'
    or (context_value ->> 'expiresAt')::timestamptz <= checked_at then
    return;
  end if;

  return query
  with current_roles as (
    select role.role_id, role.source_role_id, revision.assignment_policy,
      revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision, revision.activation_policy_fingerprint
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    where role.organization_id = (context_value ->> 'organizationId')::uuid
      and role.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and role.role_kind = 'application'
      and revision.lifecycle in ('active', 'acceptance_required')
  ), active_roles as (
    select role.source_role_id
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = (context_value ->> 'organizationId')::uuid
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= checked_at
      and (assignment.expires_at is null or assignment.expires_at > checked_at)
    where role.assignment_policy = 'standing'

    union

    select role.source_role_id
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = (context_value ->> 'organizationId')::uuid
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= checked_at
      and (assignment.expires_at is null or assignment.expires_at > checked_at)
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and membership.state = 'live'
      and membership.starts_at <= checked_at
      and (membership.expires_at is null or membership.expires_at > checked_at)
    where role.assignment_policy = 'standing'

    union

    select role.source_role_id
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = (context_value ->> 'organizationId')::uuid
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= checked_at
      and (assignment.expires_at is null or assignment.expires_at > checked_at)
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'direct'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= checked_at
      and activation.expires_at > checked_at
      and activation.authority_continuity_revision = role.authority_continuity_revision
      and activation.policy_continuity_revision = role.policy_continuity_revision
      and activation.activation_policy_id = role.activation_policy_id
      and activation.activation_policy_revision = role.activation_policy_revision
      and activation.activation_policy_fingerprint = role.activation_policy_fingerprint
    where role.assignment_policy = 'activation_required'

    union

    select role.source_role_id
    from current_roles as role
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = (context_value ->> 'organizationId')::uuid
      and assignment.role_id = role.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= checked_at
      and (assignment.expires_at is null or assignment.expires_at > checked_at)
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'group'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= checked_at
      and activation.expires_at > checked_at
      and activation.authority_continuity_revision = role.authority_continuity_revision
      and activation.policy_continuity_revision = role.policy_continuity_revision
      and activation.activation_policy_id = role.activation_policy_id
      and activation.activation_policy_revision = role.activation_policy_revision
      and activation.activation_policy_fingerprint = role.activation_policy_fingerprint
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and membership.membership_id = activation.membership_id
      and membership.revision = activation.membership_revision
      and membership.state = 'live'
      and membership.starts_at <= checked_at
      and (membership.expires_at is null or membership.expires_at > checked_at)
    where role.assignment_policy = 'activation_required'
  )
  select active.source_role_id from active_roles as active
  order by active.source_role_id;
end
$function$;

revoke execute on function vortex_access.read_current_application_role_ids_for_launcher()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.read_current_application_role_ids_for_launcher()
  to vortex_request;

comment on function vortex_access.read_current_application_role_ids_for_launcher() is
  'Returns only current direct or group application-role source identities for the validated human application context; page authority is checked separately.';

-- The candidate read and the human decision run in separate transactions.
-- Pin the candidate to the registration and installation still current in the
-- decision transaction before any candidate metadata can be returned.
create function vortex_module.is_current_application_address_release(
  p_release_revision bigint
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  installation_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId'
    or p_release_revision not between 1 and 9007199254740991 then
    return false;
  end if;
  installation_value := vortex_module.read_current_active_installation();
  return (installation_value ->> 'applicationReleaseRevision')::bigint = p_release_revision
    and exists (
    select 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = (context_value ->> 'organizationId')::uuid
      and registration.registration_kind = 'application'
      and registration.registration_owner_id =
        (context_value ->> 'applicationRootId')::uuid
      and registration.state = 'active'
      and registration.source_revision = p_release_revision
  );
exception
  when sqlstate 'P0002' or sqlstate '55000' or sqlstate '23514' then
    return false;
end
$function$;

revoke execute on function vortex_module.is_current_application_address_release(bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_module.is_current_application_address_release(bigint)
  to vortex_request;

comment on function vortex_module.is_current_application_address_release(bigint) is
  'Checks an internal candidate release against the exact active registration and binding in the validated human application context.';

-- Resolve canonical organisation addresses and provide private installation
-- candidates. App checks each page through the current Access decision before
-- returning any application metadata to the caller.

create function vortex_module.read_application_address_candidates(
  p_identity_id uuid,
  p_tenant_short_name text,
  p_organization_short_name text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  addressed_organization record;
  application_row record;
  application_values jsonb := '[]'::jsonb;
  page_values jsonb;
  role_values jsonb;
  permission_values jsonb;
  home_page_key text;
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_tenant_short_name is null
    or pg_catalog.char_length(p_tenant_short_name) not between 1 and 40
    or p_tenant_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_organization_short_name is null
    or pg_catalog.char_length(p_organization_short_name) not between 1 and 40
    or p_organization_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$' then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  select tenant.tenant_id, tenant.short_name as tenant_short_name,
    organization.organization_id, organization.short_name as organization_short_name
  into addressed_organization
  from vortex_identity.tenants as tenant
  join vortex_identity.organizations as organization
    on organization.tenant_id = tenant.tenant_id
  where tenant.short_name = p_tenant_short_name
    and organization.short_name = p_organization_short_name
    and tenant.state = 'active'
    and organization.state = 'active';

  if not found then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  begin
    perform 1
    from vortex_access.resolve_human_organization_scope(
      p_identity_id, addressed_organization.organization_id
    ) as scope;
  exception
    when sqlstate '42501' or sqlstate 'P0002' then
      return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end;

  for application_row in
    select root.root_id, root.key as application_key, release.compilation_output,
      registration.revision as registration_revision,
      registration.source_revision as release_revision
    from vortex_access.permission_registrations as registration
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = addressed_organization.organization_id
      and root.kind = 'application'
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
    where registration.organization_id = addressed_organization.organization_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and exists (
        select 1
        from vortex_module.installation_bindings as binding
        where binding.organization_id = addressed_organization.organization_id
          and binding.application_root_id = root.root_id
          and binding.application_release_revision = registration.source_revision
          and binding.state = 'active'
      )
      and registration.source_content_fingerprint = release.content_fingerprint
      and registration.source_resolution_fingerprint = release.resolution_fingerprint
      and release.compilation_output ->> 'kind' = 'application'
    order by root.key collate "C", root.root_id
  loop
    begin
      perform 1
      from vortex_access.resolve_human_application_scope(
        p_identity_id,
        addressed_organization.organization_id,
        application_row.root_id
      ) as scope;
    exception
      when sqlstate '42501' or sqlstate 'P0002' then
        continue;
    end;

    page_values := application_row.compilation_output #> '{canonical,content,pages}';
    if pg_catalog.jsonb_typeof(page_values) is distinct from 'array' then
      continue;
    end if;
    if pg_catalog.jsonb_array_length(page_values) = 0 then
      continue;
    end if;

    select page.value ->> 'key'
    into home_page_key
    from pg_catalog.jsonb_array_elements(page_values) as page(value)
    where page.value ->> 'pageId' =
      application_row.compilation_output #>> '{canonical,content,homePageId}';

    if home_page_key is null then
      continue;
    end if;

    role_values := application_row.compilation_output #> '{canonical,content,roles}';
    if pg_catalog.jsonb_typeof(role_values) is distinct from 'array' then
      continue;
    end if;

    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'key', entry.permission_key,
        'applicationRootId', entry.application_root_id,
        'ownerKind', entry.owner_kind,
        'ownerId', entry.owner_id,
        'permissionId', entry.permission_id,
        'actionKind', entry.action_kind,
        'namedAction', entry.named_action
      ) order by entry.permission_key collate "C", entry.permission_id
    ) into permission_values
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = addressed_organization.organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = application_row.root_id
      and entry.registration_revision = application_row.registration_revision
      and entry.application_root_id = application_row.root_id;

    application_values := application_values || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', application_row.root_id,
        'releaseRevision', application_row.release_revision,
        'key', application_row.application_key,
        'name', application_row.compilation_output #>> '{canonical,content,name}',
        'icon', application_row.compilation_output #>> '{canonical,content,icon}',
        'homePageKey', home_page_key,
        'pages', (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'pageId', page.value ->> 'pageId',
              'key', page.value ->> 'key',
              'accessPermissionKey', page.value ->> 'accessPermissionKey'
            ) order by page.value ->> 'key' collate "C"
          )
          from pg_catalog.jsonb_array_elements(page_values) as page(value)
        ),
        'roles', (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'roleId', role.value ->> 'roleId',
              'key', role.value ->> 'key',
              'homePageId', role.value ->> 'homePageId'
            ) order by role.value ->> 'key' collate "C"
          )
          from pg_catalog.jsonb_array_elements(role_values) as role(value)
        ),
        'permissions', coalesce(permission_values, '[]'::jsonb)
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'kind', 'available',
    'organizationId', addressed_organization.organization_id,
    'tenantShortName', addressed_organization.tenant_short_name,
    'organizationShortName', addressed_organization.organization_short_name,
    'applications', application_values
  );
end
$function$;

revoke all on function vortex_module.read_application_address_candidates(uuid, text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_module.read_application_address_candidates(uuid, text, text)
  to vortex_runtime;

comment on function vortex_module.read_application_address_candidates(uuid, text, text) is
  'Private App candidate read for one exact live human organisation address; only App may project metadata after current page Access decisions.';

set local role vortex_module_owner;
revoke create on schema vortex_module from postgres;
reset role;
