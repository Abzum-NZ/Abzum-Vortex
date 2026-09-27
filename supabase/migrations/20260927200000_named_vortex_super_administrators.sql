-- #1407: keep named Vortex super-administrator authority in one identity
-- assignment ledger, apply it at permission evaluation, and provision the
-- existing organisation-account context when a super administrator enters.

begin;

create table vortex_identity.vortex_super_administrator_assignments (
  assignment_id uuid not null,
  identity_id uuid not null,
  revision bigint not null,
  granted_at timestamptz not null,
  granted_by_kind text not null,
  granted_by_id uuid not null,
  grant_correlation_id uuid not null,
  changed_at timestamptz not null,
  changed_by_kind text not null,
  changed_by_id uuid not null,
  change_correlation_id uuid not null,
  revoked_at timestamptz,
  revoked_by_kind text,
  revoked_by_id uuid,
  revocation_correlation_id uuid,
  constraint vortex_super_administrator_assignments_pk primary key (assignment_id),
  constraint vortex_super_administrator_assignments_id_identity_unique unique (
    assignment_id, identity_id
  ),
  constraint vortex_super_administrator_assignments_id_non_nil check (
    vortex_context.is_non_nil_uuid(assignment_id::text)
  ),
  constraint vortex_super_administrator_assignments_identity_non_nil check (
    vortex_context.is_non_nil_uuid(identity_id::text)
  ),
  constraint vortex_super_administrator_assignments_revision_range check (
    revision between 1 and 9007199254740991
  ),
  constraint vortex_super_administrator_assignments_granted_by_valid check (
    granted_by_kind in ('configured_system_operator', 'identity')
    and vortex_context.is_non_nil_uuid(granted_by_id::text)
  ),
  constraint vortex_super_administrator_assignments_changed_by_valid check (
    changed_by_kind in ('configured_system_operator', 'identity')
    and vortex_context.is_non_nil_uuid(changed_by_id::text)
  ),
  constraint vortex_super_administrator_assignments_revocation_complete check (
    (revoked_at is null and revoked_by_kind is null and revoked_by_id is null
      and revocation_correlation_id is null)
    or (revoked_at is not null and revoked_by_kind = 'identity'
      and vortex_context.is_non_nil_uuid(revoked_by_id::text)
      and vortex_context.is_non_nil_uuid(revocation_correlation_id::text))
  ),
  constraint vortex_super_administrator_assignments_time_order check (
    granted_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and changed_at >= granted_at
    and (revoked_at is null or revoked_at >= granted_at)
  ),
  constraint vortex_super_administrator_assignments_grant_correlation_non_nil check (
    vortex_context.is_non_nil_uuid(grant_correlation_id::text)
  ),
  constraint vortex_super_administrator_assignments_change_correlation_non_nil check (
    vortex_context.is_non_nil_uuid(change_correlation_id::text)
  ),
  constraint vortex_super_administrator_assignments_identity_fk foreign key (identity_id)
    references vortex_identity.identity_projections (identity_id),
  constraint vortex_super_administrator_assignments_revoker_fk foreign key (revoked_by_id)
    references vortex_identity.identity_projections (identity_id)
    deferrable initially deferred
);

create unique index vortex_super_administrator_assignments_one_live_identity_idx
  on vortex_identity.vortex_super_administrator_assignments (identity_id)
  where revoked_at is null;

alter table vortex_identity.vortex_super_administrator_assignments
  enable row level security;
alter table vortex_identity.vortex_super_administrator_assignments
  force row level security;
revoke all on vortex_identity.vortex_super_administrator_assignments
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

create table vortex_identity.vortex_super_administrator_assignment_receipts (
  actor_kind text not null,
  actor_id uuid not null,
  operation_key text not null,
  duplicate_key uuid not null,
  command_fingerprint text not null,
  assignment_id uuid not null,
  revision bigint not null,
  correlation_id uuid not null,
  accepted_at timestamptz not null,
  constraint vortex_super_administrator_assignment_receipts_pk primary key (
    actor_kind, actor_id, operation_key, duplicate_key
  ),
  constraint vortex_super_administrator_assignment_receipts_actor_valid check (
    actor_kind in ('configured_system_operator', 'identity')
    and vortex_context.is_non_nil_uuid(actor_id::text)
  ),
  constraint vortex_super_administrator_assignment_receipts_operation_valid check (
    operation_key in ('bootstrap', 'grant', 'revoke')
  ),
  constraint vortex_super_administrator_assignment_receipts_duplicate_non_nil check (
    vortex_context.is_non_nil_uuid(duplicate_key::text)
  ),
  constraint vortex_super_administrator_assignment_receipts_fingerprint_valid check (
    command_fingerprint ~ '^sha256:[0-9a-f]{64}$'
  ),
  constraint vortex_super_administrator_assignment_receipts_revision_range check (
    revision between 1 and 9007199254740991
  ),
  constraint vortex_super_administrator_assignment_receipts_correlation_non_nil check (
    vortex_context.is_non_nil_uuid(correlation_id::text)
  ),
  constraint vortex_super_administrator_assignment_receipts_time_finite check (
    accepted_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  ),
  constraint vortex_super_administrator_assignment_receipts_assignment_fk foreign key (
    assignment_id
  ) references vortex_identity.vortex_super_administrator_assignments (assignment_id)
);

alter table vortex_identity.vortex_super_administrator_assignment_receipts
  enable row level security;
alter table vortex_identity.vortex_super_administrator_assignment_receipts
  force row level security;
revoke all on vortex_identity.vortex_super_administrator_assignment_receipts
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

create table vortex_activity.organization_activity_super_administrator_authority (
  organization_id uuid not null,
  activity_id uuid not null,
  authority_kind text not null,
  assignment_id uuid not null,
  constraint organization_activity_super_administrator_authority_pk primary key (
    organization_id, activity_id
  ),
  constraint organization_activity_super_administrator_authority_kind check (
    authority_kind = 'vortex_super_administrator'
  ),
  constraint organization_activity_super_administrator_authority_activity_fk foreign key (
    organization_id, activity_id
  ) references vortex_activity.organization_activity_entries (organization_id, activity_id),
  constraint organization_activity_super_administrator_authority_assignment_fk foreign key (
    assignment_id
  ) references vortex_identity.vortex_super_administrator_assignments (assignment_id)
);

alter table vortex_activity.organization_activity_super_administrator_authority
  enable row level security;
alter table vortex_activity.organization_activity_super_administrator_authority
  force row level security;
revoke all on vortex_activity.organization_activity_super_administrator_authority
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

alter table vortex_identity.organization_accounts
  add column provisioning_kind text,
  add column provisioning_assignment_id uuid,
  add column provisioned_by_identity_id uuid,
  add constraint organization_accounts_super_administrator_provisioning_shape check (
    (provisioning_kind is null and provisioning_assignment_id is null
      and provisioned_by_identity_id is null)
    or (provisioning_kind = 'vortex_super_administrator'
      and provisioning_assignment_id is not null
      and provisioned_by_identity_id = identity_id)
  ),
  add constraint organization_accounts_provisioning_assignment_identity_fk foreign key (
    provisioning_assignment_id, provisioned_by_identity_id
  ) references vortex_identity.vortex_super_administrator_assignments (
    assignment_id, identity_id
  ),
  add constraint organization_accounts_provisioned_by_fk foreign key (
    provisioned_by_identity_id
  ) references vortex_identity.identity_projections (identity_id);

