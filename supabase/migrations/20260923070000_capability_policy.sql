-- Generic capability policy definitions and assignments.  These records carry
-- no pricing, subscription, billing or provider state.  A policy revision is
-- immutable; assignments pin one exact revision for one tenant or organisation.

create function vortex_access.capability_policy_quantity_is_valid(p_quantity numeric)
returns boolean
language sql immutable strict parallel safe security invoker set search_path = ''
as $function$
  select p_quantity > 0
    and p_quantity <= 9007199254740991::numeric
    and p_quantity <> 'NaN'::numeric;
$function$;

create function vortex_access.capability_policy_key_is_valid(p_key text)
returns boolean
language sql immutable strict parallel safe security invoker set search_path = ''
as $function$
  select p_key = pg_catalog.btrim(p_key)
    and pg_catalog.length(p_key) between 3 and 120
    and p_key ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
    and not exists (
      select 1 from pg_catalog.unnest(pg_catalog.string_to_array(p_key, '.')) as part(value)
      where pg_catalog.length(part.value) > 40
    );
$function$;

create function vortex_access.capability_policy_unit_is_valid(p_unit text)
returns boolean
language sql immutable strict parallel safe security invoker set search_path = ''
as $function$
  select p_unit = pg_catalog.btrim(p_unit)
    and pg_catalog.length(p_unit) between 1 and 40
    and p_unit ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$';
$function$;

create table vortex_access.capability_policy_definitions (
  policy_id uuid not null,
  tenant_id uuid not null references vortex_identity.tenants (tenant_id),
  capability_key text not null,
  unit text not null,
  quantity_limit numeric not null,
  revision bigint not null,
  published_at timestamptz not null,
  published_by_actor_id uuid not null,
  publication_correlation_id uuid not null,
  primary key (policy_id, revision),
  unique (tenant_id, policy_id, revision),
  constraint capability_policy_definitions_ids_non_nil check (
    vortex_context.is_non_nil_uuid(policy_id::text)
    and vortex_context.is_non_nil_uuid(tenant_id::text)
    and vortex_context.is_non_nil_uuid(published_by_actor_id::text)
    and vortex_context.is_non_nil_uuid(publication_correlation_id::text)
  ),
  constraint capability_policy_definitions_scope_valid check (
    vortex_access.capability_policy_key_is_valid(capability_key)
    and vortex_access.capability_policy_unit_is_valid(unit)
  ),
  constraint capability_policy_definitions_quantity_valid check (
    vortex_access.capability_policy_quantity_is_valid(quantity_limit)
  ),
  constraint capability_policy_definitions_revision_valid check (
    revision between 1 and 9007199254740991
  ),
  constraint capability_policy_definitions_time_valid check (
    published_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
  )
);

