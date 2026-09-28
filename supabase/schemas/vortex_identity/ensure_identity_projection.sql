create or replace function vortex_identity.ensure_identity_projection(
  p_identity_id uuid,
  p_correlation_id uuid
)
returns table (
  identity_id uuid,
  state text,
  created_at timestamptz,
  state_changed_at timestamptz,
  state_changed_by uuid,
  state_change_correlation_id uuid,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Identity projection input is invalid';
  end if;

  insert into vortex_identity.identity_projections (
    identity_id, state, created_at, state_changed_at, state_changed_by,
    state_change_correlation_id, revision
  ) values (
    p_identity_id, 'active', operation_at, operation_at, p_identity_id,
    p_correlation_id, 1
  ) on conflict on constraint identity_projections_pk do nothing;

  return query
  select projection.identity_id, projection.state, projection.created_at,
    projection.state_changed_at, projection.state_changed_by,
    projection.state_change_correlation_id, projection.revision
  from vortex_identity.identity_projections as projection
  where projection.identity_id = p_identity_id;
end
$function$;

revoke all on function vortex_identity.ensure_identity_projection(uuid, uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.ensure_identity_projection(uuid, uuid) to vortex_runtime;

comment on function vortex_identity.ensure_identity_projection(uuid, uuid) is null;

alter function vortex_identity.ensure_identity_projection(uuid, uuid) owner to vortex_identity_owner;
