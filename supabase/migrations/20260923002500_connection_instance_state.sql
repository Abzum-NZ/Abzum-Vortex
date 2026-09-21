-- ============================================================================
-- Migration: 20260923002500_connection_instance_state.sql
-- #408: Source-owned Connection-instance state, explicit permanent-application
-- grants, closed destination identity/fingerprint, and readiness projection.
-- ============================================================================

create schema if not exists vortex_connection authorization postgres;

-- ----------------------------------------------------------------------------
-- Authoritative Connection Instances Table
-- ----------------------------------------------------------------------------
create table vortex_connection.connection_instances (
  connection_instance_id uuid primary key,
  organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  connection_type_id uuid not null,
  connection_type_version text not null,
  destination_key text not null,
  destination_fingerprint text not null,
  state text not null check (state in ('pending', 'active', 'unhealthy', 'revoked')),
  last_health_outcome text not null check (last_health_outcome in ('healthy', 'unhealthy', 'unknown')),
  revision bigint not null check (revision between 1 and 9007199254740991),
  administrator_activity_id uuid not null,
  token_expires_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint connection_instances_id_non_nil check (
    connection_instance_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint connection_instances_organization_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint connection_instances_type_non_nil check (
    connection_type_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint connection_instances_activity_non_nil check (
    administrator_activity_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint connection_instances_destination_key_valid check (
    destination_key = pg_catalog.btrim(destination_key)
    and pg_catalog.char_length(destination_key) between 1 and 80
    and destination_key ~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$'
    and destination_key !~* 'https?:|postgres:|select\s|insert\s|delete\s|update\s|drop\s'
  ),
  constraint connection_instances_destination_fingerprint_valid check (
    destination_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  constraint connection_instances_time_order check (
    updated_at >= created_at
  ),
  constraint connection_instances_org_destination_unique unique (
    organization_id, destination_key
  )
);

alter table vortex_connection.connection_instances enable row level security;
alter table vortex_connection.connection_instances force row level security;

-- ----------------------------------------------------------------------------
-- Explicit Permanent-Application Grants Table
-- ----------------------------------------------------------------------------
create table vortex_connection.connection_application_grants (
  connection_instance_id uuid not null
    references vortex_connection.connection_instances (connection_instance_id)
    on delete cascade,
  application_root_id uuid not null,
  organization_id uuid not null
    references vortex_identity.organizations (organization_id),
  granted_at timestamptz not null,
  primary key (connection_instance_id, application_root_id),
  constraint connection_grants_app_non_nil check (
    application_root_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  constraint connection_grants_organization_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  )
);

alter table vortex_connection.connection_application_grants enable row level security;
alter table vortex_connection.connection_application_grants force row level security;

-- ----------------------------------------------------------------------------
-- RLS Scope Policies
-- ----------------------------------------------------------------------------
create policy connection_instances_request_read on vortex_connection.connection_instances
  for select to vortex_request
  using (
    organization_id = vortex_context.organization_id()
  );

create policy connection_application_grants_request_read on vortex_connection.connection_application_grants
  for select to vortex_request
  using (
    organization_id = vortex_context.organization_id()
  );

-- ----------------------------------------------------------------------------
-- Owner-Projected Readiness Check Function
--
-- Exposes an owner-projected read/check surface consumed by 20260923010000
-- policy SQL.
--
-- Fails closed:
--   - Rejects missing, pending, unhealthy, revoked, or superseded connection
--   - Rejects organization mismatch
--   - Rejects missing explicit permanent-application grant
--   - Rejects stale revision or destination fingerprint
--   - Rejects destination key mismatch
--   - Rejects expired credentials/tokens
--   - Rejects caller-supplied boolean flags or mutable label bypasses
--   - Outputs zero secret/credential material
-- ----------------------------------------------------------------------------
create function vortex_connection.resolve_connection_instance_readiness(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_connection_instance_id uuid,
  p_destination_key text,
  p_expected_revision bigint default null,
  p_expected_fingerprint text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  context_org_id uuid;
  context_app_id uuid;
  conn_row vortex_connection.connection_instances%rowtype;
  now_ts timestamptz := pg_catalog.statement_timestamp();
  has_app_grant boolean;
begin
  -- 1. Validate parameter shapes
  if p_organization_id is null or p_organization_id = nil_uuid
    or p_connection_instance_id is null or p_connection_instance_id = nil_uuid
    or p_destination_key is null
    or pg_catalog.char_length(p_destination_key) not between 1 and 80
    or p_destination_key !~ '^[a-z0-9]+(?:[-_][a-z0-9]+)*$'
    or (p_expected_revision is not null and p_expected_revision not between 1 and 9007199254740991)
    or (p_expected_fingerprint is not null and p_expected_fingerprint !~ '^[a-f0-9]{64}$') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'invalid_parameters'
    );
  end if;

  -- 2. Validate request context binding
  context_value := vortex_context.current_context();
  context_org_id := vortex_context.organization_id();
  if context_org_id is null or context_org_id <> p_organization_id then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'organization_mismatch'
    );
  end if;

  -- Connection instances strictly require permanent application scope (not organisation-shared)
  if p_application_root_id is null or p_application_root_id = nil_uuid then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'application_scope_required'
    );
  end if;

  if context_value ? 'applicationRootId' then
    context_app_id := (context_value ->> 'applicationRootId')::uuid;
    if context_app_id is distinct from p_application_root_id then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused',
        'reasonCode', 'application_mismatch'
      );
    end if;
  end if;

  -- 3. Read connection instance row under FOR SHARE lock
  select conn.* into conn_row
  from vortex_connection.connection_instances as conn
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = p_organization_id
  for share;

  if not found then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'connection_unavailable'
    );
  end if;

  -- 4. Check active state and health outcome
  if conn_row.state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'connection_not_active',
      'currentState', conn_row.state
    );
  end if;

  if conn_row.last_health_outcome <> 'healthy' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'connection_unhealthy',
      'currentHealthOutcome', conn_row.last_health_outcome
    );
  end if;

  -- 5. Check token expiry if set
  if conn_row.token_expires_at is not null and conn_row.token_expires_at <= now_ts then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'connection_token_expired'
    );
  end if;

  -- 6. Check destination key
  if conn_row.destination_key <> p_destination_key then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'destination_mismatch'
    );
  end if;

  -- 7. Check revision freshness
  if p_expected_revision is not null and conn_row.revision <> p_expected_revision then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'stale_revision',
      'currentRevision', conn_row.revision
    );
  end if;

  -- 8. Check destination fingerprint freshness
  if p_expected_fingerprint is not null and conn_row.destination_fingerprint <> p_expected_fingerprint then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'stale_fingerprint'
    );
  end if;

  -- 9. Check explicit permanent-application grant
  select exists (
    select 1
    from vortex_connection.connection_application_grants as grant_entry
    where grant_entry.connection_instance_id = p_connection_instance_id
      and grant_entry.application_root_id = p_application_root_id
      and grant_entry.organization_id = p_organization_id
  ) into has_app_grant;

  if not has_app_grant then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', 'grant_unauthorized'
    );
  end if;

  -- 10. Return authoritative owner-projected readiness evidence
  return pg_catalog.jsonb_build_object(
    'outcome', 'ready',
    'connectionInstanceId', conn_row.connection_instance_id,
    'organizationId', conn_row.organization_id,
    'applicationRootId', p_application_root_id,
    'destinationKey', conn_row.destination_key,
    'destinationFingerprint', conn_row.destination_fingerprint,
    'revision', conn_row.revision,
    'healthOutcome', conn_row.last_health_outcome,
    'state', conn_row.state,
    'verifiedAt', pg_catalog.to_jsonb(now_ts)
  );