create table vortex_access.capability_policy_assignments (
  assignment_id uuid not null,
  tenant_id uuid not null references vortex_identity.tenants (tenant_id),
  organization_id uuid references vortex_identity.organizations (organization_id),
  policy_id uuid not null,
  policy_revision bigint not null,
  capability_key text not null,
  unit text not null,
  starts_at timestamptz not null,
  expires_at timestamptz,
  revision bigint not null,
  assigned_at timestamptz not null,
  assigned_by_actor_id uuid not null,
  assignment_correlation_id uuid not null,
  changed_at timestamptz not null,
  changed_by_actor_id uuid not null,
  change_correlation_id uuid not null,
  revoked_at timestamptz,
  revoked_by_actor_id uuid,
  revocation_correlation_id uuid,
  primary key (assignment_id),
  foreign key (tenant_id, policy_id, policy_revision)
    references vortex_access.capability_policy_definitions (tenant_id, policy_id, revision),
  constraint capability_policy_assignments_ids_non_nil check (
    vortex_context.is_non_nil_uuid(assignment_id::text)
    and vortex_context.is_non_nil_uuid(tenant_id::text)
    and (organization_id is null or vortex_context.is_non_nil_uuid(organization_id::text))
    and vortex_context.is_non_nil_uuid(policy_id::text)
    and vortex_context.is_non_nil_uuid(assigned_by_actor_id::text)
    and vortex_context.is_non_nil_uuid(assignment_correlation_id::text)
    and vortex_context.is_non_nil_uuid(changed_by_actor_id::text)
    and vortex_context.is_non_nil_uuid(change_correlation_id::text)
    and (revoked_by_actor_id is null
      or vortex_context.is_non_nil_uuid(revoked_by_actor_id::text))
    and (revocation_correlation_id is null
      or vortex_context.is_non_nil_uuid(revocation_correlation_id::text))
  ),
  constraint capability_policy_assignments_scope_valid check (
    vortex_access.capability_policy_key_is_valid(capability_key)
    and vortex_access.capability_policy_unit_is_valid(unit)
  ),
  constraint capability_policy_assignments_revisions_valid check (
    policy_revision between 1 and 9007199254740991
    and revision between 1 and 9007199254740991
  ),
  constraint capability_policy_assignments_time_valid check (
    starts_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and assigned_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and changed_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    and (expires_at is null
      or expires_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and (revoked_at is null
      or revoked_at not in ('-infinity'::timestamptz, 'infinity'::timestamptz))
    and (expires_at is null or expires_at > starts_at)
  ),
  constraint capability_policy_assignments_revocation_complete check (
    (revoked_at is null and revoked_by_actor_id is null and revocation_correlation_id is null)
    or (
      revoked_at is not null
      and revoked_by_actor_id is not null
      and revocation_correlation_id is not null
      and revoked_at = changed_at
      and revoked_by_actor_id = changed_by_actor_id
      and revocation_correlation_id = change_correlation_id
    )
  )
);

create unique index capability_policy_assignments_live_scope_unique
  on vortex_access.capability_policy_assignments (
    tenant_id, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    capability_key, unit
  ) where revoked_at is null;
create index capability_policy_definitions_tenant_scope_idx
  on vortex_access.capability_policy_definitions (tenant_id, capability_key, unit, policy_id, revision);
create index capability_policy_assignments_effective_scope_idx
  on vortex_access.capability_policy_assignments (
    tenant_id, organization_id, capability_key, unit, starts_at, expires_at
  ) where revoked_at is null;

alter table vortex_access.capability_policy_definitions enable row level security;
alter table vortex_access.capability_policy_definitions force row level security;
alter table vortex_access.capability_policy_assignments enable row level security;
alter table vortex_access.capability_policy_assignments force row level security;

revoke all on table vortex_access.capability_policy_definitions,
  vortex_access.capability_policy_assignments
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
revoke execute on function
  vortex_access.capability_policy_quantity_is_valid(numeric),
  vortex_access.capability_policy_key_is_valid(text),
  vortex_access.capability_policy_unit_is_valid(text)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

create function vortex_access.publish_capability_policy_definition(
  p_actor_identity_id uuid,
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_policy_id uuid,
  p_capability_key text,
  p_unit text,
  p_quantity_limit numeric,
  p_expected_revision bigint default null
)
returns table (
  outcome text, policy_id uuid, tenant_id uuid, capability_key text, unit text,
  quantity_limit numeric, revision bigint, correlation_id uuid, accepted_at timestamptz
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  current_revision bigint;
  resulting_revision bigint;
  correlation uuid := pg_catalog.gen_random_uuid();
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  command_fingerprint text;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or p_policy_id is null or not vortex_context.is_non_nil_uuid(p_policy_id::text)
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit)
    or not vortex_access.capability_policy_quantity_is_valid(p_quantity_limit)
    or (p_expected_revision is not null
      and p_expected_revision not between 1 and 9007199254740991) then
    raise exception using errcode = '22023', message = 'Capability policy definition is invalid';
  end if;
  perform 1 from vortex_identity.tenants where tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  perform vortex_identity.require_current_tenant_capability(
    p_actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at
  );
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'publish_capability_policy_definition',
      p_tenant_id::text, p_policy_id::text, p_capability_key, p_unit,
      p_quantity_limit::text, coalesce(p_expected_revision::text, '')), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts as stored
  where stored.actor_id = p_actor_identity_id and stored.tenant_id = p_tenant_id
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
  select max(definition.revision) into current_revision
  from vortex_access.capability_policy_definitions as definition
  where definition.tenant_id = p_tenant_id and definition.policy_id = p_policy_id;
  if (current_revision is null and p_expected_revision is not null)
    or (current_revision is not null and p_expected_revision is distinct from current_revision)
    or (current_revision is null and p_expected_revision is null and exists (
      select 1 from vortex_access.capability_policy_definitions definition
      where definition.policy_id = p_policy_id
    )) then
    raise exception using errcode = 'V3102', message = 'Capability policy definition revision is stale';
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
    evaluated_at, p_actor_identity_id, correlation
  );
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    correlation, p_actor_identity_id, p_tenant_id, 'publish_capability_policy_definition',
    p_duplicate_key, command_fingerprint, array[p_policy_id], array[resulting_revision], evaluated_at
  );
  return query select 'accepted'::text, p_policy_id, p_tenant_id, p_capability_key,
    p_unit, p_quantity_limit, resulting_revision, correlation, evaluated_at;