-- Canonical function definitions are installed in this migration and mirrored
-- in supabase/schemas by the implementation.

create or replace function vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
  p_identity_id uuid,
  p_checked_at timestamptz
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select assignment.assignment_id
  from vortex_identity.vortex_super_administrator_assignments as assignment
  join vortex_identity.identity_projections as identity
    on identity.identity_id = assignment.identity_id
    and identity.state = 'active'
  where assignment.identity_id = p_identity_id
    and (assignment.revoked_at is null or assignment.revoked_at > p_checked_at)
    and assignment.granted_at <= p_checked_at
  limit 1
$function$;

revoke all on function
  vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(uuid, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function
  vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(uuid, timestamptz) is
  'Private live assignment lookup for the named Vortex super-administrator authority; tenant and organisation roles never participate.';

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
  existing_receipt vortex_identity.vortex_super_administrator_assignment_receipts%rowtype;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  evaluated_at timestamptz;
  computed_fingerprint text;
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_identity_id is null
    or not vortex_context.is_non_nil_uuid(p_identity_id::text) then
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

  select receipt.* into existing_receipt
  from vortex_identity.vortex_super_administrator_assignment_receipts as receipt
  where receipt.actor_kind = 'configured_system_operator'
    and receipt.actor_id = p_operator_actor_id
    and receipt.operation_key = 'bootstrap'
    and receipt.duplicate_key = p_duplicate_key;
  if found then
    if existing_receipt.command_fingerprint <> computed_fingerprint then
      raise exception using errcode = 'V3143',
        message = 'Super-administrator bootstrap duplicate conflicts';
    end if;
    return query select 'replayed'::text, existing_receipt.assignment_id,
      p_identity_id, existing_receipt.revision, existing_receipt.correlation_id,
      existing_receipt.accepted_at;
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

  insert into vortex_identity.vortex_super_administrator_assignment_receipts (
    actor_kind, actor_id, operation_key, duplicate_key, command_fingerprint,
    assignment_id, revision, correlation_id, accepted_at
  ) values (
    'configured_system_operator', p_operator_actor_id, 'bootstrap',
    p_duplicate_key, computed_fingerprint, new_assignment_id, 1,
    new_correlation_id, evaluated_at
  );

  return query select 'accepted'::text, new_assignment_id, p_identity_id,
    1::bigint, new_correlation_id, evaluated_at;
end
$function$;

revoke all on function vortex_identity.bootstrap_vortex_super_administrator(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.bootstrap_vortex_super_administrator(uuid, uuid, uuid)
  to vortex_runtime;

comment on function vortex_identity.bootstrap_vortex_super_administrator(uuid, uuid, uuid) is
  'Bootstraps the first named super-administrator assignment through the existing configured system operator.';

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
  existing_receipt vortex_identity.vortex_super_administrator_assignment_receipts%rowtype;
  active_assignment_id uuid;
  new_assignment_id uuid := pg_catalog.gen_random_uuid();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  evaluated_at timestamptz;
  computed_fingerprint text;
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_identity_id is null
    or not vortex_context.is_non_nil_uuid(p_identity_id::text) then
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
  select receipt.* into existing_receipt
  from vortex_identity.vortex_super_administrator_assignment_receipts as receipt
  where receipt.actor_kind = 'identity'
    and receipt.actor_id = actor_identity_id
    and receipt.operation_key = 'grant'
    and receipt.duplicate_key = p_duplicate_key;
  if found then
    if existing_receipt.command_fingerprint <> computed_fingerprint then
      raise exception using errcode = 'V3143',
        message = 'Super-administrator grant duplicate conflicts';
    end if;
    return query select 'replayed'::text, existing_receipt.assignment_id,
      p_identity_id, existing_receipt.revision, existing_receipt.correlation_id,
      existing_receipt.accepted_at;
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

  insert into vortex_identity.vortex_super_administrator_assignment_receipts (
    actor_kind, actor_id, operation_key, duplicate_key, command_fingerprint,
    assignment_id, revision, correlation_id, accepted_at
  ) values (
    'identity', actor_identity_id, 'grant', p_duplicate_key,
    computed_fingerprint, new_assignment_id, 1, new_correlation_id, evaluated_at
  );

  perform vortex_activity.append_organization_activity_entry(
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
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.grant_vortex_super_administrator(uuid, uuid)
  to vortex_runtime;

comment on function vortex_identity.grant_vortex_super_administrator(uuid, uuid) is
  'Grants a named super-administrator assignment through the live account-bound super-administrator context, with recent sign-in and immutable attribution.';

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
  existing_receipt vortex_identity.vortex_super_administrator_assignment_receipts%rowtype;
  assignment_fact vortex_identity.vortex_super_administrator_assignments%rowtype;
  evaluated_at timestamptz;
  revoked_at_value timestamptz;
  resulting_revision bigint;
  computed_fingerprint text;
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
begin
  if p_duplicate_key is null
    or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_assignment_id is null
    or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
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

  select receipt.* into existing_receipt
  from vortex_identity.vortex_super_administrator_assignment_receipts as receipt
  where receipt.actor_kind = 'identity'
    and receipt.actor_id = actor_identity_id
    and receipt.operation_key = 'revoke'
    and receipt.duplicate_key = p_duplicate_key;
  if found then
    if existing_receipt.command_fingerprint <> computed_fingerprint then
      raise exception using errcode = 'V3143',
        message = 'Super-administrator revocation duplicate conflicts';
    end if;
    return query select 'replayed'::text, existing_receipt.assignment_id,
      target_identity_id, existing_receipt.revision,
      existing_receipt.correlation_id, existing_receipt.accepted_at;
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

  perform vortex_activity.append_organization_activity_entry(
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

  insert into vortex_identity.vortex_super_administrator_assignment_receipts (
    actor_kind, actor_id, operation_key, duplicate_key, command_fingerprint,
    assignment_id, revision, correlation_id, accepted_at
  ) values (
    'identity', actor_identity_id, 'revoke', p_duplicate_key,
    computed_fingerprint, p_assignment_id, resulting_revision,
    new_correlation_id, revoked_at_value
  );

  return query select 'accepted'::text, p_assignment_id, target_identity_id,
    resulting_revision, new_correlation_id, revoked_at_value;
end
$function$;

revoke all on function vortex_identity.revoke_vortex_super_administrator(uuid, uuid, bigint)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.revoke_vortex_super_administrator(uuid, uuid, bigint)
  to vortex_runtime;

comment on function vortex_identity.revoke_vortex_super_administrator(uuid, uuid, bigint) is
  'Revokes a named super-administrator assignment through the live account-bound super-administrator context, with recent sign-in and exact revision evidence.';

create or replace function vortex_identity.list_vortex_super_administrator_assignments(
  p_limit integer,
  p_after uuid default null
)
returns table (
  assignment_id uuid,
  identity_id uuid,
  revision bigint,
  granted_at timestamptz,
  granted_by_kind text,
  granted_by_id uuid,
  changed_at timestamptz,
  changed_by_kind text,
  changed_by_id uuid,
  grant_correlation_id uuid,
  change_correlation_id uuid,
  revoked_at timestamptz,
  revoked_by_kind text,
  revoked_by_id uuid,
  revocation_correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  actor_identity_id uuid;
begin
  if p_limit is null or p_limit not between 1 and 101
    or (p_after is not null and not vortex_context.is_non_nil_uuid(p_after::text)) then
    raise exception using errcode = '22023',
      message = 'Super-administrator assignment read is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  actor_identity_id := (context_value ->> 'identityId')::uuid;
  if vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
    actor_identity_id, pg_catalog.clock_timestamp()
  ) is null then
    raise exception using errcode = '42501',
      message = 'Super-administrator authority is unavailable';
  end if;

  return query
  select assignment.assignment_id, assignment.identity_id,
    assignment.revision, assignment.granted_at, assignment.granted_by_kind,
    assignment.granted_by_id, assignment.changed_at, assignment.changed_by_kind,
    assignment.changed_by_id, assignment.grant_correlation_id,
    assignment.change_correlation_id, assignment.revoked_at,
    assignment.revoked_by_kind, assignment.revoked_by_id,
    assignment.revocation_correlation_id
  from vortex_identity.vortex_super_administrator_assignments as assignment
  where p_after is null or assignment.assignment_id > p_after
  order by assignment.assignment_id
  limit p_limit;
end
$function$;

revoke all on function vortex_identity.list_vortex_super_administrator_assignments(integer, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.list_vortex_super_administrator_assignments(integer, uuid)
  to vortex_runtime;

comment on function vortex_identity.list_vortex_super_administrator_assignments(integer, uuid) is
  'Lists the immutable and revisioned named super-administrator assignment ledger to an active super administrator.';

create or replace function vortex_identity.require_current_tenant_capability(
  p_identity_id uuid,
  p_tenant_id uuid,
  p_capability_key text,
  p_evaluated_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if not exists (
    select 1
    from vortex_identity.tenants as tenant
    join vortex_identity.identity_projections as identity
      on identity.identity_id = p_identity_id
    where tenant.tenant_id = p_tenant_id
      and tenant.state = 'active'
      and identity.state = 'active'
      and (
        vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          identity.identity_id, p_evaluated_at
        ) is not null
        or exists (
          select 1
          from vortex_identity.tenant_administrator_assignments as assignment
          where assignment.tenant_id = tenant.tenant_id
            and assignment.identity_id = identity.identity_id
            and assignment.revoked_at is null
            and assignment.starts_at <= p_evaluated_at
            and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
            and p_capability_key = any(assignment.capability_keys)
        )
      )
  ) then
    raise exception using errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;
end
$function$;

revoke all on function vortex_identity.require_current_tenant_capability(uuid, uuid, text, timestamptz)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.require_current_tenant_capability(uuid, uuid, text, timestamptz) is
  'Requires one current tenant capability or the independent active Vortex super-administrator assignment.';

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
    raise exception using errcode = '22023',
      message = 'Tenant launcher request is invalid';
  end if;
  if not exists (
    select 1 from vortex_identity.identity_projections as identity
    where identity.identity_id = actor_identity_id and identity.state = 'active'
  ) then
    raise exception using errcode = 'V3101',
      message = 'Tenant operation is unavailable';
  end if;

  return query
  select tenant.tenant_id, tenant.display_name
  from vortex_identity.tenants as tenant
  where tenant.state = 'active'
    and (p_after is null or tenant.tenant_id > p_after)
    and (
      vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
        actor_identity_id, evaluated_at
      ) is not null
      or exists (
        select 1
        from vortex_identity.tenant_administrator_assignments as assignment
        where assignment.tenant_id = tenant.tenant_id
          and assignment.identity_id = actor_identity_id
          and assignment.revoked_at is null
          and assignment.starts_at <= evaluated_at
          and (assignment.expires_at is null or assignment.expires_at > evaluated_at)
      )
    )
  order by tenant.tenant_id
  limit p_limit;
end
$function$;

revoke all on function vortex_identity.list_tenant_launcher(integer, uuid)
  from public, anon, authenticated, service_role, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_identity.list_tenant_launcher(integer, uuid)
  to vortex_runtime;

comment on function vortex_identity.list_tenant_launcher(integer, uuid) is
  'Lists active tenants assigned to the bound identity, or all active tenants for a named Vortex super administrator.';

create or replace function vortex_identity.resolve_active_organization_account(
  p_identity_id uuid,
  p_organization_id uuid
)
returns table (
  tenant_id uuid,
  organization_id uuid,
  organization_account_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  resolved_tenant_id uuid;
  resolved_assignment_id uuid;
  resolved_account_id uuid;
  account_state text;
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  new_correlation_id uuid := pg_catalog.gen_random_uuid();
  inserted_account_id uuid;
begin
  if p_identity_id is null
    or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text) then
    raise exception using errcode = '22023',
      message = 'Organisation selection is invalid';
  end if;

  select organization.tenant_id
  into resolved_tenant_id
  from vortex_identity.identity_projections as identity
  join vortex_identity.organizations as organization
    on organization.organization_id = p_organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where identity.identity_id = p_identity_id
    and identity.state = 'active'
    and organization.state = 'active'
    and tenant.state = 'active'
  for share of identity, organization, tenant;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organisation selection is unavailable';
  end if;

  select account.organization_account_id, account.state
  into resolved_account_id, account_state
  from vortex_identity.organization_accounts as account
  where account.identity_id = p_identity_id
    and account.organization_id = p_organization_id
  for share;
  if found then
    if account_state = 'active' then
      return query select resolved_tenant_id, p_organization_id,
        resolved_account_id;
      return;
    end if;
    if account_state = 'suspended'
      and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
        p_identity_id, evaluated_at
      ) is not null then
      raise exception using errcode = 'V3140',
        message = 'This super-administrator organisation account is suspended';
    end if;
    raise exception using errcode = '42501',
      message = 'Organisation selection is unavailable';
  end if;

  select assignment.assignment_id
  into resolved_assignment_id
  from vortex_identity.vortex_super_administrator_assignments as assignment
  where assignment.identity_id = p_identity_id
    and assignment.revoked_at is null
    and assignment.granted_at <= evaluated_at
  for share of assignment;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organisation selection is unavailable';
  end if;

  insert into vortex_identity.organization_accounts (
    organization_account_id, organization_id, identity_id, display_name,
    state, language, time_zone, activated_at, changed_at, state_changed_at,
    state_changed_by, state_change_correlation_id, revision,
    provisioning_kind, provisioning_assignment_id, provisioned_by_identity_id
  ) values (
    pg_catalog.gen_random_uuid(), p_organization_id, p_identity_id, null,
    'active', null, null, evaluated_at, evaluated_at, evaluated_at,
    p_identity_id, new_correlation_id, 1, 'vortex_super_administrator',
    resolved_assignment_id, p_identity_id
  )
  on conflict (organization_id, identity_id) do nothing
  returning organization_account_id into inserted_account_id;

  if inserted_account_id is null then
    select account.organization_account_id, account.state
    into resolved_account_id, account_state
    from vortex_identity.organization_accounts as account
    where account.identity_id = p_identity_id
      and account.organization_id = p_organization_id
    for share;
    if account_state = 'active' then
      return query select resolved_tenant_id, p_organization_id,
        resolved_account_id;
      return;
    end if;
    if account_state = 'suspended' then
      raise exception using errcode = 'V3140',
        message = 'This super-administrator organisation account is suspended';
    end if;
    raise exception using errcode = '42501',
      message = 'Organisation selection is unavailable';
  end if;

  perform vortex_activity.append_organization_activity_entry(
    p_organization_id, pg_catalog.gen_random_uuid(), evaluated_at,
    'identity', p_identity_id, 'super_administrator_account_provisioned',
    array(
      select subject_id
      from pg_catalog.unnest(array[
        p_organization_id, inserted_account_id, resolved_assignment_id
      ]) as subject(subject_id)
      order by subject_id
    ), '{}'::uuid[], 'web', new_correlation_id, 'completed'
  );

  return query select resolved_tenant_id, p_organization_id,
    inserted_account_id;
end
$function$;

revoke all on function vortex_identity.resolve_active_organization_account(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_identity.resolve_active_organization_account(uuid, uuid) is
  'Returns an active local account or transactionally provisions one for an assigned Vortex super administrator with immutable provenance and Activity evidence.';

create or replace function vortex_access.resolve_human_organization_scope(
  p_identity_id uuid,
  p_organization_id uuid
)
returns table (
  tenant_id uuid,
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
  eligible_tenant_id uuid;
  eligible_organization_id uuid;
  eligible_account_id uuid;
  resolved_access_version bigint;
  resolved_tenant_id uuid;
  resolved_organization_id uuid;
  resolved_account_id uuid;
begin
  if p_identity_id is null
    or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text) then
    raise exception using errcode = '22023',
      message = 'Organisation selection is invalid';
  end if;

  select tenant.tenant_id, organization.organization_id,
    account.organization_account_id, version.current_version
  into eligible_tenant_id, eligible_organization_id,
    eligible_account_id, resolved_access_version
  from vortex_identity.identity_projections as identity
  join vortex_identity.organizations as organization
    on organization.organization_id = p_organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  join vortex_access.organization_access_versions as version
    on version.organization_id = organization.organization_id
  left join vortex_identity.organization_accounts as account
    on account.organization_id = organization.organization_id
    and account.identity_id = identity.identity_id
  where identity.identity_id = p_identity_id
    and identity.state = 'active'
    and organization.state = 'active'
    and tenant.state = 'active'
    and (
      account.state = 'active'
      or (account.organization_account_id is null
        and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          p_identity_id, pg_catalog.statement_timestamp()
        ) is not null)
    )
  for share of version;

  if not found then
    if exists (
      select 1
      from vortex_identity.identity_projections as identity
      join vortex_identity.organizations as organization
        on organization.organization_id = p_organization_id
      join vortex_identity.tenants as tenant
        on tenant.tenant_id = organization.tenant_id
      join vortex_identity.organization_accounts as account
        on account.organization_id = organization.organization_id
        and account.identity_id = identity.identity_id
      where identity.identity_id = p_identity_id
        and identity.state = 'active'
        and organization.state = 'active'
        and tenant.state = 'active'
        and account.state = 'suspended'
        and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          p_identity_id, pg_catalog.statement_timestamp()
        ) is not null
    ) then
      raise exception using errcode = 'V3140',
        message = 'This super-administrator organisation account is suspended';
    end if;
    raise exception using errcode = '42501',
      message = 'Organisation selection is unavailable';
  end if;

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id
  into resolved_tenant_id, resolved_organization_id, resolved_account_id
  from vortex_identity.resolve_active_organization_account(
    p_identity_id, p_organization_id
  ) as scope;
  if not found
    or resolved_tenant_id is distinct from eligible_tenant_id
    or resolved_organization_id is distinct from eligible_organization_id
    or (eligible_account_id is not null
      and resolved_account_id is distinct from eligible_account_id) then
    raise exception using errcode = '42501',
      message = 'Organisation selection is unavailable';
  end if;

  return query select resolved_tenant_id, resolved_organization_id,
    resolved_account_id, resolved_access_version;
end
$function$;

revoke execute on function vortex_access.resolve_human_organization_scope(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.resolve_human_organization_scope(uuid, uuid)
  to vortex_runtime;

comment on function vortex_access.resolve_human_organization_scope(uuid, uuid) is
  'Resolves one active account-bound organisation scope under its Access lock, provisioning missing local accounts only for assigned Vortex super administrators.';

create or replace function vortex_access.resolve_human_organization_change_scope(
  p_identity_id uuid,
  p_organization_id uuid
)
returns table (
  tenant_id uuid,
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
  eligible_tenant_id uuid;
  eligible_organization_id uuid;
  eligible_account_id uuid;
  locked_access_version bigint;
  resolved_tenant_id uuid;
  resolved_organization_id uuid;
  resolved_account_id uuid;
begin
  if p_identity_id is null
    or not vortex_context.is_non_nil_uuid(p_identity_id::text)
    or p_organization_id is null
    or not vortex_context.is_non_nil_uuid(p_organization_id::text) then
    raise exception using errcode = '22023',
      message = 'Organisation change selection is invalid';
  end if;

  select tenant.tenant_id, organization.organization_id,
    account.organization_account_id, version.current_version
  into eligible_tenant_id, eligible_organization_id,
    eligible_account_id, locked_access_version
  from vortex_identity.identity_projections as identity
  join vortex_identity.organizations as organization
    on organization.organization_id = p_organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  join vortex_access.organization_access_versions as version
    on version.organization_id = organization.organization_id
  left join vortex_identity.organization_accounts as account
    on account.organization_id = organization.organization_id
    and account.identity_id = identity.identity_id
  where identity.identity_id = p_identity_id
    and identity.state = 'active'
    and organization.state = 'active'
    and tenant.state = 'active'
    and (
      account.state = 'active'
      or (account.organization_account_id is null
        and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          p_identity_id, pg_catalog.statement_timestamp()
        ) is not null)
    )
  for update of version;

  if not found then
    if exists (
      select 1
      from vortex_identity.identity_projections as identity
      join vortex_identity.organizations as organization
        on organization.organization_id = p_organization_id
      join vortex_identity.tenants as tenant
        on tenant.tenant_id = organization.tenant_id
      join vortex_identity.organization_accounts as account
        on account.organization_id = organization.organization_id
        and account.identity_id = identity.identity_id
      where identity.identity_id = p_identity_id
        and identity.state = 'active'
        and organization.state = 'active'
        and tenant.state = 'active'
        and account.state = 'suspended'
        and vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          p_identity_id, pg_catalog.statement_timestamp()
        ) is not null
    ) then
      raise exception using errcode = 'V3140',
        message = 'This super-administrator organisation account is suspended';
    end if;
    raise exception using errcode = '42501',
      message = 'Organisation change selection is unavailable';
  end if;

  select scope.tenant_id, scope.organization_id,
    scope.organization_account_id
  into resolved_tenant_id, resolved_organization_id, resolved_account_id
  from vortex_identity.resolve_active_organization_account(
    p_identity_id, p_organization_id
  ) as scope;
  if not found
    or resolved_tenant_id is distinct from eligible_tenant_id
    or resolved_organization_id is distinct from eligible_organization_id
    or (eligible_account_id is not null
      and resolved_account_id is distinct from eligible_account_id) then
    raise exception using errcode = '42501',
      message = 'Organisation change selection is unavailable';
  end if;

  return query select resolved_tenant_id, resolved_organization_id,
    resolved_account_id, locked_access_version;
end
$function$;

revoke execute on function vortex_access.resolve_human_organization_change_scope(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.resolve_human_organization_change_scope(uuid, uuid)
  to vortex_runtime;

comment on function vortex_access.resolve_human_organization_change_scope(uuid, uuid) is
  'Resolves one active account-bound change scope under its Access lock, provisioning missing local accounts only for assigned Vortex super administrators.';

create or replace function vortex_identity.list_organization_launcher(p_identity_id uuid)
returns table (
  organization_id uuid,
  tenant_short_name text,
  tenant_display_name text,
  organization_short_name text,
  organization_display_name text,
  account_display_name text
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  is_super_administrator boolean;
begin
  if p_identity_id is null
    or not vortex_context.is_non_nil_uuid(p_identity_id::text) then
    raise exception using errcode = '22023',
      message = 'Launcher identity is invalid';
  end if;

  if not exists (
    select 1 from vortex_identity.identity_projections as identity
    where identity.identity_id = p_identity_id and identity.state = 'active'
  ) then
    raise exception using errcode = '42501',
      message = 'Launcher identity is unavailable';
  end if;
  is_super_administrator :=
    vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
      p_identity_id, evaluated_at
    ) is not null;

  return query
  select organization.organization_id, tenant.short_name,
    tenant.display_name, organization.short_name,
    organization.display_name, account.display_name
  from vortex_identity.organizations as organization
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  left join vortex_identity.organization_accounts as account
    on account.organization_id = organization.organization_id
    and account.identity_id = p_identity_id
  where organization.state = 'active'
    and tenant.state = 'active'
    and (
      (account.organization_account_id is not null and account.state = 'active')
      or is_super_administrator
    )
  order by tenant.display_name, tenant.tenant_id,
    organization.display_name, organization.organization_id,
    account.display_name nulls last, account.organization_account_id;
end
$function$;

revoke execute on function vortex_identity.list_organization_launcher(uuid)
  from public, anon, authenticated, service_role, vortex_request;
grant execute on function vortex_identity.list_organization_launcher(uuid)
  to vortex_runtime;

comment on function vortex_identity.list_organization_launcher(uuid) is
  'Returns safe organisation labels for active local accounts and every active organisation available to a named Vortex super administrator.';

create or replace function vortex_identity.protect_vortex_super_administrator_assignment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '23514',
      message = 'Vortex super-administrator assignment evidence is permanent';
  end if;

  if new.assignment_id is distinct from old.assignment_id
    or new.identity_id is distinct from old.identity_id
    or new.granted_at is distinct from old.granted_at
    or new.granted_by_kind is distinct from old.granted_by_kind
    or new.granted_by_id is distinct from old.granted_by_id
    or new.grant_correlation_id is distinct from old.grant_correlation_id then
    raise exception using errcode = '23514',
      message = 'Vortex super-administrator assignment grant evidence is immutable';
  end if;

  if old.revoked_at is not null
    or new.revoked_at is null
    or new.revision <> old.revision + 1
    or new.revision > 9007199254740991
    or new.changed_at < old.changed_at
    or new.revoked_at < old.granted_at
    or new.changed_by_kind <> 'identity'
    or new.changed_by_id is distinct from new.revoked_by_id
    or new.change_correlation_id is distinct from new.revocation_correlation_id
    or new.revoked_by_id is null
    or new.revocation_correlation_id is null then
    raise exception using errcode = '23514',
      message = 'Vortex super-administrator assignment transition is invalid';
  end if;

  return new;
end
$function$;

revoke all on function vortex_identity.protect_vortex_super_administrator_assignment()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.protect_vortex_super_administrator_assignment() is
  'Keeps super-administrator grants immutable and permits only one attributed, revisioned revocation.';

create or replace function vortex_identity.refuse_super_administrator_assignment_receipt_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using errcode = '23514',
    message = 'Vortex super-administrator assignment receipts are immutable';
end
$function$;

revoke all on function vortex_identity.refuse_super_administrator_assignment_receipt_change()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.refuse_super_administrator_assignment_receipt_change() is
  'Prevents rewriting or deleting a completed super-administrator assignment command receipt.';

create or replace function vortex_identity.protect_super_administrator_account_provenance()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.provisioning_kind is distinct from old.provisioning_kind
    or new.provisioning_assignment_id is distinct from old.provisioning_assignment_id
    or new.provisioned_by_identity_id is distinct from old.provisioned_by_identity_id then
    raise exception using errcode = '23514',
      message = 'Super-administrator account provenance is immutable';
  end if;
  return new;
end
$function$;

revoke all on function vortex_identity.protect_super_administrator_account_provenance()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.protect_super_administrator_account_provenance() is
  'Keeps the assignment evidence for super-administrator-provisioned accounts immutable.';

create or replace function vortex_activity.record_super_administrator_authority_internal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_identity_id uuid;
  authority_assignment_id uuid;
begin
  if new.actor_kind = 'identity' then
    actor_identity_id := new.actor_id;
  elsif new.actor_kind = 'organization_account' then
    select account.identity_id
    into actor_identity_id
    from vortex_identity.organization_accounts as account
    where account.organization_id = new.organization_id
      and account.organization_account_id = new.actor_id;
  end if;

  if actor_identity_id is null then
    return new;
  end if;

  authority_assignment_id :=
    vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
      actor_identity_id, new.occurred_at
    );
  if authority_assignment_id is null then
    return new;
  end if;

  insert into vortex_activity.organization_activity_super_administrator_authority (
    organization_id, activity_id, authority_kind, assignment_id
  ) values (
    new.organization_id, new.activity_id, 'vortex_super_administrator',
    authority_assignment_id
  );
  return new;
end
$function$;

revoke all on function vortex_activity.record_super_administrator_authority_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_activity.record_super_administrator_authority_internal() is
  'Attributes each organisation activity by an assigned Vortex super administrator to the exact active assignment without changing activity writers.';

create or replace function vortex_activity.refuse_super_administrator_authority_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception using errcode = '23514',
    message = 'Super-administrator activity authority evidence is immutable';
end
$function$;

revoke all on function vortex_activity.refuse_super_administrator_authority_change()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_activity.refuse_super_administrator_authority_change() is
  'Prevents rewriting or deleting activity evidence that names its super-administrator authority.';

create trigger organization_accounts_super_administrator_provenance_protect
before update on vortex_identity.organization_accounts
for each row execute function vortex_identity.protect_super_administrator_account_provenance();

create trigger organization_activity_super_administrator_authority_record
after insert on vortex_activity.organization_activity_entries
for each row execute function vortex_activity.record_super_administrator_authority_internal();

create trigger vortex_super_administrator_assignments_protect
before update or delete on vortex_identity.vortex_super_administrator_assignments
for each row execute function vortex_identity.protect_vortex_super_administrator_assignment();

create trigger vortex_super_administrator_assignment_receipts_immutable
before update or delete on vortex_identity.vortex_super_administrator_assignment_receipts
for each row execute function vortex_identity.refuse_super_administrator_assignment_receipt_change();

create trigger organization_activity_super_administrator_authority_immutable
before update or delete on vortex_activity.organization_activity_super_administrator_authority
for each row execute function vortex_activity.refuse_super_administrator_authority_change();


create or replace function vortex_access.evaluate_permission_role_path_internal(
  p_context jsonb,
  p_checked_at timestamptz,
  p_permission jsonb,
  p_action jsonb,
  p_record_type_id uuid
)
returns table (
  permission_entry vortex_access.permission_catalogue_entries,
  path_valid_until timestamptz
)
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  context_organization_value uuid := (p_context ->> 'organizationId')::uuid;
  context_account_value uuid := (p_context ->> 'organizationAccountId')::uuid;
  context_expires_value timestamptz := (p_context ->> 'expiresAt')::timestamptz;
  decision_checked_at timestamptz := p_checked_at;
  permission_application_value uuid := (p_permission ->> 'applicationRootId')::uuid;
  permission_owner_kind_value text := p_permission ->> 'ownerKind';
  permission_owner_value uuid := (p_permission ->> 'ownerId')::uuid;
  permission_value uuid := (p_permission ->> 'permissionId')::uuid;
  action_kind_value text := p_action ->> 'actionKind';
  named_action_value text := p_action ->> 'namedAction';
begin
  return query
  with current_permission as materialized (
    select catalogue.application_root_id, catalogue.owner_kind,
      catalogue.owner_id, catalogue.permission_id,
      catalogue.meaning_fingerprint, catalogue as permission_entry
    from vortex_access.permission_registrations as registration
    join vortex_access.permission_catalogue_entries as catalogue
      on catalogue.organization_id = registration.organization_id
      and catalogue.registration_kind = registration.registration_kind
      and catalogue.registration_owner_id = registration.registration_owner_id
      and catalogue.registration_revision = registration.revision
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = catalogue.organization_id
      and continuity.application_root_id is not distinct from
        catalogue.application_root_id
      and continuity.owner_kind = catalogue.owner_kind
      and continuity.owner_id = catalogue.owner_id
      and continuity.permission_id = catalogue.permission_id
      and continuity.registration_kind = catalogue.registration_kind
      and continuity.registration_owner_id = catalogue.registration_owner_id
      and continuity.last_processed_registration_revision = registration.revision
      and continuity.state = 'available'
      and continuity.meaning_fingerprint = catalogue.meaning_fingerprint
    where registration.organization_id = context_organization_value
      and registration.state = 'active'
      and catalogue.application_root_id is not distinct from
        permission_application_value
      and catalogue.owner_kind = permission_owner_kind_value
      and catalogue.owner_id = permission_owner_value
      and catalogue.permission_id = permission_value
      and catalogue.record_type_id is not distinct from p_record_type_id
      and catalogue.action_kind = action_kind_value
      and catalogue.named_action is not distinct from named_action_value
  ), current_role_permission as materialized (
    select role.role_id, role.live_revision,
      revision.assignment_policy, revision.authority_continuity_revision,
      revision.policy_continuity_revision, revision.activation_policy_id,
      revision.activation_policy_revision,
      revision.activation_policy_fingerprint
    from vortex_access.organization_roles as role
    join vortex_access.organization_role_revisions as revision
      on revision.organization_id = role.organization_id
      and revision.role_id = role.role_id
      and revision.revision = role.live_revision
    join vortex_access.organization_role_permission_entries as permission
      on permission.organization_id = revision.organization_id
      and permission.role_id = revision.role_id
      and permission.role_revision = revision.revision
    join current_permission as available
      on available.application_root_id is not distinct from
        permission.application_root_id
      and available.owner_kind = permission.owner_kind
      and available.owner_id = permission.owner_id
      and available.permission_id = permission.permission_id
      and available.meaning_fingerprint = permission.meaning_fingerprint
    join vortex_access.permission_continuities as continuity
      on continuity.organization_id = permission.organization_id
      and continuity.application_root_id is not distinct from
        permission.application_root_id
      and continuity.owner_kind = permission.owner_kind
      and continuity.owner_id = permission.owner_id
      and continuity.permission_id = permission.permission_id
      and continuity.state = 'available'
      and continuity.continuity_revision = permission.continuity_revision
      and continuity.meaning_fingerprint = permission.meaning_fingerprint
    where role.organization_id = context_organization_value
      and revision.lifecycle in ('active', 'acceptance_required')
  ), route_candidates as (
    select 1 as route_rank, permission.role_id,
      assignment.role_assignment_id, null::uuid as membership_id,
      null::uuid as role_activation_id,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value)
      ) as path_valid_until
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = context_account_value
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'standing'

    union all

    select 2, permission.role_id, assignment.role_assignment_id,
      membership.membership_id, null::uuid,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value)
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'standing'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_value
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'standing'

    union all

    select 3, permission.role_id, assignment.role_assignment_id,
      null::uuid, activation.role_activation_id,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        activation.expires_at
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'organization_account'
      and assignment.organization_account_id = context_account_value
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = context_account_value
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'direct'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= decision_checked_at
      and activation.expires_at > decision_checked_at
      and activation.authority_continuity_revision =
        permission.authority_continuity_revision
      and activation.policy_continuity_revision =
        permission.policy_continuity_revision
      and activation.activation_policy_id = permission.activation_policy_id
      and activation.activation_policy_revision =
        permission.activation_policy_revision
      and activation.activation_policy_fingerprint =
        permission.activation_policy_fingerprint
    where permission.assignment_policy = 'activation_required'

    union all

    select 4, permission.role_id, assignment.role_assignment_id,
      membership.membership_id, activation.role_activation_id,
      least(
        context_expires_value,
        coalesce(assignment.expires_at, context_expires_value),
        coalesce(membership.expires_at, context_expires_value),
        activation.expires_at
      )
    from current_role_permission as permission
    join vortex_access.organization_role_assignments as assignment
      on assignment.organization_id = context_organization_value
      and assignment.role_id = permission.role_id
      and assignment.assignee_kind = 'group'
      and assignment.assignment_kind = 'eligible'
      and assignment.state = 'live'
      and assignment.starts_at <= decision_checked_at
      and (
        assignment.expires_at is null
        or assignment.expires_at > decision_checked_at
      )
    join vortex_access.organization_groups as organization_group
      on organization_group.organization_id = assignment.organization_id
      and organization_group.group_id = assignment.group_id
      and organization_group.state = 'active'
    join vortex_access.organization_role_activations as activation
      on activation.organization_id = assignment.organization_id
      and activation.organization_account_id = context_account_value
      and activation.role_id = assignment.role_id
      and activation.eligibility_source_kind = 'group'
      and activation.role_assignment_id = assignment.role_assignment_id
      and activation.role_assignment_revision = assignment.revision
      and activation.state = 'live'
      and activation.activated_at <= decision_checked_at
      and activation.expires_at > decision_checked_at
      and activation.authority_continuity_revision =
        permission.authority_continuity_revision
      and activation.policy_continuity_revision =
        permission.policy_continuity_revision
      and activation.activation_policy_id = permission.activation_policy_id
      and activation.activation_policy_revision =
        permission.activation_policy_revision
      and activation.activation_policy_fingerprint =
        permission.activation_policy_fingerprint
    join vortex_access.organization_group_memberships as membership
      on membership.organization_id = assignment.organization_id
      and membership.group_id = assignment.group_id
      and membership.organization_account_id = context_account_value
      and membership.membership_id = activation.membership_id
      and membership.revision = activation.membership_revision
      and membership.state = 'live'
      and membership.starts_at <= decision_checked_at
      and (
        membership.expires_at is null
        or membership.expires_at > decision_checked_at
      )
    where permission.assignment_policy = 'activation_required'
  ), selected_route as materialized (
    select route.path_valid_until
    from route_candidates as route

    union all

    select context_expires_value
    from current_permission as available
    where vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
      (p_context ->> 'identityId')::uuid, decision_checked_at
    ) is not null

    order by path_valid_until
    limit 1
  )
  select available.permission_entry, selected.path_valid_until
  from current_permission as available
  left join selected_route as selected on true;
