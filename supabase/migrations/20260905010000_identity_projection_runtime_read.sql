-- Protected-session resolution must observe an existing projection without
-- recreating it. This deliberately contains no lifecycle transition.
create function vortex_identity.read_identity_projection(p_identity_id uuid)
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
stable
security definer
set search_path = ''
as $function$
begin
  if p_identity_id is null
    or p_identity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Identity projection identifier is invalid';
  end if;

  return query
  select projection.identity_id, projection.state, projection.created_at,
    projection.state_changed_at, projection.state_changed_by,
    projection.state_change_correlation_id, projection.revision
  from vortex_identity.identity_projections as projection
  where projection.identity_id = p_identity_id;
end
$function$;

revoke all on function vortex_identity.read_identity_projection(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.read_identity_projection(uuid)
  to vortex_runtime;

comment on function vortex_identity.read_identity_projection(uuid) is
  'Returns one existing cluster-local identity projection without creating or changing it.';
