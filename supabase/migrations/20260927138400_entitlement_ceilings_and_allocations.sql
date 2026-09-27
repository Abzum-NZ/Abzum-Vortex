-- #1384: entitlement limits. The platform operator sets tenant ceilings;
-- tenant administrators allocate within them.
--
-- Owner decision (27 Sep 2026, option 3):
--
-- * Ceiling. Only the Vortex platform operator publishes capability policies
--   and sets each tenant's ceiling for a capability. The platform operator is
--   the existing configured system operator: an actor named by trusted server
--   configuration and reached only through the runtime role in a transaction
--   that carries no request context (`require_platform_operator_internal`).
--   It is never a customer role and cannot be inferred from any tenant or
--   organisation role, delegation or session.
-- * Allocation. A tenant administrator (the tenant's
--   `platform.tenant.administrators.manage` authority, taken from the bound
--   request context) allocates or lowers a limit for the whole tenant or for
--   one organisation, and is refused above the live ceiling (V3104).
-- * Organisation administrators lose every assignment command: the old
--   `assign_capability_policy` and `revoke_capability_policy_assignment` and
--   their actor-context helper are dropped. Resolution stays readable to them.
-- * Resolution. The effective limit is the lowest of the live ceiling, the
--   tenant allocation and the organisation allocation, and reports which one
--   applied. An allocation counts only beneath a live ceiling, so no
--   allocation can raise a limit. The read path, the reservation lock and the
--   balance refresh share one private bound set
--   (`capability_limit_bounds_internal`).
-- * Evidence. Every publication, ceiling and allocation change writes an
--   accepted receipt and one row in the append-only
--   `capability_limit_changes` ledger; an organisation allocation also writes
--   content-free organisation Activity. Entitlements still grant no data access.
--
-- Existing rows keep their effect. A tenant-scope assignment becomes that
-- tenant's ceiling; an organisation-scope assignment becomes an organisation
-- allocation of the quantity it already pinned, which could only narrow the
-- tenant limit since #833. No limit rises.
--
-- Every function below is created in full and is identical to its canonical
-- file under supabase/schemas/vortex_access/. The commands whose parameters or
-- results change are dropped first.

begin;

-- 1. Assignments distinguish the platform ceiling from tenant allocations.
alter table vortex_access.capability_policy_assignments
  add column assignment_kind text,
  add column allocated_quantity numeric;

update vortex_access.capability_policy_assignments as assignment
set assignment_kind = case
      when assignment.organization_id is null then 'ceiling' else 'allocation' end,
    allocated_quantity = case
      when assignment.organization_id is null then null else definition.quantity_limit end
from vortex_access.capability_policy_definitions as definition
where definition.tenant_id = assignment.tenant_id
  and definition.policy_id = assignment.policy_id
  and definition.revision = assignment.policy_revision;

alter table vortex_access.capability_policy_assignments
  alter column assignment_kind set not null;
alter table vortex_access.capability_policy_assignments
  add constraint capability_policy_assignments_kind_valid check (
    (assignment_kind = 'ceiling' and organization_id is null and allocated_quantity is null)
    or (assignment_kind = 'allocation' and allocated_quantity is not null
      and vortex_access.capability_policy_quantity_is_valid(allocated_quantity))
  );

-- One live ceiling per tenant capability, and one live allocation per exact
-- tenant-wide or organisation scope.
drop index vortex_access.capability_policy_assignments_live_scope_unique;
create unique index capability_policy_assignments_live_scope_unique
  on vortex_access.capability_policy_assignments (
    tenant_id, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    capability_key, unit, assignment_kind
  ) where revoked_at is null;

