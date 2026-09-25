create or replace function vortex_invalidation.topic_application_root_id(p_topic text)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select case
    when p_topic ~ (
      '^'
      || (
        vortex_access.validation_reference_list('private_invalidation_topic_prefix')
      )[1]
      || ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
      || ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
      then pg_catalog.split_part(p_topic, ':', 4)::uuid
    else null
  end
$function$;

revoke all on function vortex_invalidation.topic_application_root_id(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_invalidation.topic_application_root_id(text)
  to vortex_request, vortex_runtime;

comment on function vortex_invalidation.topic_application_root_id(text) is
  'Extracts the application from a well-formed private topic, or null.';
