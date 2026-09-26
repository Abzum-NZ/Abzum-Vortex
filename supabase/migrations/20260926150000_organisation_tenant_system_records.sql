-- Tenants, organisations, tenant administrators and installed applications as
-- system records (#1034).
--
-- A system projection record type is a read-only projection over protected core
-- storage: its typed fields project one registered protected view, it has no
-- ordinary create, update, delete or restore path, and every change goes through
-- a named protected operation. This migration registers the tenant, organisation,
-- tenant-administrator and installed-application projections and their readers,
-- so the ordinary query path reads them exactly as the #1030 organisation
-- runtime-settings projection and the #1031/#1032/#1033 person, invitation, group,
-- group-membership, permission, role, assignment, activation and delegation
-- projections are read.
--
-- The registration shape adds three closed protected read-model keys, `tenants`,
-- `tenant_administrators` and `installed_applications`, beside the existing keys.
-- The `tenant_structure` key is already accepted by the registry and the storage
-- catalogue but has never had a registered reader, so the organisation projection
-- fills that existing key rather than adding a fourth. The registry and the
-- storage catalogue both carry the same closed key set, so an unregistered key
-- can never be catalogued and the two checks are replaced together as their owner.
-- The #1030 organisation runtime-settings registration already covers the one
-- organisation settings record, so it is reused; only the projection body changes,
-- to project the default application the settings detail now declares.
--
-- Row visibility stays inside each registered reader and follows today's rules,
-- applying exactly the decision the bespoke reader already applies and never
-- accepting a tenant, organisation or application from the caller:
--   * the organisation projection applies the fixed
--     platform.tenant.hierarchy.read capability the tenant-structure reader
--     applies, on the caller's own resolved tenant, and returns only the caller's
--     own organisation, which is the row an organisation-shared record type owns;
--   * the tenant projection returns the active tenants the caller's effective
--     structural administrator assignment already lists, the exact rule the
--     tenant launcher applies;
--   * the tenant-administrator projection applies the fixed
--     platform.tenant.administrators.read capability the tenant-administration
--     reader applies, and the derived state is descriptive and grants nothing;
--   * the installed-application projection applies the exact derived installed
--     predicate the permitted-applications feed derives, and then authorises every
--     row individually through the same application scope resolution the feed
--     uses. The permitted-applications feed itself stays as it is until a
--     follow-up replaces it.
-- Creation, identity and state-change evidence, capability grant and revocation
-- audit columns, compilation output, fingerprints and the whole installation
-- binding set are never projected.

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
    'delegations',
    'tenants',
    'tenant_administrators',
    'installed_applications'
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
        'delegations',
        'tenants',
        'tenant_administrators',
        'installed_applications'
      )
    )
  );

reset role;

-- ============================================================================
-- Registered organisation projection. The key is the `tenant_structure`
-- protected read model, which the closed set already accepted.
-- ============================================================================

