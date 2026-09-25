create or replace function vortex_context.channel()
returns text
language sql
stable
security invoker
set search_path = ''
as $function$
  select coalesce(vortex_context.current_context() ->> 'channel', 'web')
$function$;

revoke execute on function vortex_context.channel()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_context.channel() to vortex_request;

comment on function vortex_context.channel() is
  'Returns the channel the trusted entry point installed in this transaction''s request context, or web when that entry point set none; never a client-supplied value.';
