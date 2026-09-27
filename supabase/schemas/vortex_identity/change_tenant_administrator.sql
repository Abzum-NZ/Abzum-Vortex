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
