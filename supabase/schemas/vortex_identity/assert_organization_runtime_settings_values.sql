create or replace function vortex_identity.assert_organization_runtime_settings_values(
  p_language text,
  p_time_zone text,
  p_currency text,
  p_date_format text,
  p_number_format text
)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if p_language is null
    or p_language <> pg_catalog.btrim(p_language)
    or pg_catalog.char_length(p_language) < 2
    -- Exact BCP-47 canonicalisation belongs to the trusted contract adapter.
    or p_time_zone is null
    or p_time_zone <> pg_catalog.btrim(p_time_zone)
    or pg_catalog.char_length(p_time_zone) not between 1 and 100
    -- pg_timezone_names admits aliases that the contract deliberately rejects.
    or p_currency is null
    or p_currency <> all (
      vortex_access.validation_reference_list('organization_runtime_settings_currency')
    )
    or p_date_format is null
    or p_date_format <> all (
      vortex_access.validation_reference_list('organization_runtime_settings_date_format')
    )
    or p_number_format is null
    or p_number_format <> all (
      vortex_access.validation_reference_list('organization_runtime_settings_number_format')
    ) then
    raise exception using errcode = '22023',
      message = 'Organization runtime settings are invalid';
  end if;
end
$function$;

revoke all on function vortex_identity.assert_organization_runtime_settings_values(
  text, text, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
grant execute on function vortex_identity.assert_organization_runtime_settings_values(
  text, text, text, text, text
) to vortex_identity_owner;

comment on function vortex_identity.assert_organization_runtime_settings_values(
  text, text, text, text, text
) is
  'Private boundary validation for organisation runtime settings; currency and display-format membership comes from the seeded validation reference lists.';

alter function vortex_identity.assert_organization_runtime_settings_values(
  text, text, text, text, text
) owner to postgres;
