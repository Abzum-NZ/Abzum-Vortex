-- #1048: tenant governance commands take their acting person only from the
-- verified database-bound request context.  The actor is never a caller
-- parameter, so a command runs under the request context established for the
-- transaction and refuses when no such context is bound.  Every replaced
-- function keeps its owner, complete body, security, search_path, grants and
-- comment, and has an identical canonical source under
-- supabase/schemas/vortex_identity/.

-- Each signature change is an explicit drop of the old actor-bearing signature
-- before its replacement is created.
drop function if exists vortex_identity.list_tenant_launcher(uuid, integer, uuid);
drop function if exists vortex_identity.list_tenant_hierarchy(uuid, uuid, integer, uuid);
drop function if exists vortex_identity.read_tenant_organization(uuid, uuid, uuid);
drop function if exists vortex_identity.list_tenant_administrator_assignments(uuid, uuid, integer, uuid);
drop function if exists vortex_identity.grant_tenant_administrator(uuid, uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz);
drop function if exists vortex_identity.change_tenant_administrator(uuid, uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz);
drop function if exists vortex_identity.revoke_tenant_administrator(uuid, uuid, text, uuid, uuid, bigint);
drop function if exists vortex_identity.rename_tenant_organization(uuid, uuid, text, uuid, uuid, bigint, text);
drop function if exists vortex_identity.reparent_tenant_organization(uuid, uuid, text, uuid, uuid, bigint, uuid);
drop function if exists vortex_identity.suspend_tenant_organization(uuid, uuid, text, uuid, uuid, bigint);
drop function if exists vortex_identity.reactivate_tenant_organization(uuid, uuid, text, uuid, uuid, bigint);
drop function if exists vortex_identity.archive_tenant_organization(uuid, uuid, text, uuid, uuid, bigint);
drop function if exists vortex_identity.create_tenant_organization(uuid, uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text);


create or replace function vortex_identity.tenant_request_actor_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  checked jsonb;
begin
  checked := vortex_context.current_context();
  if checked ->> 'callerKind' is null
    or checked ->> 'callerKind' not in ('human', 'federated')
    or not vortex_context.is_non_nil_uuid(checked ->> 'identityId') then
    raise exception using errcode = '42501', message = 'Tenant request actor is unavailable';
  end if;
  return (checked ->> 'identityId')::uuid;
end
$function$;

revoke execute on function vortex_identity.tenant_request_actor_id()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.tenant_request_actor_id() is
  'Returns the acting person from the verified request context for tenant governance, or refuses when the bound context names no human or federated person.';

