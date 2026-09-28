-- Run the remaining Access catalogue, permission-list and address-role readers with the Access owner.

begin;

-- These readers need additional Access columns and two read-only relations.
revoke all privileges on table
  vortex_access.permission_registration_revisions,
  vortex_access.validation_reference_values
from vortex_access_owner;

grant select (application_root_id, role_kind, source_role_id)
on table vortex_access.organization_roles to vortex_access_owner;

grant select (
  role_kind, privilege_classification, application_root_id, source_catalogue_fingerprint,
  accepted_registration_revision, source_registration_kind, source_definition_key,
  source_release_revision,
  source_release_version, source_validation_contract_version, source_content_fingerprint,
  source_resolution_fingerprint
) on table vortex_access.organization_role_revisions to vortex_access_owner;

grant select (
  registration_kind, registration_owner_id, accepted_registration_revision, catalogue_fingerprint
)
on table vortex_access.organization_role_permission_entries to vortex_access_owner;

grant select (
  organization_id, registration_kind, registration_owner_id, revision, state,
  source_definition_key, source_version, source_revision, validation_contract_version,
  source_content_fingerprint, source_resolution_fingerprint, permission_catalogue_fingerprint
) on table vortex_access.permission_registration_revisions to vortex_access_owner;

create policy permission_registration_revisions_access_owner_select
  on vortex_access.permission_registration_revisions
  for select to vortex_access_owner using (true);

grant select (reference_list, reference_value, reference_ordinal)
on table vortex_access.validation_reference_values to vortex_access_owner;

create policy validation_reference_values_access_owner_select
  on vortex_access.validation_reference_values
  for select to vortex_access_owner using (true);

-- Reinstall the four pre-canonical readers from migration text so their new canonical files match exactly.

