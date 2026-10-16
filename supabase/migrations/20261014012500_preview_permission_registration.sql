-- Preview works before the first publish and for draft-only permissions (#2798).
-- A preview now has its own permission registration, written when it is provisioned from the
-- rehearsed releases: the permissions the previewed Application and its own Modules declare, and
-- the draft's roles, which only the builder who opened the preview holds. One function,
-- request_application_registration_internal, says which registration a request runs under: the
-- installed one, or for a preview request only the preview's own. The scope gates, the address
-- check, the permission role path, the launcher's roles and the record-link check all take it from
-- there. A used Module's permissions are still decided by the builder's own live access, and no
-- preview role reaches a system projection. A preview's installation is only its builder's.
-- A preview is provisioned in the organisation's context, so an Application with no installation
-- can be previewed. Its storage is created empty and then seeded, under the builder's own live
-- access in the installed Application, with only the records and fields the builder reads there.
set local role vortex_owner;

alter table vortex_definition.preview_installations
  add column seeded_at timestamptz;

create table vortex_access.preview_permission_registrations (
  preview_installation_id uuid not null
    references vortex_definition.preview_installations (preview_installation_id) on delete cascade,
  organization_id uuid not null,
  application_root_id uuid not null,
  organization_account_id uuid not null,
  owned_owner_ids uuid[] not null
    constraint preview_permission_registrations_owners_check
    check (pg_catalog.cardinality(owned_owner_ids) between 1 and 201),
  role_ids uuid[] not null,
  constraint preview_permission_registrations_pkey primary key (preview_installation_id)
);
alter table vortex_access.preview_permission_registrations enable row level security;
alter table vortex_access.preview_permission_registrations force row level security;
create policy preview_permission_registrations_owner
  on vortex_access.preview_permission_registrations
  to vortex_owner using (true) with check (true);
revoke all on table vortex_access.preview_permission_registrations
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on table vortex_access.preview_permission_registrations is
  'The permission registration of one preview: the previewed Application and its own Modules, and the draft roles the builder who opened the preview holds there.';

create table vortex_access.preview_permission_entries (
  preview_installation_id uuid not null
    references vortex_access.preview_permission_registrations (preview_installation_id)
    on delete cascade,
  entry vortex_access.permission_catalogue_entries not null,
  held boolean not null
);
create unique index preview_permission_entries_identity
  on vortex_access.preview_permission_entries (
    preview_installation_id, ((entry).owner_kind), ((entry).owner_id), ((entry).permission_id)
  );
alter table vortex_access.preview_permission_entries enable row level security;
alter table vortex_access.preview_permission_entries force row level security;
create policy preview_permission_entries_owner
  on vortex_access.preview_permission_entries
  to vortex_owner using (true) with check (true);
revoke all on table vortex_access.preview_permission_entries
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on table vortex_access.preview_permission_entries is
  'The permissions one preview registers, each as the catalogue entry it would be at installation, and whether a draft role selects it.';

-- Previews of the earlier shape were seeded with every live record: drop them.
do $migration$
declare
  preview_row record;
begin
  for preview_row in
    select preview.preview_installation_id
    from vortex_definition.preview_installations as preview
    order by preview.preview_installation_id
  loop
    perform vortex_record.drop_preview_installation_storage(preview_row.preview_installation_id);
    delete from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = preview_row.preview_installation_id;
  end loop;
end
$migration$;

create or replace function vortex_access.request_application_registration_internal(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_organization_account_id uuid
)
returns table (
  registration_kind text,
  preview_installation_id uuid,
  source_revision bigint,
  owned_owner_ids uuid[],
  role_ids uuid[],
  valid_until timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  preview_address text;
begin
  -- The one place that says which permission registration a request to an Application runs
  -- under. A request without a preview address runs the active installed registration. A request
  -- with one runs only that preview's registration, which exists for the builder who opened the
  -- preview, and never falls back to the installed registration.
  if not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text) then
    return;
  end if;
  preview_address := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  if preview_address is null then
    return query
    select 'installed'::text, null::uuid, registration.source_revision, null::uuid[],
      null::uuid[], null::timestamptz
    from vortex_access.permission_registrations as registration
    where registration.organization_id = p_organization_id
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = p_application_root_id
      and registration.state = 'active';
    return;
  end if;
  if not pg_catalog.pg_input_is_valid(preview_address, 'uuid') then
    return;
  end if;
  return query
  select 'preview'::text, preview.preview_installation_id,
    preview.application_release_revision, registration.owned_owner_ids,
    registration.role_ids, preview.expires_at
  from vortex_access.preview_permission_registrations as registration
  join vortex_definition.preview_installations as preview
    on preview.preview_installation_id = registration.preview_installation_id
  where registration.preview_installation_id = preview_address::uuid
    and registration.organization_id = p_organization_id
    and registration.application_root_id = p_application_root_id
    and registration.organization_account_id = p_organization_account_id
    and preview.organization_id = p_organization_id
    and preview.application_root_id = p_application_root_id
    and preview.previewer_organization_account_id = p_organization_account_id
    and preview.expires_at > pg_catalog.statement_timestamp();
end
$function$;

alter function vortex_access.request_application_registration_internal(uuid, uuid, uuid)
  owner to vortex_owner;

revoke all on function vortex_access.request_application_registration_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;

comment on function vortex_access.request_application_registration_internal(uuid, uuid, uuid) is
  'The permission registration one organisation account''s request to an Application runs under: the active installed registration, or, for a request with a preview address, only the registration of that unexpired preview, which only the builder who opened it holds.';

CREATE OR REPLACE FUNCTION vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) RETURNS TABLE(tenant_id uuid, organization_id uuid, organization_account_id uuid, application_root_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  resolved_tenant_id uuid;
  resolved_organization_id uuid;
  resolved_organization_account_id uuid;
  resolved_access_version bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application selection is invalid';
  end if;

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id, scope.access_version
  into resolved_tenant_id, resolved_organization_id,
    resolved_organization_account_id, resolved_access_version
  from vortex_access.resolve_human_organization_scope(
    p_identity_id,
    p_organization_id
  ) as scope;

  -- The registration the request runs under: the installed one, or the preview's own.
  if not exists (
    select 1
    from vortex_access.request_application_registration_internal(
      resolved_organization_id, p_application_root_id, resolved_organization_account_id
    )
  ) then
    raise exception using errcode = '42501',
      message = 'Application selection is unavailable';
  end if;

  return query select resolved_tenant_id, resolved_organization_id,
    resolved_organization_account_id, p_application_root_id,
    resolved_access_version;
end
$$;

alter function vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) IS 'Resolves one exact active human organisation scope and active application registration under the organisation Access lock.';

REVOKE ALL ON FUNCTION vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) TO vortex_runtime;

grant execute on function vortex_access.resolve_human_application_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) to postgres;

CREATE OR REPLACE FUNCTION vortex_access.resolve_human_application_change_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) RETURNS TABLE(tenant_id uuid, organization_id uuid, organization_account_id uuid, application_root_id uuid, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  resolved_tenant_id uuid;
  resolved_organization_id uuid;
  resolved_organization_account_id uuid;
  resolved_access_version bigint;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Application change selection is invalid';
  end if;

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id, scope.access_version
  into resolved_tenant_id, resolved_organization_id,
    resolved_organization_account_id, resolved_access_version
  from vortex_access.resolve_human_organization_change_scope(
    p_identity_id,
    p_organization_id
  ) as scope;

  -- The registration the request runs under: the installed one, or the preview's own.
  if not exists (
    select 1
    from vortex_access.request_application_registration_internal(
      resolved_organization_id, p_application_root_id, resolved_organization_account_id
    )
  ) then
    raise exception using errcode = '42501',
      message = 'Application change selection is unavailable';
  end if;

  return query select resolved_tenant_id, resolved_organization_id,
    resolved_organization_account_id, p_application_root_id,
    resolved_access_version;
end
$$;

alter function vortex_access.resolve_human_application_change_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) owner to vortex_owner;

