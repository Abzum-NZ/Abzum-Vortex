-- #663: durable workflow actors for protected service operations.
--
-- A durable workflow step run as a system actor takes its actor and request
-- scope from the one Access-owned system actor grant registry (#1089), never
-- from an engine signature, a stored run-as label or an installation. Two new
-- Access functions:
--
-- - resolve_durable_system_actor_scope names the effective system actor as the
--   holder of the one active grant for an exact protected operation,
--   organisation, flow and application source (scope key
--   `application:<application root id>`), and returns its closed request scope.
--   No grant, more than one grant, an inactive organisation or an unregistered
--   application refuses.
-- - validated_durable_system_request_context is the reader a protected owner
--   operation calls inside its own transaction: it re-checks the context kind,
--   channel, Access version, active organisation, tenant and application
--   registration and the same grant, so a suspension or revocation between
--   resolution and use refuses.
--
-- Both are new functions; every body is identical to its canonical file under
-- supabase/schemas/vortex_access/. No table is added: the grant registry
-- already stores registration and revocation, and its registration step stays a
-- separate reviewed owner step.

begin;

create or replace function vortex_access.resolve_durable_system_actor_scope(
  p_organization_id uuid,
  p_application_root_id uuid,
  p_flow_id uuid,
  p_operation_key text
)
returns table (
  system_actor_id uuid,
  tenant_id uuid,
  organization_id uuid,
  application_root_id uuid,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  resolved_tenant_id uuid;
  resolved_access_version bigint;
  granted_actor_ids uuid[];
begin
  if p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_context.is_non_nil_uuid(p_application_root_id::text)
    or p_flow_id is null or not vortex_context.is_non_nil_uuid(p_flow_id::text)
    or p_operation_key is null
    or pg_catalog.octet_length(p_operation_key) not between 1 and 128
    or p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception using errcode = '22023',
      message = 'Durable system actor selection is invalid';
  end if;

  -- The organisation and its access version are share-locked before the grant
  -- is read, in the request resolver's Access-first order, so a concurrent
  -- suspension or grant revocation either commits first and is seen here or
  -- waits for this transaction.
  select organization.tenant_id, version.current_version
  into resolved_tenant_id, resolved_access_version
  from vortex_identity.organizations as organization
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  join vortex_access.organization_access_versions as version
    on version.organization_id = organization.organization_id
  where organization.organization_id = p_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of organization, tenant, version;

  if resolved_tenant_id is null
    or not exists (
      select 1
      from vortex_access.permission_registrations as registration
      where registration.organization_id = p_organization_id
        and registration.registration_kind = 'application'
        and registration.registration_owner_id = p_application_root_id
        and registration.state = 'active'
    ) then
    raise exception using errcode = '42501',
      message = 'Durable system actor selection is unavailable';
  end if;

  -- The effective system actor is the holder of the one active system actor
  -- grant for exactly this protected operation, organisation, flow and
  -- application source (scope key `application:<application root id>`). The
  -- matched rows stay share-locked until the transaction ends. No grant, or more
  -- than one, refuses: an engine signature, run-as label or installation names
  -- no actor and confers no authority.
  select pg_catalog.array_agg(matched.system_actor_id)
  into granted_actor_ids
  from (
    select actor_grant.system_actor_id
    from vortex_access.system_actor_grants as actor_grant
    where actor_grant.operation_key = p_operation_key
      and actor_grant.organization_id = p_organization_id
      and (actor_grant.flow_id is null or actor_grant.flow_id = p_flow_id)
      and actor_grant.scope_key =
        'application:' || pg_catalog.lower(p_application_root_id::text)
      and actor_grant.state = 'active'
    for share of actor_grant
  ) as matched;

  if granted_actor_ids is null or pg_catalog.cardinality(granted_actor_ids) <> 1 then
    raise exception using errcode = '42501',
      message = 'Durable system actor selection is unavailable';
  end if;

  return query select granted_actor_ids[1], resolved_tenant_id, p_organization_id,
    p_application_root_id, resolved_access_version;
end
$function$;

revoke all on function vortex_access.resolve_durable_system_actor_scope(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.resolve_durable_system_actor_scope(
  uuid, uuid, uuid, text
) to vortex_runtime;

comment on function vortex_access.resolve_durable_system_actor_scope(
  uuid, uuid, uuid, text
) is
  'Resolves the system actor and closed request scope of one durable workflow protected operation from the system actor grant registry. Refuses unless an active organisation holds an active application registration and exactly one active grant exists for this operation, organisation, flow and application source; an engine signature, run-as label or installation names no actor and confers nothing. Runtime-only.';

create or replace function vortex_access.validated_durable_system_request_context(
  p_operation_key text,
  p_flow_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  if p_operation_key is null
    or pg_catalog.octet_length(p_operation_key) not between 1 and 128
    or p_operation_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_flow_id is null
    or not vortex_context.is_non_nil_uuid(p_flow_id::text) then
    raise exception using errcode = '22023',
      message = 'Durable system actor purpose is invalid';
  end if;

  checked := vortex_context.current_context();
  if checked ->> 'callerKind' is distinct from 'system'
    or checked ->> 'channel' is distinct from 'durable_workflow'
    or checked ? 'supportContext'
    or not checked ? 'applicationRootId'
    or not vortex_context.is_non_nil_uuid(checked ->> 'systemActorId') then
    raise exception using errcode = '42501',
      message = 'Durable system actor context is required';
  end if;

  if not exists (
    select 1
    from vortex_access.organization_access_versions as version
    where version.organization_id = (checked ->> 'organizationId')::uuid
      and version.current_version = (checked ->> 'accessVersion')::bigint
  ) then
    raise exception using errcode = '42501',
      message = 'Request access version is stale or unavailable';
  end if;

  -- The organisation, its tenant, the application registration and the grant are
  -- re-read for this exact operation and flow inside the protected operation's
  -- own transaction, so a suspension or revocation between resolution and use
  -- refuses instead of running on the earlier read.
  if not exists (
    select 1
    from vortex_identity.organizations as organization
    join vortex_identity.tenants as tenant
      on tenant.tenant_id = organization.tenant_id
    where organization.organization_id = (checked ->> 'organizationId')::uuid
      and organization.tenant_id = (checked ->> 'tenantId')::uuid
      and organization.state = 'active'
      and tenant.state = 'active'
  ) or not exists (
    select 1
    from vortex_access.permission_registrations as registration
    where registration.organization_id = (checked ->> 'organizationId')::uuid
      and registration.registration_kind = 'application'
      and registration.registration_owner_id = (checked ->> 'applicationRootId')::uuid
      and registration.state = 'active'
  ) or vortex_access.resolve_system_actor_grant_internal(
    (checked ->> 'systemActorId')::uuid,
    p_operation_key,
    (checked ->> 'organizationId')::uuid,
    p_flow_id,
    'application:' || pg_catalog.lower(checked ->> 'applicationRootId')
  ) is distinct from 'active' then
    raise exception using errcode = '42501',
      message = 'Durable system actor authority is unavailable';
  end if;

  return checked;
end
$function$;

revoke all on function vortex_access.validated_durable_system_request_context(text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.validated_durable_system_request_context(text, uuid)
  to vortex_request;

comment on function vortex_access.validated_durable_system_request_context(text, uuid) is
  'Fails closed unless the request context is a system actor context on the durable_workflow channel for an application, its Access version is current, its organisation, tenant and application registration are active and the system actor grant registry still holds an active grant for exactly this actor, operation, organisation, flow and application source.';

commit;
