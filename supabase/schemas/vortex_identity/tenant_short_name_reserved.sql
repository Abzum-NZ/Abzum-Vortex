create or replace function vortex_identity.tenant_short_name_reserved(p_short_name text)
returns boolean
language sql
immutable
strict
set search_path = ''
as $function$
  select p_short_name = any (array['api', 'auth', 'fonts', 'health', 'signed-in', 'studio']::text[])
$function$;

alter function vortex_identity.tenant_short_name_reserved(text) owner to vortex_owner;
revoke all on function vortex_identity.tenant_short_name_reserved(text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_identity.tenant_short_name_reserved(text) to vortex_owner, postgres;