COMMENT ON FUNCTION vortex_access.resolve_human_application_change_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) IS 'Resolves one active human application change scope under the organization Access governance lock.';

REVOKE ALL ON FUNCTION vortex_access.resolve_human_application_change_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.resolve_human_application_change_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) TO vortex_runtime;

grant execute on function vortex_access.resolve_human_application_change_scope(p_identity_id uuid, p_organization_id uuid, p_application_root_id uuid) to postgres;

create or replace function vortex_access.evaluate_permission_role_path_internal(
  p_context jsonb,
  p_checked_at timestamptz,
  p_permission jsonb,
  p_action jsonb,
  p_record_type_id uuid
)
returns table (
  permission_entry vortex_access.permission_catalogue_entries,
  path_valid_until timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  context_organization_value uuid := (p_context ->> 'organizationId')::uuid;
  context_account_value uuid := (p_context ->> 'organizationAccountId')::uuid;
  context_expires_value timestamptz := (p_context ->> 'expiresAt')::timestamptz;
  decision_checked_at timestamptz := p_checked_at;
  permission_application_value uuid := (p_permission ->> 'applicationRootId')::uuid;
  permission_owner_kind_value text := p_permission ->> 'ownerKind';
  permission_owner_value uuid := (p_permission ->> 'ownerId')::uuid;
  permission_value uuid := (p_permission ->> 'permissionId')::uuid;
  action_kind_value text := p_action ->> 'actionKind';
  named_action_value text := p_action ->> 'namedAction';
  preview_registration record;
begin
  -- A preview request decides the permissions of the previewed Application and its own Modules
  -- from the preview's registration alone: the builder who opened the preview holds the draft's
  -- roles there. Every other permission, a used Module's included, is decided by the builder's
  -- own live access below; the preview's roles never apply to it.
  if permission_owner_kind_value in ('application', 'module')
    and nullif(
      pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
    ) is not null then
    select registration.* into preview_registration
    from vortex_access.request_application_registration_internal(
      context_organization_value,
      (p_context ->> 'applicationRootId')::uuid,
      context_account_value
    ) as registration;
    if preview_registration.registration_kind is distinct from 'preview' then
      return;
    end if;
    if permission_owner_value = any(preview_registration.owned_owner_ids) then
      return query
      select preview_entry.entry,
        case when preview_entry.held
          then least(context_expires_value, preview_registration.valid_until)
        end
      from vortex_access.preview_permission_entries as preview_entry
      where preview_entry.preview_installation_id = preview_registration.preview_installation_id
        and (preview_entry.entry).application_root_id is not distinct from
          permission_application_value
        and (preview_entry.entry).owner_kind = permission_owner_kind_value
        and (preview_entry.entry).owner_id = permission_owner_value
        and (preview_entry.entry).permission_id = permission_value
        and (preview_entry.entry).record_type_id is not distinct from p_record_type_id
        and (preview_entry.entry).action_kind = action_kind_value
        and (preview_entry.entry).named_action is not distinct from named_action_value;
      return;
    end if;
  end if;

  return query
  with current_permission as materialized (
    select catalogue.application_root_id, catalogue.owner_kind,
      catalogue.owner_id, catalogue.permission_id,
      catalogue.meaning_fingerprint, catalogue as permission_entry
    from vortex_access.permission_registrations as registration
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = registration.organization_id
      and catalogue.registration_kind = registration.registration_kind
      and catalogue.registration_owner_id = registration.registration_owner_id
      and catalogue.registration_revision = registration.revision
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = catalogue.organization_id
      and continuity.application_scope_id = coalesce(catalogue.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and continuity.owner_kind = catalogue.owner_kind
      and continuity.owner_id = catalogue.owner_id
      and continuity.permission_id = catalogue.permission_id
      and continuity.registration_kind = catalogue.registration_kind
      and continuity.registration_owner_id = catalogue.registration_owner_id
      and continuity.last_processed_registration_revision = registration.revision
      and continuity.state = 'available'
      and continuity.meaning_fingerprint = catalogue.meaning_fingerprint
    where registration.organization_id = context_organization_value
      and registration.state = 'active'
      and catalogue.application_root_id is not distinct from
        permission_application_value
      and catalogue.owner_kind = permission_owner_kind_value
      and catalogue.owner_id = permission_owner_value
      and catalogue.permission_id = permission_value
      and catalogue.record_type_id is not distinct from p_record_type_id
      and catalogue.action_kind = action_kind_value
      and catalogue.named_action is not distinct from named_action_value
  ), current_role_permission as materialized (
    select role.role_id, role.live_revision,
      revision.assignment_policy, revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = revision.organization_id
      and permission.role_id = revision.role_id
      and permission.role_revision = revision.revision
    join current_permission as available
      on available.application_root_id is not distinct from
        permission.application_root_id
      and available.owner_kind = permission.owner_kind
      and available.owner_id = permission.owner_id
      and available.permission_id = permission.permission_id
      and available.meaning_fingerprint = permission.meaning_fingerprint
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = permission.organization_id
      and continuity.application_scope_id = coalesce(permission.application_root_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and continuity.owner_kind = permission.owner_kind
      and continuity.owner_id = permission.owner_id
      and continuity.permission_id = permission.permission_id
      and continuity.state = 'available'
      and continuity.continuity_revision = permission.continuity_revision
      and continuity.meaning_fingerprint = permission.meaning_fingerprint
    where role.organization_id = context_organization_value
      and revision.lifecycle in ('active', 'acceptance_required')
  ), route_candidates as (
    select 1 as route_rank, permission.role_id,
      assignment.role_assignment_id, null::uuid as membership_id,
      null::uuid as role_activation_id,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value)
      ) as path_valid_until
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = context_account_value
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'standing'

    union all

    select 2, permission.role_id, assignment.role_assignment_id,
      membership.membership_id, null::uuid,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value)
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_value
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'standing'

    union all

    select 3, permission.role_id, assignment.role_assignment_id,
      null::uuid, activation.role_activation_id,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        activation.expires_at
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = context_account_value
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = context_account_value
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'direct'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= decision_checked_at
      and activation.expires_at > decision_checked_at
      and activation.authority_continuity_revision =
        permission.authority_continuity_revision
      and activation.policy_continuity_revision =
        permission.policy_continuity_revision
      and activation.activation_policy_id = permission.activation_policy_id
      and activation.activation_policy_revision =
        permission.activation_policy_revision
    where permission.assignment_policy = 'activation_required'

    union all

    select 4, permission.role_id, assignment.role_assignment_id,
      membership.membership_id, activation.role_activation_id,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value),
        activation.expires_at
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = context_account_value
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'group'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= decision_checked_at
      and activation.expires_at > decision_checked_at
      and activation.authority_continuity_revision =
        permission.authority_continuity_revision
      and activation.policy_continuity_revision =
        permission.policy_continuity_revision
      and activation.activation_policy_id = permission.activation_policy_id
      and activation.activation_policy_revision =
        permission.activation_policy_revision
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_value
      and membership.membership_id = activation.membership_id
      and membership.revision = activation.membership_revision
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'activation_required'
  ), selected_route as materialized (
    select route.path_valid_until
    from route_candidates as route

    union all

    select context_expires_value
    from current_permission as available
    where vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
      (p_context ->> 'identityId')::uuid, decision_checked_at
    ) is not null

    order by path_valid_until
    limit 1
  )
  select available.permission_entry, selected.path_valid_until
  from current_permission as available
  left join selected_route as selected on true;
