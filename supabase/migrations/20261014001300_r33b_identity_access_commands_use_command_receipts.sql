-- R3.3b (#2238): move the Identity and Access command receipts onto vortex_record.command_receipts.
--
-- vortex_identity.accepted_administration_receipts, vortex_identity.vortex_super_administrator_assignment_receipts
-- and vortex_access.capability_reservation_commands were idempotency records only. Each command now claims its
-- command id in vortex_record.command_receipts (organisation, tenant, actor and its own command kind) and stores its
-- result there; a replay returns the stored result only inside the scope and kind that stored it. The three tables,
-- the super-administrator receipt immutability trigger and the setup manifest foreign key are removed.
-- vortex_identity.identity_disablement_commands (a resumable disablement state machine read by
-- identity_is_disabled and referenced by identity_disablement_events) and
-- vortex_access.record_share_grant_consent_requests (the pending or withdrawn consent request of a share grant)
-- are product state and stay. There is no production data, so the old tables are dropped without a carry-over.

-- The Record adapter owns the receipt table and the functions that touch it.
set local role vortex_record_adapter;
alter table vortex_record.command_receipts drop constraint command_receipts_kind_valid;
alter table vortex_record.command_receipts add constraint command_receipts_kind_valid
  check (command_kind ~ '^[a-z][a-z0-9_.]*$' and pg_catalog.char_length(command_kind) <= 160);

create or replace function vortex_record.claim_scoped_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid,
  p_organization_id uuid,
  p_tenant_id uuid,
  p_actor_id uuid,
  p_conflict_message text,
  p_conflict_errcode text default 'V3001'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  inserted_command_id uuid;
  receipt vortex_record.command_receipts%rowtype;
begin
  -- Claims the command id for the scope the caller names (an organisation command sets
  -- organisation, tenant and actor; a tenant command sets the tenant; a platform command sets
  -- neither organisation nor tenant). The caller completes the receipt in the same transaction.
  insert into vortex_record.command_receipts (
    command_id, organization_id, tenant_id, actor_id, command_kind
  ) values (
    p_command_id, p_organization_id, p_tenant_id, p_actor_id, p_command_kind
  )
  on conflict (command_id) do nothing
  returning command_id into inserted_command_id;
  if inserted_command_id is not null then
    return null;
  end if;
  select stored.* into receipt
  from vortex_record.command_receipts as stored
  where stored.command_id = p_command_id
  for update;
  if not found then
    raise exception using errcode = '40001',
      message = 'Command receipt was released while it was claimed';
  end if;
  -- A command id replays only inside the scope and kind that stored it.
  if receipt.organization_id is distinct from p_organization_id
    or receipt.tenant_id is distinct from p_tenant_id
    or receipt.actor_id is distinct from p_actor_id
    or receipt.command_kind is distinct from p_command_kind then
    raise exception using errcode = p_conflict_errcode, message = p_conflict_message;
  end if;
  if receipt.result is null then
    raise exception using errcode = '40001', message = 'Command receipt is still pending';
  end if;
  return receipt.result;
end
$function$;

alter function vortex_record.claim_scoped_command_receipt_internal(text,uuid,uuid,uuid,uuid,text,text) owner to vortex_record_adapter;

revoke all on function vortex_record.claim_scoped_command_receipt_internal(
  text, uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_record.claim_scoped_command_receipt_internal(
  text, uuid, uuid, uuid, uuid, text, text
) to vortex_owner, postgres;

comment on function vortex_record.claim_scoped_command_receipt_internal(
  text, uuid, uuid, uuid, uuid, text, text
) is
  'Claims a command id for an explicit organisation, tenant and actor scope (used by Identity and Access commands, which run outside a Record request). Returns null for a new claim, the stored result for a replay inside the same organisation, tenant, actor and command kind, and raises the caller''s error code (V3001 unless the caller names another) with the caller''s message when the id was stored under another scope or kind.';

create or replace function vortex_record.command_receipt_subject_exists_internal(
  p_command_kind text,
  p_tenant_id uuid,
  p_subject_id uuid,
  p_excluding_command_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  -- True when a completed receipt of this command kind exists, optionally narrowed to one tenant
  -- (null tenant matches any) and to a receipt whose result names the subject id (null subject
  -- matches any), leaving out the receipt of the command that is asking.
  select exists (
    select 1
    from vortex_record.command_receipts as stored
    where stored.command_kind = p_command_kind
      and stored.result is not null
      and stored.command_id is distinct from p_excluding_command_id
      and (p_tenant_id is null or stored.tenant_id = p_tenant_id)
      and (
        p_subject_id is null
        or stored.result -> 'subjectIds' @> pg_catalog.to_jsonb(array[p_subject_id])
      )
  )
$function$;

alter function vortex_record.command_receipt_subject_exists_internal(text,uuid,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.command_receipt_subject_exists_internal(text, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_record.command_receipt_subject_exists_internal(text, uuid, uuid, uuid)
  to vortex_owner, postgres;

comment on function vortex_record.command_receipt_subject_exists_internal(text, uuid, uuid, uuid) is
  'True when a completed receipt of one command kind exists, optionally for one tenant and naming one subject id in its result, ignoring the receipt of the asking command. Identity administration commands use it to tell whether a tenant or organisation was already adopted or provisioned.';

create or replace function vortex_record.complete_scoped_command_receipt_internal(
  p_command_id uuid,
  p_result jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  update vortex_record.command_receipts as stored
  set result = p_result
  where stored.command_id = p_command_id
    and stored.result is null;
  if not found then
    raise exception using errcode = '40001', message = 'Command receipt is not pending';
  end if;
end
$function$;

alter function vortex_record.complete_scoped_command_receipt_internal(uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.complete_scoped_command_receipt_internal(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_record.complete_scoped_command_receipt_internal(uuid, jsonb)
  to vortex_owner, postgres;

comment on function vortex_record.complete_scoped_command_receipt_internal(uuid, jsonb) is
  'Stores the result of the command this transaction claimed through claim_scoped_command_receipt_internal, or raises a 40001 error when no pending receipt is left.';

create or replace function vortex_record.read_command_receipt_by_receipt_id_internal(
  p_command_kind text,
  p_receipt_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  receipt vortex_record.command_receipts%rowtype;
begin
  -- Finds a completed receipt of one command kind by the receipt id (correlation id) that its
  -- result stores, which is not the command id. Returns null when none matches.
  select stored.* into receipt
  from vortex_record.command_receipts as stored
  where stored.command_kind = p_command_kind
    and stored.result is not null
    and stored.result ->> 'receiptId' = p_receipt_id::text
  order by stored.command_id
  limit 1;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'tenantId', receipt.tenant_id,
    'actorId', receipt.actor_id,
    'result', receipt.result
  );
end
$function$;

alter function vortex_record.read_command_receipt_by_receipt_id_internal(text,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_command_receipt_by_receipt_id_internal(text, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_record.read_command_receipt_by_receipt_id_internal(text, uuid)
  to vortex_owner, postgres;

comment on function vortex_record.read_command_receipt_by_receipt_id_internal(text, uuid) is
  'Reads a completed command receipt of one command kind by the receipt id stored in its result (the correlation id of the original command), returning its tenant, actor and result as jsonb, or null when no receipt matches.';

reset role;

create or replace function vortex_access.close_organization_account_for_administration(
  p_duplicate_key uuid, p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, operation text, organization_id uuid,
  organization_account_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz, access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  stored record; claimed jsonb;
  target record; changed record; command_fingerprint text;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account closure command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'close_organization_account',
      scope.organization_id::text, p_organization_account_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'close_organization_account', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(stored."subjectIds") <> 2
      or not scope.organization_id = any(stored."subjectIds")
      or not p_organization_account_id = any(stored."subjectIds") then
      raise exception using errcode = '42501', message = 'Account closure receipt is unavailable';
    end if;
    return query select 'replayed'::text, 'close_organization_account'::text,
      scope.organization_id, p_organization_account_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", p_organization_account_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found or target.state not in ('active', 'suspended')
    or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account closure is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'closed'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'closed' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account closure result is unavailable';
  end if;
  if scope.organization_id < p_organization_account_id then
    subject_ids := array[scope.organization_id, p_organization_account_id];
    subject_revisions := array[changed.access_version, changed.revision];
  else
    subject_ids := array[p_organization_account_id, scope.organization_id];
    subject_revisions := array[changed.revision, changed.access_version];
  end if;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', changed.state_change_correlation_id,
      'acceptedAt', changed.changed_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions),
      'fingerprint', command_fingerprint, 'clusterId', null));
  return query select 'accepted'::text, 'close_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

comment on function vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected active-or-suspended-to-closed account command; closure is not deletion.';

revoke execute on function
  vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.close_organization_account_for_administration(uuid, uuid, bigint) to vortex_request;

CREATE OR REPLACE FUNCTION vortex_access.consume_capability_reservation(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_reservation_id uuid, p_quantity numeric, p_duplicate_key uuid) RETURNS TABLE(result jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  effective record;
  protected_context record;
  target vortex_access.capability_reservations%rowtype;
  balance record;
  claimed jsonb;
  request_actor_id uuid;
  command_fingerprint text;
  remaining numeric;
  new_consumed numeric;
  new_remaining numeric;
  new_state text;
  safe_result jsonb;
  refusal_reason text;
begin
  if not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_policy_id is null or not vortex_platform.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision not between 1 and 9007199254740991
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
    or p_assignment_revision not between 1 and 9007199254740991
    or p_reservation_id is null or not vortex_platform.is_non_nil_uuid(p_reservation_id::text)
    or not vortex_access.capability_policy_quantity_is_valid(p_quantity)
    or p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text) then
    raise exception using errcode = '22023', message = 'Capability consumption command is invalid';
  end if;
  select locked.* into effective
  from vortex_access.lock_effective_capability_policy(
    p_tenant_id, p_organization_id, p_capability_key, p_unit, evaluated_at
  ) as locked;
  if effective.correlation_id is null then
    select context.* into strict protected_context
    from vortex_access.capability_reservation_request_context(
      p_tenant_id, p_organization_id
    ) as context;
  else
    protected_context := effective;
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'consume_capability_reservation', p_tenant_id::text,
      coalesce(protected_context.request_organization_id::text, ''),
      p_capability_key, p_unit, p_policy_id::text, p_policy_revision::text,
      p_assignment_id::text, p_assignment_revision::text,
      p_reservation_id::text, p_quantity::text), 'UTF8'), 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f', p_tenant_id::text,
      coalesce(protected_context.request_organization_id::text, ''),
      p_duplicate_key::text), 650)
  );
  request_actor_id := coalesce(
    vortex_platform.current_context() ->> 'organizationAccountId',
    vortex_platform.current_context() ->> 'systemActorId'
  )::uuid;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'capability_consume', p_duplicate_key, protected_context.request_organization_id,
    p_tenant_id, request_actor_id, 'Capability consumption duplicate conflicts'
  );
  if claimed is not null then
    if claimed ->> 'fingerprint' <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Capability consumption duplicate conflicts';
    end if;
    return query select pg_catalog.jsonb_set(
      claimed - 'fingerprint', '{status}', '"replayed"'::jsonb, false
    );
    return;
  end if;
  select reservation.* into target
  from vortex_access.capability_reservations as reservation
  where reservation.reservation_id = p_reservation_id for update;
  if not found
    or target.tenant_id <> p_tenant_id
    or target.request_organization_id is distinct from protected_context.request_organization_id
    or target.capability_key <> p_capability_key or target.unit <> p_unit
    or target.policy_id <> p_policy_id or target.policy_revision <> p_policy_revision
    or target.assignment_id <> p_assignment_id
    or target.assignment_revision <> p_assignment_revision then
    refusal_reason := 'reservation_unavailable';
  elsif target.state <> 'active' or target.expires_at <= evaluated_at then
    if target.state = 'active' then
      update vortex_access.capability_reservations as reservation
      set state = 'expired', expired_at = evaluated_at, updated_at = evaluated_at
      where reservation.reservation_id = p_reservation_id;
    end if;
    refusal_reason := 'reservation_stale';
  elsif effective.assignment_id is null
    or effective.policy_id <> target.policy_id
    or effective.policy_revision <> target.policy_revision
    or effective.assignment_id <> target.assignment_id
    or effective.assignment_revision <> target.assignment_revision
    or effective.applied_scope <> target.applied_scope then
    update vortex_access.capability_reservations as reservation
    set state = 'expired', expired_at = evaluated_at, updated_at = evaluated_at
    where reservation.reservation_id = p_reservation_id;
    refusal_reason := 'reservation_stale';
  else
    remaining := target.reserved_quantity - target.consumed_quantity - target.released_quantity;
    if p_quantity > remaining then refusal_reason := 'insufficient_reserved_quantity'; end if;
  end if;
  if refusal_reason is not null then
    safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'status', 'accepted', 'reservationId', p_reservation_id,
      'tenantId', p_tenant_id,
      'organizationId', protected_context.request_organization_id,
      'capabilityKey', p_capability_key, 'unit', p_unit,
      'reasonCode', refusal_reason,
      'decidedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'correlationId', protected_context.correlation_id
    ));
    perform vortex_record.complete_scoped_command_receipt_internal(
      p_duplicate_key,
      safe_result || pg_catalog.jsonb_build_object('fingerprint', command_fingerprint)
    );
    return query select safe_result;
    return;
  end if;
  new_consumed := target.consumed_quantity + p_quantity;
  new_remaining := remaining - p_quantity;
  new_state := case when new_remaining = 0 then 'consumed' else 'active' end;
  update vortex_access.capability_reservations as reservation
  set consumed_quantity = new_consumed, state = new_state,
      consumed_at = evaluated_at, updated_at = evaluated_at
  where reservation.reservation_id = p_reservation_id;
  select refreshed.* into strict balance
  from vortex_access.refresh_capability_reservation_balance(
    p_tenant_id, effective.request_organization_id, p_capability_key, p_unit,
    effective.applied_scope, effective.assignment_organization_id,
    effective.policy_id, effective.policy_revision, effective.assignment_id,
    effective.assignment_revision, effective.quantity_limit, evaluated_at
  ) as refreshed;
  safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'outcome', 'consumed', 'status', 'accepted', 'reservationId', p_reservation_id,
    'tenantId', p_tenant_id, 'organizationId', effective.request_organization_id,
    'capabilityKey', p_capability_key, 'unit', p_unit,
    'policyId', target.policy_id, 'policyRevision', target.policy_revision,
    'assignmentId', target.assignment_id,
    'assignmentRevision', target.assignment_revision,
    'appliedScope', target.applied_scope, 'consumedAmount', p_quantity::text,
    'totalConsumedQuantity', new_consumed::text,
    'remainingReservedQuantity', new_remaining::text,
    'reservationState', new_state,
    'consumedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'correlationId', effective.correlation_id,
    'balance', pg_catalog.jsonb_build_object(
      'policyLimit', balance.policy_quantity_limit::text,
      'activeReservedQuantity', balance.active_reserved_quantity::text,
      'consumedQuantity', balance.consumed_quantity::text,
      'releasedQuantity', balance.released_quantity::text,
      'availableQuantity', balance.available_quantity::text)
  ));
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    safe_result || pg_catalog.jsonb_build_object('fingerprint', command_fingerprint)
  );
  return query select safe_result;
end
$$;

ALTER FUNCTION vortex_access.consume_capability_reservation(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_reservation_id uuid, p_quantity numeric, p_duplicate_key uuid) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.consume_capability_reservation(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_reservation_id uuid, p_quantity numeric, p_duplicate_key uuid) IS 'Consumes only a current exact unexpired reservation and records immutable duplicate-protected outcomes.';

REVOKE ALL ON FUNCTION vortex_access.consume_capability_reservation(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_reservation_id uuid, p_quantity numeric, p_duplicate_key uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.consume_capability_reservation(p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text, p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid, p_assignment_revision bigint, p_reservation_id uuid, p_quantity numeric, p_duplicate_key uuid) TO vortex_request;

CREATE OR REPLACE FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_token_fingerprint text, p_expires_at timestamp with time zone) RETURNS TABLE(outcome text, operation text, organization_id uuid, invitation_id uuid, revision bigint, correlation_id uuid, accepted_at timestamp with time zone, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  scope record;
  stored record; claimed jsonb;
  new_receipt_id uuid; new_accepted_at timestamptz;
  created record; command_fingerprint text; target_invitation_id uuid;
  subject_ids uuid[]; subject_revisions bigint[];
  operation_at timestamptz;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_invited_email is null
    or p_invited_email <> pg_catalog.lower(pg_catalog.btrim(p_invited_email))
    or pg_catalog.char_length(p_invited_email) not between 3 and 320
    or p_invited_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
    or p_token_fingerprint is null
    or p_token_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_expires_at is null
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz) then
    raise exception using errcode = '22023', message = 'Invitation creation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'create_organization_invitation',
      scope.organization_id::text, p_invited_email, p_expires_at::text), 'UTF8'),
      'sha256'), 'hex');
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'create_organization_invitation', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(stored."subjectIds") <> 2
      or not scope.organization_id = any(stored."subjectIds") then
      raise exception using errcode = '42501', message = 'Invitation creation receipt is unavailable';
    end if;
    target_invitation_id := case when stored."subjectIds"[1] = scope.organization_id
      then stored."subjectIds"[2] else stored."subjectIds"[1] end;
    return query select 'replayed'::text, 'create_organization_invitation'::text,
      scope.organization_id, target_invitation_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", target_invitation_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at <= operation_at then
    raise exception using errcode = '40001', message = 'Invitation creation is stale or unavailable';
  end if;
  select result.* into strict created
  from vortex_identity.create_organization_invitation(
    p_invited_email, p_token_fingerprint, p_expires_at
  ) as result;
  if created.organization_id <> scope.organization_id or created.revision <> 1
    or created.invited_email <> p_invited_email or created.expires_at <> p_expires_at
    or created.invited_by <> scope.organization_account_id then
    raise exception using errcode = '42501', message = 'Invitation creation result is unavailable';
  end if;
  if scope.organization_id < created.invitation_id then
    subject_ids := array[scope.organization_id, created.invitation_id];
    subject_revisions := array[scope.access_version, created.revision];
  else
    subject_ids := array[created.invitation_id, scope.organization_id];
    subject_revisions := array[created.revision, scope.access_version];
  end if;
  new_receipt_id := (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
  new_accepted_at := created.created_at;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', new_accepted_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions),
      'fingerprint', command_fingerprint, 'clusterId', null));
  return query select 'accepted'::text, 'create_organization_invitation'::text,
    scope.organization_id, created.invitation_id, created.revision,
    new_receipt_id, new_accepted_at, scope.access_version;
end
$_$;

ALTER FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_token_fingerprint text, p_expires_at timestamp with time zone) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_token_fingerprint text, p_expires_at timestamp with time zone) IS 'Protected no-intent invitation creation; replay returns receipt evidence and never secret material.';