create or replace function vortex_access.list_organization_permissions_for_administration(
  p_after_application_root_id uuid,
  p_after_owner_kind text,
  p_after_owner_id uuid,
  p_after_permission_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  permissions jsonb,
  next_after_application_root_id uuid,
  next_after_owner_kind text,
  next_after_owner_id uuid,
  next_after_permission_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  permission_items jsonb;
  page_application_root_ids uuid[];
  page_owner_kinds text[];
  page_owner_ids uuid[];
  page_permission_ids uuid[];
  candidate_count integer;
  cursor_absent boolean;
  cursor_valid boolean;
begin
  cursor_absent := p_after_application_root_id is null
    and p_after_owner_kind is null
    and p_after_owner_id is null
    and p_after_permission_id is null;
  cursor_valid := cursor_absent
    or (
      p_after_application_root_id is null
      and p_after_owner_kind = 'platform'
      and p_after_owner_id is not null
      and p_after_permission_id is not null
    )
    or (
      p_after_application_root_id is not null
      and p_after_owner_kind in ('application', 'module')
      and p_after_owner_id is not null
      and p_after_permission_id is not null
      and (
        p_after_owner_kind <> 'application'
        or p_after_owner_id = p_after_application_root_id
      )
    );

  if p_page_size is null or p_page_size not between 1 and 100
    or cursor_valid is not true
    or p_after_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_after_owner_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_after_permission_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization permission catalogue page input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_permissions_administration_scope() as authorized;

  with candidates as (
    select entry.application_root_id, entry.owner_kind, entry.owner_id,
      entry.permission_id, entry.permission_key, entry.label, entry.description,
      entry.record_type_id, entry.action_kind, entry.named_action,
      entry.administrative,
      pg_catalog.row_number() over (
        order by entry.application_root_id asc nulls last,
          entry.owner_kind, entry.owner_id, entry.permission_id
      ) as ordinal
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
    where entry.organization_id = scope.organization_id
      and registration.state = 'active'
      and (
        cursor_absent
        or (
          p_after_application_root_id is not null
          and (
            entry.application_root_id is null
            or (
              entry.application_root_id is not null
              and (
                entry.application_root_id, entry.owner_kind,
                entry.owner_id, entry.permission_id
              ) > (
                p_after_application_root_id, p_after_owner_kind,
                p_after_owner_id, p_after_permission_id
              )
            )
          )
        )
        or (
          p_after_application_root_id is null
          and entry.application_root_id is null
          and (entry.owner_kind, entry.owner_id, entry.permission_id)
            > (p_after_owner_kind, p_after_owner_id, p_after_permission_id)
        )
      )
    order by entry.application_root_id asc nulls last,
      entry.owner_kind, entry.owner_id, entry.permission_id
    limit p_page_size + 1
  )
  select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_strip_nulls(
          pg_catalog.jsonb_build_object(
            'reference', pg_catalog.jsonb_strip_nulls(
              pg_catalog.jsonb_build_object(
                'applicationRootId', candidate.application_root_id,
                'ownerKind', candidate.owner_kind,
                'ownerId', candidate.owner_id,
                'permissionId', candidate.permission_id
              )
            ),
            'key', candidate.permission_key,
            'label', candidate.label,
            'description', candidate.description,
            'recordTypeId', candidate.record_type_id,
            'action', pg_catalog.jsonb_strip_nulls(
              pg_catalog.jsonb_build_object(
                'actionKind', candidate.action_kind,
                'namedAction', candidate.named_action
              )
            ),
            'administrative', candidate.administrative
          )
        ) order by candidate.application_root_id asc nulls last,
          candidate.owner_kind, candidate.owner_id, candidate.permission_id
      ) filter (where candidate.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    pg_catalog.array_agg(candidate.application_root_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.array_agg(candidate.owner_kind order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.array_agg(candidate.owner_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.array_agg(candidate.permission_id order by candidate.ordinal)
      filter (where candidate.ordinal <= p_page_size),
    pg_catalog.count(*)
  into permission_items, page_application_root_ids, page_owner_kinds,
    page_owner_ids, page_permission_ids, candidate_count
  from candidates as candidate;

  return query select scope.organization_id, permission_items,
    case when candidate_count > p_page_size
      then page_application_root_ids[p_page_size] else null end,
    case when candidate_count > p_page_size
      then page_owner_kinds[p_page_size] else null end,
    case when candidate_count > p_page_size
      then page_owner_ids[p_page_size] else null end,
    case when candidate_count > p_page_size
      then page_permission_ids[p_page_size] else null end,
    scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.list_organization_permissions_for_administration(uuid, text, uuid, uuid, integer)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.list_organization_permissions_for_administration(uuid, text, uuid, uuid, integer)
to vortex_request;

comment on function
  vortex_access.list_organization_permissions_for_administration(uuid, text, uuid, uuid, integer) is
  'Returns one bounded current permission-catalogue page without internal registration evidence.';
create or replace function vortex_access.organization_permissions_administration_scope()
returns table (
  organization_id uuid,
  organization_account_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  decision record;
begin
  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.permissions.read',
      'action', pg_catalog.jsonb_build_object('actionKind', 'read'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '687d5649-62ee-43dd-b684-b8af3a5394c1'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;

  if decision.outcome is distinct from 'eligible' then
    raise exception using errcode = '42501',
      message = 'Organization permission catalogue is unavailable';
  end if;

  return query select decision.organization_id,
    decision.organization_account_id, decision.access_version;
end
$function$;

revoke execute on function vortex_access.organization_permissions_administration_scope()
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.organization_permissions_administration_scope() is
  'Private fixed permissions-read authorization for the current registered permission catalogue.';
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
create or replace function vortex_access.read_organization_permission_for_administration(
  p_application_root_id uuid,
  p_owner_kind text,
  p_owner_id uuid,
  p_permission_id uuid
)
returns table (
  organization_id uuid,
  outcome text,
  permission_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  permission_value jsonb;
begin
  if p_owner_id is null or p_permission_id is null
    or p_owner_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_permission_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (
      (
        p_application_root_id is null
        and p_owner_kind = 'platform'
      )
      or (
        p_application_root_id is not null
        and p_owner_kind in ('application', 'module')
        and (
          p_owner_kind <> 'application'
          or p_owner_id = p_application_root_id
        )
      )
    ) is not true then
    raise exception using errcode = '22023',
      message = 'Organization permission catalogue detail input is invalid';
  end if;

  select authorized.* into strict scope
  from vortex_access.organization_permissions_administration_scope() as authorized;

  select pg_catalog.jsonb_strip_nulls(
    pg_catalog.jsonb_build_object(
      'reference', pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'applicationRootId', entry.application_root_id,
          'ownerKind', entry.owner_kind,
          'ownerId', entry.owner_id,
          'permissionId', entry.permission_id
        )
      ),
      'key', entry.permission_key,
      'label', entry.label,
      'description', entry.description,
      'recordTypeId', entry.record_type_id,
      'action', pg_catalog.jsonb_strip_nulls(
        pg_catalog.jsonb_build_object(
          'actionKind', entry.action_kind,
          'namedAction', entry.named_action
        )
      ),
      'administrative', entry.administrative
    )
  )
  into permission_value
  from vortex_access.permission_catalogue_entries as entry
  join vortex_access.permission_registrations as registration
    on registration.organization_id = entry.organization_id
    and registration.registration_kind = entry.registration_kind
    and registration.registration_owner_id = entry.registration_owner_id
    and registration.revision = entry.registration_revision
  where entry.organization_id = scope.organization_id
    and registration.state = 'active'
    and entry.application_root_id is not distinct from p_application_root_id
    and entry.owner_kind = p_owner_kind
    and entry.owner_id = p_owner_id
    and entry.permission_id = p_permission_id;

  return query select scope.organization_id,
    case when permission_value is null then 'unavailable' else 'available' end,
    permission_value, scope.access_version;
end
$function$;

revoke execute on function
  vortex_access.read_organization_permission_for_administration(uuid, text, uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_access.read_organization_permission_for_administration(uuid, text, uuid, uuid)
to vortex_request;

comment on function
  vortex_access.read_organization_permission_for_administration(uuid, text, uuid, uuid) is
  'Returns one safe current permission-catalogue detail under the fixed permissions-read decision.';

-- Existing functions keep their body, pinned search_path, caller grants and comment.
alter function vortex_access.list_organization_permissions_for_administration(
  uuid, text, uuid, uuid, integer
)
  owner to vortex_access_owner;
alter function vortex_access.list_organization_permissions_projection(uuid, integer)
  owner to vortex_access_owner;
alter function vortex_access.organization_permissions_administration_scope()
  owner to vortex_access_owner;
alter function vortex_access.read_current_application_role_ids_for_launcher()
  owner to vortex_access_owner;
alter function vortex_access.read_organization_permission_for_administration(
  uuid, text, uuid, uuid
)
  owner to vortex_access_owner;
alter function vortex_access.validate_application_role_template_continuity_evidence()
  owner to vortex_access_owner;
alter function vortex_access.validate_organization_role_revision_evidence()
  owner to vortex_access_owner;
alter function vortex_access.validate_permission_continuity_evidence()
  owner to vortex_access_owner;
alter function vortex_access.validation_reference_list(text)
  owner to vortex_access_owner;

commit;