end
$function$;

revoke execute on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  ) to vortex_owner;

comment on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  ) is
  'Private current-permission and role-path evidence; null record type selects only non-record permissions. A preview request decides the previewed Application''s own permissions from its preview registration. No row authority.';

alter function vortex_access.evaluate_permission_role_path_internal(p_context jsonb, p_checked_at timestamp with time zone, p_permission jsonb, p_action jsonb, p_record_type_id uuid) owner to vortex_owner;

grant execute on function vortex_access.evaluate_permission_role_path_internal(p_context jsonb, p_checked_at timestamp with time zone, p_permission jsonb, p_action jsonb, p_record_type_id uuid) to postgres;

create or replace function vortex_access.read_current_application_role_ids_for_launcher()
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

  -- In a preview the builder who opened it holds every role of the previewed draft.
  if nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  ) is not null then
    return query
    select distinct role_id.value
    from vortex_access.request_application_registration_internal(
      (context_value ->> 'organizationId')::uuid,
      (context_value ->> 'applicationRootId')::uuid,
      (context_value ->> 'organizationAccountId')::uuid
    ) as registration
    cross join lateral pg_catalog.unnest(registration.role_ids) as role_id(value)
    where registration.registration_kind = 'preview'
      and registration.valid_until > checked_at
    order by role_id.value;
    return;
  end if;

  return query
  with current_roles as (
    select role.role_id, role.source_role_id, revision.assignment_policy,
      revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision
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
  'Returns only current direct or group application-role source identities for the validated human application context, or every role of the previewed draft for the builder of a preview; page authority is checked separately.';

alter function vortex_access.read_current_application_role_ids_for_launcher() owner to vortex_owner;

-- Private Access-owner routine; Record callers first lock the active linked account.
create or replace function vortex_access.organization_account_has_current_application_access_internal(
  p_organization_id uuid,
  p_organization_account_id uuid,
  p_application_root_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  checked_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return false;
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId'
    or (context_value ->> 'expiresAt')::timestamptz <= checked_at
    or (context_value ->> 'organizationId')::uuid is distinct from p_organization_id
    or (context_value ->> 'applicationRootId')::uuid is distinct from p_application_root_id then
    return false;
  end if;

  -- In a preview the builder who opened it holds every role of the previewed draft; anyone else
  -- has the access their live roles give them.
  if exists (
    select 1
    from vortex_access.request_application_registration_internal(
      p_organization_id, p_application_root_id, p_organization_account_id
    ) as registration
    where registration.registration_kind = 'preview'
      and registration.valid_until > checked_at
      and pg_catalog.cardinality(registration.role_ids) > 0
  ) then
    return true;
  end if;

  -- The Record writer invokes this helper only after locking the exact active
  -- organisation-account projection and its active identity in this organisation.
  return exists (
    with current_roles as (
      select role.role_id, role.source_role_id, revision.assignment_policy,
        revision.authority_continuity_revision,
        revision.policy_continuity_revision, revision.activation_policy_id,
        revision.activation_policy_revision
      from vortex_access.organization_roles as role
      join vortex_access.organization_role_revisions as revision
        on revision.organization_id = role.organization_id
        and revision.role_id = role.role_id
        and revision.revision = role.live_revision
      where role.organization_id = p_organization_id
        and role.application_root_id = p_application_root_id
        and role.role_kind = 'application'
        and revision.lifecycle in ('active', 'acceptance_required')
    ), active_roles as (
      select role.source_role_id
      from current_roles as role
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = p_organization_id
        and assignment.role_id = role.role_id
        and assignment.assignee_kind = 'organization_account'
        and assignment.organization_account_id = p_organization_account_id
        and assignment.assignment_kind = 'standing'
        and assignment.state = 'live'
        and assignment.starts_at <= checked_at
        and (assignment.expires_at is null or assignment.expires_at > checked_at)
      where role.assignment_policy = 'standing'

      union

      select role.source_role_id
      from current_roles as role
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = p_organization_id
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
        and membership.organization_account_id = p_organization_account_id
        and membership.state = 'live'
        and membership.starts_at <= checked_at
        and (membership.expires_at is null or membership.expires_at > checked_at)
      where role.assignment_policy = 'standing'

      union

      select role.source_role_id
      from current_roles as role
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = p_organization_id
        and assignment.role_id = role.role_id
        and assignment.assignee_kind = 'organization_account'
        and assignment.organization_account_id = p_organization_account_id
        and assignment.assignment_kind = 'eligible'
        and assignment.state = 'live'
        and assignment.starts_at <= checked_at
        and (assignment.expires_at is null or assignment.expires_at > checked_at)
      join vortex_access.organization_role_activations as activation
        on activation.organization_id = assignment.organization_id
        and activation.organization_account_id = p_organization_account_id
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
      where role.assignment_policy = 'activation_required'

      union

      select role.source_role_id
      from current_roles as role
      join vortex_access.organization_role_assignments as assignment
        on assignment.organization_id = p_organization_id
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
        and activation.organization_account_id = p_organization_account_id
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
      join vortex_access.organization_group_memberships as membership
        on membership.organization_id = assignment.organization_id
        and membership.group_id = assignment.group_id
        and membership.organization_account_id = p_organization_account_id
        and membership.membership_id = activation.membership_id
        and membership.revision = activation.membership_revision
        and membership.state = 'live'
        and membership.starts_at <= checked_at
        and (membership.expires_at is null or membership.expires_at > checked_at)
      where role.assignment_policy = 'activation_required'
    )
    select 1 from active_roles
  );
end
$function$;
alter function vortex_access.organization_account_has_current_application_access_internal(uuid,uuid,uuid) owner to vortex_owner;


revoke all on function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid)
  to vortex_record_adapter;

comment on function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid) is
  'Private Record-link authorization for a previously locked active organisation account: returns only whether that linked account has a current direct or Group application role under the validated human application context, including current assignment, membership and activation continuity, or is the builder of the preview the context runs, who holds its draft''s roles.';

alter function vortex_access.organization_account_has_current_application_access_internal(uuid, uuid, uuid)
  owner to vortex_owner;

create or replace function vortex_definition.is_current_application_address_release(
  p_release_revision bigint
)
returns boolean
language plpgsql
volatile
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
  installation_value := vortex_definition.read_current_active_installation();
  return (installation_value ->> 'applicationReleaseRevision')::bigint = p_release_revision
    and exists (
    select 1
    from vortex_access.request_application_registration_internal(
      (context_value ->> 'organizationId')::uuid,
      (context_value ->> 'applicationRootId')::uuid,
      (context_value ->> 'organizationAccountId')::uuid
    ) as registration
    where registration.source_revision = p_release_revision
      and (registration.registration_kind = 'preview')
        = (installation_value ? 'previewInstallationId')
  );