REVOKE ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_token_fingerprint text, p_expires_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.create_organization_invitation_for_administration(p_duplicate_key uuid, p_invited_email text, p_token_fingerprint text, p_expires_at timestamp with time zone) TO vortex_request;

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
  stored record; claimed jsonb;
  command_fingerprint text;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_policy_id is null or not vortex_platform.is_non_nil_uuid(p_policy_id::text)
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
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'publish_capability_policy_definition', p_duplicate_key, null,
    p_tenant_id, p_operator_actor_id, 'Capability policy duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint
      or stored."subjectIds" <> array[p_policy_id]
      or pg_catalog.cardinality(stored."subjectRevisions") <> 1 then
      raise exception using errcode = 'V3001', message = 'Capability policy duplicate conflicts';
    end if;
    return query
      select 'replayed'::text, definition.policy_id, definition.tenant_id,
        definition.capability_key, definition.unit, definition.quantity_limit,
        definition.revision, stored."receiptId", stored."acceptedAt"
      from vortex_access.capability_policy_definitions as definition
      where definition.policy_id = p_policy_id
        and definition.revision = stored."subjectRevisions"[1];
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
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', correlation,
      'acceptedAt', evaluated_at, 'subjectIds', pg_catalog.to_jsonb(array[p_policy_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', command_fingerprint, 'clusterId', null));
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
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.publish_capability_policy_definition(
  uuid, uuid, uuid, uuid, text, text, numeric, bigint
) to vortex_runtime;

comment on function vortex_access.publish_capability_policy_definition(
  uuid, uuid, uuid, uuid, text, text, numeric, bigint
) is
  'Platform-operator-only capability policy publication for one tenant: an immutable revision with an accepted receipt and append-only change evidence.';

create or replace function vortex_access.reactivate_organization_account_for_administration(
  p_duplicate_key uuid, p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, operation text, organization_id uuid,
  organization_account_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz, access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  stored record; claimed jsonb;
  target record; changed record; command_fingerprint text;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account reactivation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'reactivate_organization_account',
      scope.organization_id::text, p_organization_account_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'reactivate_organization_account', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(stored."subjectIds") <> 2
      or not scope.organization_id = any(stored."subjectIds")
      or not p_organization_account_id = any(stored."subjectIds") then
      raise exception using errcode = '42501', message = 'Account reactivation receipt is unavailable';
    end if;
    return query select 'replayed'::text, 'reactivate_organization_account'::text,
      scope.organization_id, p_organization_account_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", p_organization_account_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found or target.state not in ('suspended', 'closed')
    or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account reactivation is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'active'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'active' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account reactivation result is unavailable';
  end if;
  if scope.organization_id < p_organization_account_id then
    subject_ids := array[scope.organization_id, p_organization_account_id];
    subject_revisions := array[changed.access_version, changed.revision];
  else
    subject_ids := array[p_organization_account_id, scope.organization_id];
    subject_revisions := array[changed.revision, changed.access_version];
  end if;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', changed.state_change_correlation_id,
      'acceptedAt', changed.changed_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions),
      'fingerprint', command_fingerprint, 'clusterId', null));
  return query select 'accepted'::text, 'reactivate_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

comment on function vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected suspended-or-closed-to-active account command using the existing guarded owner and accepted receipt.';

revoke execute on function
  vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.reactivate_organization_account_for_administration(uuid, uuid, bigint) to vortex_request;

create or replace function vortex_access.register_flow_execution_binding(
  p_actor_identity_id uuid,
  p_actor_organization_account_id uuid,
  p_duplicate_key uuid,
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
  p_actor_system_actor_id uuid,
  p_permitted_invokers jsonb,
  p_permitted_surfaces jsonb,
  p_permitted_inputs jsonb,
  p_expires_at timestamptz,
  p_expected_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text,
  result jsonb,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  command_fingerprint text;
  stored record; claimed jsonb;
  current_binding vortex_access.flow_execution_bindings%rowtype;
  stored_binding vortex_access.flow_execution_bindings%rowtype;
  operation_at timestamptz;
  new_receipt_id uuid := pg_catalog.gen_random_uuid();
  next_revision bigint;
  activity_result text;
  permits_system boolean;
begin
  if p_actor_identity_id is null or not vortex_platform.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_execution_binding_id is null or not vortex_platform.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_release_version is null
    or p_release_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or p_flow_id is null or not vortex_platform.is_non_nil_uuid(p_flow_id::text)
    or p_node_id is null or not vortex_platform.is_non_nil_uuid(p_node_id::text)
    or p_operation_owner_kind is null
    or p_operation_owner_kind not in ('application', 'module', 'platform_service')
    or p_operation_owner_id is null or not vortex_platform.is_non_nil_uuid(p_operation_owner_id::text)
    or (p_operation_owner_kind = 'application' and p_operation_owner_id <> p_application_root_id)
    or p_operation_id is null or not vortex_platform.is_non_nil_uuid(p_operation_id::text)
    or p_actor_kind is null or p_actor_kind not in ('specified_user', 'system')
    or (p_actor_kind = 'specified_user' and (
      p_actor_account_id is null or not vortex_platform.is_non_nil_uuid(p_actor_account_id::text)
      or p_actor_system_actor_id is not null))
    or (p_actor_kind = 'system' and (
      p_actor_system_actor_id is null or not vortex_platform.is_non_nil_uuid(p_actor_system_actor_id::text)
      or p_actor_account_id is not null))
    or p_permitted_invokers is null or pg_catalog.jsonb_typeof(p_permitted_invokers) <> 'array'
    or pg_catalog.jsonb_array_length(p_permitted_invokers) not between 1 and 20
    or p_permitted_surfaces is null or pg_catalog.jsonb_typeof(p_permitted_surfaces) <> 'array'
    or pg_catalog.jsonb_array_length(p_permitted_surfaces) not between 1 and 5
    or p_permitted_inputs is null or pg_catalog.jsonb_typeof(p_permitted_inputs) <> 'array'
    or pg_catalog.jsonb_array_length(p_permitted_inputs) > 20
    or (p_expected_revision is not null and p_expected_revision not between 1 and 9007199254740991)
    or (p_expires_at is not null and p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or p_activity_id is null or not vortex_platform.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023', message = 'Flow execution binding command is invalid';
  end if;

  -- Exact invoker, surface and input bounds: known shapes only, no duplicates.
  if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_permitted_invokers) as invoker(value)
      where pg_catalog.jsonb_typeof(invoker.value) <> 'object'
        or not (
          (invoker.value = '{"kind":"system"}'::jsonb)
          or (
            invoker.value ->> 'kind' = 'organization_account'
            and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(invoker.value)) = 2
            and pg_catalog.jsonb_typeof(invoker.value -> 'organizationAccountId') = 'string'
            and vortex_platform.is_non_nil_uuid(invoker.value ->> 'organizationAccountId')
          )
        )
    )
    or (
      select pg_catalog.count(distinct case invoker.value ->> 'kind'
        when 'system' then 'system'
        else 'account:' || pg_catalog.lower(invoker.value ->> 'organizationAccountId')
      end)
      from pg_catalog.jsonb_array_elements(p_permitted_invokers) as invoker(value)
    ) <> pg_catalog.jsonb_array_length(p_permitted_invokers)
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_permitted_surfaces) as surface(value)
      where pg_catalog.jsonb_typeof(surface.value) <> 'string'
        or surface.value #>> '{}' not in (
          'web', 'mcp', 'programmatic_interface', 'connection', 'federation',
          'durable_workflow', 'system')
    )
    or (
      select pg_catalog.count(distinct surface.value)
      from pg_catalog.jsonb_array_elements(p_permitted_surfaces) as surface(value)
    ) <> pg_catalog.jsonb_array_length(p_permitted_surfaces)
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_permitted_inputs) as input(value)
      where pg_catalog.jsonb_typeof(input.value) <> 'string'
        or pg_catalog.char_length(input.value #>> '{}') not between 1 and 40
        or (input.value #>> '{}') !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    )
    or (
      select pg_catalog.count(distinct input.value)
      from pg_catalog.jsonb_array_elements(p_permitted_inputs) as input(value)
    ) <> pg_catalog.jsonb_array_length(p_permitted_inputs) then
    raise exception using errcode = '22023', message = 'Flow execution binding bounds are invalid';
  end if;

  permits_system := p_permitted_invokers @> '[{"kind":"system"}]'::jsonb;
  if (p_actor_kind = 'system') <> permits_system then
    raise exception using errcode = '22023',
      message = 'Only a system execution binding permits, and must permit, the system origin';
  end if;

  select granted.* into strict authority
  from vortex_access.flow_execution_binding_authority_internal(
    p_actor_identity_id, p_actor_organization_account_id, p_organization_id, 'grant'
  ) as granted;

  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'register_flow_execution_binding',
      p_organization_id::text,
      p_execution_binding_id::text,
      p_application_root_id::text,
      p_release_version,
      p_flow_id::text,
      p_node_id::text,
      p_operation_owner_kind,
      p_operation_owner_id::text,
      p_operation_id::text,
      p_actor_kind,
      coalesce(p_actor_account_id::text, ''),
      coalesce(p_actor_system_actor_id::text, ''),
      p_permitted_invokers::text,
      p_permitted_surfaces::text,
      p_permitted_inputs::text,
      coalesce(vortex_platform.format_timestamp_utc(p_expires_at), ''),
      coalesce(p_expected_revision::text, '')
    ), 'UTF8'),
    'sha256'), 'hex');

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'register_flow_execution_binding', p_duplicate_key, p_organization_id,
    authority.tenant_id, p_actor_organization_account_id, 'Flow execution binding duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint
      or stored."subjectIds" <> array[p_execution_binding_id]
      or stored."subjectRevisions"[1] is null then
      raise exception using errcode = 'V3001', message = 'Flow execution binding duplicate conflicts';
    end if;
    select binding.* into stored_binding
    from vortex_access.flow_execution_bindings as binding
    where binding.execution_binding_id = p_execution_binding_id
      and binding.revision = stored."subjectRevisions"[1]
      and binding.organization_id = p_organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'Flow execution binding replay is unavailable';
    end if;
    return query select 'replayed'::text,
      vortex_access.flow_execution_binding_to_json_internal(stored_binding),
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  -- The effective person and every named invoker must be active accounts of
  -- this organisation now; #686 re-checks their lifecycle at each use.
  if p_actor_kind = 'specified_user' and not exists (
      select 1 from vortex_identity.organization_accounts as account
      where account.organization_account_id = p_actor_account_id
        and account.organization_id = p_organization_id
        and account.state = 'active'
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_permitted_invokers) as invoker(value)
      where invoker.value ->> 'kind' = 'organization_account'
        and not exists (
          select 1 from vortex_identity.organization_accounts as account
          where account.organization_account_id = (invoker.value ->> 'organizationAccountId')::uuid
            and account.organization_id = p_organization_id
            and account.state = 'active'
        )
    ) then
    raise exception using errcode = '42501', message = 'Flow execution binding account is unavailable';
  end if;

  select binding.* into current_binding
  from vortex_access.flow_execution_bindings as binding
  where binding.execution_binding_id = p_execution_binding_id
    and binding.is_current
  for update;

  if found then
    if current_binding.organization_id is distinct from p_organization_id then
      raise exception using errcode = '23505', message = 'Flow execution binding identity is unavailable';
    end if;
    if p_expected_revision is null then
      raise exception using errcode = '23505', message = 'Flow execution binding already exists';
    end if;
    if current_binding.state = 'revoked' then
      raise exception using errcode = 'V3101', message = 'A revoked flow execution binding cannot be revived';
    end if;
    if current_binding.revision <> p_expected_revision then
      raise exception using errcode = 'V3102', message = 'Flow execution binding revision is stale';
    end if;
    if current_binding.application_root_id is distinct from p_application_root_id
      or current_binding.release_version is distinct from p_release_version
      or current_binding.flow_id is distinct from p_flow_id
      or current_binding.node_id is distinct from p_node_id
      or current_binding.operation_owner_kind is distinct from p_operation_owner_kind
      or current_binding.operation_owner_id is distinct from p_operation_owner_id
      or current_binding.operation_id is distinct from p_operation_id
      or current_binding.actor_kind is distinct from p_actor_kind
      or current_binding.actor_organization_account_id is distinct from p_actor_account_id
      or current_binding.actor_system_actor_id is distinct from p_actor_system_actor_id then
      raise exception using errcode = '22023', message = 'Flow execution binding scope is immutable';
    end if;
    next_revision := current_binding.revision + 1;
  else
    if p_expected_revision is not null then
      raise exception using errcode = 'V3102', message = 'Flow execution binding is unavailable';
    end if;
    next_revision := 1;
  end if;

  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at is not null and p_expires_at <= operation_at then
    raise exception using errcode = '22023', message = 'Flow execution binding expiry must be in the future';
  end if;

  if next_revision > 1 then
    update vortex_access.flow_execution_bindings as binding
    set is_current = false
    where binding.execution_binding_id = p_execution_binding_id
      and binding.revision = current_binding.revision;
  end if;

  insert into vortex_access.flow_execution_bindings (
    execution_binding_id, revision, is_current,
    organization_id, application_root_id, release_version,
    flow_id, node_id, operation_owner_kind, operation_owner_id, operation_id,
    actor_kind, actor_organization_account_id, actor_system_actor_id,
    permitted_invokers, permitted_surfaces, permitted_inputs,
    expires_at, state, recorded_at, recorded_by_actor_id, recorded_correlation_id, revoked_at
  ) values (
    p_execution_binding_id, next_revision, true,
    p_organization_id, p_application_root_id, p_release_version,
    p_flow_id, p_node_id, p_operation_owner_kind, p_operation_owner_id, p_operation_id,
    p_actor_kind, p_actor_account_id, p_actor_system_actor_id,
    p_permitted_invokers, p_permitted_surfaces, p_permitted_inputs,
    p_expires_at, 'active', operation_at, p_actor_organization_account_id, authority.correlation_id, null
  ) returning * into stored_binding;

  perform 1 from vortex_access.increment_organization_access_version(
    p_organization_id, p_actor_organization_account_id, authority.correlation_id,
    'access_grant_changed'
  );

  activity_result := vortex_record.append_organization_activity_entry(
    p_organization_id,
    p_activity_id,
    operation_at,
    'organization_account',
    p_actor_organization_account_id,
    case when next_revision = 1
      then 'register_flow_execution_binding'
      else 'replace_flow_execution_binding'
    end,
    array[p_execution_binding_id]::uuid[],
    array[]::uuid[],
    vortex_platform.channel(),
    authority.correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Flow execution binding Activity is stale';
  end if;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', operation_at, 'subjectIds', pg_catalog.to_jsonb(array[p_execution_binding_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[next_revision]),
      'fingerprint', command_fingerprint, 'clusterId', null));

  return query select 'accepted'::text,
    vortex_access.flow_execution_binding_to_json_internal(stored_binding),
    new_receipt_id,
    operation_at;
end
$function$;

revoke all on function vortex_access.register_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid,
  jsonb, jsonb, jsonb, timestamptz, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_access.register_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid,
  jsonb, jsonb, jsonb, timestamptz, bigint, uuid
) to vortex_request;

comment on function vortex_access.register_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, uuid, text, uuid, uuid, text, uuid, uuid,
  jsonb, jsonb, jsonb, timestamptz, bigint, uuid
) is
  'Registers or replaces one exact flow execution binding at its next revision; permitted surfaces are drawn from the one channel vocabulary.';

