-- Roles, permissions, role assignments, role activations and delegations as
-- system records (#1033).
--
-- A system projection record type is a read-only projection over protected core
-- storage: its typed fields project one registered protected view, it has no
-- ordinary create, update, delete or restore path, and every change goes through
-- a named protected operation. This migration registers the permission, role,
-- role-assignment, role-activation and delegation projections and their readers,
-- so the ordinary query path reads them exactly as the #1030 organisation
-- runtime-settings projection and the #1031/#1032 person, invitation, group and
-- group-membership projections are read.
--
-- The registration shape adds three closed protected read-model keys,
-- `permissions`, `role_activations` and `delegations`, beside the existing
-- `roles` and `effective_assignments` keys. The registry and the storage
-- catalogue both carry the same closed key set, so an unregistered key can never
-- be catalogued and the two checks are replaced together as their owner.
--
-- Row visibility stays inside each registered reader and follows today's rules.
-- The permission projection applies the fixed
-- platform.organization.permissions.read decision; the role projection applies
-- the fixed platform.organization.roles.read decision; and the role-assignment,
-- role-activation and delegation projections apply the fixed
-- platform.organization.assignments.read decision, exactly as the bespoke
-- Access administration readers do. Registration provenance, fingerprints,
-- record-scope evidence, policy provenance, caller bindings, the bounded
-- delegation permission set and every grant or revocation audit column are never
-- projected. Each reader is registered in the closed
-- vortex_record.protected_read_model_views registry, so storage provisioning can
-- only ever catalogue it under its exact declared key.

begin;

-- ============================================================================
-- Extend the closed protected read-model key set. The registry is owned by
-- vortex_record_owner, whose policy is the only write path, so the checks are
-- replaced as that role.
-- ============================================================================

set local role vortex_record_owner;

alter table vortex_record.protected_read_model_views
  drop constraint protected_read_model_views_protected_read_model_key_check;

alter table vortex_record.protected_read_model_views
  add constraint protected_read_model_views_protected_read_model_key_check
  check (protected_read_model_key in (
    'people',
    'organization_accounts',
    'roles',
    'groups',
    'effective_assignments',
    'tenant_structure',
    'organization_invitations',
    'organization_runtime_settings',
    'permissions',
    'role_activations',
    'delegations'
  ));

alter table vortex_record.storage_catalogue
  drop constraint storage_catalogue_protected_read_model_key_check;

alter table vortex_record.storage_catalogue
  add constraint storage_catalogue_protected_read_model_key_check
  check (
    (physical_schema_token = 'system_projection') = (protected_read_model_key is not null)
    and (
      protected_read_model_key is null
      or protected_read_model_key in (
        'people',
        'organization_accounts',
        'roles',
        'groups',
        'effective_assignments',
        'tenant_structure',
        'organization_invitations',
        'organization_runtime_settings',
        'permissions',
        'role_activations',
        'delegations'
      )
    )
  );

reset role;

-- ============================================================================
-- Access-registered projection readers. One reader per protected read-model
-- key, applying that read model's own visibility and returning the
-- organisation, the projected row identity, the projected revision and the
-- projected safe attribute values for the current viewer.
-- ============================================================================

create or replace function vortex_access.list_organization_permissions_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.organization.permissions.read decision the bespoke permission
  -- catalogue administration reader applies is the only visibility, and the
  -- caller's current organisation is never an input. A viewer the decision
  -- refuses sees no rows, exactly as a missing or foreign record, so the record
  -- adapters return their identical refusal and a list page is empty rather than
  -- failing. A permission identity is unique only within its registration and
  -- owner, so the record identity is a stable version-8 UUID derived from the
  -- exact owner-qualified declaration (registration kind and owner, owner kind
  -- and owner, permission): two owners declaring the same permission identity
  -- stay two distinct records, and a new registration revision keeps the record
  -- identity. The revision is the active catalogue registration revision and the
  -- attribute names are the lowercase field keys a projection record type
  -- declares. Registration provenance, fingerprints, record-scope evidence and
  -- audit columns stay in the protected storage and are never projected.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_permissions_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  return query
  select
    scope_row.organization_id,
    projected.record_id,
    projected.registration_revision,
    projected.attribute_values
  from (
    select
      (
        pg_catalog.substr(derived.hash_hex, 1, 8) || '-'
        || pg_catalog.substr(derived.hash_hex, 9, 4) || '-'
        || '8' || pg_catalog.substr(derived.hash_hex, 14, 3) || '-'
        || pg_catalog.substr(
             '89ab',
             1 + ((pg_catalog.strpos(
               '0123456789abcdef', pg_catalog.substr(derived.hash_hex, 17, 1)
             ) - 1) % 4),
             1
           ) || pg_catalog.substr(derived.hash_hex, 18, 3) || '-'
        || pg_catalog.substr(derived.hash_hex, 21, 12)
      )::uuid as record_id,
      entry.registration_revision,
      pg_catalog.jsonb_build_object(
        'key', entry.permission_key,
        'label', entry.label,
        'description', entry.description,
        'owner_kind', entry.owner_kind,
        'action_kind', entry.action_kind,
        'named_action', entry.named_action,
        'administrative', entry.administrative
      ) as attribute_values
    from vortex_access.permission_catalogue_entries as entry
    join vortex_access.permission_registrations as registration
      on registration.organization_id = entry.organization_id
      and registration.registration_kind = entry.registration_kind
      and registration.registration_owner_id = entry.registration_owner_id
      and registration.revision = entry.registration_revision
    cross join lateral (
      select pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          'vortex.permission_projection' || E'\x1f'
            || entry.organization_id::text || E'\x1f'
            || entry.registration_kind || E'\x1f'
            || entry.registration_owner_id::text || E'\x1f'
            || entry.owner_kind || E'\x1f'
            || entry.owner_id::text || E'\x1f'
            || entry.permission_id::text,
          'UTF8'
        )),
        'hex'
      ) as hash_hex
    ) as derived
    where entry.organization_id = scope_row.organization_id
      and registration.state = 'active'
  ) as projected
  where p_record_id is null or p_record_id = projected.record_id
  order by projected.record_id;