end
$function$;

-- This helper consumes internal facts, so it has no request/runtime entry grant.
revoke execute on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  )
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_module_owner, vortex_record_owner, vortex_record_adapter;

comment on function
  vortex_access.evaluate_permission_role_path_internal(
    jsonb, timestamptz, jsonb, jsonb, uuid
  ) is
  'Private current-permission and role-path evidence; null record type selects only non-record permissions. No row authority.';


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
      where vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          actor_identity_id, evaluated_at
        ) is null
        and not exists (
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
      where vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
          actor_identity_id, evaluated_at
        ) is null
        and not exists (
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


create or replace function vortex_activity.read_organization_activity_page(
  p_occurred_from timestamptz,
  p_occurred_to timestamptz,
  p_actor_kind text,
  p_actor_id uuid,
  p_action text,
  p_correlation_id uuid,
  p_outcome text,
  p_source text,
  p_page_size integer,
  p_after_occurred_at timestamptz,
  p_after_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  context_organization_id uuid;
  context_identity_id uuid;
  context_account_id uuid;
  decision_outcome text;
  decision_organization_id uuid;
  decision_account_id uuid;
  audit_projection boolean := false;
  entries jsonb;
  has_more boolean := false;
  last_occurred_at timestamptz;
  last_activity_id uuid;
begin
  if p_page_size is null or p_page_size not between 1 and 200
    or (p_occurred_from is not null
      and p_occurred_from in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_occurred_to is not null
      and p_occurred_to in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_occurred_from is not null and p_occurred_to is not null
      and p_occurred_from > p_occurred_to)
    or (p_actor_kind is not null
      and p_actor_kind <> all (array['identity', 'organization_account', 'system', 'public_session']))
    or (p_actor_id is not null
      and p_actor_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_action is not null and (
      pg_catalog.char_length(p_action) not between 1 and 40
      or p_action !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    ))
    or (p_correlation_id is not null
      and p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid)
    or (p_outcome is not null
      and p_outcome <> all (array['completed', 'refused', 'failed']))
    or (p_source is not null
      and p_source <> all (array[
        'web', 'mcp', 'programmatic_interface', 'connection', 'federation',
        'durable_workflow', 'system'
      ]))
    or (p_after_occurred_at is null) <> (p_after_activity_id is null)
    or (p_after_occurred_at is not null
      and p_after_occurred_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    or (p_after_activity_id is not null
      and p_after_activity_id = '00000000-0000-0000-0000-000000000000'::uuid) then
    raise exception using errcode = '22023',
      message = 'Activity history page selector is invalid';
  end if;

  checked_context := vortex_access.validated_human_request_context();
  if checked_context ->> 'callerKind' is distinct from 'human' then
    raise exception using errcode = '42501',
      message = 'Activity history is unavailable';
  end if;
  context_organization_id := (checked_context ->> 'organizationId')::uuid;
  context_identity_id := (checked_context ->> 'identityId')::uuid;
  context_account_id := (checked_context ->> 'organizationAccountId')::uuid;

  select evaluated.outcome, evaluated.organization_id, evaluated.organization_account_id
  into decision_outcome, decision_organization_id, decision_account_id
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.activity.read',
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

  audit_projection := coalesce(
    decision_outcome = 'eligible'
      and decision_organization_id = context_organization_id
      and decision_account_id = context_account_id,
    false
  );

  with filtered as (
    select entry.*, authority.authority_kind,
      authority.assignment_id as authority_assignment_id
    from vortex_activity.organization_activity_entries as entry
    left join vortex_activity.organization_activity_super_administrator_authority as authority
      on authority.organization_id = entry.organization_id
      and authority.activity_id = entry.activity_id
    where entry.organization_id = context_organization_id
      and (audit_projection
        or (entry.actor_kind = 'organization_account' and entry.actor_id = context_account_id)
        or (entry.actor_kind = 'identity' and entry.actor_id = context_identity_id))
      and (p_occurred_from is null or entry.occurred_at >= p_occurred_from)
      and (p_occurred_to is null or entry.occurred_at <= p_occurred_to)
      and (p_actor_kind is null or entry.actor_kind = p_actor_kind)
      and (p_actor_id is null or entry.actor_id = p_actor_id)
      and (p_action is null or entry.action = p_action)
      and (p_correlation_id is null or entry.correlation_id = p_correlation_id)
      and (p_outcome is null or entry.outcome = p_outcome)
      and (p_source is null or entry.source = p_source)
  ),
  ordered as (
    select filtered.*
    from filtered
    where p_after_occurred_at is null
      or (filtered.occurred_at, filtered.activity_id)
        < (p_after_occurred_at, p_after_activity_id)
    order by filtered.occurred_at desc, filtered.activity_id desc
    limit p_page_size + 1
  ),
  numbered as (
    select ordered.*,
      pg_catalog.row_number() over (
        order by ordered.occurred_at desc, ordered.activity_id desc
      ) as ordinal
    from ordered
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'activityId', numbered.activity_id,
          'occurredAt', numbered.occurred_at,
          'actorKind', numbered.actor_kind,
          'actorId', numbered.actor_id,
          'action', numbered.action,
          'subjectIds', pg_catalog.to_jsonb(numbered.subject_ids),
          'source', numbered.source,
          'correlationId', numbered.correlation_id,
          'outcome', numbered.outcome
        ) || case
          when numbered.authority_assignment_id is not null then pg_catalog.jsonb_build_object(
            'authority', pg_catalog.jsonb_build_object(
              'kind', numbered.authority_kind,
              'assignmentId', numbered.authority_assignment_id
            )
          )
          else '{}'::jsonb
        end || case
          when audit_projection then pg_catalog.jsonb_build_object(
            'changedFieldIds', pg_catalog.to_jsonb(numbered.changed_field_ids)
          )
          else '{}'::jsonb
        end
        order by numbered.ordinal
      ) filter (where numbered.ordinal <= p_page_size),
      '[]'::jsonb
    ),
    coalesce(pg_catalog.max(numbered.ordinal) > p_page_size, false),
    (pg_catalog.array_agg(numbered.occurred_at order by numbered.ordinal)
      filter (where numbered.ordinal = p_page_size))[1],
    (pg_catalog.array_agg(numbered.activity_id order by numbered.ordinal)
      filter (where numbered.ordinal = p_page_size))[1]
  into entries, has_more, last_occurred_at, last_activity_id
  from numbered;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'projection', case when audit_projection then 'audit' else 'own' end,
    'entries', entries,
    'next', case
      when has_more then pg_catalog.jsonb_build_object(
        'occurredAt', last_occurred_at,
        'activityId', last_activity_id
      )
      else null
    end
  );