create or replace function vortex_access.register_flow_run_as_principal(
  p_actor_identity_id uuid,
  p_actor_organization_account_id uuid,
  p_duplicate_key uuid,
  p_execution_binding_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid,
  p_release_version text,
  p_flow_id uuid,
  p_actor_kind text,
  p_actor_account_id uuid,
  p_actor_system_actor_id uuid,
  p_expires_at timestamptz,
  p_expected_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text,
  result jsonb,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  command_fingerprint text;
  stored record; claimed jsonb;
  current_principal vortex_access.flow_run_as_principals%rowtype;
  stored_principal vortex_access.flow_run_as_principals%rowtype;
  operation_at timestamptz;
  new_receipt_id uuid := pg_catalog.gen_random_uuid();
  next_revision bigint;
  activity_result text;
begin
  if p_actor_identity_id is null or not vortex_platform.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_execution_binding_id is null or not vortex_platform.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_application_root_id is null or not vortex_platform.is_non_nil_uuid(p_application_root_id::text)
    or p_release_version is null
    or p_release_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
    or p_flow_id is null or not vortex_platform.is_non_nil_uuid(p_flow_id::text)
    or p_actor_kind is null or p_actor_kind not in ('specified_account', 'system')
    or (p_actor_kind = 'specified_account' and (
      p_actor_account_id is null or not vortex_platform.is_non_nil_uuid(p_actor_account_id::text)
      or p_actor_system_actor_id is not null))
    or (p_actor_kind = 'system' and (
      p_actor_system_actor_id is null or not vortex_platform.is_non_nil_uuid(p_actor_system_actor_id::text)
      or p_actor_account_id is not null))
    or (p_expected_revision is not null and p_expected_revision not between 1 and 9007199254740991)
    or (p_expires_at is not null and p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or p_activity_id is null or not vortex_platform.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023', message = 'Flow run-as principal command is invalid';
  end if;

  select granted.* into strict authority
  from vortex_access.flow_execution_binding_authority_internal(
    p_actor_identity_id, p_actor_organization_account_id, p_organization_id, 'grant'
  ) as granted;

  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'register_flow_run_as_principal',
      p_organization_id::text,
      p_execution_binding_id::text,
      p_application_root_id::text,
      p_release_version,
      p_flow_id::text,
      p_actor_kind,
      coalesce(p_actor_account_id::text, ''),
      coalesce(p_actor_system_actor_id::text, ''),
      coalesce(vortex_platform.format_timestamp_utc(p_expires_at), ''),
      coalesce(p_expected_revision::text, '')
    ), 'UTF8'),
    'sha256'), 'hex');

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'register_flow_run_as_principal', p_duplicate_key, p_organization_id,
    authority.tenant_id, p_actor_organization_account_id, 'Flow run-as principal duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint
      or stored."subjectIds" <> array[p_execution_binding_id]
      or stored."subjectRevisions"[1] is null then
      raise exception using errcode = 'V3001', message = 'Flow run-as principal duplicate conflicts';
    end if;
    select principal.* into stored_principal
    from vortex_access.flow_run_as_principals as principal
    where principal.execution_binding_id = p_execution_binding_id
      and principal.revision = stored."subjectRevisions"[1]
      and principal.organization_id = p_organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'Flow run-as principal replay is unavailable';
    end if;
    return query select 'replayed'::text,
      vortex_access.flow_run_as_principal_to_json_internal(stored_principal),
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  -- An account principal must be active in the named organisation. A System principal must
  -- already have an active Access registration scoped to that organisation and flow.
  if p_actor_kind = 'specified_account' and not exists (
      select 1 from vortex_identity.organization_accounts as account
      where account.organization_account_id = p_actor_account_id
        and account.organization_id = p_organization_id
        and account.state = 'active'
    )
    or p_actor_kind = 'system' and not exists (
      select 1 from vortex_access.system_actor_grants as actor_grant
      where actor_grant.system_actor_id = p_actor_system_actor_id
        and actor_grant.organization_id = p_organization_id
        and (actor_grant.flow_id is null or actor_grant.flow_id = p_flow_id)
        and actor_grant.state = 'active'
    ) then
    raise exception using errcode = '42501', message = 'Flow run-as principal actor is unavailable';
  end if;

  select principal.* into current_principal
  from vortex_access.flow_run_as_principals as principal
  where principal.execution_binding_id = p_execution_binding_id
    and principal.is_current
  for update;

  if found then
    if current_principal.organization_id is distinct from p_organization_id then
      raise exception using errcode = '42501', message = 'Flow run-as principal scope is unavailable';
    end if;
    if p_expected_revision is null then
      raise exception using errcode = '23505', message = 'Flow run-as principal already exists';
    end if;
    if current_principal.state = 'revoked' then
      raise exception using errcode = 'V3101', message = 'A revoked flow run-as principal cannot be revived';
    end if;
    if current_principal.revision <> p_expected_revision then
      raise exception using errcode = 'V3102', message = 'Flow run-as principal revision is stale';
    end if;
    if current_principal.application_root_id is distinct from p_application_root_id
      or current_principal.release_version is distinct from p_release_version
      or current_principal.flow_id is distinct from p_flow_id then
      raise exception using errcode = '22023', message = 'Flow run-as principal scope is immutable';
    end if;
    if current_principal.revision >= 9007199254740991 then
      raise exception using errcode = 'V3102', message = 'Flow run-as principal revision is exhausted';
    end if;
    next_revision := current_principal.revision + 1;
  else
    if p_expected_revision is not null then
      raise exception using errcode = 'V3102', message = 'Flow run-as principal is unavailable';
    end if;
    next_revision := 1;
  end if;

  operation_at := pg_catalog.clock_timestamp();
  if p_expires_at is not null and p_expires_at <= operation_at then
    raise exception using errcode = '22023', message = 'Flow run-as principal expiry must be in the future';
  end if;

  if next_revision > 1 then
    update vortex_access.flow_run_as_principals as principal
    set is_current = false
    where principal.execution_binding_id = p_execution_binding_id
      and principal.revision = current_principal.revision;
  end if;

  insert into vortex_access.flow_run_as_principals (
    execution_binding_id, revision, is_current,
    organization_id, application_root_id, release_version, flow_id,
    actor_kind, actor_organization_account_id, actor_system_actor_id,
    expires_at, state, recorded_at, recorded_by_actor_id, recorded_correlation_id, revoked_at
  ) values (
    p_execution_binding_id, next_revision, true,
    p_organization_id, p_application_root_id, p_release_version, p_flow_id,
    p_actor_kind, p_actor_account_id, p_actor_system_actor_id,
    p_expires_at, 'active', operation_at, p_actor_organization_account_id,
    authority.correlation_id, null
  ) returning * into stored_principal;

  perform 1 from vortex_access.increment_organization_access_version(
    p_organization_id, p_actor_organization_account_id, authority.correlation_id,
    'access_grant_changed'
  );

  activity_result := vortex_record.append_organization_activity_entry(
    p_organization_id,
    p_activity_id,
    operation_at,
    'organization_account',
    p_actor_organization_account_id,
    case when next_revision = 1
      then 'register_flow_run_as_principal'
      else 'replace_flow_run_as_principal'
    end,
    array[p_execution_binding_id]::uuid[],
    array[]::uuid[],
    vortex_platform.channel(),
    authority.correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Flow run-as principal Activity is stale';
  end if;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', operation_at, 'subjectIds', pg_catalog.to_jsonb(array[p_execution_binding_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[next_revision]),
      'fingerprint', command_fingerprint, 'clusterId', null));

  return query select 'accepted'::text,
    vortex_access.flow_run_as_principal_to_json_internal(stored_principal),
    new_receipt_id,
    operation_at;
end
$function$;

revoke all on function vortex_access.register_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, text, uuid, uuid, timestamptz, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_access.register_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, text, uuid, uuid, timestamptz, bigint, uuid
) to vortex_request;

comment on function vortex_access.register_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, uuid, text, uuid, text, uuid, uuid, timestamptz, bigint, uuid
) is
  'Registers or replaces one exact compiled flow run-as principal under the existing execution-binding administration authority.';

create or replace function vortex_access.release_capability_reservation(
  p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text,
  p_policy_id uuid, p_policy_revision bigint, p_assignment_id uuid,
  p_assignment_revision bigint, p_reservation_id uuid, p_duplicate_key uuid,
  p_quantity numeric default null
)
returns table (result jsonb)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  protected_context record;
  target vortex_access.capability_reservations%rowtype;
  claimed jsonb;
  request_actor_id uuid;
  command_fingerprint text;
  remaining numeric;
  release_amount numeric;
  new_released numeric;
  new_remaining numeric;
  new_state text;
  balance record;
  safe_result jsonb;
  refusal_reason text;
begin
  if not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_policy_id is null or not vortex_platform.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision not between 1 and 9007199254740991
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
    or p_assignment_revision not between 1 and 9007199254740991
    or p_reservation_id is null or not vortex_platform.is_non_nil_uuid(p_reservation_id::text)
    or (p_quantity is not null
      and not vortex_access.capability_policy_quantity_is_valid(p_quantity))
    or p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text) then
    raise exception using errcode = '22023', message = 'Capability release command is invalid';
  end if;
  select context.* into strict protected_context
  from vortex_access.capability_reservation_request_context(
    p_tenant_id, p_organization_id
  ) as context;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'release_capability_reservation', p_tenant_id::text,
      coalesce(protected_context.request_organization_id::text, ''),
      p_capability_key, p_unit, p_policy_id::text, p_policy_revision::text,
      p_assignment_id::text, p_assignment_revision::text,
      p_reservation_id::text, coalesce(p_quantity::text, 'all')), 'UTF8'), 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f', p_tenant_id::text,
      coalesce(protected_context.request_organization_id::text, ''),
      p_duplicate_key::text), 650)
  );
  request_actor_id := coalesce(
    vortex_platform.current_context() ->> 'organizationAccountId',
    vortex_platform.current_context() ->> 'systemActorId'
  )::uuid;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'capability_release', p_duplicate_key, protected_context.request_organization_id,
    p_tenant_id, request_actor_id, 'Capability release duplicate conflicts'
  );
  if claimed is not null then
    if claimed ->> 'fingerprint' <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Capability release duplicate conflicts';
    end if;
    return query select pg_catalog.jsonb_set(
      claimed - 'fingerprint', '{status}', '"replayed"'::jsonb, false
    );
    return;
  end if;
  select reservation.* into target
  from vortex_access.capability_reservations as reservation
  where reservation.reservation_id = p_reservation_id for update;
  if not found
    or target.tenant_id <> p_tenant_id
    or target.request_organization_id is distinct from protected_context.request_organization_id
    or target.capability_key <> p_capability_key or target.unit <> p_unit
    or target.policy_id <> p_policy_id or target.policy_revision <> p_policy_revision
    or target.assignment_id <> p_assignment_id
    or target.assignment_revision <> p_assignment_revision then
    refusal_reason := 'reservation_unavailable';
  elsif target.state <> 'active' or target.expires_at <= evaluated_at then
    if target.state = 'active' then
      update vortex_access.capability_reservations as reservation
      set state = 'expired', expired_at = evaluated_at, updated_at = evaluated_at
      where reservation.reservation_id = p_reservation_id;
    end if;
    refusal_reason := 'reservation_stale';
  else
    remaining := target.reserved_quantity - target.consumed_quantity - target.released_quantity;
    release_amount := coalesce(p_quantity, remaining);
    if release_amount <= 0 or release_amount > remaining then
      refusal_reason := 'insufficient_reserved_quantity';
    end if;
  end if;
  if refusal_reason is not null then
    safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'status', 'accepted', 'reservationId', p_reservation_id,
      'tenantId', p_tenant_id,
      'organizationId', protected_context.request_organization_id,
      'capabilityKey', p_capability_key, 'unit', p_unit,
      'reasonCode', refusal_reason,
      'decidedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'correlationId', protected_context.correlation_id
    ));
    perform vortex_record.complete_scoped_command_receipt_internal(
      p_duplicate_key,
      safe_result || pg_catalog.jsonb_build_object('fingerprint', command_fingerprint)
    );
    return query select safe_result;
    return;
  end if;
  new_released := target.released_quantity + release_amount;
  new_remaining := remaining - release_amount;
  new_state := case when new_remaining = 0 then 'released' else 'active' end;
  update vortex_access.capability_reservations as reservation
  set released_quantity = new_released, state = new_state,
      released_at = evaluated_at, updated_at = evaluated_at
  where reservation.reservation_id = p_reservation_id;
  select refreshed.* into strict balance
  from vortex_access.refresh_capability_reservation_balance(
    target.tenant_id, target.request_organization_id, target.capability_key, target.unit,
    target.applied_scope,
    case when target.applied_scope = 'organization'
      then target.request_organization_id else null::uuid end,
    target.policy_id, target.policy_revision, target.assignment_id,
    target.assignment_revision, target.policy_quantity_limit, evaluated_at
  ) as refreshed;
  safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'outcome', 'released', 'status', 'accepted', 'reservationId', p_reservation_id,
    'tenantId', p_tenant_id, 'organizationId', target.request_organization_id,
    'capabilityKey', target.capability_key, 'unit', target.unit,
    'policyId', target.policy_id, 'policyRevision', target.policy_revision,
    'assignmentId', target.assignment_id,
    'assignmentRevision', target.assignment_revision,
    'appliedScope', target.applied_scope, 'releasedAmount', release_amount::text,
    'totalReleasedQuantity', new_released::text,
    'remainingReservedQuantity', new_remaining::text,
    'reservationState', new_state,
    'releasedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'correlationId', protected_context.correlation_id,
    'balance', pg_catalog.jsonb_build_object(
      'policyLimit', balance.policy_quantity_limit::text,
      'activeReservedQuantity', balance.active_reserved_quantity::text,
      'consumedQuantity', balance.consumed_quantity::text,
      'releasedQuantity', balance.released_quantity::text,
      'availableQuantity', balance.available_quantity::text)
  ));
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    safe_result || pg_catalog.jsonb_build_object('fingerprint', command_fingerprint)
  );
  return query select safe_result;
end
$function$;

comment on function vortex_access.release_capability_reservation(
  uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, uuid, numeric
) is
  'Releases an exact unexpired reservation and records the canonical refreshed balance in its immutable duplicate-protected outcome.';

revoke execute on function
  vortex_access.release_capability_reservation(
    uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, uuid, numeric
  ) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.release_capability_reservation(
    uuid, uuid, text, text, uuid, bigint, uuid, bigint, uuid, uuid, numeric
  ) to vortex_request;

create or replace function vortex_access.reserve_capability_quantity(
  p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text,
  p_policy_claim jsonb, p_requested_quantity numeric, p_duplicate_key uuid
)
returns table (result jsonb)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  effective record;
  protected_context record;
  balance record;
  claimed jsonb;
  request_actor_id uuid;
  command_fingerprint text;
  reservation_id uuid;
  expires_at timestamptz;
  safe_result jsonb;
begin
  if not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or p_policy_claim is null or pg_catalog.jsonb_typeof(p_policy_claim) <> 'object'
    or not vortex_access.capability_policy_quantity_is_valid(p_requested_quantity)
    or p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text) then
    raise exception using errcode = '22023', message = 'Capability reservation command is invalid';
  end if;
  select locked.* into effective
  from vortex_access.lock_effective_capability_policy(
    p_tenant_id, p_organization_id, p_capability_key, p_unit, evaluated_at
  ) as locked;
  if effective.correlation_id is null then
    select context.* into strict protected_context
    from vortex_access.capability_reservation_request_context(
      p_tenant_id, p_organization_id
    ) as context;
  else
    protected_context := effective;
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'reserve_capability_quantity', p_tenant_id::text,
      coalesce(protected_context.request_organization_id::text, ''),
      p_capability_key, p_unit, p_policy_claim::text,
      p_requested_quantity::text), 'UTF8'), 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(pg_catalog.concat_ws(E'\x1f', p_tenant_id::text,
      coalesce(protected_context.request_organization_id::text, ''),
      p_duplicate_key::text), 650)
  );
  request_actor_id := coalesce(
    vortex_platform.current_context() ->> 'organizationAccountId',
    vortex_platform.current_context() ->> 'systemActorId'
  )::uuid;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'capability_reserve', p_duplicate_key, protected_context.request_organization_id,
    p_tenant_id, request_actor_id, 'Capability reservation duplicate conflicts'
  );
  if claimed is not null then
    if claimed ->> 'fingerprint' <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Capability reservation duplicate conflicts';
    end if;
    return query select pg_catalog.jsonb_set(
      claimed - 'fingerprint', '{status}', '"replayed"'::jsonb, false
    );
    return;
  end if;
  if effective.assignment_id is null then
    safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'status', 'accepted', 'tenantId', p_tenant_id,
      'organizationId', protected_context.request_organization_id,
      'capabilityKey', p_capability_key, 'unit', p_unit,
      'requestedQuantity', p_requested_quantity::text,
      'reasonCode', 'capability_not_assigned',
      'decidedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'correlationId', protected_context.correlation_id
    ));
    perform vortex_record.complete_scoped_command_receipt_internal(
      p_duplicate_key,
      safe_result || pg_catalog.jsonb_build_object('fingerprint', command_fingerprint)
    );
    return query select safe_result;
    return;
  end if;
  select refreshed.* into strict balance
  from vortex_access.refresh_capability_reservation_balance(
    p_tenant_id, effective.request_organization_id, p_capability_key, p_unit,
    effective.applied_scope, effective.assignment_organization_id,
    effective.policy_id, effective.policy_revision, effective.assignment_id,
    effective.assignment_revision, effective.quantity_limit, evaluated_at
  ) as refreshed;
  if balance.available_quantity < p_requested_quantity then
    safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'status', 'accepted', 'tenantId', p_tenant_id,
      'organizationId', effective.request_organization_id,
      'capabilityKey', p_capability_key, 'unit', p_unit,
      'policyId', effective.policy_id, 'policyRevision', effective.policy_revision,
      'assignmentId', effective.assignment_id,
      'assignmentRevision', effective.assignment_revision,
      'appliedScope', effective.applied_scope,
      'requestedQuantity', p_requested_quantity::text,
      'reasonCode', 'insufficient_capacity',
      'decidedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'correlationId', effective.correlation_id,
      'balance', pg_catalog.jsonb_build_object(
        'policyLimit', balance.policy_quantity_limit::text,
        'activeReservedQuantity', balance.active_reserved_quantity::text,
        'consumedQuantity', balance.consumed_quantity::text,
        'releasedQuantity', balance.released_quantity::text,
        'availableQuantity', balance.available_quantity::text)
    ));
    perform vortex_record.complete_scoped_command_receipt_internal(
      p_duplicate_key,
      safe_result || pg_catalog.jsonb_build_object('fingerprint', command_fingerprint)
    );
    return query select safe_result;
    return;
  end if;
  expires_at := least(evaluated_at + interval '300 seconds',
    effective.request_expires_at,
    coalesce(effective.assignment_expires_at, 'infinity'::timestamptz));
  if expires_at <= evaluated_at then
    safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'status', 'accepted', 'tenantId', p_tenant_id,
      'organizationId', effective.request_organization_id,
      'capabilityKey', p_capability_key, 'unit', p_unit,
      'policyId', effective.policy_id, 'policyRevision', effective.policy_revision,
      'assignmentId', effective.assignment_id,
      'assignmentRevision', effective.assignment_revision,
      'appliedScope', effective.applied_scope,
      'requestedQuantity', p_requested_quantity::text, 'reasonCode', 'policy_stale',
      'decidedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'correlationId', effective.correlation_id
    ));
    perform vortex_record.complete_scoped_command_receipt_internal(
      p_duplicate_key,
      safe_result || pg_catalog.jsonb_build_object('fingerprint', command_fingerprint)
    );
    return query select safe_result;
    return;
  end if;
  reservation_id := pg_catalog.gen_random_uuid();
  insert into vortex_access.capability_reservations (
    reservation_id, tenant_id, request_organization_id, capability_key, unit,
    policy_id, policy_revision, assignment_id, assignment_revision,
    applied_scope, policy_quantity_limit, reserved_quantity,
    consumed_quantity, released_quantity, state, created_at, expires_at,
    updated_at, reserve_duplicate_key, correlation_id
  ) values (
    reservation_id, p_tenant_id, effective.request_organization_id,
    p_capability_key, p_unit, effective.policy_id, effective.policy_revision,
    effective.assignment_id, effective.assignment_revision,
    effective.applied_scope, effective.quantity_limit, p_requested_quantity,
    0, 0, 'active', evaluated_at, expires_at, evaluated_at,
    p_duplicate_key, effective.correlation_id
  );
  select refreshed.* into strict balance
  from vortex_access.refresh_capability_reservation_balance(
    p_tenant_id, effective.request_organization_id, p_capability_key, p_unit,
    effective.applied_scope, effective.assignment_organization_id,
    effective.policy_id, effective.policy_revision, effective.assignment_id,
    effective.assignment_revision, effective.quantity_limit, evaluated_at
  ) as refreshed;
  safe_result := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'outcome', 'reserved', 'status', 'accepted', 'reservationId', reservation_id,
    'tenantId', p_tenant_id, 'organizationId', effective.request_organization_id,
    'capabilityKey', p_capability_key, 'unit', p_unit,
    'policyId', effective.policy_id, 'policyRevision', effective.policy_revision,
    'assignmentId', effective.assignment_id,
    'assignmentRevision', effective.assignment_revision,
    'appliedScope', effective.applied_scope,
    'reservedQuantity', p_requested_quantity::text,
    'reservedAt', pg_catalog.to_char(evaluated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'expiresAt', pg_catalog.to_char(expires_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'correlationId', effective.correlation_id,
    'balance', pg_catalog.jsonb_build_object(
      'policyLimit', balance.policy_quantity_limit::text,
      'activeReservedQuantity', balance.active_reserved_quantity::text,
      'consumedQuantity', balance.consumed_quantity::text,
      'releasedQuantity', balance.released_quantity::text,
      'availableQuantity', balance.available_quantity::text)
  ));
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    safe_result || pg_catalog.jsonb_build_object('fingerprint', command_fingerprint)
  );
  return query select safe_result;
end
$function$;

comment on function vortex_access.reserve_capability_quantity(
  uuid, uuid, text, text, jsonb, numeric, uuid
) is
  'Resolves and locks current organisation-preferred policy, then atomically reserves or records a safe refusal.';