exception
  when sqlstate 'P0002' or sqlstate '55000' or sqlstate '23514' then
    return false;
end
$function$;

revoke execute on function vortex_definition.is_current_application_address_release(bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.is_current_application_address_release(bigint)
  to vortex_request;

comment on function vortex_definition.is_current_application_address_release(bigint) is
  'Checks an internal candidate release against the registration the validated human application context runs under and its binding: the installed registration, or the preview''s own registration and pins.';

alter function vortex_definition.is_current_application_address_release(p_release_revision bigint) owner to vortex_owner;

create or replace function vortex_definition.current_preview_installation_id_internal()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  address_value text;
  context_value jsonb;
  preview_id_value uuid;
begin
  address_value := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  if address_value is null then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not pg_catalog.pg_input_is_valid(address_value, 'uuid')
    or context_value is null
    or not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Preview installation address is refused';
  end if;
  select preview.preview_installation_id into preview_id_value
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = address_value::uuid
    and preview.organization_id = (context_value ->> 'organizationId')::uuid
    and preview.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and preview.previewer_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp();
  if not found then
    raise exception using errcode = '42501',
      message = 'Preview installation is unavailable';
  end if;
  return preview_id_value;
end
$function$;

alter function vortex_definition.current_preview_installation_id_internal() owner to vortex_owner;

revoke all on function vortex_definition.current_preview_installation_id_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.current_preview_installation_id_internal()
  to vortex_record_adapter;
comment on function vortex_definition.current_preview_installation_id_internal() is
  'The unexpired preview installation the transaction-local preview address names for the validated human Application context, or null without an address; a refused address raises instead of selecting live releases.';

create or replace function vortex_definition.read_preview_record_installation_internal(
  p_preview_installation_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  preview_row vortex_definition.preview_installations%rowtype;
  module_bindings_value jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text) then
    return null;
  end if;

  begin
    context_value := vortex_definition.assert_preview_installation_authority_internal();
  exception when insufficient_privilege then
    return null;
  end;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (context_value ->> 'organizationId')::uuid
    and preview.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and preview.previewer_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
  for key share;
  if not found then
    return null;
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'organizationId', preview_row.organization_id,
      'applicationRootId', preview_row.application_root_id,
      'moduleRootId', item.value -> 'moduleRootId',
      'bindingRevision', 1,
      'applicationReleaseRevision', preview_row.application_release_revision,
      'moduleReleaseRevision', item.value -> 'moduleReleaseRevision',
      'state', 'active'
    ) order by item.value ->> 'moduleRootId' collate "C"
  ), '[]'::jsonb)
  into module_bindings_value
  from pg_catalog.jsonb_array_elements(preview_row.resolved_modules) as item(value);

  return pg_catalog.jsonb_build_object(
    'organizationId', preview_row.organization_id,
    'applicationRootId', preview_row.application_root_id,
    'applicationReleaseRevision', preview_row.application_release_revision,
    'moduleBindings', module_bindings_value,
    'previewInstallationId', preview_row.preview_installation_id,
    'storageIdentities', preview_row.storage_identities
  );
end
$function$;

alter function vortex_definition.read_preview_record_installation_internal(uuid)
  owner to vortex_owner;

revoke all on function vortex_definition.read_preview_record_installation_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_definition.read_preview_record_installation_internal(uuid)
  to vortex_record_adapter, vortex_owner;
comment on function vortex_definition.read_preview_record_installation_internal(uuid) is
  'The installation of one unexpired preview for a builder of its Application in the validated human request: the active installation shape with the preview''s exact release pins, its address and its isolated storage identities.';

set local role vortex_record_adapter;

drop function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid);