create or replace function vortex_identity.list_organizations_projection(
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
  context_value jsonb;
  visible_tenant_id uuid;
  visible_organization_id uuid;
  actor_identity_id uuid;
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  organization_row record;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.tenant.hierarchy.read capability the bespoke tenant-structure reader
  -- requires is the only visibility, and the tenant is the caller's own resolved
  -- tenant, never page input. A viewer the capability refuses sees no row, exactly
  -- as a missing or foreign record, so the record adapters return their identical
  -- refusal and a list page is empty rather than failing. The record identity is
  -- the organisation and the revision is the organisation's own revision, so an
  -- organisation-shared record type owns exactly the organisation the caller is
  -- established in; its position in the tenant hierarchy is the parent reference
  -- the projection returns. Creation and state-change evidence stay in the
  -- protected storage and are never projected.
  begin
    context_value := vortex_access.validated_human_request_context();
  exception
    when insufficient_privilege then
      return;
  end;
  visible_tenant_id := (context_value ->> 'tenantId')::uuid;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_context.is_non_nil_uuid(visible_tenant_id::text)
    or not vortex_context.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_context.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform vortex_identity.require_current_tenant_capability(
      actor_identity_id,
      visible_tenant_id,
      'platform.tenant.hierarchy.read',
      evaluated_at
    );
  exception
    when sqlstate 'V3101' then
      return;
  end;
  select organization.* into organization_row
  from vortex_identity.organizations as organization
  where organization.tenant_id = visible_tenant_id
    and organization.organization_id = visible_organization_id;
  if organization_row.organization_id is null
    or organization_row.organization_id is distinct from visible_organization_id then
    return;
  end if;
  if p_record_id is not null and p_record_id <> organization_row.organization_id then
    return;
  end if;
  return query select
    organization_row.organization_id,
    organization_row.organization_id,
    organization_row.revision,
    pg_catalog.jsonb_build_object(
      'tenant_id', organization_row.tenant_id,
      'parent_organization_id', organization_row.parent_organization_id,
      'short_name', organization_row.short_name,
      'display_name', organization_row.display_name,
      'state', organization_row.state,
      'state_changed_at', organization_row.state_changed_at,
      'created_at', organization_row.created_at
    );
end
$function$;

revoke all on function vortex_identity.list_organizations_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_identity.list_organizations_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_identity.list_organizations_projection(uuid, integer) is
  'Registered organisation projection: returns the one organisation the current viewer is established in under the fixed platform.tenant.hierarchy.read capability, with the organisation, the organisation identity, the organisation revision and the safe projected attribute values keyed by lowercase field key, or no row when the capability refuses the viewer. Creation and state-change evidence are never projected.';

-- ============================================================================
-- Registered tenant projection. The projection keeps exactly the tenant
-- launcher's rule: an active tenant the caller's effective structural
-- administrator assignment already lists.
-- ============================================================================

create or replace function vortex_identity.list_tenants_projection(
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
  context_value jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
begin
  -- The projection keeps today's row visibility inside itself: the same effective
  -- structural administrator assignment the bespoke tenant launcher applies is
  -- the only visibility, and neither the tenant nor the organisation is ever an
  -- input. A viewer with no effective assignment sees no rows, exactly as a
  -- missing or foreign record, so the record adapters return their identical
  -- refusal and a list page is empty rather than failing. The record identity is
  -- the tenant and the revision is the tenant's own revision. A tenant is a
  -- governance boundary rather than an organisation-owned row, so the projected
  -- organisation is the organisation the record is read in, the one the caller's
  -- validated request context already established; capability evidence and every
  -- grant, revocation and correlation column stay in the protected storage and
  -- are never projected.
  begin
    context_value := vortex_access.validated_human_request_context();
  exception
    when insufficient_privilege then
      return;
  end;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_context.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_context.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  return query
  select
    visible_organization_id,
    tenant.tenant_id,
    tenant.revision,
    pg_catalog.jsonb_build_object(
      'short_name', tenant.short_name,
      'display_name', tenant.display_name,
      'state', tenant.state,
      'state_changed_at', tenant.state_changed_at,
      'created_at', tenant.created_at
    )
  from vortex_identity.tenants as tenant
  where tenant.state = 'active'
    and (p_record_id is null or p_record_id = tenant.tenant_id)
    and exists (
      select 1
      from vortex_identity.tenant_administrator_assignments as assignment
      where assignment.tenant_id = tenant.tenant_id
        and assignment.identity_id = actor_identity_id
        and assignment.revoked_at is null
        and assignment.starts_at <= evaluated_at
        and (assignment.expires_at is null or assignment.expires_at > evaluated_at)
    )
  order by tenant.tenant_id;
end
$function$;

revoke all on function vortex_identity.list_tenants_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_identity.list_tenants_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_identity.list_tenants_projection(uuid, integer) is
  'Registered tenant projection: returns every active tenant the current viewer''s effective structural administrator assignment already lists, the exact rule the tenant launcher applies, with the organisation the record is read in, the tenant identity, the tenant revision and the safe projected attribute values keyed by lowercase field key, or no row when the viewer has no effective assignment. Capability and change evidence is never projected.';

-- ============================================================================
-- Registered tenant-administrator projection.
-- ============================================================================

create or replace function vortex_identity.list_tenant_administrators_projection(
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
  context_value jsonb;
  visible_tenant_id uuid;
  visible_organization_id uuid;
  actor_identity_id uuid;
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- platform.tenant.administrators.read capability the bespoke tenant-administration
  -- reader requires is the only visibility, and the tenant is the caller's own
  -- resolved tenant, never page input. A viewer the capability refuses sees no
  -- rows, exactly as a missing or foreign record, so the record adapters return
  -- their identical refusal and a list page is empty rather than failing. The
  -- record identity is the assignment and the revision is the assignment's own
  -- revision. Every assignment of the tenant is listed, whether scheduled, active,
  -- expired or revoked, and the projected state is descriptive: it grants nothing
  -- and is exactly the derived outcome the bespoke reader returns. The grant,
  -- revocation and correlation audit columns are never projected.
  begin
    context_value := vortex_access.validated_human_request_context();
  exception
    when insufficient_privilege then
      return;
  end;
  visible_tenant_id := (context_value ->> 'tenantId')::uuid;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_context.is_non_nil_uuid(visible_tenant_id::text)
    or not vortex_context.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_context.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  begin
    perform vortex_identity.require_current_tenant_capability(
      actor_identity_id,
      visible_tenant_id,
      'platform.tenant.administrators.read',
      evaluated_at
    );
  exception
    when sqlstate 'V3101' then
      return;
  end;
  return query
  select
    visible_organization_id,
    assignment.assignment_id,
    assignment.revision,
    pg_catalog.jsonb_build_object(
      'tenant_id', assignment.tenant_id,
      'identity_id', assignment.identity_id,
      'capability_keys', assignment.capability_keys,
      'starts_at', assignment.starts_at,
      'expires_at', assignment.expires_at,
      'state', case
        when assignment.revoked_at is not null
          and assignment.revoked_at <= evaluated_at then 'revoked'
        when assignment.starts_at > evaluated_at then 'scheduled'
        when assignment.expires_at is not null
          and assignment.expires_at <= evaluated_at then 'expired'
        else 'active'
      end
    )
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = visible_tenant_id
    and (p_record_id is null or p_record_id = assignment.assignment_id)
  order by assignment.assignment_id;
end
$function$;

revoke all on function vortex_identity.list_tenant_administrators_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_identity.list_tenant_administrators_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_identity.list_tenant_administrators_projection(uuid, integer) is
  'Registered tenant-administrator projection: returns every administrator assignment of the caller''s own tenant, whether scheduled, active, expired or revoked, under the fixed platform.tenant.administrators.read capability, with the organisation the record is read in, the assignment identity, the assignment revision and the safe projected attribute values keyed by lowercase field key, or no row when the capability refuses the viewer. The projected state grants nothing and grant or revocation evidence is never projected.';

-- ============================================================================
-- Registered installed-application projection. Visibility is the exact derived
-- installed predicate the permitted-applications feed applies, then the same
-- per-application authorisation the feed applies.
-- ============================================================================

create or replace function vortex_access.list_installed_applications_projection(
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
  context_value jsonb;
  visible_organization_id uuid;
  actor_identity_id uuid;
  default_application_root_id uuid;
  application_row record;
  authorised boolean;
begin
  -- The projection keeps today's row visibility inside itself and neither the
  -- organisation nor the application is ever an input. An installed application is
  -- exactly the row the permitted-applications feed derives: an active application
  -- registration of the organisation whose published release still matches every
  -- fingerprint and whose installation binding is itself active, so a provisioned
  -- or draining installation is not an installed application. Each derived row is
  -- then authorised individually through the same application scope resolution the
  -- feed uses, so a viewer the scope refuses sees no row for that application,
  -- exactly as a missing or foreign record, and the record adapters return their
  -- identical refusal and a list page is empty rather than failing. The record
  -- identity is the application root and the revision is the registration's own
  -- revision, which every installation change advances. Compilation output,
  -- fingerprints, release evidence, binding evidence and the whole module set are
  -- never projected.
  begin
    context_value := vortex_access.validated_human_request_context();
  exception
    when insufficient_privilege then
      return;
  end;
  visible_organization_id := (context_value ->> 'organizationId')::uuid;
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if not vortex_context.is_non_nil_uuid(visible_organization_id::text)
    or not vortex_context.is_non_nil_uuid(actor_identity_id::text) then
    return;
  end if;
  select settings.default_application_root_id into default_application_root_id
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = visible_organization_id;
  for application_row in
    select
      root.root_id,
      root.key as application_key,
      registration.revision as registration_revision,
      registration.source_revision as release_revision
    from vortex_access.permission_registrations as registration
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = registration.organization_id
      and root.kind = 'application'
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
    where registration.organization_id = visible_organization_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and (p_record_id is null or p_record_id = root.root_id)
      and release.compilation_output ->> 'kind' = 'application'
      and registration.source_content_fingerprint = release.content_fingerprint
      and registration.source_resolution_fingerprint = release.resolution_fingerprint
      and exists (
        select 1
        from vortex_module.installation_bindings as binding
        where binding.organization_id = visible_organization_id
          and binding.application_root_id = root.root_id
          and binding.application_release_revision = registration.source_revision
          and binding.state = 'active'
      )
    order by root.key collate "C", root.root_id
  loop
    authorised := false;
    begin
      perform 1
      from vortex_access.resolve_human_application_scope(
        actor_identity_id, visible_organization_id, application_row.root_id
      ) as scope;
      authorised := true;
    exception
      when sqlstate '42501' or sqlstate 'P0002' then
        authorised := false;
    end;
    if authorised then
      return query select
        visible_organization_id,
        application_row.root_id,
        application_row.registration_revision,
        pg_catalog.jsonb_build_object(
          'key', application_row.application_key,
          'release_revision', application_row.release_revision,
          'is_default', application_row.root_id
            is not distinct from default_application_root_id
        );
    end if;
  end loop;
end
$function$;

revoke all on function vortex_access.list_installed_applications_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_installed_applications_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_installed_applications_projection(uuid, integer) is
  'Registered installed-application projection: returns every application the current viewer may reach that is installed in the viewer''s organisation, being an active application registration whose published release still matches every fingerprint and whose installation binding is active, with the organisation, the application identity, the registration revision and the safe projected attribute values keyed by lowercase field key, or no row when the application scope refuses the viewer. Compilation output, fingerprints, release evidence and binding evidence are never projected.';

-- ============================================================================
-- The one organisation settings record keeps the #1030 registration. Its reader
-- is replaced only to project the default application the settings detail now
-- declares, and it keeps the same fixed runtime-settings decision and the same
-- single settings row, read exactly as the private Identity reader read it.
-- ============================================================================

create or replace function vortex_access.list_organization_runtime_settings_projection(
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
  settings_row record;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- runtime-settings read decision the bespoke reader applies decides whether
  -- any row exists at all, and the caller's current organisation is never an
  -- input. A viewer the decision refuses sees no row, exactly as a missing or
  -- foreign record, so the record adapters return their identical refusal and
  -- a list page is empty rather than failing. The record identity is the
  -- organisation, whose settings are a single row, and the revision is the
  -- settings document's own revision, which the default application shares.
  -- Attribute names are the lowercase field keys a projection record type
  -- declares.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_runtime_settings_administration_read_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  select settings.* into settings_row
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = scope_row.organization_id;
  if settings_row.organization_id is null
    or settings_row.organization_id is distinct from scope_row.organization_id then
    return;
  end if;
  if p_record_id is not null and p_record_id <> settings_row.organization_id then
    return;
  end if;
  return query select
    settings_row.organization_id,
    settings_row.organization_id,
    settings_row.revision,
    pg_catalog.jsonb_build_object(
      'language', settings_row.language,
      'time_zone', settings_row.time_zone,
      'currency', settings_row.currency,
      'date_format', settings_row.date_format,
      'number_format', settings_row.number_format,
      'default_application_root_id', settings_row.default_application_root_id
    );
end
$function$;

revoke all on function vortex_access.list_organization_runtime_settings_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_runtime_settings_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_runtime_settings_projection(uuid, integer) is
  'Registered organisation runtime-settings projection: returns the one settings row the current viewer may read under the fixed runtime-settings decision, with the organisation, the record identity, the settings revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer or no settings exist.';

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
  ('tenant_structure', 'vortex_identity', 'list_organizations_projection'),
  ('tenants', 'vortex_identity', 'list_tenants_projection'),
  ('tenant_administrators', 'vortex_identity', 'list_tenant_administrators_projection'),
  ('installed_applications', 'vortex_access', 'list_installed_applications_projection');

reset role;

commit;