revoke execute on function
  vortex_access.reserve_capability_quantity(uuid, uuid, text, text, jsonb, numeric, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.reserve_capability_quantity(uuid, uuid, text, text, jsonb, numeric, uuid) to vortex_request;

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
  stored record; claimed jsonb;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
  activity_subjects uuid[];
  activity_result text;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_platform.is_non_nil_uuid(p_organization_id::text))
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990
    or (p_organization_id is null) <> (p_activity_id is null)
    or (p_activity_id is not null and not vortex_platform.is_non_nil_uuid(p_activity_id::text)) then
    raise exception using errcode = '22023', message = 'Capability allocation revocation is invalid';
  end if;
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  request_correlation_id := (vortex_platform.current_context() ->> 'correlationId')::uuid;
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for no key update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id, 'platform.tenant.capability_limits.allocate', evaluated_at
  );
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'revoke_capability_limit_allocation',
      p_tenant_id::text, coalesce(p_organization_id::text, ''), p_assignment_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  -- The accepted receipt is consulted before the staleness test so an
  -- identical retry replays instead of refusing the allocation it revoked.
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'revoke_capability_limit_allocation', p_duplicate_key, null,
    p_tenant_id, actor_identity_id, 'Capability allocation revocation duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint
      or stored."subjectIds" <> array[p_assignment_id]
      or stored."subjectRevisions"[1] is null then
      raise exception using errcode = 'V3001', message = 'Capability allocation revocation duplicate conflicts';
    end if;
    return query select 'replayed'::text, p_assignment_id, p_tenant_id, p_organization_id,
      stored."subjectRevisions"[1], stored."receiptId", stored."acceptedAt";
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
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', correlation,
      'acceptedAt', evaluated_at, 'subjectIds', pg_catalog.to_jsonb(array[p_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[(p_expected_revision + 1)::bigint]),
      'fingerprint', command_fingerprint, 'clusterId', null));
  insert into vortex_access.capability_limit_changes(
    change_id, tenant_id, organization_id, change_kind, actor_kind, actor_id,
    policy_id, policy_revision, assignment_id, assignment_revision,
    capability_key, unit, quantity_limit, expires_at, source, correlation_id, occurred_at
  ) values (
    correlation, p_tenant_id, p_organization_id, 'allocation_revoked', 'tenant_administrator',
    actor_identity_id, target.policy_id, target.policy_revision, p_assignment_id,
    p_expected_revision + 1, target.capability_key, target.unit, null, null,
    vortex_platform.channel(), request_correlation_id, evaluated_at
  );
  if p_organization_id is not null then
    select pg_catalog.array_agg(distinct subject.subject_id order by subject.subject_id)
    into activity_subjects
    from pg_catalog.unnest(array[p_assignment_id, target.policy_id]) as subject(subject_id);
    activity_result := vortex_record.append_organization_activity_entry(
      p_organization_id, p_activity_id, evaluated_at, 'identity', actor_identity_id,
      'revoke_capability_limit_allocation', activity_subjects, array[]::uuid[],
      vortex_platform.channel(), request_correlation_id, 'completed'
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
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.revoke_capability_limit_allocation(
  uuid, uuid, uuid, uuid, bigint, uuid
) to vortex_request;

comment on function vortex_access.revoke_capability_limit_allocation(
  uuid, uuid, uuid, uuid, bigint, uuid
) is
  'Tenant capability-limits allocation permission command that revokes a tenant-wide or organisation allocation, leaving the platform ceiling as the bound; it writes an accepted receipt, append-only change evidence and, for an organisation, content-free Activity.';

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
  context_value jsonb;
  actor_kind_value text := 'platform_operator';
  actor_id_value uuid := p_operator_actor_id;
  source_value text := 'system';
  actor_identity_id uuid;
  active_assignment_id uuid;
  target vortex_access.capability_policy_assignments%rowtype;
  stored record; claimed jsonb;
  evidence vortex_access.capability_limit_changes%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990 then
    raise exception using errcode = '22023', message = 'Capability ceiling revocation is invalid';
  end if;
  if p_operator_actor_id is not null then
    -- The configured system operator remains a context-free bootstrap caller.
    perform vortex_access.require_platform_operator_internal(p_operator_actor_id);
  else
    context_value := vortex_access.validated_human_request_context();
    actor_identity_id := (context_value ->> 'identityId')::uuid;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex.super_administrator.assignments', 0)
    );
    perform 1
    from vortex_identity.identity_projections as identity
    where identity.identity_id = actor_identity_id
      and identity.state = 'active'
    for share;
    if not found then
      raise exception using errcode = 'V3141',
        message = 'Capability ceiling authority is unavailable';
    end if;
    evaluated_at := pg_catalog.clock_timestamp();
    active_assignment_id :=
      vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
        actor_identity_id, evaluated_at
      );
    if active_assignment_id is null then
      raise exception using errcode = 'V3141',
        message = 'Capability ceiling authority is unavailable';
    end if;
    if vortex_access.recent_authentication_deadline_internal(
      context_value, evaluated_at,
      '{"kind":"primary","maximumAgeSeconds":900}'::jsonb
    ) is null then
      raise exception using errcode = 'V3142',
        message = 'A recent sign-in is required for capability ceiling changes';
    end if;
    actor_kind_value := 'identity';
    actor_id_value := actor_identity_id;
    source_value := coalesce(context_value ->> 'channel', 'web');
    correlation := (context_value ->> 'correlationId')::uuid;
  end if;
  if actor_kind_value = 'identity' then
    -- The selected organisation is only the request anchor. The target tenant
    -- is independently checked and may have no active organisation.
    perform 1 from vortex_identity.tenants tenant
    where tenant.tenant_id = p_tenant_id and tenant.state = 'active'
    for no key update;
  else
    perform 1 from vortex_identity.tenants tenant
    where tenant.tenant_id = p_tenant_id
    for no key update;
  end if;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'revoke_capability_policy_ceiling',
      p_tenant_id::text, p_assignment_id::text, p_expected_revision::text), 'UTF8'),
    'sha256'), 'hex');
  -- The accepted receipt is consulted before the staleness test so an
  -- identical retry replays instead of refusing the ceiling it already revoked.
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'revoke_capability_policy_ceiling', p_duplicate_key, null,
    p_tenant_id, actor_id_value, 'Capability ceiling revocation duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint
      or stored."subjectIds" <> array[p_assignment_id]
      or stored."subjectRevisions"[1] is null then
      raise exception using errcode = 'V3001', message = 'Capability ceiling revocation duplicate conflicts';
    end if;
    select change.* into evidence
    from vortex_access.capability_limit_changes as change
    where change.change_id = stored."receiptId";
    if not found
      or evidence.actor_kind is distinct from actor_kind_value
      or evidence.actor_id is distinct from actor_id_value
      or evidence.tenant_id is distinct from p_tenant_id
      or evidence.assignment_id is distinct from p_assignment_id
      or evidence.assignment_revision is distinct from stored."subjectRevisions"[1]
      or evidence.change_kind is distinct from 'ceiling_revoked'
      or evidence.correlation_id is distinct from stored."receiptId" then
      raise exception using errcode = '42501',
        message = 'Capability ceiling revocation replay is unavailable';
    end if;
    return query select 'replayed'::text, p_assignment_id, p_tenant_id,
      stored."subjectRevisions"[1], stored."receiptId", stored."acceptedAt";
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
      changed_by_actor_id = actor_id_value, change_correlation_id = correlation,
      revoked_at = evaluated_at, revoked_by_actor_id = actor_id_value,
      revocation_correlation_id = correlation
  where assignment.assignment_id = p_assignment_id;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', correlation,
      'acceptedAt', evaluated_at, 'subjectIds', pg_catalog.to_jsonb(array[p_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[(p_expected_revision + 1)::bigint]),
      'fingerprint', command_fingerprint, 'clusterId', null));
  insert into vortex_access.capability_limit_changes(
    change_id, tenant_id, organization_id, change_kind, actor_kind, actor_id,
    policy_id, policy_revision, assignment_id, assignment_revision,
    capability_key, unit, quantity_limit, expires_at, source, correlation_id, occurred_at
  ) values (
    correlation, p_tenant_id, null, 'ceiling_revoked', actor_kind_value, actor_id_value,
    target.policy_id, target.policy_revision, p_assignment_id, p_expected_revision + 1,
    target.capability_key, target.unit, null, null, source_value, correlation, evaluated_at
  );
  return query select 'accepted'::text, p_assignment_id, p_tenant_id,
    p_expected_revision + 1, correlation, evaluated_at;
end
$function$;

revoke execute on function vortex_access.revoke_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.revoke_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, bigint
) to vortex_runtime, vortex_request;

comment on function vortex_access.revoke_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, bigint
) is
  'Revokes a tenant capability ceiling. The configured system operator retains its context-free bootstrap path; an active named Vortex super administrator may act as a verified person with recent primary authentication, using the selected organisation only as an account-bound request anchor and independently checking an active target tenant. Both paths write an accepted receipt and append-only change evidence; allocations beneath the ceiling stop applying.';

create or replace function vortex_access.revoke_flow_execution_binding(
  p_actor_identity_id uuid,
  p_actor_organization_account_id uuid,
  p_duplicate_key uuid,
  p_execution_binding_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text,
  result jsonb,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  command_fingerprint text;
  stored record; claimed jsonb;
  current_binding vortex_access.flow_execution_bindings%rowtype;
  stored_binding vortex_access.flow_execution_bindings%rowtype;
  operation_at timestamptz;
  new_receipt_id uuid := pg_catalog.gen_random_uuid();
  next_revision bigint;
  activity_result text;
begin
  if p_actor_identity_id is null or not vortex_platform.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_execution_binding_id is null or not vortex_platform.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_activity_id is null or not vortex_platform.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023', message = 'Flow execution binding revoke command is invalid';
  end if;

  select granted.* into strict authority
  from vortex_access.flow_execution_binding_authority_internal(
    p_actor_identity_id, p_actor_organization_account_id, p_organization_id, 'revoke'
  ) as granted;

  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'revoke_flow_execution_binding',
      p_organization_id::text,
      p_execution_binding_id::text,
      p_expected_revision::text
    ), 'UTF8'),
    'sha256'), 'hex');

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'revoke_flow_execution_binding', p_duplicate_key, p_organization_id,
    authority.tenant_id, p_actor_organization_account_id, 'Flow execution binding duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint
      or stored."subjectIds" <> array[p_execution_binding_id]
      or stored."subjectRevisions"[1] is null then
      raise exception using errcode = 'V3001', message = 'Flow execution binding duplicate conflicts';
    end if;
    select binding.* into stored_binding
    from vortex_access.flow_execution_bindings as binding
    where binding.execution_binding_id = p_execution_binding_id
      and binding.revision = stored."subjectRevisions"[1]
      and binding.organization_id = p_organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'Flow execution binding replay is unavailable';
    end if;
    return query select 'replayed'::text,
      vortex_access.flow_execution_binding_to_json_internal(stored_binding),
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  -- A binding of another organisation is indistinguishable from a missing one.
  select binding.* into current_binding
  from vortex_access.flow_execution_bindings as binding
  where binding.execution_binding_id = p_execution_binding_id
    and binding.organization_id = p_organization_id
    and binding.is_current
  for update;

  if not found or current_binding.state = 'revoked' then
    raise exception using errcode = 'V3101', message = 'Flow execution binding is unavailable';
  end if;
  if current_binding.revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Flow execution binding revision is stale';
  end if;

  operation_at := pg_catalog.clock_timestamp();
  next_revision := current_binding.revision + 1;

  update vortex_access.flow_execution_bindings as binding
  set is_current = false
  where binding.execution_binding_id = p_execution_binding_id
    and binding.revision = current_binding.revision;

  insert into vortex_access.flow_execution_bindings (
    execution_binding_id, revision, is_current,
    organization_id, application_root_id, release_version,
    flow_id, node_id, operation_owner_kind, operation_owner_id, operation_id,
    actor_kind, actor_organization_account_id, actor_system_actor_id,
    permitted_invokers, permitted_surfaces, permitted_inputs,
    expires_at, state, recorded_at, recorded_by_actor_id, recorded_correlation_id, revoked_at
  ) values (
    current_binding.execution_binding_id, next_revision, true,
    current_binding.organization_id, current_binding.application_root_id,
    current_binding.release_version, current_binding.flow_id, current_binding.node_id,
    current_binding.operation_owner_kind, current_binding.operation_owner_id,
    current_binding.operation_id, current_binding.actor_kind,
    current_binding.actor_organization_account_id, current_binding.actor_system_actor_id,
    current_binding.permitted_invokers, current_binding.permitted_surfaces,
    current_binding.permitted_inputs, current_binding.expires_at, 'revoked', operation_at,
    p_actor_organization_account_id, authority.correlation_id, operation_at
  ) returning * into stored_binding;

  perform 1 from vortex_access.increment_organization_access_version(
    p_organization_id, p_actor_organization_account_id, authority.correlation_id,
    'access_grant_changed'
  );

  activity_result := vortex_record.append_organization_activity_entry(
    p_organization_id,
    p_activity_id,
    operation_at,
    'organization_account',
    p_actor_organization_account_id,
    'revoke_flow_execution_binding',
    array[p_execution_binding_id]::uuid[],
    array[]::uuid[],
    vortex_platform.channel(),
    authority.correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Flow execution binding Activity is stale';
  end if;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', operation_at, 'subjectIds', pg_catalog.to_jsonb(array[p_execution_binding_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[next_revision]),
      'fingerprint', command_fingerprint, 'clusterId', null));

  return query select 'accepted'::text,
    vortex_access.flow_execution_binding_to_json_internal(stored_binding),
    new_receipt_id,
    operation_at;
end
$function$;

revoke all on function vortex_access.revoke_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.revoke_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) to vortex_request;

comment on function vortex_access.revoke_flow_execution_binding(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) is
  'Revokes one exact current flow execution binding at its next revision; the recorded channel comes from the trusted request context.';

create or replace function vortex_access.revoke_flow_run_as_principal(
  p_actor_identity_id uuid,
  p_actor_organization_account_id uuid,
  p_duplicate_key uuid,
  p_execution_binding_id uuid,
  p_organization_id uuid,
  p_expected_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text,
  result jsonb,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority record;
  command_fingerprint text;
  stored record; claimed jsonb;
  current_principal vortex_access.flow_run_as_principals%rowtype;
  stored_principal vortex_access.flow_run_as_principals%rowtype;
  operation_at timestamptz;
  new_receipt_id uuid := pg_catalog.gen_random_uuid();
  next_revision bigint;
  activity_result text;
begin
  if p_actor_identity_id is null or not vortex_platform.is_non_nil_uuid(p_actor_identity_id::text)
    or p_actor_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_actor_organization_account_id::text)
    or p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_execution_binding_id is null or not vortex_platform.is_non_nil_uuid(p_execution_binding_id::text)
    or p_organization_id is null or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991
    or p_activity_id is null or not vortex_platform.is_non_nil_uuid(p_activity_id::text) then
    raise exception using errcode = '22023', message = 'Flow run-as principal revoke command is invalid';
  end if;

  select granted.* into strict authority
  from vortex_access.flow_execution_binding_authority_internal(
    p_actor_identity_id, p_actor_organization_account_id, p_organization_id, 'revoke'
  ) as granted;

  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f',
      'revoke_flow_run_as_principal',
      p_organization_id::text,
      p_execution_binding_id::text,
      p_expected_revision::text
    ), 'UTF8'),
    'sha256'), 'hex');

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'revoke_flow_run_as_principal', p_duplicate_key, p_organization_id,
    authority.tenant_id, p_actor_organization_account_id, 'Flow run-as principal duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint
      or stored."subjectIds" <> array[p_execution_binding_id]
      or stored."subjectRevisions"[1] is null then
      raise exception using errcode = 'V3001', message = 'Flow run-as principal duplicate conflicts';
    end if;
    select principal.* into stored_principal
    from vortex_access.flow_run_as_principals as principal
    where principal.execution_binding_id = p_execution_binding_id
      and principal.revision = stored."subjectRevisions"[1]
      and principal.organization_id = p_organization_id;
    if not found then
      raise exception using errcode = '42501', message = 'Flow run-as principal replay is unavailable';
    end if;
    return query select 'replayed'::text,
      vortex_access.flow_run_as_principal_to_json_internal(stored_principal),
      stored."receiptId",
      stored."acceptedAt";
    return;
  end if;

  select principal.* into current_principal
  from vortex_access.flow_run_as_principals as principal
  where principal.execution_binding_id = p_execution_binding_id
    and principal.organization_id = p_organization_id
    and principal.is_current
  for update;

  if not found or current_principal.state = 'revoked' then
    raise exception using errcode = 'V3101', message = 'Flow run-as principal is unavailable';
  end if;
  if current_principal.revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Flow run-as principal revision is stale';
  end if;
  if current_principal.revision >= 9007199254740991 then
    raise exception using errcode = 'V3102', message = 'Flow run-as principal revision is exhausted';
  end if;

  operation_at := pg_catalog.clock_timestamp();
  next_revision := current_principal.revision + 1;

  update vortex_access.flow_run_as_principals as principal
  set is_current = false
  where principal.execution_binding_id = p_execution_binding_id
    and principal.revision = current_principal.revision;

  insert into vortex_access.flow_run_as_principals (
    execution_binding_id, revision, is_current,
    organization_id, application_root_id, release_version, flow_id,
    actor_kind, actor_organization_account_id, actor_system_actor_id,
    expires_at, state, recorded_at, recorded_by_actor_id, recorded_correlation_id, revoked_at
  ) values (
    current_principal.execution_binding_id, next_revision, true,
    current_principal.organization_id, current_principal.application_root_id,
    current_principal.release_version, current_principal.flow_id,
    current_principal.actor_kind, current_principal.actor_organization_account_id,
    current_principal.actor_system_actor_id, current_principal.expires_at, 'revoked',
    operation_at, p_actor_organization_account_id, authority.correlation_id, operation_at
  ) returning * into stored_principal;

  perform 1 from vortex_access.increment_organization_access_version(
    p_organization_id, p_actor_organization_account_id, authority.correlation_id,
    'access_grant_changed'
  );

  activity_result := vortex_record.append_organization_activity_entry(
    p_organization_id,
    p_activity_id,
    operation_at,
    'organization_account',
    p_actor_organization_account_id,
    'revoke_flow_run_as_principal',
    array[p_execution_binding_id]::uuid[],
    array[]::uuid[],
    vortex_platform.channel(),
    authority.correlation_id,
    'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Flow run-as principal Activity is stale';
  end if;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', operation_at, 'subjectIds', pg_catalog.to_jsonb(array[p_execution_binding_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[next_revision]),
      'fingerprint', command_fingerprint, 'clusterId', null));

  return query select 'accepted'::text,
    vortex_access.flow_run_as_principal_to_json_internal(stored_principal),
    new_receipt_id,
    operation_at;
end
$function$;

revoke all on function vortex_access.revoke_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_access.revoke_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) to vortex_request;