create or replace function vortex_identity.list_tenant_launcher(
  p_limit integer,
  p_after uuid default null
)
returns table (tenant_id uuid, display_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  actor_identity_id uuid;
begin
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  if p_limit is null or p_limit not between 1 and 101
    or (p_after is not null and not vortex_context.is_non_nil_uuid(p_after::text)) then
    raise exception using errcode = '22023', message = 'Tenant launcher request is invalid';
  end if;
  if not exists (
    select 1
    from vortex_identity.identity_projections projection
    where projection.identity_id = actor_identity_id
      and projection.state = 'active'
  ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  return query
  select tenant.tenant_id, tenant.display_name
  from vortex_identity.tenants tenant
  where tenant.state = 'active'
    and (p_after is null or tenant.tenant_id > p_after)
    and exists (
      select 1
      from vortex_identity.tenant_administrator_assignments assignment
      where assignment.tenant_id = tenant.tenant_id
        and assignment.identity_id = actor_identity_id
        and assignment.revoked_at is null
        and assignment.starts_at <= evaluated_at
        and (assignment.expires_at is null or assignment.expires_at > evaluated_at)
    )
  order by tenant.tenant_id limit p_limit;
end
$function$;

revoke execute on function vortex_identity.list_tenant_launcher(integer, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.list_tenant_launcher(integer, uuid)
  to vortex_runtime;

comment on function vortex_identity.list_tenant_launcher(integer, uuid) is
  'Bounded active tenant contexts visible through the bound request context person''s effective structural assignments.';

create or replace function vortex_identity.list_tenant_hierarchy(
  p_tenant_id uuid,
  p_limit integer,
  p_after uuid default null
)
returns table (organization_id uuid, parent_organization_id uuid, short_name text, display_name text, state text, revision bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  actor_identity_id uuid;
begin
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_limit is null or p_limit not between 1 and 101
    or (p_after is not null and not vortex_context.is_non_nil_uuid(p_after::text)) then
    raise exception using errcode = '22023', message = 'Tenant hierarchy request is invalid';
  end if;
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.hierarchy.read',
    pg_catalog.clock_timestamp()
  );
  return query
  select organization.organization_id, organization.parent_organization_id,
    organization.short_name, organization.display_name, organization.state, organization.revision
  from vortex_identity.organizations organization
  where organization.tenant_id = p_tenant_id
    and (p_after is null or organization.organization_id > p_after)
  order by organization.organization_id limit p_limit;
end
$function$;

revoke execute on function vortex_identity.list_tenant_hierarchy(uuid, integer, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.list_tenant_hierarchy(uuid, integer, uuid)
  to vortex_runtime;

comment on function vortex_identity.list_tenant_hierarchy(uuid, integer, uuid) is
  'Bounded deterministic same-tenant structural hierarchy read under the bound request context person''s exact hierarchy.read capability.';

create or replace function vortex_identity.read_tenant_organization(
  p_tenant_id uuid,
  p_organization_id uuid
)
returns table (organization_id uuid, parent_organization_id uuid, short_name text, display_name text, state text, revision bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  actor_identity_id uuid;
begin
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null or not vortex_context.is_non_nil_uuid(p_organization_id::text) then
    raise exception using errcode = '22023', message = 'Tenant organization request is invalid';
  end if;
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.hierarchy.read',
    pg_catalog.clock_timestamp()
  );
  return query
  select organization.organization_id, organization.parent_organization_id,
    organization.short_name, organization.display_name, organization.state, organization.revision
  from vortex_identity.organizations organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
end
$function$;

revoke execute on function vortex_identity.read_tenant_organization(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.read_tenant_organization(uuid, uuid)
  to vortex_runtime;

comment on function vortex_identity.read_tenant_organization(uuid, uuid) is
  'Exact same-tenant structural organisation read under the bound request context person''s hierarchy.read capability.';

create or replace function vortex_identity.list_tenant_administrator_assignments(
  p_tenant_id uuid,
  p_limit integer,
  p_after uuid default null
)
returns table (assignment_id uuid, identity_id uuid, capability_keys text[], starts_at timestamptz, expires_at timestamptz, revision bigint, outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  actor_identity_id uuid;
begin
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_limit is null or p_limit not between 1 and 101
    or (p_after is not null and not vortex_context.is_non_nil_uuid(p_after::text)) then
    raise exception using errcode = '22023', message = 'Tenant assignment request is invalid';
  end if;
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.administrators.read',
    evaluated_at
  );
  return query
  select assignment.assignment_id, assignment.identity_id, assignment.capability_keys,
    assignment.starts_at, assignment.expires_at, assignment.revision,
    case when assignment.revoked_at is not null and assignment.revoked_at <= evaluated_at then 'revoked'
      when assignment.starts_at > evaluated_at then 'scheduled'
      when assignment.expires_at is not null and assignment.expires_at <= evaluated_at then 'expired'
      else 'active' end
  from vortex_identity.tenant_administrator_assignments assignment
  where assignment.tenant_id = p_tenant_id
    and (p_after is null or assignment.assignment_id > p_after)
  order by assignment.assignment_id limit p_limit;
end
$function$;

revoke execute on function vortex_identity.list_tenant_administrator_assignments(uuid, integer, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.list_tenant_administrator_assignments(uuid, integer, uuid)
  to vortex_runtime;

comment on function vortex_identity.list_tenant_administrator_assignments(uuid, integer, uuid) is
  'Bounded deterministic same-tenant assignment read under the bound request context person''s exact administrators.read capability.';

create or replace function vortex_identity.grant_tenant_administrator(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_subject_identity_id uuid,
  p_capabilities jsonb,
  p_starts_at timestamptz,
  p_expires_at timestamptz
)
returns table (outcome text, operation text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  capabilities text[];
  computed_fingerprint text;
  expiry_cap timestamptz;
  evaluated_at timestamptz;
  actor_identity_id uuid;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_subject_identity_id is null or not vortex_context.is_non_nil_uuid(p_subject_identity_id::text)
    or p_command_fingerprint is null or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' or capabilities is null
    or p_starts_at is null or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))) then
    raise exception using errcode = '22023', message = 'Tenant assignment command is invalid';
  end if;
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  perform 1 from vortex_identity.identity_projections projection
    where projection.identity_id in (actor_identity_id, p_subject_identity_id)
    order by projection.identity_id for share;
  perform 1 from vortex_identity.tenant_administrator_assignments assignment
    where assignment.tenant_id = p_tenant_id and assignment.identity_id = actor_identity_id
    order by assignment.assignment_id for update;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at
  );
  if p_subject_identity_id = actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
  end if;
  computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'grant_tenant_administrator',
      p_tenant_id::text, p_subject_identity_id::text, pg_catalog.array_to_string(capabilities, ','),
      pg_catalog.to_char(pg_catalog.timezone('UTC', p_starts_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      coalesce(pg_catalog.to_char(pg_catalog.timezone('UTC', p_expires_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '')),
      'UTF8'), 'sha256'), 'hex');
  if not exists (
      select 1 from vortex_identity.identity_projections p
      where p.identity_id = p_subject_identity_id and p.state = 'active'
    ) or exists (
      select 1 from pg_catalog.unnest(capabilities) c
      where not exists (
        select 1 from vortex_identity.tenant_administrator_assignments a
        where a.tenant_id = p_tenant_id and a.identity_id = actor_identity_id
          and a.revoked_at is null and a.starts_at <= evaluated_at
          and (a.expires_at is null or a.expires_at > evaluated_at)
          and c = any(a.capability_keys)
      )
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts stored
  where stored.actor_id = actor_identity_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'grant_tenant_administrator'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> computed_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'grant_tenant_administrator'::text,
      receipt.subject_ids[1], receipt.subject_revisions[1], receipt.receipt_id, receipt.accepted_at;
    return;
  end if;
  expiry_cap := vortex_identity.tenant_administrator_grant_expiry_cap(
    actor_identity_id, p_tenant_id, capabilities, evaluated_at
  );
  if expiry_cap is not null and (p_expires_at is null or p_expires_at > expiry_cap) then
    p_expires_at := expiry_cap;
  end if;
  if p_expires_at is not null and p_expires_at <= p_starts_at then
    raise exception using errcode = '42501', message = 'Tenant assignment cannot outlast your own authority';
  end if;
  insert into vortex_identity.tenant_administrator_assignments values (
    new_assignment_id, p_tenant_id, p_subject_identity_id, capabilities, p_starts_at, p_expires_at, 1,
    evaluated_at, actor_identity_id, new_correlation_id, evaluated_at, actor_identity_id, new_correlation_id, null, null, null
  );
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id, 'grant_tenant_administrator',
    p_duplicate_key, computed_fingerprint, array[new_assignment_id], array[1::bigint], evaluated_at
  );
  return query select 'accepted'::text, 'grant_tenant_administrator'::text,
    new_assignment_id, 1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator grant under the bound request context person''s current structural authority, with database-computed command fingerprint, self-grant refusal, grantor-bounded expiry and accepted replay.';

create or replace function vortex_identity.change_tenant_administrator(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_assignment_id uuid,
  p_expected_revision bigint,
  p_capabilities jsonb,
  p_starts_at timestamptz,
  p_expires_at timestamptz
)
returns table (outcome text, operation text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  capabilities text[];
  computed_fingerprint text;
  expiry_cap timestamptz;
  evaluated_at timestamptz;
  actor_identity_id uuid;
  target_identity_id uuid;
  current_revision bigint;
  current_revoked_at timestamptz;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or capabilities is null or p_starts_at is null
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))) then
    raise exception using errcode = '22023', message = 'Tenant assignment command is invalid';
  end if;
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  perform 1 from vortex_identity.tenants tenant
    where tenant.tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  select a.identity_id into target_identity_id
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  perform 1 from vortex_identity.identity_projections p
    where p.identity_id in (actor_identity_id, target_identity_id)
    order by p.identity_id for share;
  perform 1 from vortex_identity.tenant_administrator_assignments a
    where a.tenant_id = p_tenant_id
      and (a.identity_id = actor_identity_id or a.assignment_id = p_assignment_id)
    order by a.assignment_id for update;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id,
    'platform.tenant.administrators.manage', evaluated_at
  );
  if target_identity_id is null or not exists (
      select 1 from vortex_identity.identity_projections p
      where p.identity_id = target_identity_id and p.state = 'active'
    ) or exists (
      select 1 from pg_catalog.unnest(capabilities) c
      where not exists (
        select 1 from vortex_identity.tenant_administrator_assignments a
        where a.tenant_id = p_tenant_id and a.identity_id = actor_identity_id
          and a.revoked_at is null and a.starts_at <= evaluated_at
          and (a.expires_at is null or a.expires_at > evaluated_at)
          and c = any(a.capability_keys)
      )
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if target_identity_id = actor_identity_id then
    raise exception using errcode = '42501', message = 'Tenant authority cannot be granted to yourself';
  end if;
  computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'change_tenant_administrator',
      p_tenant_id::text, p_assignment_id::text, p_expected_revision::text,
      pg_catalog.array_to_string(capabilities, ','),
      pg_catalog.to_char(pg_catalog.timezone('UTC', p_starts_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      coalesce(pg_catalog.to_char(pg_catalog.timezone('UTC', p_expires_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '')),
      'UTF8'), 'sha256'), 'hex');
  select a.revision, a.revoked_at into current_revision, current_revoked_at
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts stored
  where stored.actor_id = actor_identity_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'change_tenant_administrator'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> computed_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'change_tenant_administrator'::text,
      p_assignment_id, receipt.subject_revisions[1], receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;
  expiry_cap := vortex_identity.tenant_administrator_grant_expiry_cap(
    actor_identity_id, p_tenant_id, capabilities, evaluated_at
  );
  if expiry_cap is not null and (p_expires_at is null or p_expires_at > expiry_cap) then
    p_expires_at := expiry_cap;
  end if;
  if p_expires_at is not null and p_expires_at <= p_starts_at then
    raise exception using errcode = '42501', message = 'Tenant assignment cannot outlast your own authority';
  end if;
  if current_revision is null or current_revoked_at is not null then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if current_revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Tenant assignment revision is stale';
  end if;
  if not (
      'platform.tenant.administrators.manage' = any(capabilities)
      and p_starts_at <= evaluated_at and p_expires_at is null
    ) and not vortex_identity.tenant_has_permanent_manager(
      p_tenant_id, evaluated_at, p_assignment_id
    ) then
    raise exception using errcode = 'V3103', message = 'Permanent tenant manager is required';
  end if;
  resulting_revision := current_revision + 1;
  update vortex_identity.tenant_administrator_assignments
  set capability_keys = capabilities, starts_at = p_starts_at,
    expires_at = p_expires_at, revision = resulting_revision,
    changed_at = evaluated_at, changed_by_actor_id = actor_identity_id,
    change_correlation_id = new_correlation_id
  where tenant_administrator_assignments.assignment_id = p_assignment_id;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id,
    'change_tenant_administrator', p_duplicate_key, computed_fingerprint,
    array[p_assignment_id], array[resulting_revision], evaluated_at
  );
  return query select 'accepted'::text, 'change_tenant_administrator'::text,
    p_assignment_id, resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator change under the bound request context person''s current structural authority, with database-computed command fingerprint, self-grant refusal, grantor-bounded expiry, exact revision and accepted replay.';