end
$function$;

revoke all on function vortex_access.list_organization_permissions_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_permissions_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_permissions_projection(uuid, integer) is
  'Registered permission projection: returns every current registered permission catalogue entry the fixed platform.organization.permissions.read decision admits, with the organisation, a stable record identity derived from the exact owner-qualified permission, the active registration revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer. Registration provenance, fingerprints, record-scope evidence and audit columns are never projected.';

create or replace function vortex_access.list_organization_roles_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.organization.roles.read decision the bespoke role catalogue
  -- administration reader applies is the only visibility, and the caller's
  -- current organisation is never an input. A viewer the decision refuses sees
  -- no rows, exactly as a missing or foreign record, so the record adapters
  -- return their identical refusal and a list page is empty rather than failing.
  -- The record identity is the role, the revision is the role's own live revision
  -- and the attribute names are the lowercase field keys a projection record type
  -- declares. Role identity, key, label, lifecycle, kind, privilege
  -- classification, assignment policy and accepted permission count are the only
  -- facts projected; acceptance evidence and audit columns stay in the protected
  -- storage.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_roles_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  return query
  select
    scope_row.organization_id,
    role.role_id,
    role.live_revision,
    pg_catalog.jsonb_build_object(
      'key', role_revision.role_key,
      'label', role_revision.label,
      'lifecycle', role_revision.lifecycle,
      'role_kind', role.role_kind,
      'privilege_classification', role_revision.privilege_classification,
      'assignment_policy', role_revision.assignment_policy,
      'accepted_permission_count', (
        select pg_catalog.count(*)
        from vortex_access.organization_role_permission_entries as permission
        where permission.organization_id = role_revision.organization_id
          and permission.role_id = role_revision.role_id
          and permission.role_revision = role_revision.revision
      )
    )
  from vortex_access.organization_roles as role
  join vortex_access.organization_role_revisions as role_revision
    on role_revision.organization_id = role.organization_id
    and role_revision.role_id = role.role_id
    and role_revision.revision = role.live_revision
  where role.organization_id = scope_row.organization_id
    and (p_record_id is null or p_record_id = role.role_id)
  order by role.role_id;