comment on function vortex_access.revoke_flow_run_as_principal(
  uuid, uuid, uuid, uuid, uuid, bigint, uuid
) is
  'Revokes one exact current flow run-as principal at its next revision under the existing execution-binding administration authority.';

CREATE OR REPLACE FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) RETURNS TABLE(outcome text, operation text, organization_id uuid, invitation_id uuid, revision bigint, correlation_id uuid, accepted_at timestamp with time zone, access_version bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
  stored record; claimed jsonb;
  new_receipt_id uuid; new_accepted_at timestamptz;
  revoked record; command_fingerprint text;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_invitation_id is null or not vortex_platform.is_non_nil_uuid(p_invitation_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Invitation revocation command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_invitations_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'revoke_organization_invitation',
      scope.organization_id::text, p_invitation_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'revoke_organization_invitation', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(stored."subjectIds") <> 2
      or not scope.organization_id = any(stored."subjectIds")
      or not p_invitation_id = any(stored."subjectIds") then
      raise exception using errcode = '42501', message = 'Invitation revocation receipt is unavailable';
    end if;
    return query select 'replayed'::text, 'revoke_organization_invitation'::text,
      scope.organization_id, p_invitation_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", p_invitation_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  if p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Invitation revocation is stale or unavailable';
  end if;
  select result.* into strict revoked
  from vortex_identity.revoke_organization_invitation(
    p_invitation_id, p_expected_revision
  ) as result;
  if revoked.organization_id <> scope.organization_id
    or revoked.invitation_id <> p_invitation_id
    or revoked.revision <> p_expected_revision + 1
    or revoked.accepted_at is not null or revoked.revoked_at is null
    or revoked.revoked_by <> scope.organization_account_id then
    raise exception using errcode = '42501', message = 'Invitation revocation result is unavailable';
  end if;
  if scope.organization_id < p_invitation_id then
    subject_ids := array[scope.organization_id, p_invitation_id];
    subject_revisions := array[scope.access_version, revoked.revision];
  else
    subject_ids := array[p_invitation_id, scope.organization_id];
    subject_revisions := array[revoked.revision, scope.access_version];
  end if;
  new_receipt_id := (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
  new_accepted_at := revoked.changed_at;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', new_receipt_id,
      'acceptedAt', new_accepted_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions),
      'fingerprint', command_fingerprint, 'clusterId', null));
  return query select 'accepted'::text, 'revoke_organization_invitation'::text,
    scope.organization_id, p_invitation_id, revoked.revision,
    new_receipt_id, new_accepted_at, scope.access_version;
end
$$;

ALTER FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) OWNER TO postgres;

COMMENT ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) IS 'Protected pending invitation revocation, including expired invitations, using the existing Identity owner.';

REVOKE ALL ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION vortex_access.revoke_organization_invitation_for_administration(p_duplicate_key uuid, p_invitation_id uuid, p_expected_revision bigint) TO vortex_request;

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
  stored record; claimed jsonb;
  evidence vortex_access.capability_limit_changes%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
  resulting_revision bigint;
  activity_subjects uuid[];
  activity_result text;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null
      and not vortex_platform.is_non_nil_uuid(p_organization_id::text))
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
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
    or (p_activity_id is not null and not vortex_platform.is_non_nil_uuid(p_activity_id::text)) then
    raise exception using errcode = '22023', message = 'Capability allocation is invalid';
  end if;
  -- The acting person comes only from the bound request context, and the
  -- Authority is the dedicated tenant allocation permission. An organisation
  -- role, delegation or organisation administrator cannot supply it.
  actor_identity_id := vortex_identity.tenant_request_actor_id();
  request_correlation_id := (vortex_platform.current_context() ->> 'correlationId')::uuid;
  perform 1 from vortex_identity.tenants tenant where tenant.tenant_id = p_tenant_id for no key update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  evaluated_at := pg_catalog.clock_timestamp();
  perform vortex_identity.require_current_tenant_capability(
    actor_identity_id, p_tenant_id, 'platform.tenant.capability_limits.allocate', evaluated_at
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
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'set_capability_limit_allocation', p_duplicate_key, null,
    p_tenant_id, actor_identity_id, 'Capability allocation duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint
      or stored."subjectIds" <> array[p_assignment_id] then
      raise exception using errcode = 'V3001', message = 'Capability allocation duplicate conflicts';
    end if;
    select change.* into evidence
    from vortex_access.capability_limit_changes as change
    where change.change_id = stored."receiptId";
    if not found then
      raise exception using errcode = '42501', message = 'Capability allocation replay is unavailable';
    end if;
    return query select 'replayed'::text, evidence.assignment_id, evidence.tenant_id,
      evidence.organization_id, evidence.capability_key, evidence.unit,
      evidence.quantity_limit, evidence.policy_id, evidence.policy_revision,
      evidence.assignment_revision, stored."receiptId", stored."acceptedAt";
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
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', correlation,
      'acceptedAt', evaluated_at, 'subjectIds', pg_catalog.to_jsonb(array[p_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', command_fingerprint, 'clusterId', null));
  insert into vortex_access.capability_limit_changes(
    change_id, tenant_id, organization_id, change_kind, actor_kind, actor_id,
    policy_id, policy_revision, assignment_id, assignment_revision,
    capability_key, unit, quantity_limit, expires_at, source, correlation_id, occurred_at
  ) values (
    correlation, p_tenant_id, p_organization_id,
    case when resulting_revision = 1 then 'allocation_set' else 'allocation_revised' end,
    'tenant_administrator', actor_identity_id, live_ceiling.policy_id, live_ceiling.policy_revision,
    p_assignment_id, resulting_revision, p_capability_key, p_unit, p_quantity_limit,
    p_expires_at, vortex_platform.channel(), request_correlation_id, evaluated_at
  );
  if p_organization_id is not null then
    select pg_catalog.array_agg(distinct subject.subject_id order by subject.subject_id)
    into activity_subjects
    from pg_catalog.unnest(array[p_assignment_id, live_ceiling.policy_id]) as subject(subject_id);
    activity_result := vortex_record.append_organization_activity_entry(
      p_organization_id, p_activity_id, evaluated_at, 'identity', actor_identity_id,
      'set_capability_limit_allocation', activity_subjects, array[]::uuid[],
      vortex_platform.channel(), request_correlation_id, 'completed'
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
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.set_capability_limit_allocation(
  uuid, uuid, uuid, uuid, text, text, numeric, timestamptz, bigint, uuid
) to vortex_request;

comment on function vortex_access.set_capability_limit_allocation(
  uuid, uuid, uuid, uuid, text, text, numeric, timestamptz, bigint, uuid
) is
  'Tenant capability-limits allocation permission command that allocates, or revises in place, a tenant-wide or organisation limit for one capability, refused above the live platform ceiling; it writes an accepted receipt, append-only change evidence and, for an organisation, content-free Activity.';

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
  context_value jsonb;
  actor_kind_value text := 'platform_operator';
  actor_id_value uuid := p_operator_actor_id;
  source_value text := 'system';
  actor_identity_id uuid;
  active_assignment_id uuid;
  policy vortex_access.capability_policy_definitions%rowtype;
  target vortex_access.capability_policy_assignments%rowtype;
  stored record; claimed jsonb;
  evidence vortex_access.capability_limit_changes%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
  resulting_revision bigint;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
    or p_policy_id is null or not vortex_platform.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision is null or p_policy_revision not between 1 and 9007199254740991
    or p_starts_at is null or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)))
    or (p_expected_revision is not null
      and p_expected_revision not between 1 and 9007199254740990) then
    raise exception using errcode = '22023', message = 'Capability ceiling is invalid';
  end if;
  if p_operator_actor_id is not null then
    -- The configured system operator remains a context-free bootstrap caller.
    perform vortex_access.require_platform_operator_internal(p_operator_actor_id);
  else
    context_value := vortex_access.validated_human_request_context();
    actor_identity_id := (context_value ->> 'identityId')::uuid;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('vortex.super_administrator.assignments', 0)
    );
    perform 1
    from vortex_identity.identity_projections as identity
    where identity.identity_id = actor_identity_id
      and identity.state = 'active'
    for share;
    if not found then
      raise exception using errcode = 'V3141',
        message = 'Capability ceiling authority is unavailable';
    end if;
    evaluated_at := pg_catalog.clock_timestamp();
    active_assignment_id :=
      vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
        actor_identity_id, evaluated_at
      );
    if active_assignment_id is null then
      raise exception using errcode = 'V3141',
        message = 'Capability ceiling authority is unavailable';
    end if;
    if vortex_access.recent_authentication_deadline_internal(
      context_value, evaluated_at,
      '{"kind":"primary","maximumAgeSeconds":900}'::jsonb
    ) is null then
      raise exception using errcode = 'V3142',
        message = 'A recent sign-in is required for capability ceiling changes';
    end if;
    actor_kind_value := 'identity';
    actor_id_value := actor_identity_id;
    source_value := coalesce(context_value ->> 'channel', 'web');
    correlation := (context_value ->> 'correlationId')::uuid;
  end if;
  if actor_kind_value = 'identity' then
    -- The selected organisation is only the request anchor. The target tenant
    -- is independently checked and may have no active organisation.
    perform 1 from vortex_identity.tenants tenant
    where tenant.tenant_id = p_tenant_id and tenant.state = 'active'
    for no key update;
  else
    perform 1 from vortex_identity.tenants tenant
    where tenant.tenant_id = p_tenant_id
    for no key update;
  end if;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'set_capability_policy_ceiling',
      p_tenant_id::text, p_assignment_id::text, p_policy_id::text, p_policy_revision::text,
      p_starts_at::text, coalesce(p_expires_at::text, ''),
      coalesce(p_expected_revision::text, '')), 'UTF8'), 'sha256'), 'hex');
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'set_capability_policy_ceiling', p_duplicate_key, null,
    p_tenant_id, actor_id_value, 'Capability ceiling duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint
      or stored."subjectIds" <> array[p_assignment_id] then
      raise exception using errcode = 'V3001', message = 'Capability ceiling duplicate conflicts';
    end if;
    select change.* into evidence
    from vortex_access.capability_limit_changes as change
    where change.change_id = stored."receiptId";
    if not found
      or evidence.actor_kind is distinct from actor_kind_value
      or evidence.actor_id is distinct from actor_id_value
      or evidence.tenant_id is distinct from p_tenant_id
      or evidence.assignment_id is distinct from p_assignment_id
      or evidence.assignment_revision is distinct from stored."subjectRevisions"[1]
      or evidence.change_kind not in ('ceiling_set', 'ceiling_revised')
      or evidence.correlation_id is distinct from stored."receiptId" then
      raise exception using errcode = '42501', message = 'Capability ceiling replay is unavailable';
    end if;
    return query select 'replayed'::text, evidence.assignment_id, evidence.tenant_id,
      evidence.policy_id, evidence.policy_revision, evidence.capability_key, evidence.unit,
      evidence.quantity_limit, evidence.assignment_revision, stored."receiptId",
      stored."acceptedAt";
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
      evaluated_at, actor_id_value, correlation, evaluated_at, actor_id_value,
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
        changed_at = evaluated_at, changed_by_actor_id = actor_id_value,
        change_correlation_id = correlation
    where assignment.assignment_id = p_assignment_id;
  end if;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', correlation,
      'acceptedAt', evaluated_at, 'subjectIds', pg_catalog.to_jsonb(array[p_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', command_fingerprint, 'clusterId', null));
  insert into vortex_access.capability_limit_changes(
    change_id, tenant_id, organization_id, change_kind, actor_kind, actor_id,
    policy_id, policy_revision, assignment_id, assignment_revision,
    capability_key, unit, quantity_limit, expires_at, source, correlation_id, occurred_at
  ) values (
    correlation, p_tenant_id, null,
    case when resulting_revision = 1 then 'ceiling_set' else 'ceiling_revised' end,
    actor_kind_value, actor_id_value, p_policy_id, p_policy_revision,
    p_assignment_id, resulting_revision, policy.capability_key, policy.unit,
    policy.quantity_limit, p_expires_at, source_value, correlation, evaluated_at
  );
  return query select 'accepted'::text, p_assignment_id, p_tenant_id, p_policy_id,
    p_policy_revision, policy.capability_key, policy.unit, policy.quantity_limit,
    resulting_revision, correlation, evaluated_at;
end
$function$;

revoke execute on function vortex_access.set_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_access.set_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, bigint
) to vortex_runtime, vortex_request;

comment on function vortex_access.set_capability_policy_ceiling(
  uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz, bigint
) is
  'Sets or re-pins a tenant capability ceiling to an exact policy revision. The configured system operator retains its context-free bootstrap path; an active named Vortex super administrator may act as a verified person with recent primary authentication, using the selected organisation only as an account-bound request anchor and independently checking an active target tenant. Both paths write an accepted receipt and append-only change evidence.';

create or replace function vortex_access.suspend_organization_account_for_administration(
  p_duplicate_key uuid, p_organization_account_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text, operation text, organization_id uuid,
  organization_account_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz, access_version bigint
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  scope record;
  stored record; claimed jsonb;
  target record; changed record; command_fingerprint text;
  subject_ids uuid[]; subject_revisions bigint[];
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_organization_account_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Account suspension command is invalid';
  end if;
  select authorized.* into strict scope
  from vortex_access.organization_accounts_administration_change_scope() as authorized;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'suspend_organization_account',
      scope.organization_id::text, p_organization_account_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'suspend_organization_account', p_duplicate_key, scope.organization_id,
    scope.tenant_id, scope.organization_account_id, 'Administration duplicate conflicts');
  if claimed is not null then
    select r.* into stored from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid);
    if stored."fingerprint" <> command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if pg_catalog.cardinality(stored."subjectIds") <> 2
      or not scope.organization_id = any(stored."subjectIds")
      or not p_organization_account_id = any(stored."subjectIds") then
      raise exception using errcode = '42501', message = 'Account suspension receipt is unavailable';
    end if;
    return query select 'replayed'::text, 'suspend_organization_account'::text,
      scope.organization_id, p_organization_account_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", p_organization_account_id)],
      stored."receiptId", stored."acceptedAt",
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", scope.organization_id)];
    return;
  end if;
  -- Lock order: organization access version, then the account row, the same
  -- order invitation acceptance uses.
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = scope.organization_id
  for update;
  select account.state, account.revision into target
  from vortex_identity.organization_accounts as account
  where account.organization_id = scope.organization_id
    and account.organization_account_id = p_organization_account_id
  for update;
  if not found or target.state <> 'active' or target.revision <> p_expected_revision
    or p_expected_revision = 9007199254740991 then
    raise exception using errcode = '40001', message = 'Account suspension is stale or unavailable';
  end if;
  select result.* into strict changed
  from vortex_access.change_organization_account_state(
    p_organization_account_id, p_expected_revision, 'suspended'
  ) as result;
  if changed.organization_id <> scope.organization_id
    or changed.organization_account_id <> p_organization_account_id
    or changed.state <> 'suspended' or changed.revision <> p_expected_revision + 1
    or changed.access_version <> scope.access_version + 1 then
    raise exception using errcode = '42501', message = 'Account suspension result is unavailable';
  end if;
  if scope.organization_id < p_organization_account_id then
    subject_ids := array[scope.organization_id, p_organization_account_id];
    subject_revisions := array[changed.access_version, changed.revision];
  else
    subject_ids := array[p_organization_account_id, scope.organization_id];
    subject_revisions := array[changed.revision, changed.access_version];
  end if;
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object('receiptId', changed.state_change_correlation_id,
      'acceptedAt', changed.changed_at, 'subjectIds', pg_catalog.to_jsonb(subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(subject_revisions),
      'fingerprint', command_fingerprint, 'clusterId', null));
  return query select 'accepted'::text, 'suspend_organization_account'::text,
    scope.organization_id, p_organization_account_id, changed.revision,
    changed.state_change_correlation_id, changed.changed_at, changed.access_version;
end
$function$;

comment on function vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) is
  'Protected active-to-suspended account command using the existing guarded owner and accepted receipt.';

revoke execute on function
  vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function
  vortex_access.suspend_organization_account_for_administration(uuid, uuid, bigint) to vortex_request;

create or replace function vortex_identity.adopt_organization(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_steward_identity_id uuid,
  p_organization_account_id uuid
)
returns table (
  outcome text,
  operation text,
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid,
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
  stored record;
  claimed jsonb;
  requirement vortex_access.organization_stewardship_requirements%rowtype;
  account_revision bigint;
  new_role_id uuid := pg_catalog.gen_random_uuid();
  new_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_delegation_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  operation_at timestamptz := pg_catalog.clock_timestamp();
  resulting_access_version bigint;
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  authoritative_tenant_id uuid;
  authoritative_organization_id uuid;
  authoritative_account_id uuid;
begin
  if not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or not vortex_platform.is_non_nil_uuid(p_steward_identity_id::text)
    or not vortex_platform.is_non_nil_uuid(p_organization_account_id::text)
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Organization adoption input is invalid';
  end if;

  -- This is deliberately an unlocked eligibility probe. Existing request
  -- resolution locks Access first and then authoritatively locks Identity, so
  -- adoption must follow that same order.
  perform 1
  from vortex_identity.organizations as organization
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where organization.organization_id = p_organization_id
    and organization.tenant_id = p_tenant_id
    and organization.state = 'active'
    and tenant.state = 'active';
  if not found then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  perform 1 from vortex_access.initialize_organization_access_version(
    p_organization_id, p_operator_actor_id, new_correlation_id
  );
  perform 1
  from vortex_access.organization_access_versions as version
  where version.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'adopt_organization', p_duplicate_key, null, p_tenant_id, p_operator_actor_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    if not stored."subjectIds" @> array[p_organization_id, p_organization_account_id] then
      raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
    end if;
    return query select 'replayed'::text, 'adopt_organization'::text,
      p_tenant_id, p_organization_id, p_organization_account_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", p_organization_id)],
      stored."receiptId", stored."acceptedAt";
    return;
  end if;

  if exists (
    select 1
    where vortex_record.command_receipt_subject_exists_internal(
      'adopt_organization', p_tenant_id, p_organization_id, p_duplicate_key
    )
  ) then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    p_organization_id, p_operator_actor_id, new_correlation_id
  );

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id, account.revision
  into authoritative_tenant_id, authoritative_organization_id,
    authoritative_account_id, account_revision
  from vortex_identity.resolve_active_organization_account(
    p_steward_identity_id, p_organization_id
  ) as scope
  join vortex_identity.organization_accounts as account
    on account.organization_account_id = scope.organization_account_id;
  if not found or authoritative_account_id is distinct from p_organization_account_id then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;
  if authoritative_tenant_id is distinct from p_tenant_id
    or authoritative_organization_id is distinct from p_organization_id then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  select current_requirement.* into requirement
  from vortex_access.organization_stewardship_requirements as current_requirement
  where current_requirement.organization_id = p_organization_id
  for update;
  if found then
    if requirement.original_organization_account_id <> p_organization_account_id then
      raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
    end if;
    select adopted.access_version into resulting_access_version
    from vortex_access.coordinate_organization_stewardship_adoption(
      p_organization_id, p_organization_account_id,
      requirement.original_role_id, 'organization_steward',
      'Organisation steward', 'Permanent minimum organisation administration.',
      requirement.original_role_assignment_id,
      requirement.original_delegation_authority_id,
      requirement.adopted_by, requirement.adoption_correlation_id
    ) as adopted;
  else
    select adopted.access_version into resulting_access_version
    from vortex_access.coordinate_organization_stewardship_adoption(
      p_organization_id, p_organization_account_id, new_role_id,
      'organization_steward', 'Organisation steward',
      'Permanent minimum organisation administration.',
      new_role_assignment_id, new_delegation_id, p_operator_actor_id,
      new_correlation_id
    ) as adopted;
  end if;

  -- #33 queues this evidence trigger. Validate it while the privileged boundary
  -- is still active so a runtime-role commit cannot bypass or fail its reads.
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
    (p_organization_id, resulting_access_version),
    (p_organization_account_id, account_revision)
  ) as result(subject_id, subject_revision);
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', operation_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
  );
  return query select 'accepted'::text, 'adopt_organization'::text,
    p_tenant_id, p_organization_id, p_organization_account_id,
    resulting_access_version, new_correlation_id, operation_at;
