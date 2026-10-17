-- Preview works before the first publish and for draft-only permissions (#2798).
-- A preview now has its own permission registration, written when it is provisioned from the
-- rehearsed releases: the permissions the previewed Application and its own Modules declare, and
-- the draft's roles, which only the builder who opened the preview holds. One function,
-- request_application_registration_internal, says which registration a request runs under: the
-- installed one, or for a preview request only the preview's own. The scope gates, the address
-- check, the permission role path, the launcher's roles and the record-link check all take it from
-- there. A used Module's permissions are still decided by the builder's own live access, and no
-- preview role reaches a system projection: a preview reads every system projection, of its own
-- Modules or a used one, on the live path under the builder's own live access. A preview's
-- installation is only its builder's.
-- A preview is provisioned in the organisation's context, so an Application with no installation
-- can be previewed. Its storage is created empty and then seeded, under the builder's own live
-- access in the installed Application, with only the records and fields the builder reads there:
-- at most the first 2,000 readable records of each record type, a deliberate preview bound the
-- preview tells the builder about when it is reached.
set local role vortex_owner;

alter table vortex_definition.preview_installations
  add column seeded_at timestamptz,
  -- The record types whose seed reached the preview bound of 2,000 readable records.
  add column seed_bounded_record_type_ids uuid[] not null default '{}';

create table vortex_access.preview_permission_registrations (
  preview_installation_id uuid not null
    references vortex_definition.preview_installations (preview_installation_id) on delete cascade,
  organization_id uuid not null,
  application_root_id uuid not null,
  organization_account_id uuid not null,
  system_projection_record_type_ids uuid[] not null,
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
  system_projection_record_type_ids uuid[],
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
      null::uuid[], null::uuid[], null::timestamptz
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
    registration.system_projection_record_type_ids, registration.role_ids, preview.expires_at
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
  -- roles there. Every other permission, a used Module's included, and every permission on a
  -- system projection, the platform's live read model, is decided by the builder's own live
  -- access below; the preview's roles never apply to it.
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
    if permission_owner_value = any(preview_registration.owned_owner_ids)
      and not coalesce(
        p_record_type_id = any(preview_registration.system_projection_record_type_ids), false
      ) then
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
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  -- The deliberate preview bound: a preview holds at most this many records of one record type,
  -- the first the builder can read in record order. The seed says when the bound was reached, and
  -- the preview tells the builder so.
  copy_limit constant integer := 2000;
  bounded boolean := false;
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
  -- limits the live table to the request's organisation and Application. The bound counts only
  -- readable records, in record order, so the builder gets the first records they can see.
  for live_record in
    execute pg_catalog.format(
      'select record_id from record_data.%I order by record_id', live_table_token
    )
  loop
    select projected.projection, projected.read_bounds into row_read
    from vortex_record.read_record_projection_internal(
      p_record_type_id, live_record.record_id
    ) as projected;
    continue when row_read.projection ->> 'outcome' is distinct from 'allowed';
    if copied_count = copy_limit then
      bounded := true;
      exit;
    end if;
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
  return pg_catalog.jsonb_build_object('copied', copied_count, 'bounded', bounded);
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
  'Seeds one preview record table with the live records of the same record type that the request''s builder reads in the installed Application, each with only the fields they read there, and the reference counters: the first 2,000 they read, in record order, and whether there were more.';

create or replace function vortex_record.load_record_access_facts_from_installation_internal(
  p_record_type_id uuid,
  p_action_kind text,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_installation jsonb,
  p_projection_row jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  plan jsonb;
  type_meta jsonb := '{}'::jsonb;
  relationship_by_id jsonb := '{}'::jsonb;
  condition_list jsonb := '[]'::jsonb;
  permission_by_id jsonb := '{}'::jsonb;
  required_permissions jsonb;
  declaration jsonb;
  target_meta jsonb;
  target_table text;
  target_scope text;
  target_module_root_id uuid;
  target_release_revision bigint;
  target_is_system_projection boolean;
  preview_target boolean;
  target_source_sql text;
  target_projection_definition jsonb;
  target_projection_sort_key text;
  projection_reader_sql text;
  records_by_id jsonb := '{}'::jsonb;
  candidate_edges jsonb := '[]'::jsonb;
  load_contracts uuid[] := array[]::uuid[];
  load_records uuid[] := array[]::uuid[];
  pair_records uuid[] := array[]::uuid[];
  pair_permissions uuid[] := array[]::uuid[];
  seen_pairs text[] := array[]::text[];
  pair_identity text;
  current_contract uuid;
  current_record uuid;
  current_permission uuid;
  batch_record_ids uuid[];
  loaded_row record;
  current_meta jsonb;
  current_scope jsonb;
  route_item jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  load_sql text;
  record_fact jsonb;
  target_fact jsonb;
  target_concurrency_number bigint;
  target_definition_revision bigint;
  facts jsonb;
begin
  if p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore', 'transfer')
    or (p_expected_concurrency_number is not null
      and p_expected_concurrency_number not between 1 and 9007199254740991) then
    raise exception using errcode = '22023',
      message = 'Record adapter selector is invalid';
  end if;

  -- Step 1: the verified request context. The adapter never reads
  -- `current_user`, which is its own owner inside a definer function.
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := case
    when context_value ? 'applicationRootId'
      then (context_value ->> 'applicationRootId')::uuid
    else null
  end;
  if context_application_root_id is null then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;

  -- Step 2: the exact installation supplied by the trusted caller. Its reader
  -- owns the pin-set rules; this adapter consumes them and adds none.
  -- Step 3: the cached access plan. Definitions, column maps, permission
  -- alternatives and saved conditions are resolved once per installation
  -- binding revision and reused by every load below.
  plan := vortex_record.resolve_installation_access_plan_internal(p_installation);
  if (plan ->> 'organizationId')::uuid is distinct from context_organization_id
    or (plan ->> 'applicationRootId')::uuid is distinct from context_application_root_id then
    raise exception using errcode = '42501',
      message = 'Record adapter requires an application context';
  end if;
  type_meta := plan -> 'recordTypes';
  relationship_by_id := plan -> 'relationships';
  condition_list := plan -> 'sharingConditions';
  permission_by_id := plan -> 'permissions';

  target_meta := type_meta -> pg_catalog.lower(p_record_type_id::text);
  if target_meta is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  target_table := target_meta ->> 'table';
  target_scope := target_meta ->> 'storageScope';
  target_module_root_id := (target_meta ->> 'moduleRootId')::uuid;
  target_release_revision := (target_meta ->> 'releaseRevision')::bigint;
  if pg_catalog.jsonb_typeof(target_meta -> 'isSystemProjection')
    is distinct from 'boolean' then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  end if;
  target_is_system_projection := (target_meta ->> 'isSystemProjection')::boolean;

  target_source_sql := pg_catalog.format('record_data.%I as stored', target_table);
  if target_is_system_projection then
    select storage.record_type_definition into target_projection_definition
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = (target_meta ->> 'storageContractId')::uuid
      and storage.physical_schema_token = 'system_projection'
      and storage.state = 'active';
    if not found then
      raise exception using errcode = '55000',
        message = 'Protected projection reader is unavailable';
    end if;
    if pg_catalog.jsonb_typeof(target_projection_definition -> 'fields') is distinct from 'array'
      or pg_catalog.jsonb_typeof(target_projection_definition -> 'systemProjection')
        is distinct from 'object' then
      raise exception using errcode = '55000',
        message = 'Protected projection definition is invalid';
    end if;
    select field.value ->> 'key' into target_projection_sort_key
    from pg_catalog.jsonb_array_elements(target_projection_definition -> 'fields')
      as field(value)
    where field.value ->> 'fieldId'
      = target_projection_definition #>> '{systemProjection,sortableFieldIds,0}';
    if target_projection_definition #> '{systemProjection,sortableFieldIds,0}' is not null
      and target_projection_sort_key is null then
      raise exception using errcode = '55000',
        message = 'Protected projection sort field is invalid';
    end if;
    target_projection_sort_key := coalesce(target_projection_sort_key, 'record_id');
    -- Shape each protected reader row as the existing view's composite type.
    -- The view supplies the type only: its unbounded reader is never scanned.
    projection_reader_sql := case when p_projection_row is null then pg_catalog.format(
      'vortex_record.read_system_projection_rows_internal(%L::uuid, array[$2]::uuid[], %L, ''ascending'', null::jsonb, 1) as projection',
      (target_meta ->> 'storageContractId')::uuid, target_projection_sort_key
    ) else
      'pg_catalog.jsonb_to_record($3) as projection(organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb)'
    end;
    target_source_sql := pg_catalog.format($source$
      %s
      cross join lateral pg_catalog.jsonb_populate_record(
        null::record_data.%I,
        pg_catalog.jsonb_build_object(
          'organisation_id', projection.organization_id,
          'module_root_id', %L::uuid,
          'record_type_id', %L::uuid,
          'storage_contract_id', %L::uuid,
          'record_id', projection.record_id,
          'definition_revision', %L::bigint,
          'lifecycle_state', 'active',
          'concurrency_number', projection.revision
        ) || coalesce((
          select pg_catalog.jsonb_object_agg(
            'f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''),
            case
              when field.value ->> 'fieldId' = %L
                then pg_catalog.to_jsonb(projection.organization_id::text)
              when field.value ->> 'fieldId' = %L
                then pg_catalog.to_jsonb(projection.revision)
              else projection.attribute_values -> (field.value ->> 'key')
            end
          )
          from pg_catalog.jsonb_array_elements(%L::jsonb -> 'fields') as field(value)
        ), '{}'::jsonb)
      ) as stored$source$,
      projection_reader_sql, target_table, target_module_root_id, p_record_type_id,
      (target_meta ->> 'storageContractId')::uuid, target_release_revision,
      target_projection_definition #>> '{systemProjection,organizationFieldId}',
      target_projection_definition #>> '{systemProjection,revisionFieldId}',
      target_projection_definition
    );
  end if;

  -- A preview reads its own copy of every record type except a system projection: that is the
  -- platform's live read model, which a preview reads on the live path under the reader's own
  -- live access, never as the preview's owner.
  preview_target := p_installation ? 'previewInstallationId' and not target_is_system_projection;

  -- Step 4: the declaration. Every record-scoped permission of this action
  -- kind declared for this exact record type, owned by the context Application
  -- or by the record type's own Module, in the canonical order the eligibility
  -- core requires.
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'applicationRootId', context_application_root_id,
      'ownerKind', declared.value ->> 'ownerKind',
      'ownerId', (declared.value ->> 'ownerId')::uuid,
      'permissionId', declared.key::uuid
    )
    order by declared.value ->> 'ownerKind' collate "C", declared.key collate "C"
  )
  into required_permissions
  from pg_catalog.jsonb_each(permission_by_id) as declared(key, value)
  where pg_catalog.lower(declared.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and declared.value ->> 'actionKind' = p_action_kind
    -- `->>` and not `->`: a permission that declares no named action is stored
    -- here as JSON null, which `-> 'namedAction' is null` would never match, so
    -- that test would leave every declaration empty and refuse every record.
    and (declared.value ->> 'namedAction') is null
    and (
      (declared.value ->> 'ownerKind') = 'application'
      or (declared.value ->> 'ownerId')::uuid = target_module_root_id
    );

  declaration := case
    when required_permissions is null
      and not preview_target then null
    else pg_catalog.jsonb_build_object(
      'operationKey', 'record.' || p_action_kind,
      'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
      'target', pg_catalog.jsonb_build_object(
        'kind', 'application', 'applicationRootId', context_application_root_id
      ),
      'requiredPermissions', coalesce(required_permissions, '[]'::jsonb),
      'recordBinding', pg_catalog.jsonb_build_object(
        'moduleRootId', target_module_root_id,
        'recordTypeId', p_record_type_id,
        'storageContractId', (target_meta ->> 'storageContractId')::uuid,
        'storageScope', target_scope
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object(
        'kind', case when preview_target
          then 'preview_owner' else 'permission' end
      )
    )
  end;

  -- Step 5: the target row. The change path locks it here, before any other
  -- row is read, and refuses a stale number without doing the closure work.
  -- Organisation and application isolation is the scope policy's, which is what
  -- makes a foreign row indistinguishable from a missing one.
  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_build_object(
       ''recordScope'', pg_catalog.jsonb_build_object(
         ''storageScope'', %L,
         ''organizationId'', stored.organisation_id,
         ''moduleRootId'', %L::uuid,
         ''recordTypeId'', %L::uuid,
         ''storageContractId'', %L::uuid,
         ''recordId'', stored.record_id
       ) || case when %L = ''application_contained''
         then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
         else ''{}''::jsonb end,
       ''lifecycleState'', stored.lifecycle_state,
       ''fieldValues'', pg_catalog.jsonb_build_object(%s)
     ) || case
       when stored.owner_organisation_account_id is not null
         then pg_catalog.jsonb_build_object(
           ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
       when stored.owner_group_id is not null
         then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
       else ''{}''::jsonb end,
     stored.concurrency_number, stored.definition_revision
     from %s
     where stored.organisation_id = $1 and stored.record_id = $2%s',
    target_scope, target_module_root_id, p_record_type_id,
    (target_meta ->> 'storageContractId')::uuid, target_scope,
    target_meta ->> 'valueExpression', target_source_sql,
    case when p_expected_concurrency_number is null then '' else ' for update' end
  );

  execute load_sql
  into record_fact, target_concurrency_number, target_definition_revision
  using context_organization_id, p_record_id, p_projection_row;

  if record_fact is null then
    return pg_catalog.jsonb_build_object('outcome', 'missing');
  end if;

  if p_expected_concurrency_number is not null
    and target_concurrency_number <> p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', target_concurrency_number
    );
  end if;

  -- A compatible reprovision can advance the shared projection view while an
  -- older release remains installed. Report that exact projection definition;
  -- generated records keep their persisted last-written definition revision.
  if target_is_system_projection then
    target_definition_revision := target_release_revision;
  end if;

  records_by_id := pg_catalog.jsonb_build_object(
    pg_catalog.lower(p_record_id::text), record_fact
  );
  target_fact := record_fact;

  -- Step 6: the fact closure. Two queues drain into one loop: rows still to
  -- load, and (record, permission) pairs still to expand. A pair is expanded at
  -- most once, which bounds the walk; an inherited-ownership chain is expanded
  -- by pushing the parent under the same permission, so the chase and the
  -- relationship routes use the same mechanism.
  if declaration is not null then
    for route_item in
      select item.value from pg_catalog.jsonb_array_elements(required_permissions) as item(value)
    loop
      pair_records := pg_catalog.array_append(pair_records, p_record_id);
      pair_permissions := pg_catalog.array_append(
        pair_permissions, (route_item ->> 'permissionId')::uuid
      );
    end loop;
  end if;

  while coalesce(pg_catalog.array_length(load_records, 1), 0) > 0
    or coalesce(pg_catalog.array_length(pair_records, 1), 0) > 0
  loop
    if coalesce(pg_catalog.array_length(load_records, 1), 0) > 0 then
      current_contract := load_contracts[pg_catalog.array_length(load_contracts, 1)];
      select coalesce(pg_catalog.array_agg(distinct queued.record_id), array[]::uuid[])
      into batch_record_ids
      from pg_catalog.unnest(load_contracts, load_records)
        as queued(contract_id, record_id)
      where queued.contract_id = current_contract
        and not records_by_id ? pg_catalog.lower(queued.record_id::text);

      select coalesce(pg_catalog.array_agg(queued.contract_id order by queued.ordinality), array[]::uuid[]),
        coalesce(pg_catalog.array_agg(queued.record_id order by queued.ordinality), array[]::uuid[])
      into load_contracts, load_records
      from pg_catalog.unnest(load_contracts, load_records) with ordinality
        as queued(contract_id, record_id, ordinality)
      where queued.contract_id <> current_contract;

      if pg_catalog.array_length(batch_record_ids, 1) is null then
        continue;
      end if;

      select meta.value into current_meta
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
      where (meta.value ->> 'storageContractId')::uuid = current_contract
      limit 1;
      if current_meta is null then
        continue;
      end if;

      load_sql := pg_catalog.format(
        'select stored.record_id, pg_catalog.jsonb_build_object(
           ''recordScope'', pg_catalog.jsonb_build_object(
             ''storageScope'', %L,
             ''organizationId'', stored.organisation_id,
             ''moduleRootId'', %L::uuid,
             ''recordTypeId'', %L::uuid,
             ''storageContractId'', %L::uuid,
             ''recordId'', stored.record_id
           ) || case when %L = ''application_contained''
             then pg_catalog.jsonb_build_object(''applicationRootId'', stored.application_root_id)
             else ''{}''::jsonb end,
           ''lifecycleState'', stored.lifecycle_state,
           ''fieldValues'', pg_catalog.jsonb_build_object(%s)
         ) || case
           when stored.owner_organisation_account_id is not null
             then pg_catalog.jsonb_build_object(
               ''ownerOrganizationAccountId'', stored.owner_organisation_account_id)
           when stored.owner_group_id is not null
             then pg_catalog.jsonb_build_object(''ownerGroupId'', stored.owner_group_id)
           else ''{}''::jsonb end as fact
         from record_data.%I as stored
         where stored.organisation_id = $1 and stored.record_id = any($2)',
        current_meta ->> 'storageScope', (current_meta ->> 'moduleRootId')::uuid,
        (current_meta ->> 'recordTypeId')::uuid, current_contract,
        current_meta ->> 'storageScope', current_meta ->> 'valueExpression',
        current_meta ->> 'table'
      );

      for loaded_row in execute load_sql using context_organization_id, batch_record_ids loop
        records_by_id := records_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(loaded_row.record_id::text), loaded_row.fact
        );
      end loop;
      continue;
    end if;

    current_record := pair_records[pg_catalog.array_length(pair_records, 1)];
    current_permission := pair_permissions[pg_catalog.array_length(pair_permissions, 1)];
    pair_records := pair_records[1:pg_catalog.array_length(pair_records, 1) - 1];
    pair_permissions := pair_permissions[1:pg_catalog.array_length(pair_permissions, 1) - 1];

    pair_identity := pg_catalog.lower(current_record::text) || ':'
      || pg_catalog.lower(current_permission::text);
    if pair_identity = any (seen_pairs) then
      continue;
    end if;
    seen_pairs := pg_catalog.array_append(seen_pairs, pair_identity);

    record_fact := records_by_id -> pg_catalog.lower(current_record::text);
    if record_fact is null then
      continue;
    end if;
    current_meta := type_meta -> pg_catalog.lower(
      record_fact -> 'recordScope' ->> 'recordTypeId'
    );
    current_scope := permission_by_id -> pg_catalog.lower(current_permission::text)
      -> 'recordScope';
    if current_meta is null or current_scope is null then
      continue;
    end if;

    -- Inherited ownership: push the declared parent under the same permission,
    -- which repeats for the grandparent when that pair is expanded.
    if current_meta ->> 'ownershipMode' = 'inherited'
      and current_meta ? 'ownershipRelationshipId'
      and exists (
        select 1 from pg_catalog.jsonb_array_elements(current_scope -> 'routes') as route(value)
        where route.value ->> 'kind' = 'ownership'
      ) then
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (current_meta ->> 'ownershipRelationshipId')::uuid
          and edge.from_storage_contract_id = (current_meta ->> 'storageContractId')::uuid
          and edge.from_record_id = current_record
      loop
        load_contracts := pg_catalog.array_append(load_contracts, edge_row.to_storage_contract_id);
        load_records := pg_catalog.array_append(load_records, edge_row.to_record_id);
        pair_records := pg_catalog.array_append(pair_records, edge_row.to_record_id);
        pair_permissions := pg_catalog.array_append(pair_permissions, current_permission);
        candidate_edges := candidate_edges || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', edge_row.relationship_id,
            'fromRecordId', edge_row.from_record_id,
            'toRecordId', edge_row.to_record_id
          )
        );
      end loop;
    end if;

    -- Relationship routes: the target is always the `to` endpoint, so the
    -- sources this permission can reach it through are the `from` rows of that
    -- relationship's edges, each expanded under its own source permission.
    for route_item in
      select route.value
      from pg_catalog.jsonb_array_elements(current_scope -> 'routes') as route(value)
      where route.value ->> 'kind' = 'relationship'
    loop
      if not (relationship_by_id ? pg_catalog.lower(route_item ->> 'relationshipId')) then
        continue;
      end if;
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (route_item ->> 'relationshipId')::uuid
          and edge.to_storage_contract_id = (current_meta ->> 'storageContractId')::uuid
          and edge.to_record_id = current_record
      loop
        load_contracts := pg_catalog.array_append(
          load_contracts, edge_row.from_storage_contract_id
        );
        load_records := pg_catalog.array_append(load_records, edge_row.from_record_id);
        pair_records := pg_catalog.array_append(pair_records, edge_row.from_record_id);
        pair_permissions := pg_catalog.array_append(
          pair_permissions, (route_item ->> 'sourcePermissionId')::uuid
        );
        candidate_edges := candidate_edges || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', edge_row.relationship_id,
            'fromRecordId', edge_row.from_record_id,
            'toRecordId', edge_row.to_record_id
          )
        );
      end loop;
    end loop;
  end loop;

  -- Step 7: the facts. Every record type, relationship and saved condition of
  -- the installed definitions; the records the closure reached; and exactly the
  -- edges whose endpoints are both present, deduplicated.
  facts := pg_catalog.jsonb_build_object(
    'binding', declaration -> 'recordBinding',
    'recordTypes', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'moduleRootId', meta.value -> 'moduleRootId',
          'recordTypeId', meta.value -> 'recordTypeId',
          'storageContractId', meta.value -> 'storageContractId',
          'storageScope', meta.value -> 'storageScope',
          'ownershipMode', meta.value -> 'ownershipMode',
          'validationContractVersion', meta.value -> 'validationContractVersion',
          'fields', meta.value -> 'fields'
        ) || case
          when meta.value ? 'ownershipRelationshipId'
            then pg_catalog.jsonb_build_object(
              'ownershipRelationshipId', meta.value -> 'ownershipRelationshipId'
            )
          else '{}'::jsonb
        end
        order by meta.key collate "C"
      )
      from pg_catalog.jsonb_each(type_meta) as meta(key, value)
    ), '[]'::jsonb),
    'relationships', coalesce((
      select pg_catalog.jsonb_agg(declared.value order by declared.key collate "C")
      from pg_catalog.jsonb_each(relationship_by_id) as declared(key, value)
    ), '[]'::jsonb),
    'sharingConditions', condition_list,
    'records', coalesce((
      select pg_catalog.jsonb_agg(stored.value order by stored.key collate "C")
      from pg_catalog.jsonb_each(records_by_id) as stored(key, value)
    ), '[]'::jsonb),
    'edges', coalesce((
      select pg_catalog.jsonb_agg(distinct edge.value)
      from pg_catalog.jsonb_array_elements(candidate_edges) as edge(value)
      where records_by_id ? pg_catalog.lower(edge.value ->> 'fromRecordId')
        and records_by_id ? pg_catalog.lower(edge.value ->> 'toRecordId')
    ), '[]'::jsonb)
  );

  return pg_catalog.jsonb_build_object(
    'outcome', 'loaded',
    'context', context_value,
    'declaration', declaration,
    'facts', facts,
    'accessPermissions', permission_by_id,
    'recordTypeMeta', target_meta - 'isSystemProjection',
    'isSystemProjection', target_is_system_projection,
    'table', target_table,
    'columns', target_meta -> 'columns',
    'concurrencyNumber', target_concurrency_number,
    'definitionRevision', target_definition_revision,
    'moduleReleaseRevision', target_release_revision,
    'fieldValues', target_fact -> 'fieldValues'
  ) || case when preview_target
    then pg_catalog.jsonb_build_object(
      'previewInstallationId', p_installation -> 'previewInstallationId'
    )
    else '{}'::jsonb end;
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed Module definition is ambiguous';
end
$function$;