end
$function$;

revoke all on function vortex_access.list_organization_roles_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_roles_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_roles_projection(uuid, integer) is
  'Registered role projection: returns every current local role the fixed platform.organization.roles.read decision admits, with the organisation, the role identity, the role live revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer. Acceptance evidence and audit columns are never projected.';

create or replace function vortex_access.list_organization_role_assignments_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
  checked_at timestamptz;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.organization.assignments.read decision the bespoke assignment
  -- ledger administration reader applies is the only visibility, and the
  -- caller's current organisation is never an input. A viewer the decision
  -- refuses sees no rows, exactly as a missing or foreign record, so the record
  -- adapters return their identical refusal and a list page is empty rather than
  -- failing. The record identity is the assignment, the revision is the
  -- assignment's own revision and the attribute names are the lowercase field
  -- keys a projection record type declares. The temporal state is descriptive
  -- and grants no permission; grant and revocation evidence is never projected.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_assignment_ledger_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  return query
  select
    scope_row.organization_id,
    assignment.role_assignment_id,
    assignment.revision,
    pg_catalog.jsonb_build_object(
      'role_id', assignment.role_id,
      'role_key', role_revision.role_key,
      'role_label', role_revision.label,
      'assignee_kind', assignment.assignee_kind,
      'organization_account_id', assignment.organization_account_id,
      'group_id', assignment.group_id,
      'assignment_kind', assignment.assignment_kind,
      'starts_at', assignment.starts_at,
      'expires_at', assignment.expires_at,
      'state', assignment.state,
      'temporal_state', case
        when assignment.state = 'revoked' then 'revoked'
        when assignment.starts_at > checked_at then 'scheduled'
        when assignment.expires_at is not null
          and assignment.expires_at <= checked_at then 'expired'
        else 'active'
      end
    )
  from vortex_access.organization_role_assignments as assignment
  join vortex_access.organization_roles as role
    on role.organization_id = assignment.organization_id
    and role.role_id = assignment.role_id
  join vortex_access.organization_role_revisions as role_revision
    on role_revision.organization_id = role.organization_id
    and role_revision.role_id = role.role_id
    and role_revision.revision = role.live_revision
  where assignment.organization_id = scope_row.organization_id
    and (p_record_id is null or p_record_id = assignment.role_assignment_id)
  order by assignment.role_assignment_id;
end
$function$;

revoke all on function vortex_access.list_organization_role_assignments_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_role_assignments_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_role_assignments_projection(uuid, integer) is
  'Registered role-assignment projection: returns every standing or eligible assignment of the viewer''s organisation, whether active, scheduled, expired or revoked, under the fixed platform.organization.assignments.read decision, with the organisation, the assignment identity, the assignment revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer. Grant and revocation evidence is never projected.';

create or replace function vortex_access.list_organization_role_activations_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
  checked_at timestamptz;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.organization.assignments.read decision the bespoke activation
  -- administration reader applies is the only visibility, and the caller's
  -- current organisation is never an input. A viewer the decision refuses sees
  -- no rows, exactly as a missing or foreign record, so the record adapters
  -- return their identical refusal and a list page is empty rather than failing.
  -- The record identity is the activation, the revision is the activation's own
  -- revision and the attribute names are the lowercase field keys a projection
  -- record type declares. The temporal state is descriptive and grants no
  -- permission; policy provenance, caller bindings and audit evidence are never
  -- projected.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_assignment_ledger_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  return query
  select
    scope_row.organization_id,
    activation.role_activation_id,
    activation.revision,
    pg_catalog.jsonb_build_object(
      'organization_account_id', activation.organization_account_id,
      'account_display_name', account.display_name,
      'role_id', activation.role_id,
      'role_key', role_revision.role_key,
      'role_label', role_revision.label,
      'eligibility_source_kind', activation.eligibility_source_kind,
      'activated_at', activation.activated_at,
      'expires_at', activation.expires_at,
      'state', activation.state,
      'temporal_state', case
        when activation.state = 'revoked' then 'revoked'
        when activation.expires_at <= checked_at then 'expired'
        else 'active'
      end
    )
  from vortex_access.organization_role_activations as activation
  join vortex_identity.organization_accounts as account
    on account.organization_id = activation.organization_id
    and account.organization_account_id = activation.organization_account_id
  join vortex_access.organization_roles as role
    on role.organization_id = activation.organization_id
    and role.role_id = activation.role_id
  join vortex_access.organization_role_revisions as role_revision
    on role_revision.organization_id = role.organization_id
    and role_revision.role_id = role.role_id
    and role_revision.revision = role.live_revision
  where activation.organization_id = scope_row.organization_id
    and (p_record_id is null or p_record_id = activation.role_activation_id)
  order by activation.role_activation_id;