end
$function$;

revoke execute on function vortex_identity.adopt_organization(uuid,uuid,text,uuid,uuid,uuid,uuid) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.adopt_organization(uuid,uuid,text,uuid,uuid,uuid,uuid) to vortex_runtime;

comment on function vortex_identity.adopt_organization(uuid,uuid,text,uuid,uuid,uuid,uuid) is 'Configured-system-only explicit organisation stewardship adoption through the existing Access coordinator.';

alter function vortex_identity.adopt_organization(uuid,uuid,text,uuid,uuid,uuid,uuid) owner to postgres;

create or replace function vortex_identity.adopt_tenant(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_tenant_steward_identity_id uuid
)
returns table (
  outcome text,
  operation text,
  tenant_id uuid,
  tenant_administrator_assignment_id uuid,
  tenant_administrator_assignment_revision bigint,
  correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  stored record;
  claimed jsonb;
  tenant_revision bigint;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  operation_at timestamptz := pg_catalog.clock_timestamp();
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  replay_assignment_id uuid;
begin
  if not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or not vortex_platform.is_non_nil_uuid(p_tenant_steward_identity_id::text)
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Tenant adoption input is invalid';
  end if;

  select tenant.revision into tenant_revision
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id and tenant.state = 'active'
  for update;
  if not found then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'adopt_tenant', p_duplicate_key, null, p_tenant_id, p_operator_actor_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    select assignment.assignment_id into replay_assignment_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.assignment_id = any(stored."subjectIds");
    if replay_assignment_id is null then
      raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
    end if;
    return query select 'replayed'::text, 'adopt_tenant'::text, p_tenant_id,
      replay_assignment_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_assignment_id)],
      stored."receiptId", stored."acceptedAt";
    return;
  end if;

  if exists (
    select 1
    where vortex_record.command_receipt_subject_exists_internal(
        'adopt_tenant', p_tenant_id, null, p_duplicate_key
      )
      or vortex_record.command_receipt_subject_exists_internal(
        'provision_tenant', null, p_tenant_id, p_duplicate_key
      )
  ) then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end if;

  perform 1 from vortex_identity.identity_projections as projection
  where projection.identity_id = p_tenant_steward_identity_id
    and projection.state = 'active'
  for update;
  if not found then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;

  if exists (
    select 1
    from vortex_identity.organizations as organization
    where organization.tenant_id = p_tenant_id
      and organization.state = 'active'
      and not vortex_access.organization_has_permanent_steward(
        organization.organization_id, operation_at
      )
  ) then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;

  insert into vortex_identity.tenant_administrator_assignments (
    assignment_id, tenant_id, identity_id, capability_keys, starts_at,
    expires_at, revision, granted_at, granted_by_actor_id,
    grant_correlation_id, changed_at, changed_by_actor_id, change_correlation_id
  ) values (
    new_assignment_id, p_tenant_id, p_tenant_steward_identity_id,
    array[
      'platform.tenant.administrators.manage',
      'platform.tenant.administrators.read',
      'platform.tenant.hierarchy.read',
      'platform.tenant.organizations.create',
      'platform.tenant.organizations.lifecycle',
      'platform.tenant.organizations.rename',
      'platform.tenant.organizations.reparent'
    ], operation_at, null, 1, operation_at, p_operator_actor_id,
    new_correlation_id, operation_at, p_operator_actor_id, new_correlation_id
  );

  select pg_catalog.array_agg(subject_id order by subject_id),
    pg_catalog.array_agg(subject_revision order by subject_id)
  into result_subject_ids, result_subject_revisions
  from (values (p_tenant_id, tenant_revision), (new_assignment_id, 1::bigint))
    as result(subject_id, subject_revision);
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', operation_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
  );
  return query select 'accepted'::text, 'adopt_tenant'::text, p_tenant_id,
    new_assignment_id, 1::bigint, new_correlation_id, operation_at;
end
$function$;

revoke execute on function vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid) to vortex_runtime;

comment on function vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid) is 'Configured-system-only explicit tenant stewardship adoption; it creates no organisation authority.';

alter function vortex_identity.adopt_tenant(uuid,uuid,text,uuid,uuid) owner to postgres;

create or replace function vortex_identity.apply_configured_cluster_identity_lifecycle(
  p_operation text,
  p_cluster_id uuid,
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_identity_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  identity_id uuid,
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
  stored record;
  claimed jsonb;
  initial_organization_ids uuid[];
  current_organization_ids uuid[];
  initial_tenant_ids uuid[];
  current_tenant_ids uuid[];
  current_state text;
  current_revision bigint;
  current_changed_at timestamptz;
  required_source_state text;
  resulting_state text;
  resulting_revision bigint;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  evaluated_at timestamptz;
  persisted_state_changed_at timestamptz;
begin
  if p_operation not in (
      'suspend_cluster_identity',
      'reactivate_cluster_identity',
      'close_cluster_identity'
    )
    or p_cluster_id is null
    or not vortex_platform.is_non_nil_uuid(p_cluster_id::text)
    or p_operator_actor_id is null
    or not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text)
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Cluster identity lifecycle command is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_operator_actor_id::text || '|' || p_cluster_id::text || '|' ||
      p_operation || '|' || p_duplicate_key::text,
    30
  ));

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    p_operation, p_duplicate_key, null, null, p_operator_actor_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint
      or not stored."subjectIds" @> array[p_identity_id] then
      raise exception using errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, p_operation, p_identity_id,
      stored."subjectRevisions"[
        pg_catalog.array_position(stored."subjectIds", p_identity_id)
      ], stored."receiptId", stored."acceptedAt";
    return;
  end if;

  select coalesce(
    pg_catalog.array_agg(distinct account.organization_id order by account.organization_id),
    array[]::uuid[]
  ) into initial_organization_ids
  from vortex_identity.organization_accounts as account
  where account.identity_id = p_identity_id;

  select coalesce(
    pg_catalog.array_agg(distinct affected.tenant_id order by affected.tenant_id),
    array[]::uuid[]
  ) into initial_tenant_ids
  from (
    select organization.tenant_id
    from vortex_identity.organization_accounts as account
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    where account.identity_id = p_identity_id
    union
    select assignment.tenant_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.identity_id = p_identity_id
  ) as affected;

  perform 1
  from vortex_access.organization_access_versions as governance
  where governance.organization_id = any(initial_organization_ids)
  order by governance.organization_id
  for update;

  perform 1
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = any(initial_tenant_ids)
  order by tenant.tenant_id
  for update;

  select projection.state, projection.revision, projection.state_changed_at
  into current_state, current_revision, current_changed_at
  from vortex_identity.identity_projections as projection
  where projection.identity_id = p_identity_id
  for update;
  if not found then
    raise exception using errcode = 'V3003',
      message = 'Administration scope is unavailable';
  end if;

  select coalesce(
    pg_catalog.array_agg(distinct account.organization_id order by account.organization_id),
    array[]::uuid[]
  ) into current_organization_ids
  from vortex_identity.organization_accounts as account
  where account.identity_id = p_identity_id;

  select coalesce(
    pg_catalog.array_agg(distinct affected.tenant_id order by affected.tenant_id),
    array[]::uuid[]
  ) into current_tenant_ids
  from (
    select organization.tenant_id
    from vortex_identity.organization_accounts as account
    join vortex_identity.organizations as organization
      on organization.organization_id = account.organization_id
    where account.identity_id = p_identity_id
    union
    select assignment.tenant_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.identity_id = p_identity_id
  ) as affected;

  if current_organization_ids is distinct from initial_organization_ids
    or current_tenant_ids is distinct from initial_tenant_ids then
    raise exception using errcode = 'V3102',
      message = 'Cluster identity scope changed while the command waited';
  end if;

  if current_revision <> p_expected_revision
    or current_revision >= 9007199254740991 then
    raise exception using errcode = 'V3102',
      message = 'Identity projection revision is stale';
  end if;

  case p_operation
    when 'suspend_cluster_identity' then
      required_source_state := 'active';
      resulting_state := 'suspended';
    when 'reactivate_cluster_identity' then
      required_source_state := 'suspended';
      resulting_state := 'active';
    when 'close_cluster_identity' then
      if current_state not in ('active', 'suspended') then
        raise exception using errcode = 'V3003',
          message = 'Administration scope is unavailable';
      end if;
      resulting_state := 'closed';
  end case;
  if required_source_state is not null and current_state <> required_source_state then
    raise exception using errcode = 'V3003',
      message = 'Administration scope is unavailable';
  end if;

  -- Eligibility is always evaluated against a fresh database observation made
  -- after every governance and projection lock. A future-skewed audit value is
  -- compatible with the projection trigger, but never grants future authority.
  evaluated_at := pg_catalog.clock_timestamp();
  persisted_state_changed_at := greatest(evaluated_at, current_changed_at);
  resulting_revision := current_revision + 1;
  update vortex_identity.identity_projections as projection
  set state = resulting_state,
    state_changed_at = persisted_state_changed_at,
    state_changed_by = p_operator_actor_id,
    state_change_correlation_id = new_correlation_id,
    revision = resulting_revision
  where projection.identity_id = p_identity_id;

  if exists (
    select 1
    from vortex_access.organization_stewardship_requirements as requirement
    where requirement.organization_id = any(current_organization_ids)
      and not vortex_access.organization_has_permanent_steward(
        requirement.organization_id, evaluated_at
      )
  ) then
    raise exception using errcode = 'V3002',
      message = 'Permanent organisation steward is required';
  end if;

  if exists (
    select 1
    from pg_catalog.unnest(current_tenant_ids) as affected(tenant_id)
    where (
        vortex_record.command_receipt_subject_exists_internal(
          'adopt_tenant', affected.tenant_id, null, p_duplicate_key
        )
        or vortex_record.command_receipt_subject_exists_internal(
          'provision_tenant', null, affected.tenant_id, p_duplicate_key
        )
      )
      and not vortex_identity.tenant_has_permanent_manager(
        affected.tenant_id, evaluated_at
      )
  ) then
    raise exception using errcode = 'V3002',
      message = 'Permanent tenant manager is required';
  end if;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_identity_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', p_cluster_id
    )
  );

  return query select 'accepted'::text, p_operation, p_identity_id,
    resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) to vortex_owner;

comment on function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) is 'Private exact composition for the three configured-system cluster-local identity lifecycle commands.';

alter function vortex_identity.apply_configured_cluster_identity_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) owner to postgres;

create or replace function vortex_identity.apply_configured_tenant_lifecycle(
  p_operation text,
  p_cluster_id uuid,
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  operation text,
  tenant_id uuid,
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
  stored record;
  claimed jsonb;
  initial_organization_ids uuid[];
  current_organization_ids uuid[];
  current_state text;
  current_revision bigint;
  current_state_changed_at timestamptz;
  required_source_state text;
  resulting_state text;
  resulting_revision bigint;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  evaluated_at timestamptz;
  persisted_state_changed_at timestamptz;
begin
  if p_operation not in ('suspend_tenant', 'reactivate_tenant')
    or p_cluster_id is null
    or not vortex_platform.is_non_nil_uuid(p_cluster_id::text)
    or p_operator_actor_id is null
    or not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Configured tenant lifecycle command is invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_operator_actor_id::text || '|' || p_cluster_id::text || '|' ||
      p_operation || '|' || p_duplicate_key::text,
    30
  ));

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    p_operation, p_duplicate_key, null, null, p_operator_actor_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint
      or stored."subjectIds" <> array[p_tenant_id] then
      raise exception using errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, p_operation, p_tenant_id,
      stored."subjectRevisions"[1], stored."receiptId", stored."acceptedAt";
    return;
  end if;

  select coalesce(
    pg_catalog.array_agg(organization.organization_id order by organization.organization_id),
    array[]::uuid[]
  ) into initial_organization_ids
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id;

  perform 1
  from vortex_access.organization_access_versions as governance
  where governance.organization_id = any(initial_organization_ids)
  order by governance.organization_id
  for update;

  select tenant.state, tenant.revision, tenant.state_changed_at
  into current_state, current_revision, current_state_changed_at
  from vortex_identity.tenants as tenant
  where tenant.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception using errcode = 'V3003',
      message = 'Administration scope is unavailable';
  end if;

  select coalesce(
    pg_catalog.array_agg(organization.organization_id order by organization.organization_id),
    array[]::uuid[]
  ) into current_organization_ids
  from vortex_identity.organizations as organization
  where organization.tenant_id = p_tenant_id;

  if current_organization_ids is distinct from initial_organization_ids then
    raise exception using errcode = 'V3102',
      message = 'Tenant organisation scope changed while the command waited';
  end if;

  if current_revision <> p_expected_revision
    or current_revision >= 9007199254740991 then
    raise exception using errcode = 'V3102',
      message = 'Tenant revision is stale';
  end if;

  case p_operation
    when 'suspend_tenant' then
      required_source_state := 'active';
      resulting_state := 'suspended';
    when 'reactivate_tenant' then
      required_source_state := 'suspended';
      resulting_state := 'active';
  end case;
  if current_state <> required_source_state then
    raise exception using errcode = 'V3003',
      message = 'Administration scope is unavailable';
  end if;

  -- Authority readiness always uses a fresh observation after all scope locks.
  -- A future-skewed existing audit value is only clamped for persistence.
  evaluated_at := pg_catalog.clock_timestamp();
  persisted_state_changed_at := greatest(evaluated_at, current_state_changed_at);

  if p_operation = 'reactivate_tenant' then
    if (
        vortex_record.command_receipt_subject_exists_internal(
          'adopt_tenant', p_tenant_id, null, p_duplicate_key
        )
        or vortex_record.command_receipt_subject_exists_internal(
          'provision_tenant', null, p_tenant_id, p_duplicate_key
        )
      )
      and not vortex_identity.tenant_has_permanent_manager(
        p_tenant_id, evaluated_at
      ) then
      raise exception using errcode = 'V3002',
        message = 'Permanent tenant manager is required';
    end if;

    if exists (
      select 1
      from vortex_access.organization_stewardship_requirements as requirement
      join vortex_identity.organizations as organization
        on organization.organization_id = requirement.organization_id
      where organization.tenant_id = p_tenant_id
        and not vortex_access.organization_has_permanent_steward(
          requirement.organization_id, evaluated_at
        )
    ) then
      raise exception using errcode = 'V3002',
        message = 'Permanent organisation steward is required';
    end if;
  end if;

  resulting_revision := current_revision + 1;
  update vortex_identity.tenants as tenant
  set state = resulting_state,
    state_changed_at = persisted_state_changed_at,
    revision = resulting_revision
  where tenant.tenant_id = p_tenant_id;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_tenant_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', p_cluster_id
    )
  );

  return query select 'accepted'::text, p_operation, p_tenant_id,
    resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) to vortex_owner;

comment on function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) is 'Private exact composition for configured-system tenant suspension and reactivation.';

