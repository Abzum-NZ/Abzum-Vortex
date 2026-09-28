create or replace function vortex_identity.update_organization_runtime_settings_internal(
  p_organization_id uuid,
  p_expected_revision bigint,
  p_language text,
  p_time_zone text,
  p_currency text,
  p_date_format text,
  p_number_format text
)
returns table (
  organization_id uuid,
  language text,
  time_zone text,
  currency text,
  date_format text,
  number_format text,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_identity.organization_runtime_settings%rowtype;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Organization runtime settings update is invalid';
  end if;
  perform vortex_identity.assert_organization_runtime_settings_values(
    p_language, p_time_zone, p_currency, p_date_format, p_number_format
  );

  select settings.* into existing
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id
  for update;
  if not found or existing.revision <> p_expected_revision then
    raise exception using errcode = '40001',
      message = 'Organization runtime settings are stale or unavailable';
  end if;

  update vortex_identity.organization_runtime_settings as settings
  set language = p_language,
      time_zone = p_time_zone,
      currency = p_currency,
      date_format = p_date_format,
      number_format = p_number_format,
      changed_at = pg_catalog.statement_timestamp(),
      revision = settings.revision + 1
  where settings.organization_id = p_organization_id
  returning * into existing;

  return query select existing.organization_id, existing.language, existing.time_zone,
    existing.currency, existing.date_format, existing.number_format, existing.revision;
end
$function$;

revoke all on function vortex_identity.update_organization_runtime_settings_internal(uuid, bigint, text, text, text, text, text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_identity.update_organization_runtime_settings_internal(uuid, bigint, text, text, text, text, text) is null;

alter function vortex_identity.update_organization_runtime_settings_internal(uuid, bigint, text, text, text, text, text) owner to vortex_identity_owner;