create or replace function vortex_identity.revoke_tenant_administrator(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_assignment_id uuid,
  p_expected_revision bigint
)
returns table (outcome text, operation text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  target_identity_id uuid;
  current_revision bigint;
  current_revoked_at timestamptz;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Tenant assignment command is invalid';
  end if;
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  perform 1 from vortex_identity.tenants tenant
    where tenant.tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  select a.identity_id into target_identity_id
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  perform 1 from vortex_identity.identity_projections p
    where p.identity_id in (actor_identity_id, target_identity_id)
    order by p.identity_id for share;
  perform 1 from vortex_identity.tenant_administrator_assignments a
    where a.tenant_id = p_tenant_id
      and (a.identity_id = actor_identity_id or a.assignment_id = p_assignment_id)
    order by a.assignment_id for update;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id,
    'platform.tenant.administrators.manage', evaluated_at
  );
  select a.revision, a.revoked_at into current_revision, current_revoked_at
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts stored
  where stored.actor_id = actor_identity_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'revoke_tenant_administrator'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'revoke_tenant_administrator'::text,
      p_assignment_id, receipt.subject_revisions[1], receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;
  if current_revision is null or current_revoked_at is not null then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if current_revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Tenant assignment revision is stale';
  end if;
  if not vortex_identity.tenant_has_permanent_manager(
    p_tenant_id, evaluated_at, p_assignment_id
  ) then
    raise exception using errcode = 'V3103', message = 'Permanent tenant manager is required';
  end if;
  resulting_revision := current_revision + 1;
  update vortex_identity.tenant_administrator_assignments
  set revision = resulting_revision, changed_at = evaluated_at,
    changed_by_actor_id = actor_identity_id,
    change_correlation_id = new_correlation_id, revoked_at = evaluated_at,
    revoked_by_actor_id = actor_identity_id,
    revocation_correlation_id = new_correlation_id
  where tenant_administrator_assignments.assignment_id = p_assignment_id;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id,
    'revoke_tenant_administrator', p_duplicate_key, p_command_fingerprint,
    array[p_assignment_id], array[resulting_revision], evaluated_at
  );
  return query select 'accepted'::text, 'revoke_tenant_administrator'::text,
    p_assignment_id, resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.revoke_tenant_administrator(uuid, text, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.revoke_tenant_administrator(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.revoke_tenant_administrator(uuid, text, uuid, uuid, bigint) is
  'Protected same-tenant tenant-administrator revocation under the bound request context person''s current structural authority, with permanent-manager preservation, exact revision and accepted replay.';

create or replace function vortex_identity.rename_tenant_organization(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint,
  p_display_name text
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_revision bigint;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_display_name is null
    or p_display_name <> pg_catalog.btrim(p_display_name)
    or pg_catalog.char_length(p_display_name) not between 1 and 120 then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation rename command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.rename',
    evaluated_at
  );

  select stored.*
  into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'rename_tenant_organization'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'rename_tenant_organization'::text,
      receipt.subject_ids[1],
      receipt.subject_revisions[1],
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  select organization.revision
  into current_revision
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if current_revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations
  set display_name = p_display_name,
    revision = resulting_revision
  where organizations.tenant_id = p_tenant_id
    and organizations.organization_id = p_organization_id;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id,
    actor_id,
    tenant_id,
    operation_key,
    duplicate_key,
    command_fingerprint,
    subject_ids,
    subject_revisions,
    accepted_at
  ) values (
    new_correlation_id,
    actor_identity_id,
    p_tenant_id,
    'rename_tenant_organization',
    p_duplicate_key,
    p_command_fingerprint,
    array[p_organization_id],
    array[resulting_revision],
    evaluated_at
  );

  return query
  select 'accepted'::text,
    'rename_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text)
  to vortex_runtime;

comment on function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text) is
  'Protected same-tenant display-name-only organisation rename under the bound request context person''s current structural authority, exact revision and accepted replay.';

