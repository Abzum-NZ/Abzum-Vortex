create or replace function vortex_access.read_current_organization_theme_for_application()
returns table (selection jsonb, revision bigint)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  return query
  select theme.selection, theme.revision
  from vortex_identity.organization_themes as theme
  where theme.organization_id = (context_value ->> 'organizationId')::uuid;
end
$function$;

comment on function vortex_access.read_current_organization_theme_for_application() is
  'Reads only the organisation theme of the validated human organisation context: the stored selection delta over the platform default and its revision, or no row when the organisation has none. Every member of the organisation may read it, because every application and Studio draws with it.';

revoke all on function vortex_access.read_current_organization_theme_for_application()
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.read_current_organization_theme_for_application()
  to vortex_request;
alter function vortex_access.read_current_organization_theme_for_application()
  owner to vortex_owner;
grant execute on function vortex_access.read_current_organization_theme_for_application()
  to postgres;
