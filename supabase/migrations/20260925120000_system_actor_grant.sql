-- #1089: one Access-owned system actor grant for background work.
--
-- Background work (a flow node run as a system actor, event delivery recovery)
-- was authorised by separate registries, two of which compared session_user with
-- a stored role. This adds the single Access-owned registry of system actor
-- grants: one row names a registered system actor, the protected operation it
-- may perform and, optionally, the organisation, flow and scope subject
-- (for event recovery, the consumer) it is confined to. Authority is the stored
-- grant. The identity of the system actor is established by the server's
-- credential verification and passed as an explicit argument; storage never
-- derives authority from the database session role and never from a
-- service-role credential.
--
-- Consumer recovery moves onto the grant, and vortex_event.consumer_recovery_authority
-- (which held the session-role comparison) is dropped. The flow execution
-- binding's system-actor lifecycle is now read from the grant, replacing the
-- fail-closed placeholder. The grant ships empty and has no runtime writer, so
-- every system actor stays unauthorised until a separate, reviewed owner step
-- registers it. The deadline registry was already removed by #1067
-- (20260925090000_retire_deadline_worker.sql), so no session_user role check
-- remains.
--
-- Every function installed here is its complete body, identical to its canonical
-- file under supabase/schemas/: read_flow_execution_binding_for_run is copied from
-- its live definition (20260924040000; no later rewrite) and
-- recover_consumer_occurrence_claim from its live definition (20260923110000; no
-- later rewrite), each changing only its authority step.

begin;