create or replace function vortex_identity.reparent_tenant_organization(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint,
  p_parent_organization_id uuid
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_revision bigint;
  current_state text;
  parent_state text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or (
      p_parent_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_parent_organization_id::text)
    ) then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation reparent command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.reparent',
    evaluated_at
  );

  select stored.*
  into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'reparent_tenant_organization'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'reparent_tenant_organization'::text,
      receipt.subject_ids[1],
      receipt.subject_revisions[1],
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  select organization.revision, organization.state
  into current_revision, current_state
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if current_revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;
  if p_parent_organization_id = p_organization_id then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  if p_parent_organization_id is not null then
    select parent.state
    into parent_state
    from vortex_identity.organizations as parent
    where parent.tenant_id = p_tenant_id
      and parent.organization_id = p_parent_organization_id;
    if not found
      or (
        current_state in ('active', 'suspended')
        and parent_state in ('archived', 'removal_pending')
      ) then
      raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
    end if;
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations
  set parent_organization_id = p_parent_organization_id,
    revision = resulting_revision
  where organizations.tenant_id = p_tenant_id
    and organizations.organization_id = p_organization_id;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id,
    actor_id,
    tenant_id,
    operation_key,
    duplicate_key,
    command_fingerprint,
    subject_ids,
    subject_revisions,
    accepted_at
  ) values (
    new_correlation_id,
    actor_identity_id,
    p_tenant_id,
    'reparent_tenant_organization',
    p_duplicate_key,
    p_command_fingerprint,
    array[p_organization_id],
    array[resulting_revision],
    evaluated_at
  );

  return query
  select 'accepted'::text,
    'reparent_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.reparent_tenant_organization(uuid, text, uuid, uuid, bigint, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.reparent_tenant_organization(uuid, text, uuid, uuid, bigint, uuid)
  to vortex_runtime;

