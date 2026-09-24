-- #833: Keep organisation capability limits within the tenant's limits.
--
-- Five defects, one invariant: the tenant assignment sets the limit, an
-- organisation assignment can only lower it, and every reserve, consume,
-- release and read agrees on the same available quantity.
--
-- 1. Resolution preferred any organisation assignment over the tenant
--    assignment, so an organisation administrator could pin a wider policy
--    revision (or remove a restrictive one) and exceed the tenant's limit.
--    Resolution now requires a live tenant assignment and takes the lower of
--    the tenant and organisation limits; the organisation scope wins only when
--    it is not wider. Both `resolve_effective_capability_policy` (the read
--    path) and `lock_effective_capability_policy` (the reservation path) apply
--    the same rule.
-- 2. `refresh_capability_reservation_balance` summed active, consumed and
--    released quantities under a scope that, for a tenant balance, also
--    included every organisation-scoped reservation. The sums now select on
--    the reservation's own `applied_scope`, so a tenant balance counts only
--    tenant-scoped reservations and an organisation balance only that
--    organisation's organisation-scoped reservations.
-- 3. The balance and reservation quantity constraints required every running
--    total to survive a float8 round-trip (`x = x::float8::numeric`). Past
--    about 15 significant digits any accepted byte count made every later
--    reserve, consume, release and read fail with 23514. The round-trip checks
--    are removed from the running totals; the stored policy limit and a single
--    reserved quantity must still be exactly float8-representable, so no reader
--    ever rounds a limit it cannot represent.
-- 4. `release_capability_reservation` recomputed the balance with its own sums
--    and selected the balance row by assignment, so its replayable result could
--    hold a different `availableQuantity` than reserve, consume and read. It now
--    calls `refresh_capability_reservation_balance`, the one canonical balance
--    computation.
-- 5. `publish_capability_policy_definition`, `assign_capability_policy` and
--    `capability_reservation_request_context` locked the tenant row `FOR UPDATE`,
--    which conflicts with the `FOR KEY SHARE` locks every foreign key that
--    references the tenant needs. They lock it `FOR NO KEY UPDATE` instead, so
--    metering and organisation inserts no longer block on a reservation.
--
-- Scope: the capability policy and reservation functions only. Capability keys,
-- policy contents and metering events are unchanged. The live bodies are patched
-- in place from `pg_get_functiondef`: each reviewed fragment must occur exactly
-- once or the migration aborts, and each function is re-created under its own
-- current owner so its OID, grants, comment, security and search_path stay put.

begin;

-- 3. Running totals are exact numerics; only a stored limit must survive the
--    double-precision contract exactly.
alter table vortex_access.capability_reservation_balances
  drop constraint capability_reservation_balances_quantities_valid;
alter table vortex_access.capability_reservation_balances
  add constraint capability_reservation_balances_quantities_valid check (
    vortex_access.capability_policy_quantity_is_valid(policy_quantity_limit)
    and active_reserved_quantity >= 0
    and consumed_quantity >= 0
    and released_quantity >= 0
  );

alter table vortex_access.capability_reservations
  drop constraint capability_reservations_quantities_valid;
alter table vortex_access.capability_reservations
  add constraint capability_reservations_quantities_valid check (
    vortex_access.capability_policy_quantity_is_valid(policy_quantity_limit)
    and vortex_access.capability_policy_quantity_is_valid(reserved_quantity)
    and consumed_quantity >= 0
    and released_quantity >= 0
    and consumed_quantity + released_quantity <= reserved_quantity
  );

do $migration$
declare
  target record;
  patch jsonb;
  old_text text;
  definition text;
  owner_name name;