alter function vortex_identity.apply_configured_tenant_lifecycle(text,uuid,uuid,uuid,text,uuid,bigint) owner to postgres;

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
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
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

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'archive_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'archive_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
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

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
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
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.archive_tenant_organization(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.archive_tenant_organization(uuid, text, uuid, uuid, bigint) is
  'Protected terminal organisation archive with no unresolved direct child, under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.archive_tenant_organization(uuid,text,uuid,uuid,bigint) owner to postgres;

create or replace function vortex_identity.bootstrap_vortex_super_administrator(
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_identity_id uuid
)
returns table (
  outcome text,
  assignment_id uuid,
  identity_id uuid,
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
  claimed jsonb;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  evaluated_at timestamptz;
  computed_fingerprint text;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text) then
    raise exception using errcode = '22023',
      message = 'Super-administrator bootstrap command is invalid';
  end if;

  perform vortex_access.require_platform_operator_internal(p_operator_actor_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vortex.super_administrator.assignments', 0)
  );
  computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'bootstrap', p_identity_id::text), 'UTF8'),
    'sha256'
  ), 'hex');

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'vortex_super_administrator_bootstrap', p_duplicate_key, null, null, p_operator_actor_id,
    'Super-administrator bootstrap duplicate conflicts', 'V3143'
  );
  if claimed is not null then
    if claimed ->> 'fingerprint' <> computed_fingerprint then
      raise exception using errcode = 'V3143',
        message = 'Super-administrator bootstrap duplicate conflicts';
    end if;
    return query select 'replayed'::text, (claimed ->> 'assignmentId')::uuid,
      p_identity_id, (claimed ->> 'revision')::bigint,
      (claimed ->> 'correlationId')::uuid, (claimed ->> 'acceptedAt')::timestamptz;
    return;
  end if;

  perform 1
  from vortex_identity.identity_projections as identity
  where identity.identity_id = p_identity_id
    and identity.state = 'active'
  for share;
  if not found then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator identity is unavailable';
  end if;

  perform 1
  from vortex_identity.vortex_super_administrator_assignments as assignment
  for update;
  if found then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator bootstrap is available only for the first assignment';
  end if;

  evaluated_at := pg_catalog.clock_timestamp();
  insert into vortex_identity.vortex_super_administrator_assignments (
    assignment_id, identity_id, revision, granted_at, granted_by_kind,
    granted_by_id, grant_correlation_id, changed_at, changed_by_kind,
    changed_by_id, change_correlation_id
  ) values (
    new_assignment_id, p_identity_id, 1, evaluated_at,
    'configured_system_operator', p_operator_actor_id, new_correlation_id,
    evaluated_at, 'configured_system_operator', p_operator_actor_id,
    new_correlation_id
  );

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key, pg_catalog.jsonb_build_object(
      'fingerprint', computed_fingerprint, 'assignmentId', new_assignment_id, 'revision', 1,
      'correlationId', new_correlation_id, 'acceptedAt', evaluated_at
    )
  );

  return query select 'accepted'::text, new_assignment_id, p_identity_id,
    1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke all on function vortex_identity.bootstrap_vortex_super_administrator(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.bootstrap_vortex_super_administrator(uuid, uuid, uuid)
  to vortex_runtime;

comment on function vortex_identity.bootstrap_vortex_super_administrator(uuid, uuid, uuid) is
  'Bootstraps the first named super-administrator assignment through the existing configured system operator.';

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
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
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
      where vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          actor_identity_id, evaluated_at
        ) is null
        and not exists (
          select 1 from vortex_identity.tenant_administrator_assignments a
        where a.tenant_id = p_tenant_id and a.identity_id = actor_identity_id
          and a.revoked_at is null and a.starts_at <= evaluated_at
          and (a.expires_at is null or a.expires_at > evaluated_at)
          and (
            c = any(a.capability_keys)
            or c = 'platform.tenant.capability_limits.read'
          )
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
      vortex_platform.format_timestamp_utc(p_starts_at),
      coalesce(vortex_platform.format_timestamp_utc(p_expires_at), '')),
      'UTF8'), 'sha256'), 'hex');
  select a.revision, a.revoked_at into current_revision, current_revoked_at
  from vortex_identity.tenant_administrator_assignments a
  where a.assignment_id = p_assignment_id and a.tenant_id = p_tenant_id;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'change_tenant_administrator', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> computed_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'change_tenant_administrator'::text,
      p_assignment_id, stored."subjectRevisions"[1], stored."receiptId",
      stored."acceptedAt";
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
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', computed_fingerprint, 'clusterId', null::uuid
    )
  );
  return query select 'accepted'::text, 'change_tenant_administrator'::text,
    p_assignment_id, resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.change_tenant_administrator(uuid, text, uuid, uuid, bigint, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator change under the bound request context person''s current structural authority, with database-computed command fingerprint, self-grant refusal, grantor-bounded expiry, exact revision and accepted replay.';

alter function vortex_identity.change_tenant_administrator(uuid,text,uuid,uuid,bigint,jsonb,timestamp with time zone,timestamp with time zone) owner to postgres;

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
  stored record;
  claimed jsonb;
  new_organization_id uuid := pg_catalog.gen_random_uuid();
  new_account_id uuid := pg_catalog.gen_random_uuid();
  new_role_id uuid := pg_catalog.gen_random_uuid();
  new_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_delegation_id uuid := pg_catalog.gen_random_uuid();
  new_group_id uuid := pg_catalog.gen_random_uuid();
  new_membership_id uuid := pg_catalog.gen_random_uuid();
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
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or (p_parent_organization_id is not null
      and not vortex_platform.is_non_nil_uuid(p_parent_organization_id::text))
    or p_organization_steward_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_steward_identity_id::text)
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

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'create_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    select organization.organization_id
    into replay_organization_id
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored."subjectIds");
    select account.organization_account_id
    into replay_account_id
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = any(stored."subjectIds");
    if replay_organization_id is null or replay_account_id is null then
      raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
    end if;
    return query
    select 'replayed'::text,
      'create_tenant_organization'::text,
      replay_organization_id,
      1::bigint,
      replay_account_id,
      stored."subjectRevisions"[
        pg_catalog.array_position(stored."subjectIds", replay_account_id)
      ],
      stored."subjectRevisions"[
        pg_catalog.array_position(stored."subjectIds", replay_organization_id)
      ],
      stored."receiptId",
      stored."acceptedAt";
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

  -- The initial steward has one current Group for Group-owned records.
  perform 1 from vortex_access.coordinate_organization_group_change(
    'create_group', new_organization_id, new_group_id, null,
    'organisation_owners', 'Organisation owners', new_account_id,
    new_correlation_id
  );
  select changed.access_version into resulting_access_version
  from vortex_access.coordinate_organization_group_membership_change(
    'add_membership', new_organization_id, new_membership_id, null,
    new_group_id, new_account_id, evaluated_at, null, null,
    new_account_id, new_correlation_id
  ) as changed;

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

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
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
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text)
  to vortex_runtime;

comment on function vortex_identity.create_tenant_organization(uuid, text, uuid, uuid, text, text, uuid, text, text, text, text, text, text, text, text) is
  'Creates one tenant organisation for the bound request context person with an explicit existing steward, runtime settings, delivered Access composition and an initial current owner Group membership for that steward.';

alter function vortex_identity.create_tenant_organization(uuid,text,uuid,uuid,text,text,uuid,text,text,text,text,text,text,text,text) owner to postgres;

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
  stored record;
  claimed jsonb;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
begin
  capabilities := vortex_identity.tenant_capabilities_from_json(p_capabilities);
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_subject_identity_id is null or not vortex_platform.is_non_nil_uuid(p_subject_identity_id::text)
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
      vortex_platform.format_timestamp_utc(p_starts_at),
      coalesce(vortex_platform.format_timestamp_utc(p_expires_at), '')),
      'UTF8'), 'sha256'), 'hex');
  if not exists (
      select 1 from vortex_identity.identity_projections p
      where p.identity_id = p_subject_identity_id and p.state = 'active'
    ) or exists (
      select 1 from pg_catalog.unnest(capabilities) c
      where vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          actor_identity_id, evaluated_at
        ) is null
        and not exists (
          select 1 from vortex_identity.tenant_administrator_assignments a
        where a.tenant_id = p_tenant_id and a.identity_id = actor_identity_id
          and a.revoked_at is null and a.starts_at <= evaluated_at
          and (a.expires_at is null or a.expires_at > evaluated_at)
          and (
            c = any(a.capability_keys)
            or c = 'platform.tenant.capability_limits.read'
          )
      )
    ) then
    raise exception using errcode = 'V3101', message = 'Tenant operation is unavailable';
  end if;
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'grant_tenant_administrator', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> computed_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'grant_tenant_administrator'::text,
      stored."subjectIds"[1], stored."subjectRevisions"[1], stored."receiptId", stored."acceptedAt";
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
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[new_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[1::bigint]),
      'fingerprint', computed_fingerprint, 'clusterId', null::uuid
    )
  );
  return query select 'accepted'::text, 'grant_tenant_administrator'::text,
    new_assignment_id, 1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz)
  to vortex_runtime;

comment on function vortex_identity.grant_tenant_administrator(uuid, text, uuid, uuid, jsonb, timestamptz, timestamptz) is
  'Protected same-tenant tenant-administrator grant under the bound request context person''s current structural authority, with database-computed command fingerprint, self-grant refusal, grantor-bounded expiry and accepted replay.';

alter function vortex_identity.grant_tenant_administrator(uuid,text,uuid,uuid,jsonb,timestamp with time zone,timestamp with time zone) owner to postgres;

create or replace function vortex_identity.grant_vortex_super_administrator(
  p_duplicate_key uuid,
  p_identity_id uuid
)
returns table (
  outcome text,
  assignment_id uuid,
  identity_id uuid,
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
  context_value jsonb;
  actor_identity_id uuid;
  claimed jsonb;
  active_assignment_id uuid;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  evaluated_at timestamptz;
  computed_fingerprint text;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_identity_id is null
    or not vortex_platform.is_non_nil_uuid(p_identity_id::text) then
    raise exception using errcode = '22023',
      message = 'Super-administrator grant command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vortex.super_administrator.assignments', 0)
  );
  perform 1
  from vortex_identity.identity_projections as identity
  where identity.identity_id = actor_identity_id
    and identity.state = 'active'
  for share;
  if not found then
    raise exception using errcode = '42501',
      message = 'Super-administrator authority is unavailable';
  end if;

  select assignment.assignment_id into active_assignment_id
  from vortex_identity.vortex_super_administrator_assignments as assignment
  join vortex_identity.identity_projections as identity
    on identity.identity_id = assignment.identity_id
    and identity.state = 'active'
  where assignment.identity_id = actor_identity_id
    and assignment.revoked_at is null
  for share of assignment;
  if not found then
    raise exception using errcode = '42501',
      message = 'Super-administrator authority is unavailable';
  end if;

  perform 1
  from vortex_identity.identity_projections as identity
  where identity.identity_id = p_identity_id
    and identity.state = 'active'
  for share;
  if not found then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator identity is unavailable';
  end if;

  evaluated_at := pg_catalog.clock_timestamp();
  if vortex_access.recent_authentication_deadline_internal(
    context_value, evaluated_at,
    '{"kind":"primary","maximumAgeSeconds":900}'::jsonb
  ) is null then
    raise exception using errcode = 'V3142',
      message = 'A recent sign-in is required for super-administrator changes';
  end if;

  computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'grant', p_identity_id::text), 'UTF8'),
    'sha256'
  ), 'hex');
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'vortex_super_administrator_grant', p_duplicate_key, null, null, actor_identity_id,
    'Super-administrator grant duplicate conflicts', 'V3143'
  );
  if claimed is not null then
    if claimed ->> 'fingerprint' <> computed_fingerprint then
      raise exception using errcode = 'V3143',
        message = 'Super-administrator grant duplicate conflicts';
    end if;
    return query select 'replayed'::text, (claimed ->> 'assignmentId')::uuid,
      p_identity_id, (claimed ->> 'revision')::bigint,
      (claimed ->> 'correlationId')::uuid, (claimed ->> 'acceptedAt')::timestamptz;
    return;
  end if;

  if exists (
    select 1
    from vortex_identity.vortex_super_administrator_assignments as assignment
    where assignment.identity_id = p_identity_id
      and assignment.revoked_at is null
  ) then
    raise exception using errcode = 'V3141',
      message = 'Identity already has an active super-administrator assignment';
  end if;

  insert into vortex_identity.vortex_super_administrator_assignments (
    assignment_id, identity_id, revision, granted_at, granted_by_kind,
    granted_by_id, grant_correlation_id, changed_at, changed_by_kind,
    changed_by_id, change_correlation_id
  ) values (
    new_assignment_id, p_identity_id, 1, evaluated_at, 'identity',
    actor_identity_id, new_correlation_id, evaluated_at, 'identity',
    actor_identity_id, new_correlation_id
  );

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key, pg_catalog.jsonb_build_object(
      'fingerprint', computed_fingerprint, 'assignmentId', new_assignment_id, 'revision', 1,
      'correlationId', new_correlation_id, 'acceptedAt', evaluated_at
    )
  );

  perform vortex_record.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid, pg_catalog.gen_random_uuid(),
    evaluated_at, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'super_administrator_assignment_granted',
    array(
      select subject_id
      from pg_catalog.unnest(array[p_identity_id, new_assignment_id]) as subject(subject_id)
      order by subject_id
    ), '{}'::uuid[], coalesce(context_value ->> 'channel', 'web'),
    new_correlation_id, 'completed'
  );

  return query select 'accepted'::text, new_assignment_id, p_identity_id,
    1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke all on function vortex_identity.grant_vortex_super_administrator(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.grant_vortex_super_administrator(uuid, uuid)
  to vortex_runtime;

comment on function vortex_identity.grant_vortex_super_administrator(uuid, uuid) is
  'Grants a named super-administrator assignment through the live account-bound super-administrator context, with recent sign-in and immutable attribution.';

create or replace function vortex_identity.provision_tenant(
  p_cluster_id uuid,
  p_operator_actor_id uuid,
  p_duplicate_key uuid,
  p_command_fingerprint text,
  p_tenant_short_name text,
  p_tenant_display_name text,
  p_organization_short_name text,
  p_organization_display_name text,
  p_tenant_steward_identity_id uuid,
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
  tenant_id uuid,
  root_organization_id uuid,
  tenant_administrator_assignment_id uuid,
  tenant_administrator_assignment_revision bigint,
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
  stored record;
  claimed jsonb;
  new_tenant_id uuid := pg_catalog.gen_random_uuid();
  new_organization_id uuid := pg_catalog.gen_random_uuid();
  new_tenant_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_account_id uuid := pg_catalog.gen_random_uuid();
  new_role_id uuid := pg_catalog.gen_random_uuid();
  new_role_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_delegation_id uuid := pg_catalog.gen_random_uuid();
  new_group_id uuid := pg_catalog.gen_random_uuid();
  new_membership_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  operation_at timestamptz := pg_catalog.clock_timestamp();
  resulting_access_version bigint;
  result_subject_ids uuid[];
  result_subject_revisions bigint[];
  replay_tenant_id uuid;
  replay_organization_id uuid;
  replay_assignment_id uuid;
  replay_account_id uuid;
begin
  if not vortex_platform.is_non_nil_uuid(p_cluster_id::text)
    or not vortex_platform.is_non_nil_uuid(p_operator_actor_id::text)
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Tenant provisioning input is invalid';
  end if;

  -- The new tenant has no row to lock yet. This lock is limited to one trusted
  -- actor/cluster/duplicate tuple and exists only to converge simultaneous retry.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_operator_actor_id::text || '|' || p_cluster_id::text || '|provision_tenant|' ||
      p_duplicate_key::text,
    30
  ));

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'provision_tenant', p_duplicate_key, null, null, p_operator_actor_id,
    'Administration duplicate conflicts'
  );

  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    select tenant.tenant_id into replay_tenant_id
    from vortex_identity.tenants as tenant
    where tenant.tenant_id = any(stored."subjectIds");
    select organization.organization_id into replay_organization_id
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored."subjectIds");
    select assignment.assignment_id into replay_assignment_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.assignment_id = any(stored."subjectIds");
    select account.organization_account_id into replay_account_id
    from vortex_identity.organization_accounts as account
    where account.organization_account_id = any(stored."subjectIds");
    if replay_tenant_id is null or replay_organization_id is null
      or replay_assignment_id is null or replay_account_id is null then
      raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
    end if;
    return query select 'replayed'::text, 'provision_tenant'::text,
      replay_tenant_id, replay_organization_id, replay_assignment_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_assignment_id)],
      replay_account_id,
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_account_id)],
      stored."subjectRevisions"[pg_catalog.array_position(stored."subjectIds", replay_organization_id)],
      stored."receiptId", stored."acceptedAt";
    return;
  end if;

  perform vortex_identity.assert_organization_runtime_settings_values(
    p_runtime_language, p_runtime_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );
  -- Reuse the same #430 language/time-zone validators for account preferences.
  perform vortex_identity.assert_organization_runtime_settings_values(
    p_account_language, p_account_time_zone, p_runtime_currency,
    p_runtime_date_format, p_runtime_number_format
  );

  begin
    insert into vortex_identity.tenants (
      tenant_id, short_name, display_name, state, created_at, created_by,
      state_changed_at, revision
    ) values (
      new_tenant_id, p_tenant_short_name, p_tenant_display_name, 'active',
      operation_at, p_operator_actor_id, operation_at, 1
    );
    insert into vortex_identity.organizations (
      organization_id, tenant_id, parent_organization_id, short_name,
      display_name, state, created_at, created_by, state_changed_at, revision
    ) values (
      new_organization_id, new_tenant_id, null, p_organization_short_name,
      p_organization_display_name, 'active', operation_at,
      p_operator_actor_id, operation_at, 1
    );
  exception when unique_violation then
    raise exception using errcode = 'V3003', message = 'Administration scope is unavailable';
  end;

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values
    (p_tenant_steward_identity_id, 'active', operation_at, operation_at,
      p_operator_actor_id, new_correlation_id, 1),
    (p_organization_steward_identity_id, 'active', operation_at, operation_at,
      p_operator_actor_id, new_correlation_id, 1)
  on conflict on constraint identity_projections_pk do nothing;

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id in (
      p_tenant_steward_identity_id, p_organization_steward_identity_id
    ) and projection.state = 'active'
  order by projection.identity_id
  for update;
  if (select pg_catalog.count(distinct projection.identity_id)
      from vortex_identity.identity_projections as projection
      where projection.identity_id in (
        p_tenant_steward_identity_id, p_organization_steward_identity_id
      ) and projection.state = 'active') <>
     (select pg_catalog.count(distinct identity_id)
      from (values (p_tenant_steward_identity_id),
                   (p_organization_steward_identity_id)) as nominated(identity_id)) then
    raise exception using errcode = 'V3002', message = 'Nominated steward is unavailable';
  end if;

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, language, time_zone, activated_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision
  ) values (
    new_account_id, new_organization_id, p_organization_steward_identity_id,
    p_account_display_name, 'active', p_account_language, p_account_time_zone,
    operation_at, operation_at, operation_at, p_operator_actor_id,
    new_correlation_id, 1
  );

  perform 1 from vortex_identity.initialize_organization_runtime_settings(
    new_organization_id, p_runtime_language, p_runtime_time_zone,
    p_runtime_currency, p_runtime_date_format, p_runtime_number_format
  );
  perform 1 from vortex_access.initialize_organization_access_version(
    new_organization_id, p_operator_actor_id, new_correlation_id
  );
  perform 1 from vortex_access.initialize_platform_permission_catalogue(
    new_organization_id, p_operator_actor_id, new_correlation_id
  );

  insert into vortex_identity.tenant_administrator_assignments (
    assignment_id, tenant_id, identity_id, capability_keys, starts_at,
    expires_at, revision, granted_at, granted_by_actor_id,
    grant_correlation_id, changed_at, changed_by_actor_id, change_correlation_id
  ) values (
    new_tenant_assignment_id, new_tenant_id, p_tenant_steward_identity_id,
    array[
      'platform.tenant.administrators.manage',
      'platform.tenant.administrators.read',
      'platform.tenant.hierarchy.read',
      'platform.tenant.organizations.create',
      'platform.tenant.organizations.lifecycle',
      'platform.tenant.organizations.rename',
      'platform.tenant.organizations.reparent'
    ], operation_at, null, 1, operation_at, p_operator_actor_id,
    new_correlation_id, operation_at, p_operator_actor_id, new_correlation_id
  );

  select adopted.access_version into resulting_access_version
  from vortex_access.coordinate_organization_stewardship_adoption(
    new_organization_id, new_account_id, new_role_id, 'organization_steward',
    'Organisation steward', 'Permanent minimum organisation administration.',
    new_role_assignment_id, new_delegation_id, p_operator_actor_id,
    new_correlation_id
  ) as adopted;

  -- The first owner needs a real current Group for Group-owned records. Access
  -- owns both facts and their version; no application-specific permission is added.
  perform 1 from vortex_access.coordinate_organization_group_change(
    'create_group', new_organization_id, new_group_id, null,
    'organisation_owners', 'Organisation owners', new_account_id,
    new_correlation_id
  );
  select changed.access_version into resulting_access_version
  from vortex_access.coordinate_organization_group_membership_change(
    'add_membership', new_organization_id, new_membership_id, null,
    new_group_id, new_account_id, operation_at, null, null,
    new_account_id, new_correlation_id
  ) as changed;

  -- #33 queues this evidence trigger. Validate it while the privileged boundary
  -- is still active so a runtime-role commit cannot bypass or fail its reads.
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
    (new_tenant_id, 1::bigint),
    (new_organization_id, resulting_access_version),
    (new_tenant_assignment_id, 1::bigint),
    (new_account_id, 1::bigint)
  ) as result(subject_id, subject_revision);

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', operation_at,
      'subjectIds', pg_catalog.to_jsonb(result_subject_ids),
      'subjectRevisions', pg_catalog.to_jsonb(result_subject_revisions),
      'fingerprint', p_command_fingerprint, 'clusterId', p_cluster_id
    )
  );

  return query select 'accepted'::text, 'provision_tenant'::text,
    new_tenant_id, new_organization_id, new_tenant_assignment_id, 1::bigint,
    new_account_id, 1::bigint, resulting_access_version,
    new_correlation_id, operation_at;