create or replace function vortex_record.load_record_access_facts_from_installation_internal(
  p_record_type_id uuid,
  p_action_kind text,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_installation jsonb
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $function$
  select vortex_record.load_record_access_facts_from_installation_internal(
    p_record_type_id, p_action_kind, p_record_id, p_expected_concurrency_number,
    p_installation, null::jsonb
  )
$function$;

alter function vortex_record.load_record_access_facts_from_installation_internal(uuid,text,uuid,bigint,jsonb,jsonb) owner to vortex_record_adapter;
alter function vortex_record.load_record_access_facts_from_installation_internal(uuid,text,uuid,bigint,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.load_record_access_facts_from_installation_internal(
  uuid, text, uuid, bigint, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on function vortex_record.load_record_access_facts_from_installation_internal(
  uuid, text, uuid, bigint, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.load_record_access_facts_from_installation_internal(
  uuid, text, uuid, bigint, jsonb
) to vortex_record_adapter;

comment on function vortex_record.load_record_access_facts_from_installation_internal(
  uuid, text, uuid, bigint, jsonb
) is
  'Private adapter fact loader over one exact trusted installation or owner-validated preview, resolving definitions from the cached installation access plan.';

create or replace function vortex_record.prepare_module_query_internal(
  p_module_root_id uuid,
  p_query_id uuid,
  p_expected_release_revision bigint,
  p_input_values jsonb,
  p_user_filter jsonb,
  p_declared_filterable_field_ids jsonb,
  p_stage text default 'complete',
  p_prior_plan jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  trivial_condition constant jsonb :=
    '{"kind":"comparison","operator":"is_empty","left":{"source":"value","value":null}}'::jsonb;
  context_value jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  resolved jsonb;
  query_item jsonb;
  record_type_item jsonb;
  record_type_id_value uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  mapping_row vortex_record.field_storage_mappings%rowtype;
  field_item jsonb;
  fields_by_id jsonb := '{}'::jsonb;
  field_key text;
  field_kind text;
  semantic_type text;
  filter_condition jsonb;
  filter_exact boolean := false;
  filter_ids text[] := array[]::text[];
  filter_types jsonb := '{}'::jsonb;
  filter_nulls jsonb := '{}'::jsonb;
  filter_expressions text[] := array[]::text[];
  filter_field_columns jsonb := '{}'::jsonb;
  filter_field_database_types jsonb := '{}'::jsonb;
  filter_read_time_expressions jsonb := '{}'::jsonb;
  filter_plan jsonb;
  filter_predicate text;
  filter_parameters jsonb := '[]'::jsonb;
  user_filter jsonb;
  user_filter_ids text[] := array[]::text[];
  input_item jsonb;
  input_key text;
  input_value jsonb;
  parameter_types jsonb := '{}'::jsonb;
  parameter_values jsonb := '{}'::jsonb;
  read_time_field boolean;
  read_time_clock jsonb;
  read_time_sql text;
  access_plan record;
  readable_field_ids text[] := array[]::text[];
  declared_filterable_ids text[] := array[]::text[];
  parsed_ids text[] := array[]::text[];
  filterable_item jsonb;
  prepared_plan jsonb;
  preview_address text;
  preview_context jsonb;
  preview_installation_id uuid;
  preview_candidate_revision bigint;
  preview_candidate_revision_text text;
  preview_storage_contract_id uuid;
  preview_field_bounds jsonb;
  preview_field_mappings jsonb := '{}'::jsonb;
  preview_mode boolean := false;
  failure_sqlstate text;
  failure_message text;
begin
  if p_stage not in ('resolution', 'storage', 'complete') then
    raise exception using errcode = '22023', message = 'Invalid query preparation stage';
  end if;
  preview_address := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  preview_mode := preview_address is not null;
  if preview_mode then
    begin
      preview_context := vortex_record.read_current_preview_installation_internal();
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview installation): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
    preview_candidate_revision_text := preview_context ->> 'applicationReleaseRevision';
    if preview_context is null
      or pg_catalog.jsonb_typeof(preview_context) is distinct from 'object'
      or preview_context ? 'outcome'
      or not vortex_platform.is_non_nil_uuid(preview_context ->> 'previewInstallationId')
      or not coalesce(pg_catalog.pg_input_is_valid(preview_candidate_revision_text, 'bigint'), false) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
    preview_installation_id := (preview_context ->> 'previewInstallationId')::uuid;
    preview_candidate_revision := preview_candidate_revision_text::bigint;
    if preview_candidate_revision not between 1 and 9007199254740991 then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  end if;
  if p_prior_plan is not null then
    prepared_plan := p_prior_plan;
    -- A plan for a system projection is a live plan, in a preview too: see below.
    if preview_mode and not (prepared_plan ? 'preview')
      and prepared_plan -> 'recordType' ? 'systemProjection' then
      preview_mode := false;
    end if;
    if preview_mode then
      if pg_catalog.jsonb_typeof(prepared_plan) is distinct from 'object'
        or prepared_plan ->> 'outcome' is distinct from 'prepared'
        or not (prepared_plan ? 'preview') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      begin
        context_value := vortex_access.validated_human_request_context();
        resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
      exception
        -- A refused access context or a stale preview is the expected refusal; any
        -- other failure is logged with its cause before the same safe refusal.
        when sqlstate '42501' or sqlstate '40001' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        when others then
          get stacked diagnostics failure_sqlstate = returned_sqlstate,
            failure_message = message_text;
          raise warning 'Query preview preparation failed (preview context): SQLSTATE %, %',
            failure_sqlstate, failure_message;
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end;
      if context_value is null or not (context_value ? 'applicationRootId') or resolved is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      context_organization_id := (context_value ->> 'organizationId')::uuid;
      context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
      if p_expected_release_revision is not null
        and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
      end if;
      if preview_context ->> 'organizationId' is distinct from context_organization_id::text
        or preview_context ->> 'applicationRootId' is distinct from context_application_root_id::text
        or prepared_plan #>> '{scope,organizationId}' is distinct from context_organization_id::text
        or prepared_plan #>> '{scope,applicationRootId}' is distinct from context_application_root_id::text
        or prepared_plan -> 'preview' is distinct from pg_catalog.jsonb_build_object(
          'previewInstallationId', preview_installation_id,
          'candidateRevision', preview_candidate_revision
        )
        or prepared_plan -> 'resolved' is distinct from resolved
        or prepared_plan -> 'query' is distinct from resolved -> 'query'
        or prepared_plan -> 'recordType' is distinct from resolved -> 'recordType'
        or prepared_plan ->> 'recordTypeId' is distinct from resolved ->> 'recordTypeId' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'resolved', resolved,
        'query', resolved -> 'query',
        'recordType', resolved -> 'recordType',
        'recordTypeId', resolved -> 'recordTypeId',
        'scope', pg_catalog.jsonb_build_object(
          'organizationId', context_organization_id,
          'applicationRootId', context_application_root_id
        )
      );
      -- A previous stage's physical tokens and field bounds are reusable only
      -- after this invocation re-reads the exact preview catalogue and bounds.
      prepared_plan := prepared_plan - 'storage' - 'readableFieldIds' - 'access'
        - 'filterFieldIds' - 'filter';
    elsif prepared_plan ? 'preview' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    else
      resolved := prepared_plan -> 'resolved';
      context_organization_id := (prepared_plan #>> '{scope,organizationId}')::uuid;
      context_application_root_id := (prepared_plan #>> '{scope,applicationRootId}')::uuid;
    end if;
    user_filter := prepared_plan -> 'userFilter';
    if user_filter = 'null'::jsonb then
      user_filter := null;
    end if;
    select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
    into declared_filterable_ids
    from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'declaredFilterableIds') as item(value);
  else
  if p_input_values is null or pg_catalog.jsonb_typeof(p_input_values) <> 'object'
    or (p_expected_release_revision is not null
      and p_expected_release_revision not between 1 and 9007199254740991) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  if p_declared_filterable_field_ids is null then
    p_declared_filterable_field_ids := '[]'::jsonb;
  end if;
  if pg_catalog.jsonb_typeof(p_declared_filterable_field_ids) <> 'array'
    or pg_catalog.jsonb_array_length(p_declared_filterable_field_ids) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  for filterable_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_declared_filterable_field_ids) as item(value)
  loop
    if pg_catalog.jsonb_typeof(filterable_item) <> 'string'
      or pg_catalog.lower(filterable_item #>> '{}') !~ uuid_pattern
      or pg_catalog.lower(filterable_item #>> '{}') = any (parsed_ids) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
    end if;
    parsed_ids := pg_catalog.array_append(parsed_ids, pg_catalog.lower(filterable_item #>> '{}'));
  end loop;
  declared_filterable_ids := parsed_ids;

  if p_user_filter = 'null'::jsonb then
    p_user_filter := null;
  end if;
  if p_user_filter is not null
    and pg_catalog.jsonb_typeof(p_user_filter) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'request_invalid');
  end if;
  user_filter := p_user_filter;
  -- The verified organisation and Application; never a caller value.
  if preview_mode then
    begin
      context_value := vortex_access.validated_human_request_context();
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview context): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
    if context_value is null or not (context_value ? 'applicationRootId') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end if;
  else
    context_value := vortex_access.validated_human_request_context();
    if not (context_value ? 'applicationRootId') then
      raise exception using errcode = '42501', message = 'Query requires an application context';
    end if;
  end if;
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
  if preview_mode and (
    preview_context ->> 'organizationId' is distinct from context_organization_id::text
    or preview_context ->> 'applicationRootId' is distinct from context_application_root_id::text
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;

  if preview_mode then
    begin
      resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
      -- A system projection has no preview copy: it is the platform's live read model, which a
      -- preview reads on the live path, under the reader's own live access and never under the
      -- preview's roles.
      if resolved is null then
        resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
        if resolved -> 'recordType' ? 'systemProjection' then
          preview_mode := false;
        else
          resolved := null;
        end if;
      end if;
    exception
      -- A refused access context or a stale preview is the expected refusal; any
      -- other failure is logged with its cause before the same safe refusal.
      when sqlstate '42501' or sqlstate '40001' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      when others then
        get stacked diagnostics failure_sqlstate = returned_sqlstate,
          failure_message = message_text;
        raise warning 'Query preview preparation failed (preview query): SQLSTATE %, %',
          failure_sqlstate, failure_message;
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
  else
    resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
  end if;
  if resolved is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  if p_expected_release_revision is not null
    and (resolved ->> 'moduleReleaseRevision')::bigint <> p_expected_release_revision then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'cursor_stale');
  end if;
  end if;
  query_item := resolved -> 'query';
  record_type_item := resolved -> 'recordType';
  record_type_id_value := (resolved ->> 'recordTypeId')::uuid;
  -- A preview reads its copy of the records with their stored totals and calculations; a system
  -- projection is read only through its protected reader, never from a preview.
  if preview_mode and record_type_item ? 'systemProjection' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'descriptor_invalid');
  end if;
  if prepared_plan is null then
    prepared_plan := pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'resolved', resolved,
      'query', query_item,
      'recordType', record_type_item,
      'recordTypeId', record_type_id_value,
      'userFilter', user_filter,
      'declaredFilterableIds', pg_catalog.to_jsonb(declared_filterable_ids),
      'scope', pg_catalog.jsonb_build_object(
        'organizationId', context_organization_id,
        'applicationRootId', context_application_root_id
      )
    );
    if preview_mode then
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'preview', pg_catalog.jsonb_build_object(
          'previewInstallationId', preview_installation_id,
          'candidateRevision', preview_candidate_revision
        )
      );
    end if;
  end if;
  if p_stage = 'resolution' then
    return prepared_plan;
  end if;

  if prepared_plan ? 'storage' and not preview_mode then
    catalogue_row.storage_contract_id := (prepared_plan #>> '{storage,storageContractId}')::uuid;
    select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
    into readable_field_ids
    from pg_catalog.jsonb_array_elements_text(prepared_plan -> 'readableFieldIds') as item(value);
  else
    if preview_mode then
      preview_storage_contract_id := (resolved ->> 'previewStorageContractId')::uuid;
      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = preview_storage_contract_id;
      if not found
        or catalogue_row.state is distinct from 'active'
        or catalogue_row.physical_schema_token is distinct from 'record_data'
        or catalogue_row.module_root_id is distinct from (resolved ->> 'recordTypeModuleRootId')::uuid
        or catalogue_row.record_type_id is distinct from record_type_id_value
        or catalogue_row.storage_scope is distinct from (resolved ->> 'storageScope')
        or catalogue_row.first_compatible_release_revision is distinct from
          (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        or catalogue_row.last_compatible_release_revision is distinct from
          (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        or catalogue_row.record_type_definition ->> 'storageContractId'
          is distinct from preview_storage_contract_id::text
        or pg_catalog.lower(catalogue_row.record_type_definition ->> 'recordTypeId')
          is distinct from record_type_id_value::text
        or catalogue_row.record_type_definition ->> 'storageScope'
          is distinct from (resolved ->> 'storageScope') then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;

      preview_field_bounds := vortex_record.preview_record_field_bounds_internal(
        record_type_id_value, preview_storage_contract_id, record_type_item
      );
      if preview_field_bounds is null
        or pg_catalog.jsonb_typeof(preview_field_bounds -> 'readableFieldIds') is distinct from 'array' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
        where not exists (
          select 1
          from vortex_record.field_storage_mappings as mapping
          where mapping.storage_contract_id = preview_storage_contract_id
            and mapping.field_id = pg_catalog.lower(field.value ->> 'fieldId')::uuid
            and mapping.state is not distinct from 'active'
            and mapping.field_definition is not distinct from field.value
            and mapping.physical_column_token is not distinct from
              ('f_' || pg_catalog.replace(pg_catalog.lower(field.value ->> 'fieldId'), '-', ''))
            and mapping.database_value_type is not distinct from
              vortex_record.database_value_type(field.value)
            and mapping.introduced_by_module_root_id is not distinct from
              (resolved ->> 'recordTypeModuleRootId')::uuid
            and mapping.introduced_at_release_revision is not distinct from
              (resolved ->> 'recordTypeModuleReleaseRevision')::bigint
        )
      ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      select coalesce(pg_catalog.jsonb_object_agg(
        pg_catalog.lower(field.value ->> 'fieldId'),
        pg_catalog.to_jsonb(mapping)
        order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
      ), '{}'::jsonb)
      into preview_field_mappings
      from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
      join vortex_record.field_storage_mappings as mapping
        on mapping.storage_contract_id = preview_storage_contract_id
        and mapping.field_id = pg_catalog.lower(field.value ->> 'fieldId')::uuid
        and mapping.state is not distinct from 'active';
      if prepared_plan ? 'fieldMappings'
        and prepared_plan -> 'fieldMappings' is distinct from preview_field_mappings then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;

      for field_item in
        select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), field_item
        );
      end loop;
      select coalesce(pg_catalog.array_agg(item.value), array[]::text[])
      into readable_field_ids
      from pg_catalog.jsonb_array_elements_text(preview_field_bounds -> 'readableFieldIds') as item(value);
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'storage', pg_catalog.jsonb_build_object(
          'storageContractId', catalogue_row.storage_contract_id,
          'storageScope', catalogue_row.storage_scope,
          'moduleRootId', catalogue_row.module_root_id,
          'recordTypeId', catalogue_row.record_type_id,
          'physicalSchemaToken', catalogue_row.physical_schema_token,
          'physicalTableToken', catalogue_row.physical_table_token,
          'protectedReadModelKey', catalogue_row.protected_read_model_key
        ),
        'fieldMappings', preview_field_mappings,
        'readableFieldIds', pg_catalog.to_jsonb(readable_field_ids),
        'access', pg_catalog.jsonb_build_object(
          'predicate', 'true',
          'parameters', '[]'::jsonb,
          'ownerAccountId', null,
          'ownerGroupIds', '[]'::jsonb,
          'sharedRecordIds', '[]'::jsonb
        )
      );
    else
      -- The installed physical table for this exact record type.
      select catalogue.* into catalogue_row
      from vortex_record.storage_catalogue as catalogue
      where catalogue.storage_contract_id = (record_type_item ->> 'storageContractId')::uuid;
      if not found
        or catalogue_row.state <> 'active'
        or catalogue_row.module_root_id <> (resolved ->> 'recordTypeModuleRootId')::uuid
        or catalogue_row.record_type_id <> record_type_id_value
        or catalogue_row.storage_scope is distinct from (record_type_item ->> 'storageScope')
        or catalogue_row.physical_schema_token not in ('record_data', 'system_projection')
        or (catalogue_row.physical_schema_token = 'system_projection')
          is distinct from (record_type_item ? 'systemProjection')
        or (catalogue_row.physical_schema_token = 'system_projection'
          and catalogue_row.protected_read_model_key
            is distinct from (record_type_item #>> '{systemProjection,protectedView}')) then
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;

      for field_item in
        select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
      loop
        fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_item ->> 'fieldId'), field_item
        );
      end loop;

      -- The read-scan plan. Its access routes narrow candidate rows before the
      -- budget is spent; its readable fields are the fields this reader is
      -- guaranteed to see on every row the scan examines, and none when the scan
      -- can examine a row the reader cannot read. Only those fields may drive the
      -- scan order, the pushed filter or the keyset cursor, because any other
      -- field could be withheld and its value must not influence which rows are
      -- examined. A planning failure propagates; it never widens the scan.
      select plan.* into access_plan
      from vortex_record.plan_record_read_scan_internal(record_type_id_value) as plan;
      readable_field_ids := coalesce(access_plan.readable_field_ids, array[]::text[]);
      prepared_plan := prepared_plan || pg_catalog.jsonb_build_object(
        'storage', pg_catalog.jsonb_build_object(
          'storageContractId', catalogue_row.storage_contract_id,
          'storageScope', catalogue_row.storage_scope,
          'moduleRootId', catalogue_row.module_root_id,
          'recordTypeId', catalogue_row.record_type_id,
          'physicalSchemaToken', catalogue_row.physical_schema_token,
          'physicalTableToken', catalogue_row.physical_table_token,
          'protectedReadModelKey', catalogue_row.protected_read_model_key
        ),
        'readableFieldIds', pg_catalog.to_jsonb(readable_field_ids),
        'access', pg_catalog.jsonb_build_object(
          'predicate', access_plan.access_predicate,
          'parameters', coalesce(access_plan.access_parameters, '[]'::jsonb),
          'ownerAccountId', access_plan.owner_account_id,
          'ownerGroupIds', pg_catalog.to_jsonb(coalesce(access_plan.owner_group_ids, array[]::uuid[])),
          'sharedRecordIds', pg_catalog.to_jsonb(coalesce(access_plan.shared_record_ids, array[]::uuid[]))
        )
      );
    end if;
  end if;
  if p_stage = 'storage' then
    return prepared_plan;
  end if;

  if fields_by_id = '{}'::jsonb then
    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as item(value)
    loop
      fields_by_id := fields_by_id || pg_catalog.jsonb_build_object(
        pg_catalog.lower(field_item ->> 'fieldId'), field_item
      );
    end loop;
  end if;
  -- Filter: the published condition tree over this record type's own fields, and,
  -- when supplied, the user's typed filter ANDed with it so it can only narrow.
  -- Every field the user's tree reads must be one the component declares
  -- filterable; the record type's own filterable flag is checked below for both.
  filter_condition := query_item -> 'filter';
  if filter_condition is not null and filter_condition = 'null'::jsonb then
    filter_condition := null;
  end if;
  if user_filter is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into user_filter_ids
    from pg_catalog.jsonb_path_query(
      user_filter, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    if exists (
      select 1 from pg_catalog.unnest(user_filter_ids) as referenced(id)
      where referenced.id <> pg_catalog.lower(referenced.id)
        or referenced.id <> all (declared_filterable_ids)
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end if;
    filter_condition := case
      when filter_condition is null then user_filter
      else pg_catalog.jsonb_build_object(
        'kind', 'all',
        'conditions', pg_catalog.jsonb_build_array(filter_condition, user_filter)
      )
    end;
  end if;
  if filter_condition is not null then
    select coalesce(pg_catalog.array_agg(distinct referenced.value #>> '{}'), array[]::text[])
    into filter_ids
    from pg_catalog.jsonb_path_query(
      filter_condition, 'lax $.**?(@.source == "field").fieldId'
    ) as referenced(value);
    foreach field_key in array filter_ids loop
      -- Field values are keyed by lowercase identifier; so must the tree be.
      if field_key <> pg_catalog.lower(field_key) or not (fields_by_id ? field_key)
        or coalesce((fields_by_id -> field_key ->> 'filterable')::boolean, false) is not true then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      field_kind := fields_by_id -> field_key ->> 'type';
      if field_kind in ('calculation', 'total') then
        field_kind := fields_by_id -> field_key #>> '{settings,resultType}';
      end if;
      -- The exact (current Module contract) semantics of the saved-condition
      -- evaluator, so Query and database-backed conditions agree.
      semantic_type := case
        when field_kind = 'decimal_number' then 'decimal_number'
        when field_kind = 'money' then 'money'
        when field_kind = 'whole_number' then 'number'
        when field_kind = 'yes_no' then 'boolean'
        when field_kind = 'date' then 'date'
        when field_kind = 'date_time' then 'date_time'
        when field_kind = 'several_choices' then 'text_collection'
        when field_kind in ('table', 'attachment', 'formatted_text') then 'opaque_json'
        when field_kind in ('link', 'link_to_one_of_several') then 'record_reference'
        when field_kind = 'link_to_person' then 'organization_account_reference'
        when field_kind in (
          'text', 'long_text', 'choice', 'reference_number',
          'email_address', 'phone_number', 'web_address'
        ) then 'text'
        else null end;
      if semantic_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
      end if;
      select mapping.* into mapping_row
      from vortex_record.field_storage_mappings as mapping
      where mapping.storage_contract_id = catalogue_row.storage_contract_id
        and mapping.field_id = field_key::uuid;
      if not found or mapping_row.state is distinct from 'active' then
        if preview_mode then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
        end if;
        raise exception using errcode = '55000',
          message = 'Record storage disagrees with the installed definition';
      end if;
      filter_field_columns := filter_field_columns || pg_catalog.jsonb_build_object(
        field_key, mapping_row.physical_column_token
      );
      filter_field_database_types := filter_field_database_types || pg_catalog.jsonb_build_object(
        field_key, mapping_row.database_value_type
      );
      filter_types := filter_types || pg_catalog.jsonb_build_object(field_key, semantic_type);
      filter_nulls := filter_nulls || pg_catalog.jsonb_build_object(field_key, null::jsonb);
      read_time_field := fields_by_id -> field_key ->> 'type' = 'calculation'
        and (fields_by_id -> field_key #>> '{settings,evaluation}' = 'read_time'
          or fields_by_id -> field_key #>> '{settings,expression,kind}' = 'deadline_passed');
      if read_time_field then
        read_time_clock := coalesce(read_time_clock, vortex_record.read_time_clock_internal());
        read_time_sql := vortex_record.read_time_deadline_expression_internal(
          catalogue_row.storage_contract_id, fields_by_id -> field_key #> '{settings,expression}',
          read_time_clock
        );
        if read_time_sql is null then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
        end if;
        filter_read_time_expressions := filter_read_time_expressions || pg_catalog.jsonb_build_object(
          field_key, read_time_sql
        );
        filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
          '%L, %s', field_key, pg_catalog.format('pg_catalog.to_jsonb(%s)', read_time_sql)
        ));
        continue;
      end if;
      -- The same canonical value text the record reader projects; references
      -- are compared by their identifier, as the condition engine defines.
      filter_expressions := pg_catalog.array_append(filter_expressions, pg_catalog.format(
        '%L, %s', field_key,
        case
          when semantic_type = 'record_reference' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.lower(stored.%I ->> ''recordId''))',
              mapping_row.physical_column_token)
          when semantic_type = 'organization_account_reference' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.lower(stored.%I ->> ''organizationAccountId''))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'decimal' then
            pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'timestamp_with_time_zone' then
            pg_catalog.format(
              'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.%I))',
              mapping_row.physical_column_token)
          when mapping_row.database_value_type = 'date' then
            pg_catalog.format('pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
              mapping_row.physical_column_token)
          else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', mapping_row.physical_column_token)
        end
      ));
    end loop;
  end if;

  -- Inputs: exactly the declared keys, required ones present, references
  -- reduced to their identifier. Types are checked by the condition bridge.
  for input_key in select supplied.key from pg_catalog.jsonb_object_keys(p_input_values) as supplied(key) loop
    if not exists (
      select 1 from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
      where item.value ->> 'key' = input_key
    ) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
  end loop;
  for input_item in
    select item.value from pg_catalog.jsonb_array_elements(coalesce(query_item -> 'inputs', '[]'::jsonb)) as item(value)
  loop
    input_key := input_item ->> 'key';
    input_value := coalesce(p_input_values -> input_key, 'null'::jsonb);
    if input_value = 'null'::jsonb and (input_item ->> 'required')::boolean then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
    end if;
    if input_value <> 'null'::jsonb and input_item ->> 'type' = 'record_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'recordId') ~ uuid_pattern, false)
        or not exists (
          select 1 from pg_catalog.jsonb_array_elements(input_item -> 'recordTypes') as allowed(value)
          where allowed.value ->> 'state' = 'resolved'
            and pg_catalog.lower(allowed.value ->> 'recordTypeId')
              = pg_catalog.lower(input_value ->> 'recordTypeId')
        ) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
      input_value := pg_catalog.to_jsonb(pg_catalog.lower(input_value ->> 'recordId'));
    elsif input_value <> 'null'::jsonb and input_item ->> 'type' = 'organization_account_reference' then
      if pg_catalog.jsonb_typeof(input_value) <> 'object'
        or input_value - array['organizationAccountId']::text[] <> '{}'::jsonb
        or not coalesce(pg_catalog.lower(input_value ->> 'organizationAccountId') ~ uuid_pattern, false) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
      end if;
      input_value := pg_catalog.to_jsonb(pg_catalog.lower(input_value ->> 'organizationAccountId'));
    end if;
    parameter_types := parameter_types || pg_catalog.jsonb_build_object(input_key, case input_item ->> 'type'
      when 'formatted_text' then 'opaque_json'
      else input_item ->> 'type' end);
    parameter_values := parameter_values || pg_catalog.jsonb_build_object(input_key, input_value);
  end loop;
  begin
    perform vortex_access.evaluate_query_condition_internal(
      trivial_condition, '{}'::jsonb, '{}'::jsonb, parameter_types, parameter_values, true
    );
  exception when invalid_parameter_value then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'input_invalid');
  end;
  if filter_condition is not null then
    begin
      perform vortex_access.evaluate_query_condition_internal(
        filter_condition, filter_types, filter_nulls, parameter_types, parameter_values, true
      );
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;

  -- The published filter is pushed into the candidate scan only when every
  -- field it reads is one the reader is guaranteed to see; otherwise it is
  -- evaluated per row, so which rows the budget examines can never depend on a
  -- value the reader cannot see.
  filter_predicate := 'true';
  if filter_condition is not null
    and not exists (
      select 1 from pg_catalog.unnest(filter_ids) as referenced(id)
      where referenced.id <> all (readable_field_ids)
    ) then
    begin
      filter_plan := vortex_record.compile_query_filter_internal(
        filter_condition,
        filter_types,
        filter_field_columns,
        filter_field_database_types,
        fields_by_id,
        filter_read_time_expressions,
        parameter_types,
        parameter_values,
        9,
        0
      );
      filter_predicate := coalesce(filter_plan ->> 'predicate', 'true');
      filter_parameters := coalesce(filter_plan -> 'parameters', '[]'::jsonb);
      -- An incomplete compiled predicate remains a candidate narrowing step.
      filter_exact := filter_plan ->> 'predicate' is not null
        and (filter_plan ->> 'exact')::boolean is true;
    exception when invalid_parameter_value then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'filter_invalid');
    end;
  end if;
  return prepared_plan || pg_catalog.jsonb_build_object(
    'filterFieldIds', pg_catalog.to_jsonb(filter_ids),
    'filter', pg_catalog.jsonb_build_object(
      'residualCondition', filter_condition,
      'residualFieldTypes', filter_types,
      'residualNullValues', filter_nulls,
      'residualInputTypes', parameter_types,
      'residualInputs', parameter_values,
      'expressions', pg_catalog.to_jsonb(filter_expressions),
      'pushedPredicate', filter_predicate,
      'pushedExact', filter_exact,
      'pushedParameters', filter_parameters
    )
  );