comment on function vortex_identity.reparent_tenant_organization(uuid, text, uuid, uuid, bigint, uuid) is
  'Protected same-tenant adjacency-link-only organisation move under the bound request context person''s current structural authority, exact revision and accepted replay.';

create or replace function vortex_identity.suspend_tenant_organization(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_revision bigint;
  current_state text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation suspension command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  where version.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
  for update of version;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  select organization.revision, organization.state
  into current_revision, current_state
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.lifecycle',
    evaluated_at
  );

  select stored.*
  into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'suspend_tenant_organization'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'suspend_tenant_organization'::text,
      receipt.subject_ids[1],
      receipt.subject_revisions[1],
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  if current_revision <> p_expected_revision
    or current_revision = 9007199254740991 then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;
  if current_state <> 'active' then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations as organization
  set state = 'suspended',
    state_changed_at = evaluated_at,
    revision = resulting_revision
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id,
    'suspend_tenant_organization', p_duplicate_key, p_command_fingerprint,
    array[p_organization_id], array[resulting_revision], evaluated_at
  );

  return query
  select 'accepted'::text,
    'suspend_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.suspend_tenant_organization(uuid, text, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.suspend_tenant_organization(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.suspend_tenant_organization(uuid, text, uuid, uuid, bigint) is
  'Protected non-cascading active-to-suspended organisation transition under the bound request context person''s current tenant authority and accepted replay.';