end
$function$;

revoke all on function vortex_access.list_organization_role_activations_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_role_activations_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_role_activations_projection(uuid, integer) is
  'Registered role-activation projection: returns every retained activation of the viewer''s organisation under the fixed platform.organization.assignments.read decision, with the organisation, the activation identity, the activation revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer. Policy provenance, caller bindings and audit evidence are never projected.';

create or replace function vortex_access.list_organization_delegations_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
  checked_at timestamptz;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.organization.assignments.read decision the bespoke delegation
  -- administration reader applies is the only visibility, and the caller's
  -- current organisation is never an input. A viewer the decision refuses sees
  -- no rows, exactly as a missing or foreign record, so the record adapters
  -- return their identical refusal and a list page is empty rather than failing.
  -- The record identity is the delegation authority, the revision is the
  -- delegation's own revision and the attribute names are the lowercase field
  -- keys a projection record type declares. The temporal state is descriptive
  -- and grants no permission; the bounded permission set, its fingerprint and
  -- every grant or revocation audit column are never projected.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_assignment_ledger_administration_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  checked_at := pg_catalog.statement_timestamp();
  return query
  select
    scope_row.organization_id,
    delegation.delegation_authority_id,
    delegation.revision,
    pg_catalog.jsonb_build_object(
      'holder_kind', delegation.holder_kind,
      'organization_account_id', delegation.organization_account_id,
      'group_id', delegation.group_id,
      'scope_kind', delegation.scope_kind,
      'starts_at', delegation.starts_at,
      'expires_at', delegation.expires_at,
      'state', delegation.state,
      'temporal_state', case
        when delegation.state = 'revoked' then 'revoked'
        when delegation.starts_at > checked_at then 'scheduled'
        when delegation.expires_at is not null
          and delegation.expires_at <= checked_at then 'expired'
        else 'active'
      end
    )
  from vortex_access.organization_delegation_authorities as delegation
  where delegation.organization_id = scope_row.organization_id
    and (p_record_id is null or p_record_id = delegation.delegation_authority_id)
  order by delegation.delegation_authority_id;
end
$function$;

revoke all on function vortex_access.list_organization_delegations_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_delegations_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_delegations_projection(uuid, integer) is
  'Registered delegation projection: returns every delegation authority of the viewer''s organisation, whether active, scheduled, expired or revoked, under the fixed platform.organization.assignments.read decision, with the organisation, the delegation identity, the delegation revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer. The bounded permission set, its fingerprint and every grant or revocation audit column are never projected.';

-- ============================================================================
-- Register the readers under their exact closed keys, so a projection record
-- type can only ever be catalogued against the reader registered here. The
-- registry is owned by vortex_record_owner, whose policy is the only write
-- path, so the rows are inserted as that role.
-- ============================================================================

set local role vortex_record_owner;

insert into vortex_record.protected_read_model_views (
  protected_read_model_key, reader_schema, reader_function
) values
  ('permissions', 'vortex_access', 'list_organization_permissions_projection'),
  ('roles', 'vortex_access', 'list_organization_roles_projection'),
  ('effective_assignments', 'vortex_access',
    'list_organization_role_assignments_projection'),
  ('role_activations', 'vortex_access',
    'list_organization_role_activations_projection'),
  ('delegations', 'vortex_access', 'list_organization_delegations_projection');

reset role;

commit;