end
$function$;

revoke execute on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text
) from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text
) to vortex_runtime;
comment on function vortex_identity.provision_tenant(
  uuid, uuid, uuid, text, text, text, text, text, uuid, uuid, text, text,
  text, text, text, text, text, text
) is 'Configured-system-only atomic tenant/root-organisation provisioning with separate explicit tenant and organisation steward nominations and an initial current owner Group membership for the organisation steward.';

alter function vortex_identity.provision_tenant(uuid,uuid,uuid,text,text,text,text,text,uuid,uuid,text,text,text,text,text,text,text,text) owner to postgres;

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
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
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

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'reactivate_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'reactivate_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
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

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
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
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.reactivate_tenant_organization(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.reactivate_tenant_organization(uuid, text, uuid, uuid, bigint) is
  'Protected stewardship-ready suspended-to-active organisation transition under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.reactivate_tenant_organization(uuid,text,uuid,uuid,bigint) owner to postgres;

create or replace function vortex_identity.read_organization_setup_receipt(
  p_receipt_id uuid,
  p_expected_operation text,
  p_expected_organization_id uuid
)
returns table (
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid,
  identity_id uuid,
  operation_key text,
  receipt_id uuid,
  command_fingerprint text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  stored_receipt record;
  receipt_payload jsonb;
  resolved_tenant_id uuid;
  resolved_organization_id uuid;
  resolved_organization_tenant_id uuid;
  resolved_organization_created_at timestamptz;
  resolved_organization_created_by uuid;
  resolved_assignment_id uuid;
  resolved_organization_account_id uuid;
  resolved_account_organization_id uuid;
  resolved_identity_id uuid;
  resolved_account_activated_at timestamptz;
  matched_tenant_count bigint;
  matched_organization_count bigint;
  matched_assignment_count bigint;
  matched_account_count bigint;
  matched_identity_count bigint;
  expected_subject_ids uuid[];
begin
  if p_receipt_id is null
    or p_receipt_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_operation is null
    or p_expected_operation not in ('provision_tenant', 'create_tenant_organization')
    or p_expected_organization_id is null
    or p_expected_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;

  receipt_payload := vortex_record.read_command_receipt_by_receipt_id_internal(
    p_expected_operation, p_receipt_id
  );
  if receipt_payload is null then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;
  select payload_row."tenantId" as tenant_id,
    result_row."clusterId" as cluster_id,
    payload_row."actorId" as actor_id,
    p_expected_operation as operation_key,
    result_row."subjectIds" as subject_ids,
    result_row."subjectRevisions" as subject_revisions,
    result_row."acceptedAt" as accepted_at,
    result_row."receiptId" as receipt_id,
    result_row."fingerprint" as command_fingerprint
  into stored_receipt
  from pg_catalog.jsonb_to_record(receipt_payload) as payload_row(
    "tenantId" uuid, "actorId" uuid, "result" jsonb
  )
  cross join lateral pg_catalog.jsonb_to_record(payload_row."result") as result_row(
    "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
    "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
  );
  if not found then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;
  if stored_receipt.operation_key is distinct from p_expected_operation then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;

  if p_expected_operation = 'provision_tenant' then
    if stored_receipt.tenant_id is not null
      or stored_receipt.cluster_id is null
      or pg_catalog.cardinality(stored_receipt.subject_ids) <> 4 then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;

    select pg_catalog.count(*)
    into matched_tenant_count
    from vortex_identity.tenants as tenant
    where tenant.tenant_id = any(stored_receipt.subject_ids);
    if matched_tenant_count <> 1 then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;
    select tenant.tenant_id
    into resolved_tenant_id
    from vortex_identity.tenants as tenant
    where tenant.tenant_id = any(stored_receipt.subject_ids);
    if not exists (
      select 1
      from vortex_identity.tenants as tenant
      where tenant.tenant_id = resolved_tenant_id
        and tenant.created_at = stored_receipt.accepted_at
        and tenant.created_by = stored_receipt.actor_id
    ) then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;

    select pg_catalog.count(*)
    into matched_organization_count
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored_receipt.subject_ids);
    if matched_organization_count <> 1 then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;
    select organization.organization_id,
      organization.tenant_id,
      organization.created_at,
      organization.created_by
    into resolved_organization_id,
      resolved_organization_tenant_id,
      resolved_organization_created_at,
      resolved_organization_created_by
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored_receipt.subject_ids);
    if resolved_organization_id is distinct from p_expected_organization_id
      or resolved_organization_tenant_id is distinct from resolved_tenant_id
      or resolved_organization_created_at is distinct from stored_receipt.accepted_at
      or resolved_organization_created_by is distinct from stored_receipt.actor_id then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;

    select pg_catalog.count(*)
    into matched_assignment_count
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.assignment_id = any(stored_receipt.subject_ids)
      and assignment.tenant_id = resolved_tenant_id
      and assignment.granted_at = stored_receipt.accepted_at
      and assignment.granted_by_actor_id = stored_receipt.actor_id
      and assignment.grant_correlation_id = stored_receipt.receipt_id;
    if matched_assignment_count <> 1 then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;
    select assignment.assignment_id
    into resolved_assignment_id
    from vortex_identity.tenant_administrator_assignments as assignment
    where assignment.assignment_id = any(stored_receipt.subject_ids)
      and assignment.tenant_id = resolved_tenant_id
      and assignment.granted_at = stored_receipt.accepted_at
      and assignment.granted_by_actor_id = stored_receipt.actor_id
      and assignment.grant_correlation_id = stored_receipt.receipt_id;
  else
    if stored_receipt.tenant_id is null
      or stored_receipt.cluster_id is not null
      or pg_catalog.cardinality(stored_receipt.subject_ids) <> 2 then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;

    resolved_tenant_id := stored_receipt.tenant_id;
    select pg_catalog.count(*)
    into matched_tenant_count
    from vortex_identity.tenants as tenant
    where tenant.tenant_id = resolved_tenant_id;
    if matched_tenant_count <> 1 then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;

    select pg_catalog.count(*)
    into matched_organization_count
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored_receipt.subject_ids);
    if matched_organization_count <> 1 then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;
    select organization.organization_id,
      organization.tenant_id,
      organization.created_at,
      organization.created_by
    into resolved_organization_id,
      resolved_organization_tenant_id,
      resolved_organization_created_at,
      resolved_organization_created_by
    from vortex_identity.organizations as organization
    where organization.organization_id = any(stored_receipt.subject_ids);
    if resolved_organization_id is distinct from p_expected_organization_id
      or resolved_organization_tenant_id is distinct from resolved_tenant_id
      or resolved_organization_created_at is distinct from stored_receipt.accepted_at
      or resolved_organization_created_by is distinct from stored_receipt.actor_id then
      raise exception using
        errcode = 'V3101',
        message = 'Tenant operation is unavailable';
    end if;
  end if;

  select pg_catalog.count(*)
  into matched_account_count
  from vortex_identity.organization_accounts as account
  where account.organization_account_id = any(stored_receipt.subject_ids);
  if matched_account_count <> 1 then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;
  select account.organization_account_id,
    account.organization_id,
    account.identity_id,
    account.activated_at
  into resolved_organization_account_id,
    resolved_account_organization_id,
    resolved_identity_id,
    resolved_account_activated_at
  from vortex_identity.organization_accounts as account
  where account.organization_account_id = any(stored_receipt.subject_ids);
  if resolved_account_organization_id is distinct from resolved_organization_id
    or resolved_account_activated_at is distinct from stored_receipt.accepted_at then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;

  select pg_catalog.count(*)
  into matched_identity_count
  from vortex_identity.identity_projections as projection
  where projection.identity_id = resolved_identity_id;
  if matched_identity_count <> 1 then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;

  if p_expected_operation = 'provision_tenant' then
    select pg_catalog.array_agg(subject_id order by subject_id)
    into expected_subject_ids
    from (values
      (resolved_tenant_id),
      (resolved_organization_id),
      (resolved_assignment_id),
      (resolved_organization_account_id)
    ) as original_subjects(subject_id);
  else
    select pg_catalog.array_agg(subject_id order by subject_id)
    into expected_subject_ids
    from (values
      (resolved_organization_id),
      (resolved_organization_account_id)
    ) as original_subjects(subject_id);
  end if;
  if stored_receipt.subject_ids is distinct from expected_subject_ids then
    raise exception using
      errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;

  return query
  select resolved_tenant_id,
    resolved_organization_id,
    resolved_organization_account_id,
    resolved_identity_id,
    stored_receipt.operation_key,
    stored_receipt.receipt_id,
    stored_receipt.command_fingerprint;
end
$function$;

revoke execute on function vortex_identity.read_organization_setup_receipt(uuid, text, uuid)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.read_organization_setup_receipt(uuid, text, uuid)
  to vortex_runtime;

comment on function vortex_identity.read_organization_setup_receipt(uuid, text, uuid) is
  'Attests one accepted original tenant or child-organisation creation receipt and its immutable Identity subjects without granting setup authority.';

alter function vortex_identity.read_organization_setup_receipt(uuid,text,uuid) owner to postgres;

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
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
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

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'rename_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'rename_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
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

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
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
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text)
  to vortex_runtime;

comment on function vortex_identity.rename_tenant_organization(uuid, text, uuid, uuid, bigint, text) is
  'Protected same-tenant display-name-only organisation rename under the bound request context person''s current structural authority, exact revision and accepted replay.';

alter function vortex_identity.rename_tenant_organization(uuid,text,uuid,uuid,bigint,text) owner to postgres;

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
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_command_fingerprint is null
    or p_command_fingerprint !~ '^sha256:[0-9a-f]{64}$'
    or (
      p_parent_organization_id is not null
      and not vortex_platform.is_non_nil_uuid(p_parent_organization_id::text)
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

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'reparent_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'reparent_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
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

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
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
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.reparent_tenant_organization(uuid, text, uuid, uuid, bigint, uuid)
  to vortex_runtime;

comment on function vortex_identity.reparent_tenant_organization(uuid, text, uuid, uuid, bigint, uuid) is
  'Protected same-tenant adjacency-link-only organisation move under the bound request context person''s current structural authority, exact revision and accepted replay.';

alter function vortex_identity.reparent_tenant_organization(uuid,text,uuid,uuid,bigint,uuid) owner to postgres;

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
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_assignment_id is null or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
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
  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'revoke_tenant_administrator', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using errcode = 'V3001', message = 'Administration duplicate conflicts';
    end if;
    return query select 'replayed'::text, 'revoke_tenant_administrator'::text,
      p_assignment_id, stored."subjectRevisions"[1], stored."receiptId",
      stored."acceptedAt";
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
  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_assignment_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
  );
  return query select 'accepted'::text, 'revoke_tenant_administrator'::text,
    p_assignment_id, resulting_revision, new_correlation_id, evaluated_at;
end
$function$;

revoke execute on function vortex_identity.revoke_tenant_administrator(uuid, text, uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.revoke_tenant_administrator(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.revoke_tenant_administrator(uuid, text, uuid, uuid, bigint) is
  'Protected same-tenant tenant-administrator revocation under the bound request context person''s current structural authority, with permanent-manager preservation, exact revision and accepted replay.';

alter function vortex_identity.revoke_tenant_administrator(uuid,text,uuid,uuid,bigint) owner to postgres;

create or replace function vortex_identity.revoke_vortex_super_administrator(
  p_duplicate_key uuid,
  p_assignment_id uuid,
  p_expected_revision bigint
)
returns table (
  outcome text,
  assignment_id uuid,
  identity_id uuid,
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
  context_value jsonb;
  actor_identity_id uuid;
  target_identity_id uuid;
  claimed jsonb;
  assignment_fact vortex_identity.vortex_super_administrator_assignments%rowtype;
  evaluated_at timestamptz;
  revoked_at_value timestamptz;
  resulting_revision bigint;
  computed_fingerprint text;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_assignment_id is null
    or not vortex_platform.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Super-administrator revocation command is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vortex.super_administrator.assignments', 0)
  );
  perform 1
  from vortex_identity.identity_projections as identity
  where identity.identity_id = actor_identity_id
    and identity.state = 'active'
  for share;
  if not found then
    raise exception using errcode = '42501',
      message = 'Super-administrator authority is unavailable';
  end if;

  perform 1
  from vortex_identity.vortex_super_administrator_assignments as assignment
  where assignment.identity_id = actor_identity_id
    and assignment.revoked_at is null
  for share;
  if not found then
    raise exception using errcode = '42501',
      message = 'Super-administrator authority is unavailable';
  end if;

  select assignment.* into assignment_fact
  from vortex_identity.vortex_super_administrator_assignments as assignment
  where assignment.assignment_id = p_assignment_id
  for update;
  if not found then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator assignment is unavailable';
  end if;
  target_identity_id := assignment_fact.identity_id;

  evaluated_at := pg_catalog.clock_timestamp();
  if vortex_access.recent_authentication_deadline_internal(
    context_value, evaluated_at,
    '{"kind":"primary","maximumAgeSeconds":900}'::jsonb
  ) is null then
    raise exception using errcode = 'V3142',
      message = 'A recent sign-in is required for super-administrator changes';
  end if;

  computed_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'revoke',
      p_assignment_id::text, p_expected_revision::text), 'UTF8'), 'sha256'
  ), 'hex');

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'vortex_super_administrator_revoke', p_duplicate_key, null, null, actor_identity_id,
    'Super-administrator revocation duplicate conflicts', 'V3143'
  );
  if claimed is not null then
    if claimed ->> 'fingerprint' <> computed_fingerprint then
      raise exception using errcode = 'V3143',
        message = 'Super-administrator revocation duplicate conflicts';
    end if;
    return query select 'replayed'::text, (claimed ->> 'assignmentId')::uuid,
      target_identity_id, (claimed ->> 'revision')::bigint,
      (claimed ->> 'correlationId')::uuid, (claimed ->> 'acceptedAt')::timestamptz;
    return;
  end if;

  if assignment_fact.revoked_at is not null then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator assignment is already revoked';
  end if;
  if assignment_fact.revision <> p_expected_revision
    or assignment_fact.revision = 9007199254740991 then
    raise exception using errcode = 'V3102',
      message = 'Super-administrator assignment revision is stale';
  end if;

  revoked_at_value := evaluated_at;
  resulting_revision := assignment_fact.revision + 1;

  perform vortex_record.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid, pg_catalog.gen_random_uuid(),
    evaluated_at, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'super_administrator_assignment_revoked',
    array(
      select subject_id
      from pg_catalog.unnest(array[target_identity_id, p_assignment_id]) as subject(subject_id)
      order by subject_id
    ), '{}'::uuid[], coalesce(context_value ->> 'channel', 'web'),
    new_correlation_id, 'completed'
  );

  update vortex_identity.vortex_super_administrator_assignments as assignment
  set revision = resulting_revision,
    changed_at = revoked_at_value,
    changed_by_kind = 'identity',
    changed_by_id = actor_identity_id,
    change_correlation_id = new_correlation_id,
    revoked_at = revoked_at_value,
    revoked_by_kind = 'identity',
    revoked_by_id = actor_identity_id,
    revocation_correlation_id = new_correlation_id
  where assignment.assignment_id = p_assignment_id;

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key, pg_catalog.jsonb_build_object(
      'fingerprint', computed_fingerprint, 'assignmentId', p_assignment_id, 'revision', resulting_revision,
      'correlationId', new_correlation_id, 'acceptedAt', revoked_at_value
    )
  );

  return query select 'accepted'::text, p_assignment_id, target_identity_id,
    resulting_revision, new_correlation_id, revoked_at_value;
end
$function$;

revoke all on function vortex_identity.revoke_vortex_super_administrator(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;

grant execute on function vortex_identity.revoke_vortex_super_administrator(uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.revoke_vortex_super_administrator(uuid, uuid, bigint) is
  'Revokes a named super-administrator assignment through the live account-bound super-administrator context, with recent sign-in and exact revision evidence.';

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
  stored record;
  claimed jsonb;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  resulting_revision bigint;
begin
  if p_duplicate_key is null
    or not vortex_platform.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null
    or not vortex_platform.is_non_nil_uuid(p_tenant_id::text)
    or p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
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

  claimed := vortex_record.claim_scoped_command_receipt_internal(
    'suspend_tenant_organization', p_duplicate_key, null, p_tenant_id, actor_identity_id,
    'Administration duplicate conflicts'
  );
  if claimed is not null then
    select r.* into stored
    from pg_catalog.jsonb_to_record(claimed) as r(
      "receiptId" uuid, "acceptedAt" timestamptz, "subjectIds" uuid[],
      "subjectRevisions" bigint[], "fingerprint" text, "clusterId" uuid
    );
    if stored."fingerprint" <> p_command_fingerprint then
      raise exception using
        errcode = 'V3001',
        message = 'Administration duplicate conflicts';
    end if;
    return query
    select 'replayed'::text,
      'suspend_tenant_organization'::text,
      stored."subjectIds"[1],
      stored."subjectRevisions"[1],
      stored."receiptId",
      stored."acceptedAt";
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

  perform vortex_record.complete_scoped_command_receipt_internal(
    p_duplicate_key,
    pg_catalog.jsonb_build_object(
      'receiptId', new_correlation_id, 'acceptedAt', evaluated_at,
      'subjectIds', pg_catalog.to_jsonb(array[p_organization_id]),
      'subjectRevisions', pg_catalog.to_jsonb(array[resulting_revision]),
      'fingerprint', p_command_fingerprint, 'clusterId', null::uuid
    )
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
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.suspend_tenant_organization(uuid, text, uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.suspend_tenant_organization(uuid, text, uuid, uuid, bigint) is
  'Protected non-cascading active-to-suspended organisation transition under the bound request context person''s current tenant authority and accepted replay.';

alter function vortex_identity.suspend_tenant_organization(uuid,text,uuid,uuid,bigint) owner to postgres;

alter table vortex_definition.organization_setup_source_manifests drop constraint setup_source_manifest_receipt_fk;

drop table vortex_identity.vortex_super_administrator_assignment_receipts;
drop function vortex_identity.refuse_super_administrator_assignment_receipt_change();
drop table vortex_identity.accepted_administration_receipts;
drop table vortex_access.capability_reservation_commands;