begin
  for target in
    select candidate.procedure_id, candidate.patches
    from (values
      -- 5. Tenant lock no longer conflicts with foreign-key checks.
      ('vortex_access.publish_capability_policy_definition(uuid,uuid,uuid,uuid,text,text,numeric,bigint)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(
            $frag$perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for update;$frag$,
            $frag$perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for no key update;$frag$)
        )),
      ('vortex_access.assign_capability_policy(uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint,timestamptz,timestamptz,uuid)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(
            $frag$perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for update;$frag$,
            $frag$perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for no key update;$frag$)
        )),
      ('vortex_access.capability_reservation_request_context(uuid,uuid)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(
            $frag$where tenant.tenant_id = p_tenant_id for update;$frag$,
            $frag$where tenant.tenant_id = p_tenant_id for no key update;$frag$)
        )),
      -- 1. The read path takes the lower of the tenant and organisation limits,
      --    and a capability is unassigned unless the tenant assignment exists.
      ('vortex_access.resolve_effective_capability_policy(uuid,uuid,text,text)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(
            $frag$order by candidates.priority, candidates.assignment_id limit 1;$frag$,
            $frag$where exists (select 1 from candidates as tenant_bound where tenant_bound.priority = 1)
  order by candidates.quantity_limit, candidates.priority, candidates.assignment_id limit 1;$frag$)
        )),
      -- 1 and 5. The reservation path resolves the tenant assignment first, then
      --    applies an organisation assignment only when it is not wider.
      ('vortex_access.lock_effective_capability_policy(uuid,uuid,text,text,timestamptz)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(
            $frag$  protected_context record;
  selected record;
begin$frag$,
            $frag$  protected_context record;
  selected record;
  selected_organization record;
begin$frag$),
          pg_catalog.jsonb_build_array(
            $frag$  if protected_context.request_organization_id is not null then
    select 'organization'::text as applied_scope,
      assignment.organization_id as assignment_organization_id,
      assignment.policy_id, assignment.policy_revision, assignment.assignment_id,
      assignment.revision as assignment_revision, definition.quantity_limit,
      assignment.expires_at
    into selected
    from vortex_access.capability_policy_assignments as assignment
    join vortex_access.capability_policy_definitions as definition
      on definition.tenant_id = assignment.tenant_id
      and definition.policy_id = assignment.policy_id
      and definition.revision = assignment.policy_revision
    where assignment.tenant_id = p_tenant_id
      and assignment.organization_id = protected_context.request_organization_id
      and assignment.capability_key = p_capability_key and assignment.unit = p_unit
      and assignment.revoked_at is null and assignment.starts_at <= p_evaluated_at
      and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
    order by assignment.assignment_id limit 1 for update of assignment;
  end if;
  if selected.assignment_id is null then
    select 'tenant'::text as applied_scope,
      assignment.organization_id as assignment_organization_id,
      assignment.policy_id, assignment.policy_revision, assignment.assignment_id,
      assignment.revision as assignment_revision, definition.quantity_limit,
      assignment.expires_at
    into selected
    from vortex_access.capability_policy_assignments as assignment
    join vortex_access.capability_policy_definitions as definition
      on definition.tenant_id = assignment.tenant_id
      and definition.policy_id = assignment.policy_id
      and definition.revision = assignment.policy_revision
    where assignment.tenant_id = p_tenant_id and assignment.organization_id is null
      and assignment.capability_key = p_capability_key and assignment.unit = p_unit
      and assignment.revoked_at is null and assignment.starts_at <= p_evaluated_at
      and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
    order by assignment.assignment_id limit 1 for update of assignment;
  end if;
  if selected.assignment_id is null then return; end if;$frag$,
            $frag$  select 'tenant'::text as applied_scope,
    assignment.organization_id as assignment_organization_id,
    assignment.policy_id, assignment.policy_revision, assignment.assignment_id,
    assignment.revision as assignment_revision, definition.quantity_limit,
    assignment.expires_at
  into selected
  from vortex_access.capability_policy_assignments as assignment
  join vortex_access.capability_policy_definitions as definition
    on definition.tenant_id = assignment.tenant_id
    and definition.policy_id = assignment.policy_id
    and definition.revision = assignment.policy_revision
  where assignment.tenant_id = p_tenant_id and assignment.organization_id is null
    and assignment.capability_key = p_capability_key and assignment.unit = p_unit
    and assignment.revoked_at is null and assignment.starts_at <= p_evaluated_at
    and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
  order by assignment.assignment_id limit 1 for update of assignment;
  if not found then return; end if;
  if protected_context.request_organization_id is not null then
    select 'organization'::text as applied_scope,
      assignment.organization_id as assignment_organization_id,
      assignment.policy_id, assignment.policy_revision, assignment.assignment_id,
      assignment.revision as assignment_revision, definition.quantity_limit,
      assignment.expires_at
    into selected_organization
    from vortex_access.capability_policy_assignments as assignment
    join vortex_access.capability_policy_definitions as definition
      on definition.tenant_id = assignment.tenant_id
      and definition.policy_id = assignment.policy_id
      and definition.revision = assignment.policy_revision
    where assignment.tenant_id = p_tenant_id
      and assignment.organization_id = protected_context.request_organization_id
      and assignment.capability_key = p_capability_key and assignment.unit = p_unit
      and assignment.revoked_at is null and assignment.starts_at <= p_evaluated_at
      and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
      and definition.quantity_limit <= selected.quantity_limit
    order by assignment.assignment_id limit 1 for update of assignment;
    if found then
      selected := selected_organization;
    end if;
  end if;$frag$)
        )),
      -- 2. One `applied_scope` rule for active, consumed and released sums.
      ('vortex_access.refresh_capability_reservation_balance(uuid,uuid,text,text,text,uuid,uuid,bigint,uuid,bigint,numeric,timestamptz)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(
            $frag$  where reservation.tenant_id = p_tenant_id
    and reservation.capability_key = p_capability_key and reservation.unit = p_unit
    and (p_applied_scope = 'tenant'
      or reservation.request_organization_id
        is not distinct from p_assignment_organization_id);$frag$,
            $frag$  where reservation.tenant_id = p_tenant_id
    and reservation.capability_key = p_capability_key and reservation.unit = p_unit
    and reservation.applied_scope = p_applied_scope
    and (p_applied_scope = 'tenant'
      or reservation.request_organization_id
        is not distinct from p_assignment_organization_id);$frag$)
        )),
      -- 4. Release uses the canonical balance refresh instead of its own sums.
      ('vortex_access.release_capability_reservation(uuid,uuid,text,text,uuid,bigint,uuid,bigint,uuid,uuid,numeric)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(
            $frag$  new_state text;
  active_reserved numeric;
  consumed numeric;
  released numeric;
  available numeric;
  safe_result jsonb;$frag$,
            $frag$  new_state text;
  balance record;
  safe_result jsonb;$frag$),
          pg_catalog.jsonb_build_array(
            $frag$  select
    coalesce(sum(case when reservation.state = 'active'
      then reservation.reserved_quantity - reservation.consumed_quantity
        - reservation.released_quantity else 0 end), 0),
    coalesce(sum(reservation.consumed_quantity), 0),
    coalesce(sum(reservation.released_quantity), 0)
  into active_reserved, consumed, released
  from vortex_access.capability_reservations as reservation
  where reservation.tenant_id = target.tenant_id
    and reservation.capability_key = target.capability_key and reservation.unit = target.unit
    and (target.applied_scope = 'tenant'
      or reservation.request_organization_id is not distinct from target.request_organization_id);
  available := greatest(0::numeric, target.policy_quantity_limit - active_reserved - consumed);
  update vortex_access.capability_reservation_balances as balance
  set active_reserved_quantity = active_reserved, consumed_quantity = consumed,
      released_quantity = released, updated_at = evaluated_at
  where balance.tenant_id = target.tenant_id
    and balance.capability_key = target.capability_key and balance.unit = target.unit
    and balance.assignment_id = target.assignment_id;$frag$,
            $frag$  select refreshed.* into strict balance
  from vortex_access.refresh_capability_reservation_balance(
    target.tenant_id, target.request_organization_id, target.capability_key, target.unit,
    target.applied_scope,
    case when target.applied_scope = 'organization'
      then target.request_organization_id else null::uuid end,
    target.policy_id, target.policy_revision, target.assignment_id,
    target.assignment_revision, target.policy_quantity_limit, evaluated_at
  ) as refreshed;$frag$),
          pg_catalog.jsonb_build_array(
            $frag$    'balance', pg_catalog.jsonb_build_object(
      'policyLimit', target.policy_quantity_limit::text,
      'activeReservedQuantity', active_reserved::text,
      'consumedQuantity', consumed::text, 'releasedQuantity', released::text,
      'availableQuantity', available::text)$frag$,
            $frag$    'balance', pg_catalog.jsonb_build_object(
      'policyLimit', balance.policy_quantity_limit::text,
      'activeReservedQuantity', balance.active_reserved_quantity::text,
      'consumedQuantity', balance.consumed_quantity::text,
      'releasedQuantity', balance.released_quantity::text,
      'availableQuantity', balance.available_quantity::text)$frag$)
        ))
    ) as candidate(procedure_id, patches)
  loop
    definition := pg_catalog.pg_get_functiondef(target.procedure_id);
    for patch in select value from pg_catalog.jsonb_array_elements(target.patches)
    loop
      old_text := patch ->> 0;
      if (pg_catalog.length(definition)
          - pg_catalog.length(pg_catalog.replace(definition, old_text, '')))
          <> pg_catalog.length(old_text) then
        raise exception using errcode = '55000',
          message = 'Capability limit patch does not match exactly once',
          detail = target.procedure_id::text || ': ' || old_text;
      end if;
      definition := pg_catalog.replace(definition, old_text, patch ->> 1);
    end loop;

    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = target.procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    reset role;
  end loop;
end
$migration$;

comment on function vortex_access.resolve_effective_capability_policy(uuid, uuid, text, text) is
  'Returns the lower of the live tenant and organisation policy limits for the established request scope; an organisation assignment can only narrow the tenant limit.';
comment on function vortex_access.lock_effective_capability_policy(uuid, uuid, text, text, timestamptz) is
  'Locks the live tenant policy and, only when it is not wider, the organisation policy, then returns the lower effective limit.';
comment on function vortex_access.refresh_capability_reservation_balance(
  uuid, uuid, text, text, text, uuid, uuid, bigint, uuid, bigint, numeric, timestamptz
) is
  'Rebuilds one balance row from reservations in the same applied scope; active, consumed and released totals share one scope rule.';
comment on function vortex_access.release_capability_reservation(
  uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, uuid, numeric
) is
  'Releases an exact unexpired reservation and records the canonical refreshed balance in its immutable duplicate-protected outcome.';

commit;
