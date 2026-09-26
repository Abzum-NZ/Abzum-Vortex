create or replace function vortex_access.list_organization_runtime_settings_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
  settings_row record;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- runtime-settings read decision the bespoke reader applies decides whether
  -- any row exists at all, and the caller's current organisation is never an
  -- input. The record identity is the organisation, whose settings are a
  -- single row, and the revision is the settings document's own revision.
  select authorized.* into strict scope_row
  from vortex_access.organization_runtime_settings_administration_read_scope() as authorized;
  select result.* into settings_row
  from vortex_identity.read_current_organization_runtime_settings_internal(
    scope_row.organization_id
  ) as result;
  if settings_row.organization_id is null then
    return;
  end if;
  if p_record_id is not null and p_record_id <> settings_row.organization_id then
    return;
  end if;
  return query select
    settings_row.organization_id,
    settings_row.organization_id,
    settings_row.revision,
    pg_catalog.jsonb_build_object(
      'language', settings_row.language,
      'timeZone', settings_row.time_zone,
      'currency', settings_row.currency,
      'dateFormat', settings_row.date_format,
      'numberFormat', settings_row.number_format
    );
end
$function$;

revoke all on function vortex_access.list_organization_runtime_settings_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner;

grant execute on function vortex_access.list_organization_runtime_settings_projection(
  uuid, integer
) to vortex_record_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_runtime_settings_projection(uuid, integer) is
  'Registered organisation runtime-settings projection: returns the one settings row the current viewer may read under the fixed runtime-settings decision, with the organisation, the record identity, the settings revision and the safe projected attribute values, or no row.';
