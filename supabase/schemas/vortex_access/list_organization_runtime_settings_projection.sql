create or replace function vortex_access.list_organization_runtime_settings_projection(
  p_record_id uuid,
  p_page_size integer
)
returns table (
  organization_id uuid,
  record_id uuid,
  revision bigint,
  attribute_values jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope_row record;
  settings_row record;
  settings_default_application_root_id uuid;
begin
  -- The projection keeps today's row visibility inside itself: the same fixed
  -- runtime-settings read decision the bespoke reader applies decides whether
  -- any row exists at all, and the caller's current organisation is never an
  -- input. A viewer the decision refuses sees no row, exactly as a missing or
  -- foreign record, so the record adapters return their identical refusal and
  -- a list page is empty rather than failing. The record identity is the
  -- organisation, whose settings are a single row, and the revision is the
  -- settings document's own revision, which the default application shares.
  -- Attribute names are the lowercase field keys a projection record type
  -- declares.
  begin
    select authorized.* into strict scope_row
    from vortex_access.organization_runtime_settings_administration_read_scope() as authorized;
  exception
    when insufficient_privilege then
      return;
  end;
  select result.* into settings_row
  from vortex_identity.read_current_organization_runtime_settings_internal(
    scope_row.organization_id
  ) as result;
  if settings_row.organization_id is null
    or settings_row.organization_id is distinct from scope_row.organization_id then
    return;
  end if;
  if p_record_id is not null and p_record_id <> settings_row.organization_id then
    return;
  end if;
  select settings.default_application_root_id into settings_default_application_root_id
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = settings_row.organization_id;
  return query select
    settings_row.organization_id,
    settings_row.organization_id,
    settings_row.revision,
    pg_catalog.jsonb_build_object(
      'language', settings_row.language,
      'time_zone', settings_row.time_zone,
      'currency', settings_row.currency,
      'date_format', settings_row.date_format,
      'number_format', settings_row.number_format,
      'default_application_root_id', settings_default_application_root_id
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
  'Registered organisation runtime-settings projection: returns the one settings row the current viewer may read under the fixed runtime-settings decision, with the organisation, the record identity, the settings revision and the safe projected attribute values keyed by lowercase field key, or no row when the decision refuses the viewer or no settings exist.';