end
$function$;

alter function vortex_record.prepare_module_query_internal(uuid,uuid,bigint,jsonb,jsonb,jsonb,text,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb)
  to vortex_owner;

comment on function vortex_record.prepare_module_query_internal(uuid, uuid, bigint, jsonb, jsonb, jsonb, text, jsonb) is
  'Shared owner-only Module query preparation for list and summary reads: derives organisation and application authority from validated_human_request_context(), resolves one installed query or the exact current human-owned preview pins, revalidates preview prior plans, exact active field mappings and preview catalogue/field bounds without using the installed read-scan routes, validates declared inputs and the published filter narrowed by the declared user filter, and returns the exact access predicate, pushed filter and residual per-row condition with bound inputs; it never accepts authority or identity from caller values.';

create or replace function vortex_record.read_module_query_inputs(
  p_module_root_id uuid,
  p_query_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_address text;
  preview_context jsonb;
  resolved jsonb;
begin
  preview_address := nullif(
    pg_catalog.current_setting('vortex_record.preview_installation_id', true), ''
  );
  if preview_address is not null then
    begin
      preview_context := vortex_record.read_current_preview_installation_internal();
      if preview_context is null
        or pg_catalog.jsonb_typeof(preview_context) is distinct from 'object'
        or preview_context ? 'outcome' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
      end if;
      resolved := vortex_record.resolve_preview_module_query_internal(p_module_root_id, p_query_id);
      -- A system projection has no preview copy: a preview reads it on the live path.
      if resolved is null then
        resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
        if not coalesce(resolved -> 'recordType' ? 'systemProjection', false) then
          resolved := null;
        end if;
      end if;
    exception when others then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
    end;
  else
    resolved := vortex_record.resolve_installed_module_query_internal(p_module_root_id, p_query_id);
  end if;
  if resolved is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'query_unavailable');
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'resolved',
    'moduleReleaseRevision', resolved -> 'moduleReleaseRevision',
    'moduleReleaseVersion', resolved -> 'moduleReleaseVersion',
    'inputs', coalesce(resolved #> '{query,inputs}', '[]'::jsonb)
  );
