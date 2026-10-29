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
      '{"kind":"multi_factor","maximumAgeSeconds":3600}'::jsonb
    ) is null then
      raise exception using errcode = 'V3152',
        message = 'Multi-factor authentication is required for capability ceiling changes';
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

alter function vortex_access.revoke_capability_policy_ceiling(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint) owner to vortex_owner;

grant execute on function vortex_access.revoke_capability_policy_ceiling(p_operator_actor_id uuid, p_duplicate_key uuid, p_tenant_id uuid, p_assignment_id uuid, p_expected_revision bigint) to postgres;
