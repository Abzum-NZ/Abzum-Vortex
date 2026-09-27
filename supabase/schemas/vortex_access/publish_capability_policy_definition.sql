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
