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
  where assignment.revoked_at is null
  for update;
  if found then
    raise exception using errcode = 'V3141',
      message = 'Super-administrator bootstrap is unavailable while an assignment is active';
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
  'Bootstraps a named super-administrator assignment through the existing configured system operator when no assignment is active.';