-- 2. Append-only change evidence for every limit change, tenant or organisation.
create table vortex_access.capability_limit_changes (
  change_id uuid not null primary key,
  tenant_id uuid not null references vortex_identity.tenants (tenant_id),
  organization_id uuid references vortex_identity.organizations (organization_id),
  change_kind text not null,
  actor_kind text not null,
  actor_id uuid not null,
  policy_id uuid not null,
  policy_revision bigint not null,
  assignment_id uuid references vortex_access.capability_policy_assignments (assignment_id),
  assignment_revision bigint,
  capability_key text not null,
  unit text not null,
  quantity_limit numeric,
  expires_at timestamptz,
  source text not null,
  correlation_id uuid not null,
  occurred_at timestamptz not null,
  foreign key (tenant_id, policy_id, policy_revision)
    references vortex_access.capability_policy_definitions (tenant_id, policy_id, revision),
  constraint capability_limit_changes_ids_non_nil check (
    vortex_context.is_non_nil_uuid(change_id::text)
    and vortex_context.is_non_nil_uuid(tenant_id::text)
    and (organization_id is null or vortex_context.is_non_nil_uuid(organization_id::text))
    and vortex_context.is_non_nil_uuid(actor_id::text)
    and vortex_context.is_non_nil_uuid(policy_id::text)
    and (assignment_id is null or vortex_context.is_non_nil_uuid(assignment_id::text))
    and vortex_context.is_non_nil_uuid(correlation_id::text)
  ),
  constraint capability_limit_changes_kind_valid check (
    (change_kind = 'policy_published' and actor_kind = 'platform_operator'
      and organization_id is null and assignment_id is null and assignment_revision is null
      and quantity_limit is not null and expires_at is null)
    or (change_kind in ('ceiling_set', 'ceiling_revised') and actor_kind = 'platform_operator'
      and organization_id is null and assignment_id is not null
      and assignment_revision is not null and quantity_limit is not null)
    or (change_kind = 'ceiling_revoked' and actor_kind = 'platform_operator'
      and organization_id is null and assignment_id is not null
      and assignment_revision is not null and quantity_limit is null and expires_at is null)
    or (change_kind in ('allocation_set', 'allocation_revised')
      and actor_kind = 'tenant_administrator' and assignment_id is not null
      and assignment_revision is not null and quantity_limit is not null)
    or (change_kind = 'allocation_revoked' and actor_kind = 'tenant_administrator'
      and assignment_id is not null and assignment_revision is not null
      and quantity_limit is null and expires_at is null)
  ),
  constraint capability_limit_changes_scope_valid check (
    vortex_access.capability_policy_key_is_valid(capability_key)
    and vortex_access.capability_policy_unit_is_valid(unit)
    and (quantity_limit is null
      or vortex_access.capability_policy_quantity_is_valid(quantity_limit))
  ),
  constraint capability_limit_changes_revisions_valid check (
    policy_revision between 1 and 9007199254740991
    and (assignment_revision is null or assignment_revision between 1 and 9007199254740991)
  ),
  constraint capability_limit_changes_source_valid check (
    source in ('web', 'mcp', 'programmatic_interface', 'connection', 'federation',
      'durable_workflow', 'system')
  ),
  constraint capability_limit_changes_time_valid check (
    occurred_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (expires_at is null
      or expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
  )
);

create index capability_limit_changes_scope_idx
  on vortex_access.capability_limit_changes (tenant_id, capability_key, unit, occurred_at);
create index capability_limit_changes_assignment_idx
  on vortex_access.capability_limit_changes (assignment_id)
  where assignment_id is not null;

alter table vortex_access.capability_limit_changes enable row level security;
alter table vortex_access.capability_limit_changes force row level security;
revoke all on table vortex_access.capability_limit_changes
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

create or replace function vortex_access.refuse_capability_limit_change_edit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using errcode = '55000',
    message = 'Capability limit change evidence is append-only';
end
$function$;

revoke all on function vortex_access.refuse_capability_limit_change_edit()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.refuse_capability_limit_change_edit() is
  'Refuses every update, delete or truncate of capability limit change evidence.';

create trigger capability_limit_changes_append_only
  before update or delete on vortex_access.capability_limit_changes
  for each row execute function vortex_access.refuse_capability_limit_change_edit();
create trigger capability_limit_changes_no_truncate
  before truncate on vortex_access.capability_limit_changes
  for each statement execute function vortex_access.refuse_capability_limit_change_edit();

-- 3. Organisation administrators lose assignment authority, and the commands
--    whose authority, parameters or results change are replaced.
drop function vortex_access.assign_capability_policy(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, uuid
);
drop function vortex_access.revoke_capability_policy_assignment(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, uuid
);
drop function vortex_access.capability_policy_actor_context(uuid, uuid, uuid, uuid);
drop function vortex_access.publish_capability_policy_definition(
  uuid, uuid, uuid, uuid, text, text, numeric, bigint
);
drop function vortex_access.resolve_effective_capability_policy(uuid, uuid, text, text);

-- 4. The platform-operator boundary and the one shared bound set.

create or replace function vortex_access.require_platform_operator_internal(
  p_operator_actor_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_operator_actor_id is null
    or not vortex_context.is_non_nil_uuid(p_operator_actor_id::text) then
    raise exception using errcode = '22023', message = 'Platform operator is invalid';
  end if;
  -- The platform operator is the configured system operator: trusted server
  -- configuration reached only through the runtime role, never a person's
  -- request. A transaction that carries a request context is a customer path,
  -- so no tenant or organisation role, delegation or session can reach here.
  if exists (
    select 1
    from vortex_context.request_contexts as established
    where established.backend_pid = pg_catalog.pg_backend_pid()
      and established.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
  ) then
    raise exception using errcode = '42501', message = 'Platform operator authority is unavailable';
  end if;
end
$function$;

revoke all on function vortex_access.require_platform_operator_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.require_platform_operator_internal(uuid) is
  'Private: refuses unless the caller is the configured platform operator in a transaction that carries no request context, so no customer role or request can act as the operator.';

create or replace function vortex_access.capability_limit_bounds_internal(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_capability_key text,
  p_unit text,
  p_evaluated_at timestamptz,
  p_lock boolean
)
returns table (
  limit_source text,
  applied_scope text,
  assignment_organization_id uuid,
  policy_id uuid,
  policy_revision bigint,
  assignment_id uuid,
  assignment_revision bigint,
  quantity_limit numeric,
  expires_at timestamptz,
  precedence integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_evaluated_at is null
    or p_evaluated_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_lock is null then
    raise exception using errcode = '22023', message = 'Capability limit scope is invalid';
  end if;
  -- Every live row that can bound this scope is locked in one stable order, so
  -- the reservation paths and the administration commands never interleave.
  if p_lock then
    perform 1
    from vortex_access.capability_policy_assignments as assignment
    where assignment.tenant_id = p_tenant_id
      and (assignment.organization_id is null
        or assignment.organization_id = p_organization_id)
      and assignment.capability_key = p_capability_key and assignment.unit = p_unit
      and assignment.revoked_at is null
    order by assignment.assignment_id
    for update of assignment;
  end if;
  -- The platform ceiling is the only source of a limit. An allocation counts
  -- only while a live ceiling exists, is reported against that ceiling's policy
  -- revision, and ends no later than the ceiling does.
  return query
  with live_ceiling as (
    select assignment.assignment_id, assignment.revision, assignment.policy_id,
      assignment.policy_revision, assignment.expires_at, definition.quantity_limit
    from vortex_access.capability_policy_assignments as assignment
    join vortex_access.capability_policy_definitions as definition
      on definition.tenant_id = assignment.tenant_id
      and definition.policy_id = assignment.policy_id
      and definition.revision = assignment.policy_revision
    where assignment.tenant_id = p_tenant_id
      and assignment.assignment_kind = 'ceiling'
      and assignment.organization_id is null
      and assignment.capability_key = p_capability_key and assignment.unit = p_unit
      and assignment.revoked_at is null and assignment.starts_at <= p_evaluated_at
      and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
    order by assignment.assignment_id
    limit 1
  )
  select 'platform_ceiling'::text, 'tenant'::text, null::uuid,
    live_ceiling.policy_id, live_ceiling.policy_revision, live_ceiling.assignment_id,
    live_ceiling.revision, live_ceiling.quantity_limit, live_ceiling.expires_at, 2
  from live_ceiling
  union all
  select 'tenant_allocation'::text, 'tenant'::text, null::uuid,
    live_ceiling.policy_id, live_ceiling.policy_revision, allocation.assignment_id,
    allocation.revision, allocation.allocated_quantity,
    least(allocation.expires_at, live_ceiling.expires_at), 1
  from live_ceiling
  join vortex_access.capability_policy_assignments as allocation
    on allocation.tenant_id = p_tenant_id
    and allocation.assignment_kind = 'allocation'
    and allocation.organization_id is null
    and allocation.capability_key = p_capability_key and allocation.unit = p_unit
    and allocation.revoked_at is null and allocation.starts_at <= p_evaluated_at
    and (allocation.expires_at is null or allocation.expires_at > p_evaluated_at)
  union all
  select 'organization_allocation'::text, 'organization'::text, allocation.organization_id,
    live_ceiling.policy_id, live_ceiling.policy_revision, allocation.assignment_id,
    allocation.revision, allocation.allocated_quantity,
    least(allocation.expires_at, live_ceiling.expires_at), 0
  from live_ceiling
  join vortex_access.capability_policy_assignments as allocation
    on p_organization_id is not null
    and allocation.tenant_id = p_tenant_id
    and allocation.assignment_kind = 'allocation'
    and allocation.organization_id = p_organization_id
    and allocation.capability_key = p_capability_key and allocation.unit = p_unit
    and allocation.revoked_at is null and allocation.starts_at <= p_evaluated_at
    and (allocation.expires_at is null or allocation.expires_at > p_evaluated_at);
end
$function$;

revoke all on function vortex_access.capability_limit_bounds_internal(
  uuid, uuid, text, text, timestamptz, boolean
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.capability_limit_bounds_internal(
  uuid, uuid, text, text, timestamptz, boolean
) is
  'Private: the live platform ceiling and the tenant and organisation allocations that bound one capability scope, each with its precedence; allocations count only under a live ceiling.';

-- 5. Platform operator: policy publication and tenant ceilings.

create or replace function vortex_access.publish_capability_policy_definition(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_policy_id uuid,
  p_capability_key text,
  p_unit text,
  p_quantity_limit numeric,
  p_expected_revision bigint
)
returns table (
  outcome text, policy_id uuid, tenant_id uuid, capability_key text, unit text,
  quantity_limit numeric, revision bigint, correlation_id uuid, accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  current_definition vortex_access.capability_policy_definitions%rowtype;
  current_revision bigint;
  resulting_revision bigint;
  correlation uuid := pg_catalog.gen_random_uuid();
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  command_fingerprint text;
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_policy_id is null or not vortex_context.is_non_nil_uuid(p_policy_id::text)
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or not vortex_access.capability_policy_quantity_is_valid(p_quantity_limit)
    or (p_expected_revision is not null
      and p_expected_revision not between 1 and 9007199254740991) then
    raise exception using errcode = '22023', message = 'Capability policy definition is invalid';
  end if;
  -- Only the platform operator defines policies; no tenant or organisation
  -- authority reaches this command.
  perform vortex_access.require_platform_operator_internal(p_operator_actor_id);
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for no key update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'publish_capability_policy_definition',
      p_tenant_id::text, p_policy_id::text, p_capability_key, p_unit,
      p_quantity_limit::text, coalesce(p_expected_revision::text, '')), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_operator_actor_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'publish_capability_policy_definition'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_policy_id]
      or pg_catalog.cardinality(receipt.subject_revisions) <> 1 then
      raise exception using errcode = 'V3001', message = 'Capability policy duplicate conflicts';
    end if;
    return query
      select 'replayed'::text, definition.policy_id, definition.tenant_id,
        definition.capability_key, definition.unit, definition.quantity_limit,
        definition.revision, receipt.receipt_id, receipt.accepted_at
      from vortex_access.capability_policy_definitions as definition
      where definition.policy_id = p_policy_id
        and definition.revision = receipt.subject_revisions[1];
    if not found then
      raise exception using errcode = '42501', message = 'Capability policy replay is unavailable';
    end if;
    return;
  end if;
  select definition.* into current_definition
  from vortex_access.capability_policy_definitions as definition
  where definition.tenant_id = p_tenant_id and definition.policy_id = p_policy_id
  order by definition.revision desc limit 1;
  current_revision := current_definition.revision;
  if (current_revision is null and p_expected_revision is not null)
    or (current_revision is not null and p_expected_revision is distinct from current_revision)
    or (current_revision is null and p_expected_revision is null and exists (
      select 1 from vortex_access.capability_policy_definitions definition
      where definition.policy_id = p_policy_id
    )) then
    raise exception using errcode = 'V3102', message = 'Capability policy definition revision is stale';
  end if;
  -- A policy names one capability and unit for its whole life.  Only the
  -- quantity limit is revisable, so publishing a later revision can never
  -- re-point a ceiling that pinned an earlier one at another capability.
  if current_revision is not null
    and (current_definition.capability_key <> p_capability_key
      or current_definition.unit <> p_unit) then
    raise exception using errcode = '22023',
      message = 'Capability policy scope cannot change between revisions';
  end if;
  resulting_revision := coalesce(current_revision, 0) + 1;
  if resulting_revision > 9007199254740991 then
    raise exception using errcode = '40001', message = 'Capability policy revision is exhausted';
  end if;
  insert into vortex_access.capability_policy_definitions(
    policy_id, tenant_id, capability_key, unit, quantity_limit, revision,
    published_at, published_by_actor_id, publication_correlation_id
  ) values (
    p_policy_id, p_tenant_id, p_capability_key, p_unit, p_quantity_limit, resulting_revision,
    evaluated_at, p_operator_actor_id, correlation
  );
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    correlation, p_operator_actor_id, p_tenant_id, 'publish_capability_policy_definition',
    p_duplicate_key, command_fingerprint, array[p_policy_id], array[resulting_revision], evaluated_at
  );
  insert into vortex_access.capability_limit_changes(
    change_id, tenant_id, organization_id, change_kind, actor_kind, actor_id,
    policy_id, policy_revision, assignment_id, assignment_revision,
    capability_key, unit, quantity_limit, expires_at, source, correlation_id, occurred_at
  ) values (
    correlation, p_tenant_id, null, 'policy_published', 'platform_operator', p_operator_actor_id,
    p_policy_id, resulting_revision, null, null,
    p_capability_key, p_unit, p_quantity_limit, null, 'system', correlation, evaluated_at
  );
  return query select 'accepted'::text, p_policy_id, p_tenant_id, p_capability_key,
    p_unit, p_quantity_limit, resulting_revision, correlation, evaluated_at;
end
$function$;

revoke execute on function vortex_access.publish_capability_policy_definition(
  uuid, uuid, uuid, uuid, text, text, numeric, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.publish_capability_policy_definition(
  uuid, uuid, uuid, uuid, text, text, numeric, bigint
) to vortex_runtime;

comment on function vortex_access.publish_capability_policy_definition(
  uuid, uuid, uuid, uuid, text, text, numeric, bigint
) is
  'Platform-operator-only capability policy publication for one tenant: an immutable revision with an accepted receipt and append-only change evidence.';

create or replace function vortex_access.set_capability_policy_ceiling(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_assignment_id uuid,
  p_policy_id uuid,
  p_policy_revision bigint,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_expected_revision bigint
)
returns table (
  outcome text, assignment_id uuid, tenant_id uuid, policy_id uuid, policy_revision bigint,
  capability_key text, unit text, quantity_limit numeric, revision bigint,
  correlation_id uuid, accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  policy vortex_access.capability_policy_definitions%rowtype;
  target vortex_access.capability_policy_assignments%rowtype;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  evidence vortex_access.capability_limit_changes%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
  resulting_revision bigint;
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_policy_id is null or not vortex_context.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision is null or p_policy_revision not between 1 and 9007199254740991
    or p_starts_at is null or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)))
    or (p_expected_revision is not null
      and p_expected_revision not between 1 and 9007199254740990) then
    raise exception using errcode = '22023', message = 'Capability ceiling is invalid';
  end if;
  -- Only the platform operator sets a tenant's ceiling.
  perform vortex_access.require_platform_operator_internal(p_operator_actor_id);
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for no key update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'set_capability_policy_ceiling',
      p_tenant_id::text, p_assignment_id::text, p_policy_id::text, p_policy_revision::text,
      p_starts_at::text, coalesce(p_expires_at::text, ''),
      coalesce(p_expected_revision::text, '')), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_operator_actor_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'set_capability_policy_ceiling'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_assignment_id] then
      raise exception using errcode = 'V3001', message = 'Capability ceiling duplicate conflicts';
    end if;
    select stored.* into evidence
    from vortex_access.capability_limit_changes as stored
    where stored.change_id = receipt.receipt_id;
    if not found then
      raise exception using errcode = '42501', message = 'Capability ceiling replay is unavailable';
    end if;
    return query select 'replayed'::text, evidence.assignment_id, evidence.tenant_id,
      evidence.policy_id, evidence.policy_revision, evidence.capability_key, evidence.unit,
      evidence.quantity_limit, evidence.assignment_revision, receipt.receipt_id,
      receipt.accepted_at;
    return;
  end if;
  select definition.* into policy
  from vortex_access.capability_policy_definitions as definition
  where definition.tenant_id = p_tenant_id and definition.policy_id = p_policy_id
    and definition.revision = p_policy_revision;
  if not found then
    raise exception using errcode = 'V3101',
      message = 'Capability policy definition revision is unavailable';
  end if;
  if p_expected_revision is null then
    if exists (
      select 1 from vortex_access.capability_policy_assignments as assignment
      where assignment.tenant_id = p_tenant_id
        and assignment.assignment_kind = 'ceiling'
        and assignment.capability_key = policy.capability_key
        and assignment.unit = policy.unit and assignment.revoked_at is null
    ) or exists (
      select 1 from vortex_access.capability_policy_assignments as assignment
      where assignment.assignment_id = p_assignment_id
    ) then
      raise exception using errcode = '23505', message = 'Capability ceiling already exists';
    end if;
    resulting_revision := 1;
    insert into vortex_access.capability_policy_assignments(
      assignment_id, tenant_id, organization_id, policy_id, policy_revision,
      capability_key, unit, starts_at, expires_at, revision, assigned_at,
      assigned_by_actor_id, assignment_correlation_id, changed_at,
      changed_by_actor_id, change_correlation_id, assignment_kind, allocated_quantity
    ) values (
      p_assignment_id, p_tenant_id, null, p_policy_id, p_policy_revision,
      policy.capability_key, policy.unit, p_starts_at, p_expires_at, resulting_revision,
      evaluated_at, p_operator_actor_id, correlation, evaluated_at, p_operator_actor_id,
      correlation, 'ceiling', null
    );
  else
    select assignment.* into target
    from vortex_access.capability_policy_assignments as assignment
    where assignment.assignment_id = p_assignment_id for update;
    if not found or target.tenant_id <> p_tenant_id or target.assignment_kind <> 'ceiling' then
      raise exception using errcode = 'V3101', message = 'Capability ceiling is unavailable';
    end if;
    -- A ceiling is re-pinned in place so the tenant is never left without one,
    -- and only to a policy for the same capability and unit.
    if target.capability_key <> policy.capability_key or target.unit <> policy.unit then
      raise exception using errcode = '22023',
        message = 'Capability ceiling scope cannot change';
    end if;
    if target.revoked_at is not null or target.revision <> p_expected_revision then
      raise exception using errcode = 'V3102', message = 'Capability ceiling is stale';
    end if;
    resulting_revision := p_expected_revision + 1;
    update vortex_access.capability_policy_assignments as assignment
    set policy_id = p_policy_id, policy_revision = p_policy_revision,
        starts_at = p_starts_at, expires_at = p_expires_at, revision = resulting_revision,
        changed_at = evaluated_at, changed_by_actor_id = p_operator_actor_id,
        change_correlation_id = correlation
    where assignment.assignment_id = p_assignment_id;
  end if;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    correlation, p_operator_actor_id, p_tenant_id, 'set_capability_policy_ceiling',
    p_duplicate_key, command_fingerprint, array[p_assignment_id],
    array[resulting_revision], evaluated_at
  );
  insert into vortex_access.capability_limit_changes(
    change_id, tenant_id, organization_id, change_kind, actor_kind, actor_id,
    policy_id, policy_revision, assignment_id, assignment_revision,
    capability_key, unit, quantity_limit, expires_at, source, correlation_id, occurred_at
  ) values (
    correlation, p_tenant_id, null,
    case when resulting_revision = 1 then 'ceiling_set' else 'ceiling_revised' end,
    'platform_operator', p_operator_actor_id, p_policy_id, p_policy_revision,
    p_assignment_id, resulting_revision, policy.capability_key, policy.unit,
    policy.quantity_limit, p_expires_at, 'system', correlation, evaluated_at
  );
  return query select 'accepted'::text, p_assignment_id, p_tenant_id, p_policy_id,
    p_policy_revision, policy.capability_key, policy.unit, policy.quantity_limit,
    resulting_revision, correlation, evaluated_at;
