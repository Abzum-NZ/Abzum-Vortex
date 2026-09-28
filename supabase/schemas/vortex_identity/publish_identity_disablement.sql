create or replace function vortex_identity.publish_identity_disablement(
  p_subject_identity_id uuid,
  p_actor_identity_id uuid,
  p_correlation_id uuid,
  p_published_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'vortex_identity.projection:' || p_subject_identity_id::text, 0
    )
  );

  perform 1
  from vortex_identity.identity_projections as projection
  where projection.identity_id = p_subject_identity_id
  for update;

  update vortex_identity.identity_projections as projection
  set state = 'suspended',
    state_changed_at = greatest(p_published_at, projection.state_changed_at),
    state_changed_by = p_actor_identity_id,
    state_change_correlation_id = p_correlation_id,
    revision = projection.revision + 1
  where projection.identity_id = p_subject_identity_id
    and projection.state = 'active';
end
$function$;

revoke all on function vortex_identity.publish_identity_disablement(uuid, uuid, uuid, timestamptz) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.publish_identity_disablement(uuid, uuid, uuid, timestamptz) is
  'Private step of complete_identity_disablement: suspends the subject''s existing cluster-local identity projection.';

alter function vortex_identity.publish_identity_disablement(uuid, uuid, uuid, timestamptz) owner to vortex_identity_owner;
set role vortex_identity_owner;
grant execute on function vortex_identity.publish_identity_disablement(uuid, uuid, uuid, timestamptz) to postgres;
reset role;