create or replace function vortex_record.copy_live_records_to_preview_internal(
  p_preview_installation_id uuid,
  p_record_type_id uuid,
  p_live_storage_contract_id uuid,
  p_preview_storage_contract_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  copy_limit constant integer := 2000;
  live_table_token text;
  preview_table_token text;
  record_columns text[];
  field_columns text[];
  readable_columns text[];
  copied_columns text;
  copied_count bigint := 0;
  live_record record;
  row_read record;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_platform.is_non_nil_uuid(p_record_type_id::text)
    or not vortex_platform.is_non_nil_uuid(p_live_storage_contract_id::text)
    or not vortex_platform.is_non_nil_uuid(p_preview_storage_contract_id::text) then
    raise exception using errcode = '22023', message = 'Preview record copy selector is invalid';
  end if;
  -- The copy reads as the builder reads the installed Application: never in a preview.
  if nullif(pg_catalog.current_setting('vortex_record.preview_installation_id', true), '')
    is not null then
    raise exception using errcode = '42501', message = 'Preview record copy must read live records';
  end if;
  select catalogue.physical_table_token into strict live_table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_live_storage_contract_id
    and catalogue.record_type_id = p_record_type_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
  -- The caller passes the preview's own storage identities; both tables hold this record type.
  select catalogue.physical_table_token into strict preview_table_token
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_preview_storage_contract_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active'
    and catalogue.record_type_id = p_record_type_id;

  -- The columns both tables declare with the same type, except the storage identity each table
  -- fixes for itself: the record columns, and each field the live release and the draft share.
  select
    coalesce(pg_catalog.array_agg(preview_column.attname::text order by preview_column.attnum)
      filter (where preview_column.attname !~ '^f_[0-9a-f]{32}$'), array[]::text[]),
    coalesce(pg_catalog.array_agg(preview_column.attname::text order by preview_column.attnum)
      filter (where preview_column.attname ~ '^f_[0-9a-f]{32}$'), array[]::text[])
  into record_columns, field_columns
  from pg_catalog.pg_attribute as preview_column
  join pg_catalog.pg_class as preview_table on preview_table.oid = preview_column.attrelid
  join pg_catalog.pg_namespace as preview_schema
    on preview_schema.oid = preview_table.relnamespace
  where preview_schema.nspname = 'record_data'
    and preview_table.relname = preview_table_token
    and preview_column.attnum > 0
    and not preview_column.attisdropped
    and preview_column.attname <> 'storage_contract_id'
    and exists (
      select 1
      from pg_catalog.pg_attribute as live_column
      join pg_catalog.pg_class as live_table on live_table.oid = live_column.attrelid
      join pg_catalog.pg_namespace as live_schema on live_schema.oid = live_table.relnamespace
      where live_schema.nspname = 'record_data'
        and live_table.relname = live_table_token
        and live_column.attname = preview_column.attname
        and live_column.attnum > 0
        and not live_column.attisdropped
        and live_column.atttypid = preview_column.atttypid
    );
  if pg_catalog.cardinality(record_columns) = 0
    or not ('record_id' = any(record_columns)) then
    raise exception using errcode = '55000', message = 'Preview record copy has no columns';
  end if;

  -- Only the records the builder reads in the installed Application, each with only the fields
  -- the builder reads there; every other field of a copied record is left empty. Row security
  -- limits the live table to the request's organisation and Application.
  for live_record in
    execute pg_catalog.format(
      'select record_id from record_data.%I order by record_id limit %s',
      live_table_token, copy_limit
    )
  loop
    select projected.projection, projected.read_bounds into row_read
    from vortex_record.read_record_projection_internal(
      p_record_type_id, live_record.record_id
    ) as projected;
    continue when row_read.projection ->> 'outcome' is distinct from 'allowed';
    select coalesce(pg_catalog.array_agg(field_column.value order by field_column.value), array[]::text[])
    into readable_columns
    from pg_catalog.unnest(field_columns) as field_column(value)
    where field_column.value in (
      select 'f_' || pg_catalog.replace(pg_catalog.lower(readable.value #>> '{}'), '-', '')
      from pg_catalog.jsonb_array_elements(row_read.read_bounds -> 'readableFieldIds') as readable(value)
    );
    select pg_catalog.string_agg(pg_catalog.quote_ident(copied.value), ', ')
    into copied_columns
    from pg_catalog.unnest(record_columns || readable_columns) as copied(value);
    execute pg_catalog.format(
      'insert into record_data.%I (storage_contract_id, %s) select %L::uuid, %s from record_data.%I where record_id = $1',
      preview_table_token, copied_columns, p_preview_storage_contract_id, copied_columns,
      live_table_token
    ) using live_record.record_id;
    copied_count := copied_count + 1;
  end loop;

  insert into vortex_record.preview_reference_counters (
    preview_installation_id, storage_contract_id, field_id, next_number
  )
  select p_preview_installation_id, p_preview_storage_contract_id, counter.field_id,
    counter.next_number
  from vortex_record.record_reference_counters as counter
  where counter.storage_contract_id = p_live_storage_contract_id
    and counter.organization_id = vortex_platform.organization_id()
    and counter.next_number >= 2;
  return copied_count;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Preview record copy storage is unavailable';
end
$function$;

alter function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid)
  to vortex_owner;
comment on function vortex_record.copy_live_records_to_preview_internal(uuid, uuid, uuid, uuid) is
  'Seeds one preview record table with the live records of the same record type that the request''s builder reads in the installed Application, each with only the fields they read there, and the reference counters; at most 2,000 records.';

set local role vortex_owner;

create or replace function vortex_record.provision_preview_module_storage(
  p_preview_installation_id uuid,
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  release_row vortex_definition.releases%rowtype;
  record_types jsonb;
  record_type jsonb;
  preview_record_type jsonb;
  field_value jsonb;
  storage_id uuid;
  preview_storage_id uuid;
  record_type_id_value uuid;
  field_id_value uuid;
  table_token text;
  column_token text;
  storage_scope_value text;
  ownership_mode_value text;
  database_type text;
  sql_type text;
  shape_fingerprint text;
  scope_index_columns text;
  index_token text;
  live_table_token text;
  storage_identities jsonb := '[]'::jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text)
    or not vortex_platform.is_non_nil_uuid(p_module_root_id::text)
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Preview storage selector is invalid';
  end if;
  -- The preview's own rehearsed release of an owned Module, or else the stored release.
  select (pg_catalog.jsonb_populate_record(
    null::vortex_definition.releases, preview_release.release
  )).* into release_row
  from vortex_definition.preview_releases as preview_release
  join vortex_definition.roots as root on root.root_id = preview_release.root_id
  where preview_release.preview_installation_id = p_preview_installation_id
    and preview_release.root_id = p_module_root_id
    and preview_release.release_revision = p_module_release_revision
    and root.kind = 'module';
  if not found then
    select release.* into strict release_row
    from vortex_definition.releases as release
    join vortex_definition.roots as root on root.root_id = release.root_id
    where release.root_id = p_module_root_id
      and release.release_revision = p_module_release_revision
      and root.kind = 'module';
  end if;
  if release_row.validation_contract_version <> all (vortex_definition.accepted_contract_version('module'))
    or release_row.source_contract_version
      is distinct from release_row.validation_contract_version
    or release_row.compilation_output #>> '{kind}' is distinct from 'module'
    or release_row.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from p_module_root_id::text
    or release_row.compilation_output #>> '{validationContractVersion}'
      is distinct from release_row.validation_contract_version then
    raise exception using errcode = '23514', message = 'Exact Module release is incompatible';
  end if;
  record_types := release_row.compilation_output #> '{canonical,content,recordTypes}';
  if pg_catalog.jsonb_typeof(record_types) <> 'array' then
    raise exception using errcode = '23514', message = 'Module record storage definition is incompatible';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    where item.value ->> 'storageContractId' is null
      or item.value ->> 'recordTypeId' is null
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'storageContractId')
      or pg_catalog.count(*) <> pg_catalog.count(distinct item.value ->> 'recordTypeId')
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
  ) then
    raise exception using errcode = '23514', message = 'Module record storage identities are duplicated';
  end if;

  -- A system projection is the platform's own read model, which a preview reads as it is: it
  -- has no storage of its own to isolate.
  for record_type in
    select item.value
    from pg_catalog.jsonb_array_elements(record_types) as item(value)
    where not item.value ? 'systemProjection'
    order by item.value ->> 'storageContractId'
  loop
    begin
      storage_id := (record_type ->> 'storageContractId')::uuid;
      record_type_id_value := (record_type ->> 'recordTypeId')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = '42501', message = 'Module record storage identity is invalid';
    end;
    storage_scope_value := record_type ->> 'storageScope';
    ownership_mode_value := record_type ->> 'ownershipMode';
    if not vortex_platform.is_non_nil_uuid(storage_id::text)
      or not vortex_platform.is_non_nil_uuid(record_type_id_value::text)
      or storage_scope_value not in ('organization_shared', 'application_contained')
      or ownership_mode_value not in ('none', 'organization_account', 'group', 'inherited')
      or pg_catalog.jsonb_typeof(record_type -> 'fields') <> 'array'
      or pg_catalog.jsonb_array_length(record_type -> 'fields') < 1
      or pg_catalog.jsonb_typeof(record_type -> 'relationships') <> 'array' then
      raise exception using errcode = '42501', message = 'Module record storage definition is invalid';
    end if;

    preview_storage_id := pg_catalog.gen_random_uuid();
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex_record.storage:' || preview_storage_id::text, 0)
    );
    table_token := 'rt_' || pg_catalog.replace(pg_catalog.lower(preview_storage_id::text), '-', '');
    preview_record_type := pg_catalog.jsonb_set(
      record_type,
      '{storageContractId}',
      pg_catalog.to_jsonb(preview_storage_id::text),
      true
    );
    shape_fingerprint := vortex_record.storage_meaning_fingerprint(preview_record_type);

    -- The live storage of this record type, when it has any: the builder's readable records are
    -- seeded from it after provisioning, under the builder's own live access.
    select catalogue.physical_table_token into live_table_token
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = storage_id
      and catalogue.physical_schema_token = 'record_data'
      and catalogue.state = 'active';
    perform vortex_record.create_record_storage_table_internal(
      preview_storage_id, p_module_root_id, record_type_id_value,
      storage_scope_value, ownership_mode_value
    );
    insert into vortex_record.storage_catalogue (
      storage_contract_id, physical_schema_token, physical_table_token,
      module_root_id, record_type_id, storage_scope,
      first_compatible_release_revision, last_compatible_release_revision,
      state, content_fingerprint, record_type_definition, protected_read_model_key
    ) values (
      preview_storage_id, 'record_data', table_token,
      p_module_root_id, record_type_id_value, storage_scope_value,
      p_module_release_revision, p_module_release_revision,
      'active', shape_fingerprint, preview_record_type, null
    );

    for field_value in
      select item.value
      from pg_catalog.jsonb_array_elements(record_type -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      begin
        field_id_value := (field_value ->> 'fieldId')::uuid;
      exception when invalid_text_representation then
        raise exception using errcode = '42501', message = 'Record field storage identity is invalid';
      end;
      if not vortex_platform.is_non_nil_uuid(field_id_value::text)
        or field_value ->> 'type' is null
        or pg_catalog.jsonb_typeof(field_value -> 'required') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'unique') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'filterable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'sortable') <> 'boolean'
        or pg_catalog.jsonb_typeof(field_value -> 'settings') <> 'object' then
        raise exception using errcode = '42501', message = 'Record field storage definition is invalid';
      end if;
      column_token := 'f_' || pg_catalog.replace(pg_catalog.lower(field_id_value::text), '-', '');
      database_type := vortex_record.database_value_type(field_value);
      if database_type is null then
        raise exception using errcode = '23514', message = 'Record field storage type is unsupported';
      end if;
      sql_type := vortex_record.sql_value_type(database_type);
      execute pg_catalog.format(
        'alter table record_data.%I add column %I %s%s',
        table_token, column_token, sql_type,
        -- Copied live records have no value for a field the draft adds, so only fresh storage
        -- enforces a required field in the table; the save path enforces it for every record.
        case when (field_value ->> 'required')::boolean and live_table_token is null
          then ' not null' else '' end
      );
      insert into vortex_record.field_storage_mappings (
        storage_contract_id, field_id, physical_column_token, database_value_type,
        field_definition, introduced_by_module_root_id, introduced_at_release_revision, state
      ) values (
        preview_storage_id, field_id_value, column_token, database_type, field_value,
        p_module_root_id, p_module_release_revision, 'active'
      );
      if not (record_type ? 'systemProjection')
        and (field_value ->> 'unique')::boolean then
        scope_index_columns := case storage_scope_value
          when 'organization_shared' then 'organisation_id'
          else 'organisation_id, application_root_id'
        end;
        index_token := 'pux_' || pg_catalog.md5(
          preview_storage_id::text || ':' || field_id_value::text
        );
        execute pg_catalog.format(
          'create unique index %I on record_data.%I (%s, %I) where lifecycle_state in (''active'', ''soft_deleted'', ''removal_pending'')',
          index_token, table_token, scope_index_columns, column_token
        );
      end if;
    end loop;

    insert into vortex_record.preview_storage_bindings (
      preview_installation_id, storage_contract_id, module_root_id,
      module_release_revision, record_type_id, release_storage_contract_id
    ) values (
      p_preview_installation_id, preview_storage_id, p_module_root_id,
      p_module_release_revision, record_type_id_value, storage_id
    );
    storage_identities := storage_identities || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', p_module_root_id,
        'moduleReleaseRevision', p_module_release_revision,
        'recordTypeId', record_type_id_value,
        'releaseStorageContractId', storage_id,
        'previewStorageContractId', preview_storage_id
      )
    );
  end loop;
  return storage_identities;