create or replace function vortex_identity.reactivate_tenant_organization(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_parent_id uuid;
  current_revision bigint;
  current_state text;
  parent_state text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation reactivation command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  where version.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
  for update of version;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  select organization.parent_organization_id,
    organization.revision, organization.state
  into current_parent_id, current_revision, current_state
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.lifecycle',
    evaluated_at
  );

  select stored.*
  into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'reactivate_tenant_organization'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'reactivate_tenant_organization'::text,
      receipt.subject_ids[1],
      receipt.subject_revisions[1],
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  if current_revision <> p_expected_revision
    or current_revision = 9007199254740991 then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;
  if current_state <> 'suspended' then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  if current_parent_id is not null then
    select parent.state
    into parent_state
    from vortex_identity.organizations as parent
    where parent.tenant_id = p_tenant_id
      and parent.organization_id = current_parent_id;
    if not found or parent_state in ('archived', 'removal_pending') then
      raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
    end if;
  end if;

  if not exists (
      select 1
      from vortex_access.organization_stewardship_requirements as requirement
      where requirement.organization_id = p_organization_id
    )
    or not vortex_access.organization_has_permanent_steward(
      p_organization_id, evaluated_at
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations as organization
  set state = 'active',
    state_changed_at = evaluated_at,
    revision = resulting_revision
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id,
    'reactivate_tenant_organization', p_duplicate_key, p_command_fingerprint,
    array[p_organization_id], array[resulting_revision], evaluated_at
  );

  return query
  select 'accepted'::text,
    'reactivate_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.reactivate_tenant_organization(uuid, text, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.reactivate_tenant_organization(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.reactivate_tenant_organization(uuid, text, uuid, uuid, bigint) is
  'Protected stewardship-ready suspended-to-active organisation transition under the bound request context person''s current tenant authority and accepted replay.';