end
$function$;

create function vortex_access.assign_capability_policy(
  p_actor_identity_id uuid,
  p_actor_organization_account_id uuid,
  p_duplicate_key uuid,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_assignment_id uuid,
  p_policy_id uuid,
  p_policy_revision bigint,
  p_starts_at timestamptz,
  p_expires_at timestamptz default null
)
returns table (
  outcome text, assignment_id uuid, policy_id uuid, policy_revision bigint,
  tenant_id uuid, organization_id uuid, revision bigint, correlation_id uuid,
  accepted_at timestamptz
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  actor_id uuid := p_actor_identity_id;
  organization_scope uuid;
  organization_account uuid;
  policy record;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or (p_actor_organization_account_id is not null
      and not vortex_context.is_non_nil_uuid(p_actor_organization_account_id::text))
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_policy_id is null or not vortex_context.is_non_nil_uuid(p_policy_id::text)
    or p_policy_revision is null or p_policy_revision not between 1 and 9007199254740991
    or p_starts_at is null or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and (p_expires_at <= p_starts_at
      or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz))) then
    raise exception using errcode = '22023', message = 'Capability policy assignment is invalid';
  end if;
  perform 1 from vortex_identity.tenants where tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'V3101', message = 'Capability policy tenant is unavailable';
  end if;
  if p_organization_id is null then
    if p_actor_organization_account_id is not null then
      raise exception using errcode = '42501', message = 'Capability policy tenant authority is unavailable';
    end if;
    perform vortex_identity.require_current_tenant_capability(
      p_actor_identity_id, p_tenant_id, 'platform.tenant.administrators.manage', evaluated_at
    );
  else
    select organization_decision.organization_id, organization_decision.organization_account_id
      into strict organization_scope, organization_account
    from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.assignments.manage',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform', 'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
          'permissionId', '156d01f3-8f80-45fb-8fc8-b31c47dbb1df'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) as organization_decision
    where organization_decision.outcome = 'eligible';
    if organization_scope <> p_organization_id
      or (vortex_context.current_context() ->> 'identityId')::uuid is distinct from p_actor_identity_id then
      raise exception using errcode = '42501', message = 'Capability policy organization authority is unavailable';
    end if;
    if p_actor_organization_account_id is null
      or organization_account <> p_actor_organization_account_id then
      raise exception using errcode = '42501', message = 'Capability policy organization actor is unavailable';
    end if;
    actor_id := p_actor_organization_account_id;
    perform 1 from vortex_identity.organizations organization
    where organization.organization_id = p_organization_id
      and organization.tenant_id = p_tenant_id and organization.state = 'active';
    if not found then
      raise exception using errcode = '42501', message = 'Capability policy organization is unavailable';
    end if;
  end if;
  select definition.* into strict policy
  from vortex_access.capability_policy_definitions definition
  where definition.tenant_id = p_tenant_id and definition.policy_id = p_policy_id
    and definition.revision = p_policy_revision;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'assign_capability_policy',
      p_tenant_id::text, coalesce(p_organization_id::text, ''), p_assignment_id::text,
      p_policy_id::text, p_policy_revision::text, p_starts_at::text,
      coalesce(p_expires_at::text, '')), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts stored
  where stored.actor_id = actor_id and stored.tenant_id = p_tenant_id
    and stored.operation_key = 'assign_capability_policy'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_assignment_id]
      or receipt.subject_revisions[1] is null then
      raise exception using errcode = 'V3001', message = 'Capability policy assignment duplicate conflicts';
    end if;
    return query select 'replayed'::text, assignment.assignment_id, assignment.policy_id,
      assignment.policy_revision, assignment.tenant_id, assignment.organization_id,
      assignment.revision, receipt.receipt_id, receipt.accepted_at
    from vortex_access.capability_policy_assignments assignment
    where assignment.assignment_id = p_assignment_id
      and assignment.revision = receipt.subject_revisions[1];
    if not found then
      raise exception using errcode = '42501', message = 'Capability policy assignment replay is unavailable';
    end if;
    return;
  end if;
  if exists (
    select 1 from vortex_access.capability_policy_assignments assignment
    where assignment.tenant_id = p_tenant_id
      and assignment.organization_id is not distinct from p_organization_id
      and assignment.capability_key = policy.capability_key
      and assignment.unit = policy.unit and assignment.revoked_at is null
  ) then
    raise exception using errcode = '23505', message = 'Capability policy assignment already exists';
  end if;
  insert into vortex_access.capability_policy_assignments(
    assignment_id, tenant_id, organization_id, policy_id, policy_revision,
    capability_key, unit, starts_at, expires_at, revision, assigned_at,
    assigned_by_actor_id, assignment_correlation_id, changed_at,
    changed_by_actor_id, change_correlation_id
  ) values (
    p_assignment_id, p_tenant_id, p_organization_id, p_policy_id, p_policy_revision,
    policy.capability_key, policy.unit, p_starts_at, p_expires_at, 1, evaluated_at,
    actor_id, correlation, evaluated_at, actor_id, correlation
  );
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    correlation, actor_id, p_tenant_id, 'assign_capability_policy', p_duplicate_key,
    command_fingerprint, array[p_assignment_id], array[1::bigint], evaluated_at
  );
  return query select 'accepted'::text, p_assignment_id, p_policy_id, p_policy_revision,
    p_tenant_id, p_organization_id, 1::bigint, correlation, evaluated_at;