end
$function$;

revoke execute on function vortex_access.set_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.set_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, bigint
) to vortex_runtime;

comment on function vortex_access.set_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, bigint
) is
  'Platform-operator-only command that sets, or re-pins in place, a tenant''s ceiling for one capability to an exact policy revision, with an accepted receipt and append-only change evidence.';

create or replace function vortex_access.revoke_capability_policy_ceiling(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_assignment_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, assignment_id uuid, tenant_id uuid, revision bigint,
  correlation_id uuid, accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  target vortex_access.capability_policy_assignments%rowtype;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990 then
    raise exception using errcode = '22023', message = 'Capability ceiling revocation is invalid';
  end if;
  perform vortex_access.require_platform_operator_internal(p_operator_actor_id);
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for no key update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'revoke_capability_policy_ceiling',
      p_tenant_id::text, p_assignment_id::text, p_expected_revision::text), 'UTF8'),
    'sha256'), 'hex');
  -- The accepted receipt is consulted before the staleness test so an
  -- identical retry replays instead of refusing the ceiling it already revoked.
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_operator_actor_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'revoke_capability_policy_ceiling'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_assignment_id]
      or receipt.subject_revisions[1] is null then
      raise exception using errcode = 'V3001', message = 'Capability ceiling revocation duplicate conflicts';
    end if;
    return query select 'replayed'::text, p_assignment_id, p_tenant_id,
      receipt.subject_revisions[1], receipt.receipt_id, receipt.accepted_at;
    return;
  end if;
  select assignment.* into target
  from vortex_access.capability_policy_assignments as assignment
  where assignment.assignment_id = p_assignment_id for update;
  if not found or target.tenant_id <> p_tenant_id or target.assignment_kind <> 'ceiling' then
    raise exception using errcode = 'V3101', message = 'Capability ceiling is unavailable';
  end if;
  if target.revoked_at is not null or target.revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Capability ceiling is stale';
  end if;
  update vortex_access.capability_policy_assignments as assignment
  set revision = p_expected_revision + 1, changed_at = evaluated_at,
      changed_by_actor_id = p_operator_actor_id, change_correlation_id = correlation,
      revoked_at = evaluated_at, revoked_by_actor_id = p_operator_actor_id,
      revocation_correlation_id = correlation
  where assignment.assignment_id = p_assignment_id;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    correlation, p_operator_actor_id, p_tenant_id, 'revoke_capability_policy_ceiling',
    p_duplicate_key, command_fingerprint, array[p_assignment_id],
    array[(p_expected_revision + 1)::bigint], evaluated_at
  );
  insert into vortex_access.capability_limit_changes(
    change_id, tenant_id, organization_id, change_kind, actor_kind, actor_id,
    policy_id, policy_revision, assignment_id, assignment_revision,
    capability_key, unit, quantity_limit, expires_at, source, correlation_id, occurred_at
  ) values (
    correlation, p_tenant_id, null, 'ceiling_revoked', 'platform_operator', p_operator_actor_id,
    target.policy_id, target.policy_revision, p_assignment_id, p_expected_revision + 1,
    target.capability_key, target.unit, null, null, 'system', correlation, evaluated_at
  );
  return query select 'accepted'::text, p_assignment_id, p_tenant_id,
    p_expected_revision + 1, correlation, evaluated_at;