exception
  when no_data_found then
    raise exception using errcode = 'P0002', message = 'Exact Module release is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000', message = 'Exact Module release is ambiguous';
end
$function$;

alter function vortex_record.provision_preview_module_storage(uuid,uuid,bigint) owner to vortex_owner;

revoke all on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint)
  to vortex_owner;
comment on function vortex_record.provision_preview_module_storage(uuid, uuid, bigint) is
  'Creates empty isolated Record storage for every record type of one exact Module release of a preview, its rehearsed release or a stored one, without provisioning its live release identities.';

create or replace function vortex_definition.create_preview_installation(
  p_application_root_id uuid,
  p_expected_draft_revision bigint,
  p_releases jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_lifetime constant interval := interval '24 hours';
  checked_context jsonb;
  organization_id_value uuid;
  organization_account_id_value uuid;
  identity_id_value uuid;
  preview_installation_id_value uuid;
  draft_revision_value bigint;
  current_release_revision_value bigint;
  application_release_revision_value bigint;
  created_at_value timestamptz;
  expires_at_value timestamptz;
  previous_preview record;
  module_pin record;
  owned_release record;
  application_content_value jsonb;
  system_projection_ids_value uuid[] := array[]::uuid[];
  resolved_modules_value jsonb := '[]'::jsonb;
  storage_identities_value jsonb := '[]'::jsonb;
begin
  if not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_expected_draft_revision is null
    or p_expected_draft_revision not between 1 and 9007199254740991
    or pg_catalog.jsonb_typeof(p_releases) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_releases) > 201
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_releases) as item(value)
      where pg_catalog.jsonb_typeof(item.value -> 'release') is distinct from 'object'
        or pg_catalog.jsonb_typeof(item.value -> 'dependencies') is distinct from 'array'
        or not coalesce(pg_catalog.pg_input_is_valid(item.value #>> '{release,root_id}', 'uuid'), false)
        or not coalesce(pg_catalog.pg_input_is_valid(
          item.value #>> '{release,release_revision}', 'bigint'
        ), false)
    ) then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  organization_id_value := (checked_context ->> 'organizationId')::uuid;
  organization_account_id_value := (checked_context ->> 'organizationAccountId')::uuid;
  identity_id_value := (checked_context ->> 'identityId')::uuid;
  -- A preview is provisioned in the organisation's context: the Application it previews may have
  -- no installation, and so no Application context, yet.
  if checked_context ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;

  select draft.draft_revision, root.current_release_revision
  into draft_revision_value, current_release_revision_value
  from vortex_definition.roots as root
  join vortex_definition.drafts as draft on draft.root_id = root.root_id
  where root.root_id = p_application_root_id
    and root.organization_id = organization_id_value
    and root.kind = 'application'
  for share of draft;
  if not found or draft_revision_value <> p_expected_draft_revision then
    raise exception using errcode = '40001', message = 'Application draft revision changed';
  end if;

  -- Each rehearsed release is the release a publication of this draft writes: the Application
  -- at its draft revision, or an owned Module at its staged draft revision, newer than the
  -- current release of its root and of that root's kind; at most one per root.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_releases) as item(value)
    where not exists (
      select 1
      from vortex_definition.roots as root
      join vortex_definition.drafts as draft on draft.root_id = root.root_id
      where root.root_id = (item.value #>> '{release,root_id}')::uuid
        and root.organization_id = organization_id_value
        and (root.root_id = p_application_root_id
          or (root.kind = 'module' and root.owner_application_root_id = p_application_root_id))
        and draft.draft_revision = (item.value #>> '{release,release_revision}')::bigint
        and draft.draft_revision > coalesce(root.current_release_revision, 0)
        and item.value #>> '{release,compilation_output,kind}' = root.kind
        and not exists (
          select 1
          from pg_catalog.jsonb_array_elements(item.value -> 'dependencies') as dependency(value)
          where dependency.value ->> 'root_id' is distinct from root.root_id::text
            or dependency.value ->> 'release_revision' is distinct from draft.draft_revision::text
        )
    )
  ) or (
    select pg_catalog.count(*) <> pg_catalog.count(distinct item.value #>> '{release,root_id}')
    from pg_catalog.jsonb_array_elements(p_releases) as item(value)
  ) then
    raise exception using errcode = '23514',
      message = 'Rehearsed preview releases are not this Application draft';
  end if;
  application_release_revision_value := coalesce((
    select (item.value #>> '{release,release_revision}')::bigint
    from pg_catalog.jsonb_array_elements(p_releases) as item(value)
    where (item.value #>> '{release,root_id}')::uuid = p_application_root_id
  ), current_release_revision_value);
  if application_release_revision_value is null then
    raise exception using errcode = 'P0002', message = 'Application has no release to preview';
  end if;

  -- One preview per Application: a new preview replaces the previous one and its storage.
  for previous_preview in
    select preview.preview_installation_id
    from vortex_definition.preview_installations as preview
    where preview.organization_id = organization_id_value
      and preview.application_root_id = p_application_root_id
    order by preview.preview_installation_id
    for update
  loop
    perform vortex_record.drop_preview_installation_storage(
      previous_preview.preview_installation_id
    );
    delete from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = previous_preview.preview_installation_id;
  end loop;
  perform vortex_definition.expire_preview_installations(100);

  preview_installation_id_value := pg_catalog.gen_random_uuid();
  created_at_value := pg_catalog.statement_timestamp();
  expires_at_value := created_at_value + preview_lifetime;
  insert into vortex_definition.preview_installations (
    preview_installation_id, organization_id, application_root_id,
    draft_revision, application_release_revision, previewer_identity_id,
    previewer_organization_account_id, resolved_modules, storage_identities,
    created_at, expires_at
  ) values (
    preview_installation_id_value, organization_id_value, p_application_root_id,
    p_expected_draft_revision, application_release_revision_value, identity_id_value,
    organization_account_id_value, '[]'::jsonb, '[]'::jsonb,
    created_at_value, expires_at_value
  );
  insert into vortex_definition.preview_releases (
    preview_installation_id, root_id, release_revision, release, dependencies
  )
  select preview_installation_id_value, (item.value #>> '{release,root_id}')::uuid,
    (item.value #>> '{release,release_revision}')::bigint,
    item.value -> 'release', item.value -> 'dependencies'
  from pg_catalog.jsonb_array_elements(p_releases) as item(value);

  -- The exact Module pins of the previewed Application release, through every Module dependency,
  -- each read from this preview's rehearsed releases first and the stored releases otherwise.
  for module_pin in
    with recursive edges as (
      select dependency.root_id, dependency.release_revision,
        dependency.target_root_id, dependency.target_release_revision
      from vortex_definition.release_dependencies as dependency
      where dependency.dependency_kind = 'module'
        and not exists (
          select 1 from vortex_definition.preview_releases as preview
          where preview.preview_installation_id = preview_installation_id_value
            and preview.root_id = dependency.root_id
            and preview.release_revision = dependency.release_revision
        )
      union all
      select preview.root_id, preview.release_revision,
        (dependency.value ->> 'target_root_id')::uuid,
        (dependency.value ->> 'target_release_revision')::bigint
      from vortex_definition.preview_releases as preview
      cross join lateral pg_catalog.jsonb_array_elements(preview.dependencies) as dependency(value)
      where preview.preview_installation_id = preview_installation_id_value
        and dependency.value ->> 'dependency_kind' = 'module'
    ), closure(module_root_id, module_release_revision) as (
      select edge.target_root_id, edge.target_release_revision
      from edges as edge
      where edge.root_id = p_application_root_id
        and edge.release_revision = application_release_revision_value
      union
      select edge.target_root_id, edge.target_release_revision
      from closure
      join edges as edge
        on edge.root_id = closure.module_root_id
        and edge.release_revision = closure.module_release_revision
    )
    select closure.module_root_id, closure.module_release_revision,
      coalesce(
        (select preview.release ->> 'release_version'
          from vortex_definition.preview_releases as preview
          where preview.preview_installation_id = preview_installation_id_value
            and preview.root_id = closure.module_root_id
            and preview.release_revision = closure.module_release_revision),
        (select release.release_version
          from vortex_definition.releases as release
          join vortex_definition.roots as root on root.root_id = release.root_id
          where release.root_id = closure.module_root_id
            and release.release_revision = closure.module_release_revision
            and root.kind = 'module'
            and root.organization_id = organization_id_value)
      ) as release_version
    from closure
    order by closure.module_root_id, closure.module_release_revision
  loop
    if module_pin.module_root_id is null
      or module_pin.module_release_revision not between 1 and 9007199254740991
      or module_pin.release_version is null
      or resolved_modules_value @> pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('moduleRootId', module_pin.module_root_id)
      ) then
      raise exception using errcode = '23514',
        message = 'Preview Module pins are unavailable or ambiguous';
    end if;
    resolved_modules_value := resolved_modules_value || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'moduleRootId', module_pin.module_root_id,
        'moduleReleaseRevision', module_pin.module_release_revision,
        'releaseVersion', module_pin.release_version
      )
    );
    storage_identities_value := storage_identities_value
      || vortex_record.provision_preview_module_storage(
        preview_installation_id_value, module_pin.module_root_id,
        module_pin.module_release_revision
      );
  end loop;
  if pg_catalog.jsonb_array_length(resolved_modules_value) = 0 then
    raise exception using errcode = '23514', message = 'Previewed Application binds no Module';
  end if;

  -- The preview's own permission registration: what the previewed Application and its own
  -- Modules declare, at the releases the preview runs, and the draft's roles, which only the
  -- builder who opened the preview holds. A used Module's permissions are not part of it.
  insert into vortex_access.preview_permission_registrations (
    preview_installation_id, organization_id, application_root_id, organization_account_id,
    owned_owner_ids, role_ids
  )
  select preview_installation_id_value, organization_id_value, p_application_root_id,
    organization_account_id_value,
    pg_catalog.array_append(
      coalesce(pg_catalog.array_agg(owned.module_root_id order by owned.module_root_id), array[]::uuid[]),
      p_application_root_id
    ),
    array[]::uuid[]
  from (
    select (pin.value ->> 'moduleRootId')::uuid as module_root_id
    from pg_catalog.jsonb_array_elements(resolved_modules_value) as pin(value)
    join vortex_definition.roots as root
      on root.root_id = (pin.value ->> 'moduleRootId')::uuid
    where root.organization_id = organization_id_value
      and root.kind = 'module'
      and root.owner_application_root_id = p_application_root_id
  ) as owned;

  for owned_release in
    select pinned.root_id, root.key, pinned.owner_kind,
      coalesce(preview.release, pg_catalog.to_jsonb(stored.*)) as release
    from (
      select p_application_root_id as root_id, application_release_revision_value as release_revision,
        'application'::text as owner_kind
      union all
      select (pin.value ->> 'moduleRootId')::uuid, (pin.value ->> 'moduleReleaseRevision')::bigint,
        'module'
      from pg_catalog.jsonb_array_elements(resolved_modules_value) as pin(value)
    ) as pinned
    join vortex_definition.roots as root
      on root.root_id = pinned.root_id
      and root.organization_id = organization_id_value
      and root.kind = pinned.owner_kind
      and (root.root_id = p_application_root_id
        or root.owner_application_root_id = p_application_root_id)
    left join vortex_definition.preview_releases as preview
      on preview.preview_installation_id = preview_installation_id_value
      and preview.root_id = pinned.root_id
      and preview.release_revision = pinned.release_revision
    left join vortex_definition.releases as stored
      on preview.root_id is null
      and stored.root_id = pinned.root_id
      and stored.release_revision = pinned.release_revision
    order by pinned.owner_kind, pinned.root_id
  loop
    if owned_release.release is null
      or pg_catalog.jsonb_typeof(
        owned_release.release #> '{compilation_output,canonical,content,permissions}'
      ) is distinct from 'array' then
      raise exception using errcode = '23514',
        message = 'Previewed permission declarations are unavailable';
    end if;
    if owned_release.owner_kind = 'application' then
      application_content_value := owned_release.release #> '{compilation_output,canonical,content}';
    end if;
    -- A system projection is the platform's own live read model: no preview role reaches it.
    system_projection_ids_value := system_projection_ids_value || coalesce((
      select pg_catalog.array_agg((record_type.value ->> 'recordTypeId')::uuid)
      from pg_catalog.jsonb_array_elements(
        coalesce(owned_release.release #> '{compilation_output,canonical,content,recordTypes}', '[]'::jsonb)
      ) as record_type(value)
      where record_type.value ? 'systemProjection'
    ), array[]::uuid[]);
    insert into vortex_access.preview_permission_entries (
      preview_installation_id, entry, held
    )
    select preview_installation_id_value,
      pg_catalog.jsonb_populate_record(
        null::vortex_access.permission_catalogue_entries,
        pg_catalog.jsonb_build_object(
          'organization_id', organization_id_value,
          'registration_kind', 'application',
          'registration_owner_id', p_application_root_id,
          'registration_revision', 1,
          'application_root_id', p_application_root_id,
          'owner_kind', owned_release.owner_kind,
          'owner_id', owned_release.root_id,
          'permission_id', permission.value ->> 'permissionId',
          'permission_key', permission.value ->> 'key',
          'label', permission.value ->> 'label',
          'description', permission.value ->> 'description',
          'record_type_id', permission.value ->> 'recordTypeId',
          'action_kind', permission.value ->> 'actionKind',
          'named_action', permission.value ->> 'namedAction',
          'administrative', permission.value -> 'administrative',
          'source_kind', owned_release.owner_kind,
          'source_definition_key', owned_release.key,
          'source_root_id', owned_release.root_id,
          'source_version', owned_release.release ->> 'release_version',
          'source_revision', owned_release.release -> 'release_revision',
          'source_validation_contract_version',
            owned_release.release ->> 'validation_contract_version',
          'meaning_fingerprint', owned_release.release ->> 'content_fingerprint',
          'record_scope', permission.value -> 'recordScope',
          'field_policy', permission.value -> 'fieldPolicy'
        )
      ),
      false
    from pg_catalog.jsonb_array_elements(
      owned_release.release #> '{compilation_output,canonical,content,permissions}'
    ) as permission(value);
  end loop;
  if application_content_value is null
    or pg_catalog.jsonb_typeof(application_content_value -> 'roles') is distinct from 'array' then
    raise exception using errcode = '23514',
      message = 'Previewed permission declarations are unavailable';
  end if;

  -- The builder holds every role of the draft: a permission is held when a role selects it, an
  -- Application-wide selection taking only the Application's ordinary permissions, as it does
  -- at installation. A permission on a system projection is never held in a preview.
  update vortex_access.preview_permission_entries as preview_entry
  set held = true
  where preview_entry.preview_installation_id = preview_installation_id_value
    and not coalesce((preview_entry.entry).record_type_id = any(system_projection_ids_value), false)
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(application_content_value -> 'roles') as role(value)
      where role.value -> 'permissionKeys' ? (preview_entry.entry).permission_key
        and (
          role.value #>> '{permissionSelection,kind}' = 'exact'
          or (
            role.value #>> '{permissionSelection,kind}' = 'application_wildcard'
            and (preview_entry.entry).owner_kind = 'application'
            and not (preview_entry.entry).administrative
            and (preview_entry.entry).action_kind <> 'export'
          )
        )
    );
  update vortex_access.preview_permission_registrations as registration
  set role_ids = coalesce((
    select pg_catalog.array_agg(distinct (role.value ->> 'roleId')::uuid)
    from pg_catalog.jsonb_array_elements(application_content_value -> 'roles') as role(value)
  ), array[]::uuid[])
  where registration.preview_installation_id = preview_installation_id_value;

  update vortex_definition.preview_installations as preview
  set resolved_modules = resolved_modules_value,
      storage_identities = storage_identities_value
  where preview.preview_installation_id = preview_installation_id_value;

  return pg_catalog.jsonb_build_object(
    'previewInstallationId', preview_installation_id_value,
    'organizationId', organization_id_value,
    'applicationRootId', p_application_root_id,
    'draftRevision', p_expected_draft_revision,
    'applicationReleaseRevision', application_release_revision_value,
    'createdAt', created_at_value,
    'expiresAt', expires_at_value,
    -- The builder's live records reach the preview only through the installed Application.
    'seedable', exists (
      select 1
      from vortex_access.permission_registrations as registration
      where registration.organization_id = organization_id_value
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_application_root_id
        and registration.state = 'active'
    )
  );
end
$function$;

alter function vortex_definition.create_preview_installation(uuid, bigint, jsonb) owner to vortex_owner;

revoke all on function vortex_definition.create_preview_installation(uuid, bigint, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.create_preview_installation(uuid, bigint, jsonb)
  to vortex_request;
comment on function vortex_definition.create_preview_installation(uuid, bigint, jsonb) is
  'Replaces the 24-hour preview of one Application with a preview of its current draft: the releases its publication rehearsed, the exact Module pins they and the used Module releases name, the preview''s own permission registration whose draft roles only its builder holds, and empty isolated storage for every bound record type.';

create or replace function vortex_definition.seed_preview_installation(
  p_preview_installation_id uuid
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  preview_row vortex_definition.preview_installations;
  storage_identity jsonb;
  seeded_count bigint := 0;
begin
  if not vortex_platform.is_non_nil_uuid(p_preview_installation_id::text) then
    raise exception using errcode = '22023', message = 'Preview installation command is invalid';
  end if;
  -- The seed reads the installed Application as its builder reads it: the request runs in the
  -- installed Application's own context, never in the preview.
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  if not checked_context ? 'applicationRootId'
    or nullif(pg_catalog.current_setting('vortex_record.preview_installation_id', true), '')
      is not null then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and preview.application_root_id = (checked_context ->> 'applicationRootId')::uuid
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Preview installation is unavailable';
  end if;
  if preview_row.seeded_at is not null or preview_row.runtime_release_set is not null then
    raise exception using errcode = '55000', message = 'Preview installation is already seeded';
  end if;

  for storage_identity in
    select identity.value
    from pg_catalog.jsonb_array_elements(preview_row.storage_identities) as identity(value)
    where exists (
      select 1
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = (identity.value ->> 'releaseStorageContractId')::uuid
        and catalogue.physical_schema_token = 'record_data'
        and catalogue.state = 'active'
    )
    order by identity.value ->> 'previewStorageContractId'
  loop
    seeded_count := seeded_count + vortex_record.copy_live_records_to_preview_internal(
      p_preview_installation_id,
      (storage_identity ->> 'recordTypeId')::uuid,
      (storage_identity ->> 'releaseStorageContractId')::uuid,
      (storage_identity ->> 'previewStorageContractId')::uuid
    );
  end loop;
  update vortex_definition.preview_installations as preview
  set seeded_at = pg_catalog.statement_timestamp()
  where preview.preview_installation_id = p_preview_installation_id;
  return seeded_count;
end
$function$;

alter function vortex_definition.seed_preview_installation(uuid) owner to vortex_owner;

revoke all on function vortex_definition.seed_preview_installation(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.seed_preview_installation(uuid) to vortex_request;
comment on function vortex_definition.seed_preview_installation(uuid) is
  'Seeds a new preview''s storage, once, with the live records its builder reads in the installed Application and only the fields they read there. A preview never shows more than its builder sees live, plus what they create in it.';

reset role;