end
$function$;

create function vortex_access.revoke_capability_policy_assignment(
  p_actor_identity_id uuid, p_actor_organization_account_id uuid,
  p_duplicate_key uuid, p_assignment_id uuid,
  p_expected_revision bigint
)
returns table (outcome text, assignment_id uuid, revision bigint, correlation_id uuid, accepted_at timestamptz)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  target record;
  actor_id uuid := p_actor_identity_id;
  receipt vortex_identity.accepted_administration_receipts%rowtype;
  correlation uuid := pg_catalog.gen_random_uuid();
  command_fingerprint text;
begin
  if p_actor_identity_id is null or not vortex_context.is_non_nil_uuid(p_actor_identity_id::text)
    or (p_actor_organization_account_id is not null
      and not vortex_context.is_non_nil_uuid(p_actor_organization_account_id::text))
    or p_duplicate_key is null or not vortex_context.is_non_nil_uuid(p_duplicate_key::text)
    or p_assignment_id is null or not vortex_context.is_non_nil_uuid(p_assignment_id::text)
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023', message = 'Capability policy revocation is invalid';
  end if;
  select assignment.* into strict target
  from vortex_access.capability_policy_assignments assignment
  where assignment.assignment_id = p_assignment_id for update;
  if target.revoked_at is not null or target.revision <> p_expected_revision then
    raise exception using errcode = 'V3102', message = 'Capability policy assignment is stale';
  end if;
  if target.organization_id is null then
    if p_actor_organization_account_id is not null then
      raise exception using errcode = '42501', message = 'Capability policy tenant authority is unavailable';
    end if;
    perform vortex_identity.require_current_tenant_capability(
      p_actor_identity_id, target.tenant_id, 'platform.tenant.administrators.manage', evaluated_at
    );
  else
    perform 1 from vortex_access.evaluate_organization_permission_eligibility(
      pg_catalog.jsonb_build_object(
        'operationKey', 'platform.organization.assignments.manage',
        'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
        'target', pg_catalog.jsonb_build_object('kind', 'organization'),
        'requiredPermission', pg_catalog.jsonb_build_object(
          'ownerKind', 'platform', 'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
          'permissionId', '156d01f3-8f80-45fb-8fc8-b31c47dbb1df'
        ),
        'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
        'authority', pg_catalog.jsonb_build_object('kind', 'permission')
      )
    ) evaluated
    where evaluated.outcome = 'eligible'
      and evaluated.organization_id = target.organization_id;
    if not found or (vortex_context.current_context() ->> 'identityId')::uuid is distinct from p_actor_identity_id then
      raise exception using errcode = '42501', message = 'Capability policy organization authority is unavailable';
    end if;
    actor_id := (vortex_context.current_context() ->> 'organizationAccountId')::uuid;
    if actor_id is null or not vortex_context.is_non_nil_uuid(actor_id::text)
      or p_actor_organization_account_id is null
      or actor_id <> p_actor_organization_account_id then
      raise exception using errcode = '42501', message = 'Capability policy organization actor is unavailable';
    end if;
  end if;
  command_fingerprint := 'sha256:' || pg_catalog.encode(extensions.digest(
    pg_catalog.convert_to(pg_catalog.concat_ws(E'\x1f', 'revoke_capability_policy_assignment',
      target.tenant_id::text, target.organization_id::text, p_assignment_id::text,
      p_expected_revision::text), 'UTF8'), 'sha256'), 'hex');
  select stored.* into receipt
  from vortex_identity.accepted_administration_receipts stored
  where stored.actor_id = actor_id and stored.tenant_id = target.tenant_id
    and stored.operation_key = 'revoke_capability_policy_assignment'
    and stored.duplicate_key = p_duplicate_key for update;
  if found then
    if receipt.command_fingerprint <> command_fingerprint
      or receipt.subject_ids <> array[p_assignment_id] then
      raise exception using errcode = 'V3001', message = 'Capability policy revocation duplicate conflicts';
    end if;
    return query select 'replayed'::text, p_assignment_id, receipt.subject_revisions[1],
      receipt.receipt_id, receipt.accepted_at;
    return;
  end if;
  update vortex_access.capability_policy_assignments assignment
  set revision = p_expected_revision + 1, changed_at = evaluated_at,
      changed_by_actor_id = actor_id, change_correlation_id = correlation,
      revoked_at = evaluated_at, revoked_by_actor_id = actor_id,
      revocation_correlation_id = correlation
  where assignment.assignment_id = p_assignment_id;
  insert into vortex_identity.accepted_administration_receipts(
    receipt_id, actor_id, tenant_id, operation_key, duplicate_key,
    command_fingerprint, subject_ids, subject_revisions, accepted_at
  ) values (
    correlation, actor_id, target.tenant_id, 'revoke_capability_policy_assignment',
    p_duplicate_key, command_fingerprint, array[p_assignment_id],
    array[(p_expected_revision + 1)::bigint], evaluated_at
  );
  return query select 'accepted'::text, p_assignment_id, p_expected_revision + 1,
    correlation, evaluated_at;