end
$function$;
alter function vortex_record.read_module_query_inputs(uuid,uuid) owner to vortex_record_adapter;


alter function vortex_record.read_module_query_inputs(uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.read_module_query_inputs(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_module_query_inputs(uuid, uuid)
  to vortex_request;

comment on function vortex_record.read_module_query_inputs(uuid, uuid) is
  'The typed input contract of one installed or exact current human-owned preview Module query, or one refusal.';

create or replace function vortex_record.resolve_record_action_context_internal(
  p_record_type_id uuid,
  p_action_kind text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  application_root_id_value uuid;
  installation jsonb;
  preview_installation jsonb;
  preview_installation_id_value uuid;
  binding_item jsonb;
  module_content jsonb;
  application_content jsonb;
  module_root_id_value uuid;
  module_release_revision_value bigint;
  record_type_value jsonb;
  candidate_record_type_value jsonb;
  release_storage_contract_id uuid;
  target_module_root_id uuid;
  target_release_revision bigint;
  target_storage_contract_id uuid;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  field_item jsonb;
  field_mapping vortex_record.field_storage_mappings%rowtype;
  columns_value jsonb := '{}'::jsonb;
  required_permissions jsonb := '[]'::jsonb;
  permission_item jsonb;
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action_kind is null
    or p_action_kind not in ('create', 'read', 'update', 'delete', 'restore') then
    raise exception using errcode = '22023', message = 'Record action selector is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record action requires an application context';
  end if;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null then
    if preview_installation ->> 'outcome' = 'refused'
      or p_action_kind not in ('create', 'read', 'update') then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    installation := preview_installation;
    preview_installation_id_value :=
      (preview_installation ->> 'previewInstallationId')::uuid;
  else
    installation := vortex_definition.read_current_active_installation();
  end if;

  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  loop
    module_root_id_value := (binding_item ->> 'moduleRootId')::uuid;
    module_release_revision_value := (binding_item ->> 'moduleReleaseRevision')::bigint;
    select release.record_content into strict module_content
    from vortex_definition.runtime_releases as release
    where release.root_id = module_root_id_value
      and release.release_revision = module_release_revision_value;

    select item.value into candidate_record_type_value
    from pg_catalog.jsonb_array_elements(module_content -> 'recordTypes') as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
    if found then
      if target_module_root_id is not null then
        raise exception using errcode = '55000',
          message = 'Installed record type identity is ambiguous';
      end if;
      target_module_root_id := module_root_id_value;
      target_release_revision := module_release_revision_value;
      record_type_value := candidate_record_type_value;
      release_storage_contract_id := (record_type_value ->> 'storageContractId')::uuid;
      target_storage_contract_id := release_storage_contract_id;
      if preview_installation_id_value is not null
        and not (record_type_value ? 'systemProjection') then
        select (binding.value ->> 'previewStorageContractId')::uuid
        into strict target_storage_contract_id
        from pg_catalog.jsonb_array_elements(installation -> 'storageIdentities')
          as binding(value)
        where (binding.value ->> 'moduleRootId')::uuid = target_module_root_id
          and (binding.value ->> 'moduleReleaseRevision')::bigint = target_release_revision
          and (binding.value ->> 'recordTypeId')::uuid = p_record_type_id
          and (binding.value ->> 'releaseStorageContractId')::uuid = release_storage_contract_id;
        if not found then
          return pg_catalog.jsonb_build_object('outcome', 'refused');
        end if;
      end if;
      for permission_item in
        select item.value
        from pg_catalog.jsonb_array_elements(
          coalesce(module_content -> 'permissions', '[]'::jsonb)
        ) as item(value)
        where (item.value ->> 'recordTypeId')::uuid = p_record_type_id
          and item.value ->> 'actionKind' = p_action_kind
          and (item.value ->> 'namedAction') is null
      loop
        required_permissions := required_permissions || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'applicationRootId', application_root_id_value,
            'ownerKind', 'module', 'ownerId', target_module_root_id,
            'permissionId', (permission_item ->> 'permissionId')::uuid
          )
        );
      end loop;
    end if;
  end loop;

  if target_module_root_id is null then
    raise exception using errcode = '55000',
      message = 'Record type is not part of the active installation';
  end if;
  -- A system projection is the platform's live read model and has no preview copy: a preview
  -- reads it on the live path, under the reader's own live access, never as the preview's owner.
  if record_type_value ? 'systemProjection' then
    preview_installation_id_value := null;
  end if;

  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = target_storage_contract_id;
  if not found or catalogue_row.state <> 'active'
    or catalogue_row.module_root_id <> target_module_root_id
    or catalogue_row.record_type_id <> p_record_type_id
    or catalogue_row.storage_scope is distinct from (record_type_value ->> 'storageScope')
    or (preview_installation_id_value is null
      and catalogue_row.physical_schema_token not in ('record_data', 'system_projection'))
    or (preview_installation_id_value is not null
      and catalogue_row.physical_schema_token <> 'record_data')
    or (catalogue_row.physical_schema_token = 'system_projection')
      is distinct from (record_type_value ? 'systemProjection')
    or (catalogue_row.physical_schema_token = 'system_projection'
      and catalogue_row.protected_read_model_key
        is distinct from (record_type_value #>> '{systemProjection,protectedView}'))
    or (catalogue_row.physical_schema_token = 'system_projection'
      and not coalesce(
        (record_type_value #> '{standardActions}') ? p_action_kind,
        false
      ))
    or (preview_installation_id_value is null and not exists (
      select 1 from vortex_record.release_provisions as provision
      where provision.module_root_id = target_module_root_id
        and provision.release_revision = target_release_revision
        and release_storage_contract_id = any (provision.storage_contract_ids)
    )) then
    raise exception using errcode = '55000',
      message = 'Record storage disagrees with the active installation';
  end if;

  for field_item in
    select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
  loop
    select mapping.* into field_mapping
    from vortex_record.field_storage_mappings as mapping
    where mapping.storage_contract_id = target_storage_contract_id
      and mapping.field_id = (field_item ->> 'fieldId')::uuid;
    if not found or field_mapping.state <> 'active' then
      raise exception using errcode = '55000',
        message = 'Record field storage disagrees with the active installation';
    end if;
    columns_value := columns_value || pg_catalog.jsonb_build_object(
      pg_catalog.lower(field_item ->> 'fieldId'),
      pg_catalog.jsonb_build_object(
        'token', field_mapping.physical_column_token,
        'databaseValueType', field_mapping.database_value_type,
        'type', field_item ->> 'type',
        'required', field_item -> 'required',
        'settings', field_item -> 'settings'
      )
    );
  end loop;

  select release.record_content into strict application_content
  from vortex_definition.runtime_releases as release
  where release.root_id = application_root_id_value
    and release.release_revision = (installation ->> 'applicationReleaseRevision')::bigint;
  for permission_item in
    select item.value
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'permissions', '[]'::jsonb)
    ) as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id
      and item.value ->> 'actionKind' = p_action_kind
      and (item.value ->> 'namedAction') is null
  loop
    required_permissions := required_permissions || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', application_root_id_value,
        'ownerKind', 'application', 'ownerId', application_root_id_value,
        'permissionId', (permission_item ->> 'permissionId')::uuid
      )
    );
  end loop;

  required_permissions := coalesce((
    select pg_catalog.jsonb_agg(item.value order by
      item.value ->> 'ownerKind' collate "C", item.value ->> 'permissionId' collate "C")
    from pg_catalog.jsonb_array_elements(required_permissions) as item(value)
  ), '[]'::jsonb);

  return pg_catalog.jsonb_build_object(
    'context', context_value,
    'recordType', record_type_value,
    'moduleRootId', target_module_root_id,
    'moduleReleaseRevision', target_release_revision,
    'storageContractId', target_storage_contract_id,
    'storageScope', record_type_value ->> 'storageScope',
    'table', catalogue_row.physical_table_token,
    'columns', columns_value,
    'declaration', case when preview_installation_id_value is not null
      then pg_catalog.jsonb_build_object(
        'operationKey', 'record.' || p_action_kind,
        'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
        'target', pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', application_root_id_value
        ),
        'requiredPermissions', required_permissions,
        'recordBinding', pg_catalog.jsonb_build_object(
          'moduleRootId', target_module_root_id,
          'recordTypeId', p_record_type_id,
          'storageContractId', target_storage_contract_id,
          'storageScope', record_type_value ->> 'storageScope'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'preview_owner')
      )
      when pg_catalog.jsonb_array_length(required_permissions) = 0 then null
      else pg_catalog.jsonb_build_object(
        'operationKey', 'record.' || p_action_kind,
        'action', pg_catalog.jsonb_build_object('actionKind', p_action_kind),
        'target', pg_catalog.jsonb_build_object(
          'kind', 'application', 'applicationRootId', application_root_id_value
        ),
        'requiredPermissions', required_permissions,
        'recordBinding', pg_catalog.jsonb_build_object(
          'moduleRootId', target_module_root_id,
          'recordTypeId', p_record_type_id,
          'storageContractId', target_storage_contract_id,
          'storageScope', record_type_value ->> 'storageScope'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      ) end
  ) || case when preview_installation_id_value is not null
    then pg_catalog.jsonb_build_object(
      'previewInstallationId', preview_installation_id_value
    )
    else '{}'::jsonb end;