create or replace function vortex_identity.archive_tenant_organization(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  current_revision bigint;
  current_state text;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation archive command is invalid';
  end if;

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  perform 1
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  where version.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
  for update of version;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = actor_identity_id
  for share;
  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  select organization.revision, organization.state
  into current_revision, current_state
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.lifecycle',
    evaluated_at
  );

  select stored.*
  into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'archive_tenant_organization'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'archive_tenant_organization'::text,
      receipt.subject_ids[1],
      receipt.subject_revisions[1],
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  if current_revision <> p_expected_revision
    or current_revision = 9007199254740991 then
    raise exception using errcode = 'V3102', message = 'Organisation revision is stale';
  end if;
  if current_state not in ('active', 'suspended')
    or exists (
      select 1
      from vortex_identity.organizations as child
      where child.tenant_id = p_tenant_id
        and child.parent_organization_id = p_organization_id
        and child.state in ('active', 'suspended')
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.organizations as organization
  set state = 'archived',
    state_changed_at = evaluated_at,
    revision = resulting_revision
  where organization.tenant_id = p_tenant_id
    and organization.organization_id = p_organization_id;

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id,
    'archive_tenant_organization', p_duplicate_key, p_command_fingerprint,
    array[p_organization_id], array[resulting_revision], evaluated_at
  );

  return query
  select 'accepted'::text,
    'archive_tenant_organization'::text,
    p_organization_id,
    resulting_revision,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.archive_tenant_organization(uuid, text, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.archive_tenant_organization(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.archive_tenant_organization(uuid, text, uuid, uuid, bigint) is
  'Protected terminal organisation archive with no unresolved direct child, under the bound request context person''s current tenant authority and accepted replay.';

create or replace function vortex_identity.create_tenant_organization(
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_parent_organization_id uuid,
  p_organization_short_name text,
  p_organization_display_name text,
  p_organization_steward_identity_id uuid,
  p_account_display_name text,
  p_account_language text,
  p_account_time_zone text,
  p_runtime_language text,
  p_runtime_time_zone text,
  p_runtime_currency text,
  p_runtime_date_format text,
  p_runtime_number_format text
)
returns table (
  outcome text,
  operation text,
  organization_id uuid,
  organization_revision bigint,
  organization_account_id uuid,
  organization_account_revision bigint,
  access_version bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  new_organization_id uuid := pg_catalog.gen_random_uuid();
  new_account_id uuid := pg_catalog.gen_random_uuid();
  new_role_id uuid := pg_catalog.gen_random_uuid();
  new_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_delegation_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_access_version bigint;
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  replay_organization_id uuid;
  replay_account_id uuid;
  required_projection_count bigint;
  active_projection_count bigint;
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_parent_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_parent_organization_id::text))
    or p_organization_steward_identity_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_steward_identity_id::text)
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_organization_short_name is null
    or pg_catalog.char_length(p_organization_short_name) not between 1 and 40
    or p_organization_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_organization_display_name is null
    or p_organization_display_name is distinct from pg_catalog.btrim(p_organization_display_name)
    or pg_catalog.char_length(p_organization_display_name) not between 1 and 120
    or p_account_display_name is null
    or p_account_display_name is distinct from pg_catalog.btrim(p_account_display_name)
    or pg_catalog.char_length(p_account_display_name) not between 1 and 120 then
    raise exception using
      errcode = '22023',
      message = 'Tenant organisation creation command is invalid';
  end if;

  perform vortex_identity.assert_organization_runtime_settings_values(
    p_runtime_language, p_runtime_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );
  perform vortex_identity.assert_organization_runtime_settings_values(
    p_account_language, p_account_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );

  actor_identity_id := vortex_identity.tenant_request_actor_id();

  -- Tenant serialization converges duplicate and short-name races and keeps a
  -- parent lifecycle change from crossing this creation decision.
  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  -- Identity lifecycle writers use the same projection rows. Lock caller and
  -- nominee in stable order, but defer eligibility checks until after replay.
  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = any(array[
    actor_identity_id, p_organization_steward_identity_id
  ])
  order by projection.identity_id
  for share;

  perform 1
  from vortex_identity.tenant_administrator_assignments as assignment
  where assignment.tenant_id = p_tenant_id
    and assignment.identity_id = actor_identity_id
  order by assignment.assignment_id
  for update;

  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.create',
    evaluated_at
  );

  select stored.*
  into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id
    and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'create_tenant_organization'
    and stored.duplicate_key = p_duplicate_key
  for update;
  if found then
    if receipt.command_fingerprint <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    select organization.organization_id
    into replay_organization_id
    from vortex_identity.organizations as organization
    where organization.organization_id = any(receipt.subject_ids);
    select account.organization_account_id
    into replay_account_id
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = any(receipt.subject_ids);
    if replay_organization_id is null or replay_account_id is null then
      raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
    end if;
    return query
    select 'replayed'::text,
      'create_tenant_organization'::text,
      replay_organization_id,
      1::bigint,
      replay_account_id,
      receipt.subject_revisions[
        pg_catalog.array_position(receipt.subject_ids, replay_account_id)
      ],
      receipt.subject_revisions[
        pg_catalog.array_position(receipt.subject_ids, replay_organization_id)
      ],
      receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;

  select pg_catalog.count(distinct nominated.identity_id)
  into required_projection_count
  from (values
    (actor_identity_id),
    (p_organization_steward_identity_id)
  ) as nominated(identity_id);
  select pg_catalog.count(distinct projection.identity_id)
  into active_projection_count
  from vortex_identity.identity_projections as projection
  where projection.identity_id = any(array[
    actor_identity_id, p_organization_steward_identity_id
  ])
    and projection.state = 'active';
  if active_projection_count <> required_projection_count then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  if p_parent_organization_id is not null
    and not exists (
      select 1
      from vortex_identity.organizations as parent
      where parent.tenant_id = p_tenant_id
        and parent.organization_id = p_parent_organization_id
        and parent.state in ('active', 'suspended')
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;

  -- Re-evaluate after all locks on existing facts. No creator membership or
  -- projection fallback is inferred from the tenant assignment.
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id,
    p_tenant_id,
    'platform.tenant.organizations.create',
    evaluated_at
  );

  begin
    insert into vortex_identity.organizations (
      organization_id, tenant_id, parent_organization_id, short_name,
      display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      new_organization_id, p_tenant_id, p_parent_organization_id,
      p_organization_short_name, p_organization_display_name, 'active',
      evaluated_at, actor_identity_id, evaluated_at, 1
    );
  exception when unique_violation then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end;

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, language, time_zone, activated_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision
  ) values (
    new_account_id, new_organization_id, p_organization_steward_identity_id,
    p_account_display_name, 'active', p_account_language, p_account_time_zone,
    evaluated_at, evaluated_at, evaluated_at, actor_identity_id,
    new_correlation_id, 1
  );

  perform 1 from vortex_identity.initialize_organization_runtime_settings(
    new_organization_id, p_runtime_language, p_runtime_time_zone,
    p_runtime_currency, p_runtime_date_format, p_runtime_number_format
  );
  perform 1 from vortex_access.initialize_organization_access_version(
    new_organization_id, actor_identity_id, new_correlation_id
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    new_organization_id, actor_identity_id, new_correlation_id
  );

  select adopted.access_version
  into resulting_access_version
  from vortex_access.coordinate_organization_stewardship_adoption(
    new_organization_id, new_account_id, new_role_id, 'organization_steward',
    'Organisation steward', 'Permanent minimum organisation administration.',
    new_role_assignment_id, new_delegation_id, actor_identity_id,
    new_correlation_id
  ) as adopted;

  set constraints
    vortex_access.permission_continuities_evidence,
    vortex_access.organization_role_revisions_evidence
    immediate;
  set constraints
    vortex_access.permission_continuities_evidence,
    vortex_access.organization_role_revisions_evidence
    deferred;

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values
    (new_organization_id, resulting_access_version),
    (new_account_id, 1::bigint)
  ) as result(subject_id, subject_revision);

  insert into vortex_identity.accepted_administration_receipts (
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    new_correlation_id, actor_identity_id, p_tenant_id,
    'create_tenant_organization', p_duplicate_key, p_command_fingerprint,
    result_subject_ids, result_subject_revisions, evaluated_at
  );

  return query
  select 'accepted'::text,
    'create_tenant_organization'::text,
    new_organization_id,
    1::bigint,
    new_account_id,
    1::bigint,
    resulting_access_version,
    new_correlation_id,
    evaluated_at;
end
$function$;

revoke execute on function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text)
  to vortex_runtime;

comment on function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text) is
  'Creates one tenant organisation for the bound request context person with an explicit existing steward, runtime settings and delivered Access composition.';