end
$function$;

create function vortex_access.resolve_effective_capability_policy(
  p_tenant_id uuid, p_organization_id uuid, p_capability_key text, p_unit text
)
returns table (
  outcome text, tenant_id uuid, organization_id uuid, capability_key text, unit text,
  policy_id uuid, policy_revision bigint, assignment_id uuid, assignment_revision bigint,
  quantity_limit numeric, resolved_at timestamptz, reason_code text
)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
  context jsonb := vortex_context.current_context();
  selected record;
begin
  if p_tenant_id is null or not vortex_context.is_non_nil_uuid(p_tenant_id::text)
    or (p_organization_id is not null and not vortex_context.is_non_nil_uuid(p_organization_id::text))
    or not vortex_access.capability_policy_key_is_valid(p_capability_key)
    or not vortex_access.capability_policy_unit_is_valid(p_unit) then
    raise exception using errcode = '22023', message = 'Capability policy resolution is invalid';
  end if;
  if (context ->> 'tenantId')::uuid is distinct from p_tenant_id
    or (p_organization_id is not null and (context ->> 'organizationId')::uuid is distinct from p_organization_id) then
    raise exception using errcode = '42501', message = 'Capability policy scope is unavailable';
  end if;
  if p_organization_id is not null and not exists (
    select 1 from vortex_identity.organizations organization
    where organization.tenant_id = p_tenant_id
      and organization.organization_id = p_organization_id
      and organization.state = 'active'
  ) then
    raise exception using errcode = '42501', message = 'Capability policy scope is unavailable';
  end if;
  with candidates as (
    select 0 as priority, assignment.organization_id, assignment.policy_id,
      assignment.policy_revision, assignment.assignment_id, assignment.revision as assignment_revision,
      definition.quantity_limit
    from vortex_access.capability_policy_assignments assignment
    join vortex_access.capability_policy_definitions definition
      on definition.policy_id = assignment.policy_id
      and definition.revision = assignment.policy_revision
      and definition.tenant_id = assignment.tenant_id
    where p_organization_id is not null
      and assignment.tenant_id = p_tenant_id
      and assignment.organization_id = p_organization_id
      and assignment.capability_key = p_capability_key and assignment.unit = p_unit
      and assignment.revoked_at is null and assignment.starts_at <= evaluated_at
      and (assignment.expires_at is null or assignment.expires_at > evaluated_at)
    union all
    select 1 as priority, null::uuid, assignment.policy_id,
      assignment.policy_revision, assignment.assignment_id, assignment.revision,
      definition.quantity_limit
    from vortex_access.capability_policy_assignments assignment
    join vortex_access.capability_policy_definitions definition
      on definition.policy_id = assignment.policy_id
      and definition.revision = assignment.policy_revision
      and definition.tenant_id = assignment.tenant_id
    where assignment.tenant_id = p_tenant_id and assignment.organization_id is null
      and assignment.capability_key = p_capability_key and assignment.unit = p_unit
      and assignment.revoked_at is null and assignment.starts_at <= evaluated_at
      and (assignment.expires_at is null or assignment.expires_at > evaluated_at)
  )
  select candidates.* into selected from candidates order by priority, assignment_id limit 1;
  if not found then
    return query select 'refused'::text, p_tenant_id, p_organization_id,
      p_capability_key, p_unit, null::uuid, null::bigint, null::uuid, null::bigint,
      null::numeric, evaluated_at, 'capability_not_assigned'::text;
    return;
  end if;
  return query select 'available'::text, p_tenant_id, selected.organization_id,
    p_capability_key, p_unit, selected.policy_id, selected.policy_revision,
    selected.assignment_id, selected.assignment_revision, selected.quantity_limit,
    evaluated_at, null::text;