exception
  when no_data_found then
    raise exception using errcode = '55000',
      message = 'Installed definition evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installed definition evidence is ambiguous';
end
$function$;
alter function vortex_record.resolve_record_action_context_internal(uuid,text) owner to vortex_record_adapter;


alter function vortex_record.resolve_record_action_context_internal(uuid, text)
  owner to vortex_record_adapter;

revoke all on function vortex_record.resolve_record_action_context_internal(uuid, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.resolve_record_action_context_internal(uuid, text) is
  'Private Record metadata resolver over one exact live installation or an owner-validated, unexpired preview storage binding; preview contexts support only reads and base record changes.';

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
    system_projection_record_type_ids, owned_owner_ids, role_ids
  )
  select preview_installation_id_value, organization_id_value, p_application_root_id,
    organization_account_id_value,
    array[]::uuid[],
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

  -- A system projection, of an own Module or a used one, is the platform's live read model: every
  -- permission on it is decided by the builder's own live access, never by a preview role.
  select coalesce(pg_catalog.array_agg(distinct (record_type.value ->> 'recordTypeId')::uuid), array[]::uuid[])
  into system_projection_ids_value
  from pg_catalog.jsonb_array_elements(resolved_modules_value) as pin(value)
  left join vortex_definition.preview_releases as preview
    on preview.preview_installation_id = preview_installation_id_value
    and preview.root_id = (pin.value ->> 'moduleRootId')::uuid
    and preview.release_revision = (pin.value ->> 'moduleReleaseRevision')::bigint
  left join vortex_definition.releases as stored
    on preview.root_id is null
    and stored.root_id = (pin.value ->> 'moduleRootId')::uuid
    and stored.release_revision = (pin.value ->> 'moduleReleaseRevision')::bigint
  cross join lateral pg_catalog.jsonb_array_elements(
    coalesce(
      coalesce(preview.release -> 'compilation_output', stored.compilation_output)
        #> '{canonical,content,recordTypes}',
      '[]'::jsonb
    )
  ) as record_type(value)
  where record_type.value ? 'systemProjection';
  update vortex_access.preview_permission_registrations as registration
  set system_projection_record_type_ids = system_projection_ids_value
  where registration.preview_installation_id = preview_installation_id_value;

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
  copy_result jsonb;
  seeded_count bigint := 0;
  bounded_ids uuid[] := array[]::uuid[];
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
    copy_result := vortex_record.copy_live_records_to_preview_internal(
      p_preview_installation_id,
      (storage_identity ->> 'recordTypeId')::uuid,
      (storage_identity ->> 'releaseStorageContractId')::uuid,
      (storage_identity ->> 'previewStorageContractId')::uuid
    );
    seeded_count := seeded_count + (copy_result ->> 'copied')::bigint;
    if (copy_result ->> 'bounded')::boolean then
      bounded_ids := bounded_ids || (storage_identity ->> 'recordTypeId')::uuid;
    end if;
  end loop;
  update vortex_definition.preview_installations as preview
  set seeded_at = pg_catalog.statement_timestamp(),
      seed_bounded_record_type_ids = bounded_ids
  where preview.preview_installation_id = p_preview_installation_id;
  return seeded_count;