end
$function$;

revoke execute on function vortex_activity.read_organization_activity_page(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_activity.read_organization_activity_page(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid
) to vortex_request;

comment on function vortex_activity.read_organization_activity_page(
  timestamptz, timestamptz, text, uuid, text, uuid, text, text, integer, timestamptz, uuid
) is
  'Returns one bounded newest-first keyset page of the caller''s own organisation Activity, or the organisation-wide audit projection when the actor holds the organisation access-administration read authority.';

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
    and (
      vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
        actor_identity_id, evaluated_at
      ) is not null
      or exists (
        select 1
        from vortex_identity.tenant_administrator_assignments as assignment
        where assignment.tenant_id = tenant.tenant_id
          and assignment.identity_id = actor_identity_id
          and assignment.revoked_at is null
          and assignment.starts_at <= evaluated_at
          and (assignment.expires_at is null or assignment.expires_at > evaluated_at)
      )
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

create or replace function vortex_access.read_application_address_candidates(
  p_identity_id uuid,
  p_tenant_short_name text,
  p_organization_short_name text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  addressed_organization record;
  application_row record;
  application_values jsonb := '[]'::jsonb;
  page_values jsonb;
  experience_values jsonb;
  role_values jsonb;
  permission_values jsonb;
  home_page_key text;
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_tenant_short_name is null
    or pg_catalog.char_length(p_tenant_short_name) not between 1 and 40
    or p_tenant_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$'
    or p_organization_short_name is null
    or pg_catalog.char_length(p_organization_short_name) not between 1 and 40
    or p_organization_short_name !~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$' then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  select tenant.tenant_id, tenant.short_name as tenant_short_name,
    organization.organization_id, organization.short_name as organization_short_name
  into addressed_organization
  from vortex_identity.tenants as tenant
  join vortex_identity.organizations as organization
    on organization.tenant_id = tenant.tenant_id
  where tenant.short_name = p_tenant_short_name
    and organization.short_name = p_organization_short_name
    and tenant.state = 'active'
    and organization.state = 'active';

  if not found then
    return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end if;

  begin
    perform 1
    from vortex_access.resolve_human_organization_scope(
      p_identity_id, addressed_organization.organization_id
    ) as scope;
  exception
    when sqlstate 'V3140' then
      return pg_catalog.jsonb_build_object(
        'kind', 'suspended_super_administrator_account'
      );
    when sqlstate '42501' or sqlstate 'P0002' then
      return pg_catalog.jsonb_build_object('kind', 'unavailable');
  end;

  for application_row in
    select root.root_id, root.key as application_key, release.compilation_output,
      registration.revision as registration_revision,
      registration.source_revision as release_revision
    from vortex_access.permission_registrations as registration
    join vortex_definition.roots as root
      on root.root_id = registration.registration_owner_id
      and root.organization_id = addressed_organization.organization_id
      and root.kind = 'application'
    join vortex_definition.releases as release
      on release.root_id = root.root_id
      and release.release_revision = registration.source_revision
    where registration.organization_id = addressed_organization.organization_id
      and registration.registration_kind = 'application'
      and registration.state = 'active'
      and exists (
        select 1
        from vortex_module.installation_bindings as binding
        where binding.organization_id = addressed_organization.organization_id
          and binding.application_root_id = root.root_id
          and binding.application_release_revision = registration.source_revision
          and binding.state = 'active'
      )
      and registration.source_content_fingerprint = release.content_fingerprint
      and registration.source_resolution_fingerprint = release.resolution_fingerprint
      and release.compilation_output ->> 'kind' = 'application'
    order by root.key collate "C", root.root_id
  loop
    begin
      perform 1
      from vortex_access.resolve_human_application_scope(
        p_identity_id,
        addressed_organization.organization_id,
        application_row.root_id
      ) as scope;
    exception
      when sqlstate '42501' or sqlstate 'P0002' then
        continue;
    end;

    page_values := application_row.compilation_output #> '{canonical,content,pages}';
    if pg_catalog.jsonb_typeof(page_values) is distinct from 'array' then
      continue;
    end if;
    if pg_catalog.jsonb_array_length(page_values) = 0 then
      continue;
    end if;

    select page.value ->> 'key'
    into home_page_key
    from pg_catalog.jsonb_array_elements(page_values) as page(value)
    where page.value ->> 'pageId' =
      application_row.compilation_output #>> '{canonical,content,homePageId}';

    if home_page_key is null then
      continue;
    end if;

    -- Declared experience pages are resolved to their exact compiled page definitions here, so
    -- App can render an application's own not-found, unavailable and error surfaces. A refused
    -- page and a missing page both resolve to the same not_found experience.
    experience_values := application_row.compilation_output #> '{canonical,content,experiences}';
    if pg_catalog.jsonb_typeof(experience_values) is distinct from 'array' then
      experience_values := '[]'::jsonb;
    end if;

    role_values := application_row.compilation_output #> '{canonical,content,roles}';
    if pg_catalog.jsonb_typeof(role_values) is distinct from 'array' then
      continue;
    end if;

    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'key', entry.permission_key,
        'applicationRootId', entry.application_root_id,
        'ownerKind', entry.owner_kind,
        'ownerId', entry.owner_id,
        'permissionId', entry.permission_id,
        'actionKind', entry.action_kind,
        'namedAction', entry.named_action
      ) order by entry.permission_key collate "C", entry.permission_id
    ) into permission_values
    from vortex_access.permission_catalogue_entries as entry
    where entry.organization_id = addressed_organization.organization_id
      and entry.registration_kind = 'application'
      and entry.registration_owner_id = application_row.root_id
      and entry.registration_revision = application_row.registration_revision
      and entry.application_root_id = application_row.root_id;

    application_values := application_values || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'applicationRootId', application_row.root_id,
        'releaseRevision', application_row.release_revision,
        'key', application_row.application_key,
        'name', application_row.compilation_output #>> '{canonical,content,name}',
        'icon', application_row.compilation_output #>> '{canonical,content,icon}',
        'homePageKey', home_page_key,
        'pages', (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'pageId', page.value ->> 'pageId',
              'key', page.value ->> 'key',
              'accessPermissionKey', page.value ->> 'accessPermissionKey'
            ) order by page.value ->> 'key' collate "C"
          )
          from pg_catalog.jsonb_array_elements(page_values) as page(value)
        ),
        'experiences', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object('state', experience.value ->> 'state', 'page', page.value)
            order by experience.value ->> 'state' collate "C"
          )
          from pg_catalog.jsonb_array_elements(experience_values) as experience(value)
          join pg_catalog.jsonb_array_elements(page_values) as page(value)
            on page.value ->> 'pageId' = experience.value ->> 'pageId'
        ), '[]'::jsonb),
        'shells', case
          when pg_catalog.jsonb_array_length(experience_values) > 0
            then coalesce(
              application_row.compilation_output #> '{canonical,content,shells}',
              '[]'::jsonb
            )
          else '[]'::jsonb
        end,
        'roles', (
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'roleId', role.value ->> 'roleId',
              'key', role.value ->> 'key',
              'homePageId', role.value ->> 'homePageId'
            ) order by role.value ->> 'key' collate "C"
          )
          from pg_catalog.jsonb_array_elements(role_values) as role(value)
        ),
        'permissions', coalesce(permission_values, '[]'::jsonb)
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'kind', 'available',
    'organizationId', addressed_organization.organization_id,
    'tenantShortName', addressed_organization.tenant_short_name,
    'organizationShortName', addressed_organization.organization_short_name,
    'applications', application_values
  );
end
$function$;

revoke all on function vortex_access.read_application_address_candidates(uuid, text, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.read_application_address_candidates(uuid, text, text)
  to vortex_runtime;

comment on function vortex_access.read_application_address_candidates(uuid, text, text) is
  'Private App candidate read for one exact live human organisation address; only App may project metadata after current page Access decisions.';

commit;