end
$function$;

revoke execute on function vortex_access.revoke_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.revoke_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, bigint
) to vortex_runtime;

comment on function vortex_access.revoke_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, bigint
) is
  'Platform-operator-only command that revokes a tenant''s ceiling for one capability, with an accepted receipt and append-only change evidence; allocations beneath it stop applying.';

-- 6. Tenant administrators: allocations within the ceiling.

create or replace function vortex_access.set_capability_limit_allocation(
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_assignment_id uuid,
  p_capability_key text,
  p_unit text,
  p_quantity_limit numeric,
  p_expires_at timestamptz,
  p_expected_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text, assignment_id uuid, tenant_id uuid, organization_id uuid,
  capability_key text, unit text, quantity_limit numeric, ceiling_policy_id uuid,
  ceiling_policy_revision bigint, revision bigint, correlation_id uuid, accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  request_correlation_id uuid;
  live_ceiling record;
  target vortex_access.capability_policy_assignments%rowtype;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  evidence vortex_access.capability_limit_changes%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
  resulting_revision bigint;
  activity_subjects uuid[];
  activity_result text;
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or not vortex_access.capability_policy_quantity_is_valid(p_quantity_limit)
    or (p_expires_at is not null
      and p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_expected_revision is not null
      and p_expected_revision not between 1 and 9007199254740990)
    -- An organisation allocation is also recorded in that organisation's
    -- Activity history; a tenant-wide allocation has no organisation ledger.
    or (p_organization_id is null) <> (p_activity_id is null)
    or (p_activity_id is not null and not vortex_context.is_non_nil_uuid(p_activity_id::text)) then
    raise exception using errcode = '22023', message = 'Capability allocation is invalid';
  end if;
  -- The acting person comes only from the bound request context, and the
  -- authority is tenant administration: an organisation role, delegation or
  -- organisation administrator can never allocate a limit.
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  request_correlation_id := (vortex_context.current_context() ->> 'correlationId')::uuid;
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for no key update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at
  );
  if p_expires_at is not null and p_expires_at <= evaluated_at then
    raise exception using errcode = '22023', message = 'Capability allocation is invalid';
  end if;
  if p_organization_id is not null then
    perform 1 from vortex_identity.organizations organization
    where organization.organization_id = p_organization_id
      and organization.tenant_id = p_tenant_id and organization.state = 'active'
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'Capability allocation organization is unavailable';
    end if;
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'set_capability_limit_allocation',
      p_tenant_id::text, coalesce(p_organization_id::text, ''), p_assignment_id::text,
      p_capability_key, p_unit, p_quantity_limit::text, coalesce(p_expires_at::text, ''),
      coalesce(p_expected_revision::text, '')), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'set_capability_limit_allocation'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_assignment_id] then
      raise exception using errcode = 'V3001', message = 'Capability allocation duplicate conflicts';
    end if;
    select stored.* into evidence
    from vortex_access.capability_limit_changes as stored
    where stored.change_id = receipt.receipt_id;
    if not found then
      raise exception using errcode = '42501', message = 'Capability allocation replay is unavailable';
    end if;
    return query select 'replayed'::text, evidence.assignment_id, evidence.tenant_id,
      evidence.organization_id, evidence.capability_key, evidence.unit,
      evidence.quantity_limit, evidence.policy_id, evidence.policy_revision,
      evidence.assignment_revision, receipt.receipt_id, receipt.accepted_at;
    return;
  end if;
  -- An allocation is only ever made beneath a live platform ceiling and never
  -- above it. A later lower ceiling still bounds it, because resolution takes
  -- the lowest applicable limit.
  select bound.* into live_ceiling
  from vortex_access.capability_limit_bounds_internal(
    p_tenant_id, p_organization_id, p_capability_key, p_unit, evaluated_at, true
  ) as bound
  where bound.limit_source = 'platform_ceiling';
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability ceiling is unavailable';
  end if;
  if p_quantity_limit > live_ceiling.quantity_limit then
    raise exception using errcode = 'V3104',
      message = 'Capability allocation exceeds the platform ceiling';
  end if;
  if p_expected_revision is null then
    if exists (
      select 1 from vortex_access.capability_policy_assignments as assignment
      where assignment.tenant_id = p_tenant_id
        and assignment.organization_id is not distinct from p_organization_id
        and assignment.assignment_kind = 'allocation'
        and assignment.capability_key = p_capability_key
        and assignment.unit = p_unit and assignment.revoked_at is null
    ) or exists (
      select 1 from vortex_access.capability_policy_assignments as assignment
      where assignment.assignment_id = p_assignment_id
    ) then
      raise exception using errcode = '23505', message = 'Capability allocation already exists';
    end if;
    resulting_revision := 1;
    insert into vortex_access.capability_policy_assignments(
      assignment_id, tenant_id, organization_id, policy_id, policy_revision,
      capability_key, unit, starts_at, expires_at, revision, assigned_at,
      assigned_by_actor_id, assignment_correlation_id, changed_at,
      changed_by_actor_id, change_correlation_id, assignment_kind, allocated_quantity
    ) values (
      p_assignment_id, p_tenant_id, p_organization_id, live_ceiling.policy_id,
      live_ceiling.policy_revision, p_capability_key, p_unit, evaluated_at, p_expires_at,
      resulting_revision, evaluated_at, actor_identity_id, correlation, evaluated_at,
      actor_identity_id, correlation, 'allocation', p_quantity_limit
    );
  else
    select assignment.* into target
    from vortex_access.capability_policy_assignments as assignment
    where assignment.assignment_id = p_assignment_id for update;
    if not found or target.tenant_id <> p_tenant_id
      or target.organization_id is distinct from p_organization_id
      or target.assignment_kind <> 'allocation'
      or target.capability_key <> p_capability_key or target.unit <> p_unit then
      raise exception using errcode = 'V3101', message = 'Capability allocation is unavailable';
    end if;
    if target.revoked_at is not null or target.revision <> p_expected_revision then
      raise exception using errcode = 'V3102', message = 'Capability allocation is stale';
    end if;
    resulting_revision := p_expected_revision + 1;
    update vortex_access.capability_policy_assignments as assignment
    set allocated_quantity = p_quantity_limit, expires_at = p_expires_at,
        policy_id = live_ceiling.policy_id, policy_revision = live_ceiling.policy_revision,
        revision = resulting_revision, changed_at = evaluated_at,
        changed_by_actor_id = actor_identity_id, change_correlation_id = correlation
    where assignment.assignment_id = p_assignment_id;
  end if;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    correlation, actor_identity_id, p_tenant_id, 'set_capability_limit_allocation',
    p_duplicate_key, command_fingerprint, array[p_assignment_id],
    array[resulting_revision], evaluated_at
  );
  insert into vortex_access.capability_limit_changes(
    change_id, tenant_id, organization_id, change_kind, actor_kind, actor_id,
    policy_id, policy_revision, assignment_id, assignment_revision,
    capability_key, unit, quantity_limit, expires_at, source, correlation_id, occurred_at
  ) values (
    correlation, p_tenant_id, p_organization_id,
    case when resulting_revision = 1 then 'allocation_set' else 'allocation_revised' end,
    'tenant_administrator', actor_identity_id, live_ceiling.policy_id, live_ceiling.policy_revision,
    p_assignment_id, resulting_revision, p_capability_key, p_unit, p_quantity_limit,
    p_expires_at, vortex_context.channel(), request_correlation_id, evaluated_at
  );
  if p_organization_id is not null then
    select pg_catalog.array_agg(distinct subject.subject_id order by subject.subject_id)
    into activity_subjects
    from pg_catalog.unnest(array[p_assignment_id, live_ceiling.policy_id]) as subject(subject_id);
    activity_result := vortex_activity.append_organization_activity_entry(
      p_organization_id, p_activity_id, evaluated_at, 'identity', actor_identity_id,
      'set_capability_limit_allocation', activity_subjects, array[]::uuid[],
      vortex_context.channel(), request_correlation_id, 'completed'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Capability allocation Activity is stale';
    end if;
  end if;
  return query select 'accepted'::text, p_assignment_id, p_tenant_id, p_organization_id,
    p_capability_key, p_unit, p_quantity_limit, live_ceiling.policy_id, live_ceiling.policy_revision,
    resulting_revision, correlation, evaluated_at;
end
$function$;

revoke execute on function vortex_access.set_capability_limit_allocation(
  uuid, uuid, uuid, uuid, text, text, numeric, timestamptz, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.set_capability_limit_allocation(
  uuid, uuid, uuid, uuid, text, text, numeric, timestamptz, bigint, uuid
) to vortex_request;

comment on function vortex_access.set_capability_limit_allocation(
  uuid, uuid, uuid, uuid, text, text, numeric, timestamptz, bigint, uuid
) is
  'Tenant-administrator command that allocates, or revises in place, a tenant-wide or organisation limit for one capability, refused above the live platform ceiling; it writes an accepted receipt, append-only change evidence and, for an organisation, content-free Activity.';

create or replace function vortex_access.revoke_capability_limit_allocation(
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_assignment_id uuid,
  p_expected_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text, assignment_id uuid, tenant_id uuid, organization_id uuid,
  revision bigint, correlation_id uuid, accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz;
  actor_identity_id uuid;
  request_correlation_id uuid;
  target vortex_access.capability_policy_assignments%rowtype;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
  activity_subjects uuid[];
  activity_result text;
begin
  if p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990
    or (p_organization_id is null) <> (p_activity_id is null)
    or (p_activity_id is not null and not vortex_context.is_non_nil_uuid(p_activity_id::text)) then
    raise exception using errcode = '22023', message = 'Capability allocation revocation is invalid';
  end if;
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  request_correlation_id := (vortex_context.current_context() ->> 'correlationId')::uuid;
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for no key update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at
  );
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'revoke_capability_limit_allocation',
      p_tenant_id::text, coalesce(p_organization_id::text, ''), p_assignment_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  -- The accepted receipt is consulted before the staleness test so an
  -- identical retry replays instead of refusing the allocation it revoked.
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = actor_identity_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'revoke_capability_limit_allocation'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_assignment_id]
      or receipt.subject_revisions[1] is null then
      raise exception using errcode = 'V3001', message = 'Capability allocation revocation duplicate conflicts';
    end if;
    return query select 'replayed'::text, p_assignment_id, p_tenant_id, p_organization_id,
      receipt.subject_revisions[1], receipt.receipt_id, receipt.accepted_at;
    return;
  end if;
  select assignment.* into target
  from vortex_access.capability_policy_assignments as assignment
  where assignment.assignment_id = p_assignment_id for update;
  -- The command names the subject it believes it is revoking, so it can never
  -- settle another scope's allocation, or a ceiling, by naming only its identifier.
  if not found or target.tenant_id <> p_tenant_id
    or target.organization_id is distinct from p_organization_id
    or target.assignment_kind <> 'allocation' then
    raise exception using errcode = 'V3101', message = 'Capability allocation is unavailable';
  end if;
  if target.revoked_at is not null or target.revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Capability allocation is stale';
  end if;
  update vortex_access.capability_policy_assignments as assignment
  set revision = p_expected_revision + 1, changed_at = evaluated_at,
      changed_by_actor_id = actor_identity_id, change_correlation_id = correlation,
      revoked_at = evaluated_at, revoked_by_actor_id = actor_identity_id,
      revocation_correlation_id = correlation
  where assignment.assignment_id = p_assignment_id;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    correlation, actor_identity_id, p_tenant_id, 'revoke_capability_limit_allocation',
    p_duplicate_key, command_fingerprint, array[p_assignment_id],
    array[(p_expected_revision + 1)::bigint], evaluated_at
  );
  insert into vortex_access.capability_limit_changes(
    change_id, tenant_id, organization_id, change_kind, actor_kind, actor_id,
    policy_id, policy_revision, assignment_id, assignment_revision,
    capability_key, unit, quantity_limit, expires_at, source, correlation_id, occurred_at
  ) values (
    correlation, p_tenant_id, p_organization_id, 'allocation_revoked', 'tenant_administrator',
    actor_identity_id, target.policy_id, target.policy_revision, p_assignment_id,
    p_expected_revision + 1, target.capability_key, target.unit, null, null,
    vortex_context.channel(), request_correlation_id, evaluated_at
  );
  if p_organization_id is not null then
    select pg_catalog.array_agg(distinct subject.subject_id order by subject.subject_id)
    into activity_subjects
    from pg_catalog.unnest(array[p_assignment_id, target.policy_id]) as subject(subject_id);
    activity_result := vortex_activity.append_organization_activity_entry(
      p_organization_id, p_activity_id, evaluated_at, 'identity', actor_identity_id,
      'revoke_capability_limit_allocation', activity_subjects, array[]::uuid[],
      vortex_context.channel(), request_correlation_id, 'completed'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Capability allocation revocation Activity is stale';
    end if;
  end if;
  return query select 'accepted'::text, p_assignment_id, p_tenant_id, p_organization_id,
    p_expected_revision + 1, correlation, evaluated_at;
end
$function$;

revoke execute on function vortex_access.revoke_capability_limit_allocation(
  uuid, uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.revoke_capability_limit_allocation(
  uuid, uuid, uuid, uuid, bigint, uuid
) to vortex_request;

comment on function vortex_access.revoke_capability_limit_allocation(
  uuid, uuid, uuid, uuid, bigint, uuid
) is
  'Tenant-administrator command that revokes a tenant-wide or organisation allocation, leaving the platform ceiling as the bound; it writes an accepted receipt, append-only change evidence and, for an organisation, content-free Activity.';

-- 7. Resolution, the reservation lock and the balance refresh share the bound set.

create or replace function vortex_access.resolve_effective_capability_policy(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_capability_key text,
  p_unit text
)
returns table (
  outcome text,
  tenant_id uuid,
  organization_id uuid,
  capability_key text,
  unit text,
  applied_scope text,
  applied_limit text,
  policy_id uuid,
  policy_revision bigint,
  assignment_id uuid,
  assignment_revision bigint,
  quantity_limit numeric,
  ceiling_quantity_limit numeric,
  resolved_at timestamptz,
  reason_code text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  context jsonb := vortex_context.current_context();
  context_organization_id uuid;
  effective_organization_id uuid;
  selected record;
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit) then
    raise exception using errcode = '22023', message = 'Capability policy resolution is invalid';
  end if;
  context_organization_id := (context ->> 'organizationId')::uuid;
  -- The established organisation always belongs to the resolved scope.  An
  -- organisation-scoped request can never omit its organisation and fall back
  -- to the wider tenant limit that its own allocation narrows.
  effective_organization_id := coalesce(p_organization_id, context_organization_id);
  if (context ->> 'tenantId')::uuid is distinct from p_tenant_id
    or effective_organization_id is distinct from context_organization_id then
    raise exception using errcode = '42501', message = 'Capability policy scope is unavailable';
  end if;
  if effective_organization_id is not null and not exists (
    select 1 from vortex_identity.organizations organization
    where organization.tenant_id = p_tenant_id
      and organization.organization_id = effective_organization_id
      and organization.state = 'active'
  ) then
    raise exception using errcode = '42501', message = 'Capability policy scope is unavailable';
  end if;
  -- The effective limit is the lowest of the platform ceiling and every
  -- allocation beneath it; on a tie the narrower scope is reported. No
  -- allocation can raise a limit, and nothing applies without a live ceiling.
  select bound.*,
    max(bound.quantity_limit) filter (where bound.limit_source = 'platform_ceiling')
      over () as ceiling_limit
  into selected
  from vortex_access.capability_limit_bounds_internal(
    p_tenant_id, effective_organization_id, p_capability_key, p_unit, evaluated_at, false
  ) as bound
  order by bound.quantity_limit, bound.precedence
  limit 1;
  if not found then
    return query select 'refused'::text, p_tenant_id, effective_organization_id,
      p_capability_key, p_unit, null::text, null::text, null::uuid, null::bigint, null::uuid,
      null::bigint, null::numeric, null::numeric, evaluated_at, 'capability_not_assigned'::text;
    return;
  end if;
  return query select 'available'::text, p_tenant_id, effective_organization_id,
    p_capability_key, p_unit, selected.applied_scope, selected.limit_source,
    selected.policy_id, selected.policy_revision, selected.assignment_id,
    selected.assignment_revision, selected.quantity_limit, selected.ceiling_limit,
    evaluated_at, null::text;
end
$function$;

revoke execute on function vortex_access.resolve_effective_capability_policy(uuid, uuid, text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.resolve_effective_capability_policy(uuid, uuid, text, text)
  to vortex_request;

comment on function vortex_access.resolve_effective_capability_policy(uuid, uuid, text, text) is
  'Returns the lowest of the live platform ceiling and the tenant and organisation allocations for the established request scope, the ceiling itself, and which limit applied; an allocation can only narrow the ceiling.';

create or replace function vortex_access.lock_effective_capability_policy(
  p_tenant_id uuid,
  p_organization_id uuid,
  p_capability_key text,
  p_unit text,
  p_evaluated_at timestamptz
)
returns table (
  request_organization_id uuid,
  correlation_id uuid,
  request_expires_at timestamptz,
  applied_scope text,
  assignment_organization_id uuid,
  policy_id uuid,
  policy_revision bigint,
  assignment_id uuid,
  assignment_revision bigint,
  quantity_limit numeric,
  assignment_expires_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  protected_context record;
  selected record;
begin
  if not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_evaluated_at is null
    or p_evaluated_at in ('-infinity'::timestamptz, 'infinity'::timestamptz) then
    raise exception using errcode = '22023', message = 'Capability reservation policy request is invalid';
  end if;
  select context.* into strict protected_context
  from vortex_access.capability_reservation_request_context(
    p_tenant_id, p_organization_id
  ) as context;
  -- The same rule as the read path: the lowest of the live platform ceiling
  -- and the tenant and organisation allocations, the narrower scope on a tie.
  select bound.* into selected
  from vortex_access.capability_limit_bounds_internal(
    p_tenant_id, protected_context.request_organization_id, p_capability_key, p_unit,
    p_evaluated_at, true
  ) as bound
  order by bound.quantity_limit, bound.precedence
  limit 1;
  if not found then return; end if;
  return query select protected_context.request_organization_id,
    protected_context.correlation_id, protected_context.request_expires_at,
    selected.applied_scope, selected.assignment_organization_id,
    selected.policy_id, selected.policy_revision, selected.assignment_id,
    selected.assignment_revision, selected.quantity_limit, selected.expires_at;
end
$function$;

revoke execute on function vortex_access.lock_effective_capability_policy(
  uuid, uuid, text, text, timestamptz
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.lock_effective_capability_policy(uuid, uuid, text, text, timestamptz) is
  'Locks the live platform ceiling and the tenant and organisation allocations for the scope, then returns the lowest of them as the effective limit; an allocation can only narrow the ceiling.';

create or replace function vortex_access.refresh_capability_reservation_balance(
  p_tenant_id uuid, p_request_organization_id uuid,
  p_capability_key text, p_unit text, p_applied_scope text,
  p_assignment_organization_id uuid, p_policy_id uuid, p_policy_revision bigint,
  p_assignment_id uuid, p_assignment_revision bigint, p_quantity_limit numeric,
  p_evaluated_at timestamptz
)
returns table (
  policy_quantity_limit numeric, active_reserved_quantity numeric,
  consumed_quantity numeric, released_quantity numeric, available_quantity numeric
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  active_reserved numeric;
  consumed numeric;
  released numeric;
  tenant_bound record;
  tenant_balance record;
begin
  update vortex_access.capability_reservations as reservation
  set state = 'expired', expired_at = p_evaluated_at, updated_at = p_evaluated_at
  where reservation.tenant_id = p_tenant_id
    and reservation.capability_key = p_capability_key and reservation.unit = p_unit
    and reservation.state = 'active' and reservation.expires_at <= p_evaluated_at;
  update vortex_access.capability_reservations as reservation
  set state = 'expired', expired_at = p_evaluated_at, updated_at = p_evaluated_at
  where reservation.tenant_id = p_tenant_id
    and reservation.capability_key = p_capability_key and reservation.unit = p_unit
    and reservation.state = 'active'
    and (reservation.request_organization_id
        is not distinct from p_request_organization_id
      or (p_applied_scope = 'tenant' and reservation.applied_scope = 'tenant'))
    and (reservation.policy_id, reservation.policy_revision,
      reservation.assignment_id, reservation.assignment_revision)
      is distinct from (p_policy_id, p_policy_revision, p_assignment_id, p_assignment_revision);
  insert into vortex_access.capability_reservation_balances (
    balance_id, tenant_id, organization_id, capability_key, unit,
    policy_id, policy_revision, assignment_id, assignment_revision,
    policy_quantity_limit, active_reserved_quantity, consumed_quantity,
    released_quantity, updated_at
  ) values (
    pg_catalog.gen_random_uuid(), p_tenant_id, p_assignment_organization_id,
    p_capability_key, p_unit, p_policy_id, p_policy_revision, p_assignment_id,
    p_assignment_revision, p_quantity_limit, 0, 0, 0, p_evaluated_at
  ) on conflict do nothing;
  perform 1 from vortex_access.capability_reservation_balances as balance
  where balance.tenant_id = p_tenant_id
    and balance.organization_id is not distinct from p_assignment_organization_id
    and balance.capability_key = p_capability_key and balance.unit = p_unit
  for update;
  select
    coalesce(sum(case when reservation.state = 'active'
      then reservation.reserved_quantity - reservation.consumed_quantity
        - reservation.released_quantity else 0 end), 0),
    coalesce(sum(reservation.consumed_quantity), 0),
    coalesce(sum(reservation.released_quantity), 0)
  into active_reserved, consumed, released
  from vortex_access.capability_reservations as reservation
  where reservation.tenant_id = p_tenant_id
    and reservation.capability_key = p_capability_key and reservation.unit = p_unit
    and (p_applied_scope = 'tenant'
      or reservation.request_organization_id
        is not distinct from p_assignment_organization_id);
  update vortex_access.capability_reservation_balances as balance
  set policy_id = p_policy_id, policy_revision = p_policy_revision,
      assignment_id = p_assignment_id, assignment_revision = p_assignment_revision,
      policy_quantity_limit = p_quantity_limit,
      active_reserved_quantity = active_reserved, consumed_quantity = consumed,
      released_quantity = released, updated_at = p_evaluated_at
  where balance.tenant_id = p_tenant_id
    and balance.organization_id is not distinct from p_assignment_organization_id
    and balance.capability_key = p_capability_key and balance.unit = p_unit;
  if p_applied_scope = 'organization' then
    -- An organisation is also bounded by the tenant-wide balance, whose limit
    -- is the lower of the platform ceiling and the tenant allocation.
    select bound.policy_id, bound.policy_revision, bound.assignment_id,
      bound.assignment_revision, bound.quantity_limit
    into tenant_bound
    from vortex_access.capability_limit_bounds_internal(
      p_tenant_id, null::uuid, p_capability_key, p_unit, p_evaluated_at, true
    ) as bound
    where bound.applied_scope = 'tenant'
    order by bound.quantity_limit, bound.precedence
    limit 1;
    if not found then
      return query select p_quantity_limit, active_reserved, consumed, released,
        0::numeric;
      return;
    end if;
    select refreshed.* into strict tenant_balance
    from vortex_access.refresh_capability_reservation_balance(
      p_tenant_id, null::uuid, p_capability_key, p_unit, 'tenant'::text,
      null::uuid, tenant_bound.policy_id, tenant_bound.policy_revision,
      tenant_bound.assignment_id, tenant_bound.assignment_revision,
      tenant_bound.quantity_limit, p_evaluated_at
    ) as refreshed;
    return query select p_quantity_limit, active_reserved, consumed, released,
      least(greatest(0::numeric, p_quantity_limit - active_reserved - consumed),
        tenant_balance.available_quantity);
    return;
  end if;
  return query select p_quantity_limit, active_reserved, consumed, released,
    greatest(0::numeric, p_quantity_limit - active_reserved - consumed);
end
$function$;

revoke execute on function vortex_access.refresh_capability_reservation_balance(
  uuid, uuid, text, text, text, uuid, uuid, bigint, uuid, bigint, numeric, timestamptz
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_access.refresh_capability_reservation_balance(
  uuid, uuid, text, text, text, uuid, uuid, bigint, uuid, bigint, numeric, timestamptz
) is
  'Rebuilds tenant-aggregate or organisation-local balance evidence using one scope rule for active, consumed and released totals; an organisation is also bounded by the tenant-wide balance under the lower of the platform ceiling and the tenant allocation.';

comment on table vortex_access.capability_policy_assignments is
  'Protected capability limits: one platform-operator ceiling per tenant capability pinned to an exact policy revision, and tenant-administrator allocations for the tenant or one organisation that can only narrow it.';
comment on table vortex_access.capability_limit_changes is
  'Append-only evidence of every capability policy publication, ceiling change and allocation change, with its actor, scope, quantity and correlation; it grants no data access.';

commit;