end
$function$;

alter function vortex_definition.seed_preview_installation(uuid) owner to vortex_owner;

revoke all on function vortex_definition.seed_preview_installation(uuid)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.seed_preview_installation(uuid) to vortex_request;
comment on function vortex_definition.seed_preview_installation(uuid) is
  'Seeds a new preview''s storage, once, with the live records its builder reads in the installed Application and only the fields they read there, at most 2,000 per record type, and records the record types that reached that bound. A preview never shows more than its builder sees live, plus what they create in it.';

create or replace function vortex_definition.read_preview_runtime_source()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  installation_value jsonb;
  preview_row vortex_definition.preview_installations%rowtype;
begin
  installation_value := vortex_definition.read_current_active_installation();
  if not installation_value ? 'previewInstallationId' then
    raise exception using errcode = '42501', message = 'Preview installation address is required';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = (installation_value ->> 'previewInstallationId')::uuid;
  if not found or preview_row.runtime_release_set is null then
    raise exception using errcode = '55000', message = 'Preview release set is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'installation', installation_value,
    'draftRevision', preview_row.draft_revision,
    'expiresAt', preview_row.expires_at,
    'correlationId', vortex_access.validated_human_request_context() ->> 'correlationId',
    'releaseSet', preview_row.runtime_release_set,
    'seedBoundedRecordTypeIds', pg_catalog.to_jsonb(preview_row.seed_bounded_record_type_ids)
  );
end
$function$;

alter function vortex_definition.read_preview_runtime_source() owner to vortex_owner;

revoke all on function vortex_definition.read_preview_runtime_source()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_preview_runtime_source()
  to vortex_request;
comment on function vortex_definition.read_preview_runtime_source() is
  'The installation, draft revision, expiry and stored release set of the preview the validated human Application request runs, for the runtime to render it as an installed Application.';

reset role;