end
$function$;

revoke execute on function vortex_access.publish_capability_policy_definition(
  uuid, uuid, uuid, uuid, text, text, numeric, bigint
), vortex_access.assign_capability_policy(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz
), vortex_access.revoke_capability_policy_assignment(uuid, uuid, uuid, uuid, bigint),
vortex_access.resolve_effective_capability_policy(uuid, uuid, text, text)
from public, anon, authenticated, service_role, vortex_runtime,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.publish_capability_policy_definition(
  uuid, uuid, uuid, uuid, text, text, numeric, bigint
), vortex_access.assign_capability_policy(
  uuid, uuid, uuid, uuid, uuid, uuid, uuid, bigint, timestamptz, timestamptz
), vortex_access.revoke_capability_policy_assignment(uuid, uuid, uuid, uuid, bigint),
vortex_access.resolve_effective_capability_policy(uuid, uuid, text, text)
to vortex_runtime, vortex_request;

comment on table vortex_access.capability_policy_definitions is
  'Immutable generic capability limits; policy revisions contain no commercial or provider state.';
comment on table vortex_access.capability_policy_assignments is
  'Protected tenant or organisation policy assignments pinned to one exact policy revision.';
comment on function vortex_access.resolve_effective_capability_policy(uuid, uuid, text, text) is
  'Returns the most-specific active tenant/organisation policy revision for the current request scope.';