end
$function$;

comment on function vortex_connection.resolve_connection_instance_readiness(
  uuid, uuid, uuid, text, bigint, text
) is
  '#408: Authoritative owner-projected Connection-instance readiness resolver. Fails closed on inactive, unhealthy, expired, mismatched destination, ungranted application, or stale revision/fingerprint.';

-- ----------------------------------------------------------------------------
-- Active Connection Evidence Reader
--
-- Projects authoritative active connection evidence matching the canonical
-- activeConnectionEvidenceSchema for lifecycle policy validation.
-- ----------------------------------------------------------------------------
create function vortex_connection.read_active_connection_evidence(
  p_connection_instance_id uuid
)
returns table (
  connection_instance_id uuid,
  destination_key text,
  destination_fingerprint text,
  organization_id uuid,
  authorized_application_ids uuid[],
  state text,
  revision bigint,
  last_health_outcome text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_org_id uuid;
begin
  context_org_id := vortex_context.organization_id();

  return query
  select
    conn.connection_instance_id,
    conn.destination_key,
    conn.destination_fingerprint,
    conn.organization_id,
    pg_catalog.coalesce(
      pg_catalog.array_agg(grants.application_root_id order by grants.application_root_id)
        filter (where grants.application_root_id is not null),
      array[]::uuid[]
    ) as authorized_application_ids,
    conn.state,
    conn.revision,
    conn.last_health_outcome
  from vortex_connection.connection_instances as conn
  left join vortex_connection.connection_application_grants as grants
    on grants.connection_instance_id = conn.connection_instance_id
    and grants.organization_id = conn.organization_id
  where conn.connection_instance_id = p_connection_instance_id
    and conn.organization_id = context_org_id
    and conn.state = 'active'
    and conn.last_health_outcome = 'healthy'
    and (conn.token_expires_at is null or conn.token_expires_at > pg_catalog.statement_timestamp())
  group by
    conn.connection_instance_id,
    conn.destination_key,
    conn.destination_fingerprint,
    conn.organization_id,
    conn.state,
    conn.revision,
    conn.last_health_outcome;
end
$function$;

comment on function vortex_connection.read_active_connection_evidence(uuid) is
  '#408: Reads active healthy Connection instance evidence scoped to current context organization.';

-- ----------------------------------------------------------------------------
-- Internal Registration / Grant / Health-Update Helpers
-- ----------------------------------------------------------------------------
create function vortex_connection.register_connection_instance_internal(
  p_connection_instance_id uuid,
  p_organization_id uuid,
  p_connection_type_id uuid,
  p_connection_type_version text,
  p_destination_key text,
  p_destination_fingerprint text,
  p_state text,
  p_last_health_outcome text,
  p_revision bigint,
  p_administrator_activity_id uuid,
  p_token_expires_at timestamptz default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  insert into vortex_connection.connection_instances (
    connection_instance_id,
    organization_id,
    connection_type_id,
    connection_type_version,
    destination_key,
    destination_fingerprint,
    state,
    last_health_outcome,
    revision,
    administrator_activity_id,
    token_expires_at,
    created_at,
    updated_at
  ) values (
    p_connection_instance_id,
    p_organization_id,
    p_connection_type_id,
    p_connection_type_version,
    p_destination_key,
    p_destination_fingerprint,
    p_state,
    p_last_health_outcome,
    p_revision,
    p_administrator_activity_id,
    p_token_expires_at,
    operation_at,
    operation_at
  );
end
$function$;

create function vortex_connection.grant_connection_application_internal(
  p_connection_instance_id uuid,
  p_application_root_id uuid,
  p_organization_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  insert into vortex_connection.connection_application_grants (
    connection_instance_id,
    application_root_id,
    organization_id,
    granted_at
  ) values (
    p_connection_instance_id,
    p_application_root_id,
    p_organization_id,
    operation_at
  )
  on conflict (connection_instance_id, application_root_id) do nothing;
end
$function$;

create function vortex_connection.record_connection_health_check_internal(
  p_connection_instance_id uuid,
  p_expected_revision bigint,
  p_new_health_outcome text,
  p_new_state text default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
  new_revision bigint;
begin
  update vortex_connection.connection_instances
  set last_health_outcome = p_new_health_outcome,
      state = pg_catalog.coalesce(p_new_state, state),
      revision = revision + 1,
      updated_at = operation_at
  where connection_instance_id = p_connection_instance_id
    and revision = p_expected_revision
  returning revision into new_revision;

  if not found then
    raise exception using errcode = 'P0002',
      message = 'Connection instance health update failed: revision mismatch or not found';
  end if;

  return new_revision;
end
$function$;

-- ----------------------------------------------------------------------------
-- Permissions & Revocations
-- ----------------------------------------------------------------------------
revoke all on table vortex_connection.connection_instances
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
revoke all on table vortex_connection.connection_application_grants
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant select on table vortex_connection.connection_instances to vortex_request;
grant select on table vortex_connection.connection_application_grants to vortex_request;

revoke all on function
  vortex_connection.resolve_connection_instance_readiness(uuid, uuid, uuid, text, bigint, text),
  vortex_connection.read_active_connection_evidence(uuid),
  vortex_connection.register_connection_instance_internal(uuid, uuid, uuid, text, text, text, text, text, bigint, uuid, timestamptz),
  vortex_connection.grant_connection_application_internal(uuid, uuid, uuid),
  vortex_connection.record_connection_health_check_internal(uuid, bigint, text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_connection.resolve_connection_instance_readiness(uuid, uuid, uuid, text, bigint, text),
  vortex_connection.read_active_connection_evidence(uuid)
  to vortex_request, vortex_runtime;

grant execute on function
  vortex_connection.register_connection_instance_internal(uuid, uuid, uuid, text, text, text, text, text, bigint, uuid, timestamptz),
  vortex_connection.grant_connection_application_internal(uuid, uuid, uuid),
  vortex_connection.record_connection_health_check_internal(uuid, bigint, text, text)
  to vortex_runtime;

grant usage on schema vortex_connection to vortex_request, vortex_runtime;