create table vortex_access.system_actor_grants (
  system_actor_grant_id uuid primary key,
  system_actor_id uuid not null,
  operation_key text not null,
  organization_id uuid references vortex_identity.organizations (organization_id),
  flow_id uuid,
  scope_key text,
  state text not null default 'active',
  granted_at timestamptz not null default pg_catalog.statement_timestamp(),
  changed_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint system_actor_grants_ids_non_nil check (
    vortex_context.is_non_nil_uuid(system_actor_grant_id::text)
    and vortex_context.is_non_nil_uuid(system_actor_id::text)
    and (organization_id is null or vortex_context.is_non_nil_uuid(organization_id::text))
    and (flow_id is null or vortex_context.is_non_nil_uuid(flow_id::text))
  ),
  constraint system_actor_grants_operation_key_valid check (
    pg_catalog.octet_length(operation_key) between 1 and 128
    and operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint system_actor_grants_scope_key_valid check (
    scope_key is null or (
      pg_catalog.octet_length(scope_key) between 1 and 128
      and scope_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    )
  ),
  -- A flow only exists inside an organisation.
  constraint system_actor_grants_flow_needs_organization check (
    flow_id is null or organization_id is not null
  ),
  constraint system_actor_grants_state_valid check (state in ('active', 'revoked')),
  constraint system_actor_grants_timestamps_valid check (
    granted_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and changed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  )
);

-- One grant per exact actor, operation and scope; revoking sets its state.
create unique index system_actor_grants_scope_unique
  on vortex_access.system_actor_grants (
    system_actor_id,
    operation_key,
    coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(flow_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(scope_key, '')
  );

alter table vortex_access.system_actor_grants enable row level security;
alter table vortex_access.system_actor_grants force row level security;

revoke all on table vortex_access.system_actor_grants
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on table vortex_access.system_actor_grants is
  'The one registry of system actor grants: a registered system actor, the protected operation it may perform and an optional organisation, flow and scope subject. Ships empty; only a reviewed owner step writes it. Never a service-role credential.';

-- Resolves the grant for one system actor and exact scope, share-locked so a
-- concurrent revoke is ordered against the check. A grant with no flow applies to
-- every flow of its organisation; the organisation and scope subject must match
-- exactly. Returns 'active', 'revoked' or null (no grant). An active grant wins
-- over a revoked one.
create or replace function vortex_access.resolve_system_actor_grant_internal(
  p_system_actor_id uuid,
  p_operation_key text,
  p_organization_id uuid,
  p_flow_id uuid,
  p_scope_key text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  grant_state text;
begin
  if p_system_actor_id is null or not vortex_context.is_non_nil_uuid(p_system_actor_id::text)
    or p_operation_key is null
    or pg_catalog.octet_length(p_operation_key) not between 1 and 128
    or p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or (p_organization_id is not null and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or (p_flow_id is not null and not vortex_context.is_non_nil_uuid(p_flow_id::text))
    or (p_scope_key is not null and (
      pg_catalog.octet_length(p_scope_key) not between 1 and 128
      or p_scope_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    )) then
    raise exception using errcode = '22023', message = 'System actor grant lookup is invalid';
  end if;

  select actor_grant.state into grant_state
  from vortex_access.system_actor_grants as actor_grant
  where actor_grant.system_actor_id = p_system_actor_id
    and actor_grant.operation_key = p_operation_key
    and actor_grant.organization_id is not distinct from p_organization_id
    and (actor_grant.flow_id is null or actor_grant.flow_id = p_flow_id)
    and actor_grant.scope_key is not distinct from p_scope_key
  order by (actor_grant.state = 'active') desc
  limit 1
  for share;

  return grant_state;
end
$function$;

revoke all on function vortex_access.resolve_system_actor_grant_internal(
  uuid, text, uuid, uuid, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.resolve_system_actor_grant_internal(
  uuid, text, uuid, uuid, text
) is
  'Owner-only lookup of the one system actor grant for an exact actor, protected operation, organisation, optional flow and scope subject; returns active, revoked or null and never derives authority from the session role.';

-- ============================================================================
-- Flow execution binding runtime reader: a system actor's lifecycle now comes
-- from the system actor grant. Complete live body of #838's function; the only
-- change is the system-actor branch, which, like the specified-person branch,
-- is active only in an active organisation.
-- ============================================================================
create or replace function vortex_access.read_flow_execution_binding_for_run(
  p_execution_binding_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_release_version text,
  p_flow_id uuid,
  p_node_id uuid,
  p_operation_owner_kind text,
  p_operation_owner_id uuid,
  p_operation_id uuid,
  p_actor_kind text,
  p_actor_account_id uuid,
  p_actor_system_actor_id uuid
)
returns table (
  outcome text,
  effective_state text,
  actor_state text,
  result jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_binding vortex_access.flow_execution_bindings%rowtype;
  account_state text;
begin
  if p_execution_binding_id is null or not vortex_context.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_release_version is null
    or p_release_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_node_id is null or not vortex_context.is_non_nil_uuid(p_node_id::text)
    or p_operation_owner_kind is null
    or p_operation_owner_kind not in ('application', 'module', 'platform_service')
    or p_operation_owner_id is null or not vortex_context.is_non_nil_uuid(p_operation_owner_id::text)
    or p_operation_id is null or not vortex_context.is_non_nil_uuid(p_operation_id::text)
    or p_actor_kind is null or p_actor_kind not in ('specified_user', 'system')
    or (p_actor_kind = 'specified_user' and (
      p_actor_account_id is null or not vortex_context.is_non_nil_uuid(p_actor_account_id::text)
      or p_actor_system_actor_id is not null))
    or (p_actor_kind = 'system' and (
      p_actor_system_actor_id is null or not vortex_context.is_non_nil_uuid(p_actor_system_actor_id::text)
      or p_actor_account_id is not null)) then
    raise exception using errcode = '22023', message = 'Flow execution binding run read command is invalid';
  end if;

  -- Share-lock the current revision. A writer that is mid-replace or mid-revoke
  -- holds the row FOR UPDATE, so this waits for it. Once that writer commits the
  -- row is no longer current for this statement's re-check and is skipped; the
  -- next statement takes a fresh snapshot and finds the new current revision.
  for attempt in 1..2 loop
    select binding.* into current_binding
    from vortex_access.flow_execution_bindings as binding
    where binding.execution_binding_id = p_execution_binding_id
      and binding.organization_id = p_organization_id
      and binding.is_current
      and binding.application_root_id = p_application_root_id
      and binding.release_version = p_release_version
      and binding.flow_id = p_flow_id
      and binding.node_id = p_node_id
      and binding.operation_owner_kind = p_operation_owner_kind
      and binding.operation_owner_id = p_operation_owner_id
      and binding.operation_id = p_operation_id
      and binding.actor_kind = p_actor_kind
      and binding.actor_organization_account_id is not distinct from p_actor_account_id
      and binding.actor_system_actor_id is not distinct from p_actor_system_actor_id
    for share;
    exit when found;
  end loop;

  -- A completed FOR loop overwrites FOUND, so test the selected row itself.
  if current_binding.execution_binding_id is null then
    return query select 'unavailable'::text, null::text, null::text, null::jsonb;
    return;
  end if;

  if current_binding.actor_kind = 'specified_user' then
    -- Ordered against a concurrent suspension or closure of the effective person,
    -- in main's Access-first order: the organisation access-version row before the
    -- Identity account row, as the request resolver and account lifecycle writers
    -- take them. Binding writers lock the binding before the access version, so
    -- taking the binding first above keeps this path consistent with them too.
    perform 1
    from vortex_access.organization_access_versions as version
    where version.organization_id = current_binding.organization_id
    for share of version;

    select account.state into account_state
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = current_binding.actor_organization_account_id
      and account.organization_id = current_binding.organization_id
    for share of account;
    -- Only an active or suspended account in an active organisation keeps its
    -- state; closing, closed, deleted or missing is closed.
    if account_state is distinct from 'suspended' and (
      account_state is distinct from 'active' or not exists (
        select 1 from vortex_identity.organizations as organization
        where organization.organization_id = current_binding.organization_id
          and organization.state = 'active'
      )
    ) then
      account_state := 'closed';
    end if;
  else
    -- A system actor is active only while the one system actor grant registry
    -- holds an active grant for this actor, this protected operation and this
    -- flow in this organisation, and only in an active organisation; a missing
    -- or revoked grant, or an organisation that is not active, fails closed.
    account_state := case
      when vortex_access.resolve_system_actor_grant_internal(
        current_binding.actor_system_actor_id,
        current_binding.operation_id::text,
        current_binding.organization_id,
        current_binding.flow_id,
        null
      ) = 'active' and exists (
        select 1 from vortex_identity.organizations as organization
        where organization.organization_id = current_binding.organization_id
          and organization.state = 'active'
      ) then 'active'
      else 'closed'
    end;
  end if;

  return query select 'available'::text,
    case
      when current_binding.state = 'revoked' then 'revoked'
      when current_binding.expires_at is not null
        and current_binding.expires_at <= pg_catalog.clock_timestamp() then 'expired'
      else 'active'
    end,
    account_state,
    vortex_access.flow_execution_binding_to_json_internal(current_binding);
end
$function$;

revoke all on function vortex_access.read_flow_execution_binding_for_run(
  uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.read_flow_execution_binding_for_run(
  uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid
) to vortex_runtime;

comment on function vortex_access.read_flow_execution_binding_for_run(
  uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid
) is
  'Runtime-only, share-locked read of one exact current flow execution binding and its effective actor state; a system actor is active only under an active system actor grant in an active organisation.';

-- ============================================================================
-- Event delivery recovery: authority is the system actor grant scoped to the
-- consumer, not a session-role comparison.
-- ============================================================================
set local role postgres;

drop function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer);

-- Complete body of #640's recovery with the authority step replaced. The
-- grant is checked before anything about the claim is revealed or touched, the
-- attribution is the granted system actor (never a separately supplied
-- operator), and the caller's view of the failure count must still match so a
-- stale decision is refused rather than silently applied.
create or replace function vortex_event.recover_consumer_occurrence_claim(
  p_consumer_key text,
  p_occurrence_id uuid,
  p_expected_failure_count integer,
  p_system_actor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  recovery_time timestamptz := pg_catalog.statement_timestamp();
  grant_state text;
  progress_row vortex_event.consumer_occurrence_progress%rowtype;
begin
  if p_consumer_key is null
    or pg_catalog.octet_length(p_consumer_key) not between 1 and 128
    or p_consumer_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_occurrence_id is null or p_occurrence_id = nil_uuid
    or p_expected_failure_count is null or p_expected_failure_count < 0
    or p_system_actor_id is null or p_system_actor_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Event delivery recovery input is invalid';
  end if;

  grant_state := vortex_access.resolve_system_actor_grant_internal(
    p_system_actor_id, 'recover_consumer_occurrence_claim', null, null, p_consumer_key
  );
  if grant_state is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unauthorised', 'reason', 'authority_not_configured'
    );
  end if;
  if grant_state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unauthorised', 'reason', 'authority_revoked'
    );
  end if;

  select progress.* into progress_row
  from vortex_event.consumer_occurrence_progress as progress
  where progress.consumer_key = p_consumer_key
    and progress.occurrence_id = p_occurrence_id
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'claim_unavailable');
  end if;
  if progress_row.acknowledged_at is not null then
    return pg_catalog.jsonb_build_object('outcome', 'already_acknowledged');
  end if;
  if progress_row.terminally_failed_at is null then
    if progress_row.lease_expires_at > recovery_time then
      return pg_catalog.jsonb_build_object('outcome', 'active');
    end if;
    -- Lapsed but never exhausted: ordinary reclaim already covers it, so the
    -- privileged override is not the right path for this claim.
    return pg_catalog.jsonb_build_object('outcome', 'not_exhausted');
  end if;
  if progress_row.failure_count <> p_expected_failure_count then
    return pg_catalog.jsonb_build_object(
      'outcome', 'stale',
      'failureCount', progress_row.failure_count
    );
  end if;

  -- Clearing the terminal hold and both budgets hands the claim back to
  -- #639's ordinary reclaim for exactly this consumer and occurrence. Failure
  -- evidence and the recovery attribution stay on the row.
  update vortex_event.consumer_occurrence_progress
  set terminally_failed_at = null,
      failure_count = 0,
      attempt_count = 0,
      recovered_at = recovery_time,
      recovered_by = p_system_actor_id,
      recovery_count = recovery_count + 1,
      lease_expires_at = recovery_time
  where consumer_key = p_consumer_key and occurrence_id = p_occurrence_id;

  return pg_catalog.jsonb_build_object(
    'outcome', 'recovered',
    'recoveredBy', p_system_actor_id,
    'leaseExpiresAt', pg_catalog.to_char(
      pg_catalog.timezone('UTC', recovery_time), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
end
$function$;

alter function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer, uuid)
  owner to postgres;
revoke all on function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_adapter;
grant execute on function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer, uuid)
  to vortex_runtime;

comment on function vortex_event.recover_consumer_occurrence_claim(text, uuid, integer, uuid) is
  'Recovery of one exhausted claim for the same consumer and occurrence identity, authorised by the system actor grant scoped to that consumer and attributed to the granted system actor.';
comment on column vortex_event.consumer_occurrence_progress.recovered_by is
  'System actor whose grant authorised the last recovery of this claim; never a credential.';

drop table vortex_event.consumer_recovery_authority;

reset role;
commit;
