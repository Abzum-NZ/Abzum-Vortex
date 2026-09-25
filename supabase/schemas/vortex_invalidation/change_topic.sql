create or replace function vortex_invalidation.change_topic(
  p_organization_id uuid,
  p_application_root_id uuid
)
returns text
language sql
stable
security invoker
set search_path = ''
as $function$
  select case
    when p_organization_id is null or p_application_root_id is null then null
    else (
      vortex_access.validation_reference_list('private_invalidation_topic_prefix')
    )[1]
      || ':' || p_organization_id::text || ':' || p_application_root_id::text
  end
$function$;

revoke all on function vortex_invalidation.change_topic(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_invalidation.change_topic(uuid, uuid)
  to vortex_request, vortex_runtime;

comment on function vortex_invalidation.change_topic(uuid, uuid) is
  'Returns the deterministic private Broadcast topic for one organisation and application.';
