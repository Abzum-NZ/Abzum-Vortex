create or replace function vortex_identity.save_organization_runtime_settings_record_internal(
  p_organization_id uuid,
  p_expected_revision bigint,
  p_core_values jsonb,
  p_extension_values jsonb
)
returns table (
  organization_id uuid,
  language text,
  time_zone text,
  currency text,
  date_format text,
  number_format text,
  default_application_root_id uuid,
  extension_values jsonb,
  revision bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  existing vortex_identity.organization_runtime_settings%rowtype;
  language_value text;
  time_zone_value text;
  currency_value text;
  date_format_value text;
  number_format_value text;
  default_application_root_id_value uuid;
  extension_values_value jsonb;
  extension_item record;
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_core_values) is distinct from 'object'
    or p_core_values - array[
      'language', 'time_zone', 'currency', 'date_format', 'number_format',
      'default_application_root_id'
    ] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_extension_values) is distinct from 'object'
    or p_extension_values ?| array[
      'organization_id', 'revision', 'language', 'time_zone', 'currency',
      'date_format', 'number_format', 'default_application_root_id'
    ] then
    raise exception using errcode = '22023',
      message = 'Organization settings record update is invalid';
  end if;

  select settings.* into existing
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id
  for update;
  if not found or existing.revision <> p_expected_revision then
    raise exception using errcode = '40001',
      message = 'Organization settings record is stale or unavailable';
  end if;

  language_value := existing.language;
  time_zone_value := existing.time_zone;
  currency_value := existing.currency;
  date_format_value := existing.date_format;
  number_format_value := existing.number_format;
  default_application_root_id_value := existing.default_application_root_id;

  if p_core_values ? 'language' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'language') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    language_value := p_core_values ->> 'language';
  end if;
  if p_core_values ? 'time_zone' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'time_zone') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    time_zone_value := p_core_values ->> 'time_zone';
  end if;
  if p_core_values ? 'currency' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'currency') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    currency_value := p_core_values ->> 'currency';
  end if;
  if p_core_values ? 'date_format' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'date_format') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    date_format_value := p_core_values ->> 'date_format';
  end if;
  if p_core_values ? 'number_format' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'number_format') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    number_format_value := p_core_values ->> 'number_format';
  end if;
  if p_core_values ? 'default_application_root_id' then
    if pg_catalog.jsonb_typeof(p_core_values -> 'default_application_root_id') = 'null' then
      default_application_root_id_value := null;
    elsif pg_catalog.jsonb_typeof(p_core_values -> 'default_application_root_id') = 'string'
      and pg_catalog.pg_input_is_valid(
        p_core_values ->> 'default_application_root_id', 'uuid'
      ) then
      default_application_root_id_value :=
        (p_core_values ->> 'default_application_root_id')::uuid;
    else
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
    if default_application_root_id_value = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Organization settings record update is invalid';
    end if;
  end if;

  perform vortex_identity.assert_organization_runtime_settings_values(
    language_value, time_zone_value, currency_value, date_format_value, number_format_value
  );

  extension_values_value := existing.extension_values;
  for extension_item in
    select item.key, item.value
    from pg_catalog.jsonb_each(p_extension_values) as item(key, value)
    order by item.key collate "C"
  loop
    if pg_catalog.jsonb_typeof(extension_item.value) = 'null' then
      extension_values_value := extension_values_value - extension_item.key;
    else
      extension_values_value := extension_values_value || pg_catalog.jsonb_build_object(
        extension_item.key, extension_item.value
      );
    end if;
  end loop;

  update vortex_identity.organization_runtime_settings as settings
  set language = language_value,
      time_zone = time_zone_value,
      currency = currency_value,
      date_format = date_format_value,
      number_format = number_format_value,
      default_application_root_id = default_application_root_id_value,
      extension_values = extension_values_value,
      changed_at = pg_catalog.statement_timestamp(),
      revision = settings.revision + 1
  where settings.organization_id = p_organization_id
  returning * into existing;

  return query select existing.organization_id, existing.language, existing.time_zone,
    existing.currency, existing.date_format, existing.number_format,
    existing.default_application_root_id, existing.extension_values, existing.revision;
end
$function$;

revoke all on function vortex_identity.save_organization_runtime_settings_record_internal(
  uuid, bigint, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter;

comment on function vortex_identity.save_organization_runtime_settings_record_internal(
  uuid, bigint, jsonb, jsonb
) is
  'Private revision-checked Identity writer for one organisation settings record, merging invariant field patches and declared extension values in the same settings row.';

alter function vortex_identity.save_organization_runtime_settings_record_internal(uuid, bigint, jsonb, jsonb) owner to vortex_identity_owner;
grant execute on function vortex_identity.save_organization_runtime_settings_record_internal(uuid, bigint, jsonb, jsonb) to postgres;
