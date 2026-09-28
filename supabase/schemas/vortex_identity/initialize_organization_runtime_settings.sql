create or replace function vortex_identity.initialize_organization_runtime_settings(
  p_organization_id uuid,
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
  operation_at timestamptz := pg_catalog.statement_timestamp();
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization runtime settings initialization is invalid';
  end if;
  perform vortex_identity.assert_organization_runtime_settings_values(
    p_language, p_time_zone, p_currency, p_date_format, p_number_format
  );

  -- Serialize setup through the organisation itself.  That makes two
  -- simultaneous identical setup calls behave as retries rather than leaving
  -- one with a unique-constraint error, and it refuses an unknown organisation
  -- before any settings row can be created.
  perform 1
  from vortex_identity.organizations as organization
  where organization.organization_id = p_organization_id
  for update;
  if not found then
    raise exception using errcode = '22023',
      message = 'Organization runtime settings initialization is unavailable';
  end if;

  -- The organisation lock makes this read and the following insert one
  -- serializable setup decision for an organisation.
  select settings.* into existing
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id
  for update;

  if found then
    if existing.language is distinct from p_language
      or existing.time_zone is distinct from p_time_zone
      or existing.currency is distinct from p_currency
      or existing.date_format is distinct from p_date_format
      or existing.number_format is distinct from p_number_format then
      raise exception using errcode = '40001',
        message = 'Organization runtime settings are already initialized differently';
    end if;
    return query select existing.organization_id, existing.language, existing.time_zone,
      existing.currency, existing.date_format, existing.number_format, existing.revision;
    return;
  end if;

  insert into vortex_identity.organization_runtime_settings (
    organization_id, language, time_zone, currency, date_format, number_format,
    initialized_at, changed_at, revision
  ) values (
    p_organization_id, p_language, p_time_zone, p_currency, p_date_format,
    p_number_format, operation_at, operation_at, 1
  ) returning * into existing;

  return query select existing.organization_id, existing.language, existing.time_zone,
    existing.currency, existing.date_format, existing.number_format, existing.revision;
end
$function$;

revoke all on function vortex_identity.initialize_organization_runtime_settings(uuid, text, text, text, text, text) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_identity.initialize_organization_runtime_settings(uuid, text, text, text, text, text) to vortex_runtime;

comment on function vortex_identity.initialize_organization_runtime_settings(
  uuid, text, text, text, text, text
) is 'Trusted explicit Identity setup for one organisation runtime-settings row; identical retries return the current existing row and conflicting retries refuse.';

alter function vortex_identity.initialize_organization_runtime_settings(uuid, text, text, text, text, text) owner to vortex_identity_owner;
set role vortex_identity_owner;
grant execute on function vortex_identity.initialize_organization_runtime_settings(uuid, text, text, text, text, text) to postgres;
reset role;
