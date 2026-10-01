-- #1046: keep the settings lists in the validation reference table and route
-- every organisation-settings change through the generic revision-checked save.
-- The seeded values are copied from the exported contracts in
-- contracts/src/identity-access.ts; SQL constraints and writers read those
-- values instead of repeating list literals.

begin;

grant usage on schema vortex_access to vortex_identity_owner;

-- Replace the existing private reader under its established owner. The
-- migration role may SET this role but does not inherit its privileges.
set local role vortex_access_owner;

create or replace function vortex_access.validation_reference_list(p_list text)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  selected_values text[];
begin
  select pg_catalog.array_agg(
    reference.reference_value order by reference.reference_ordinal
  )
  into selected_values
  from vortex_access.validation_reference_values as reference
  where reference.reference_list = p_list;

  -- An unknown or empty list is an internal inconsistency. Refusing it keeps
  -- every check that reads a list closed instead of silently admitting values
  -- because the list it compares against came back empty.
  if selected_values is null then
    raise exception using errcode = '55000',
      message = 'Validation reference list is unavailable';
  end if;

  return selected_values;
end
$function$;

revoke all on function vortex_access.validation_reference_list(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_access.validation_reference_list(text)
  to vortex_request, vortex_runtime, vortex_identity_owner;

comment on function vortex_access.validation_reference_list(text) is
  'Returns the ordered values of one seeded validation reference list; refuses an unknown or empty list so no check can pass against a missing list.';

alter function vortex_access.validation_reference_list(text)
  owner to vortex_access_owner;

-- Constraint validation reads this private helper as the table-owning migration
-- role. Give that role EXECUTE only until all existing rows have been checked.
grant execute on function vortex_access.validation_reference_list(text) to postgres;
reset role;

-- BEGIN GENERATED: organization settings reference seed
insert into vortex_access.validation_reference_values (
  reference_list, reference_value, reference_ordinal
) values
  ('organization_runtime_settings_currency', 'AED', 1),
  ('organization_runtime_settings_currency', 'AFN', 2),
  ('organization_runtime_settings_currency', 'ALL', 3),
  ('organization_runtime_settings_currency', 'AMD', 4),
  ('organization_runtime_settings_currency', 'AOA', 5),
  ('organization_runtime_settings_currency', 'ARS', 6),
  ('organization_runtime_settings_currency', 'AUD', 7),
  ('organization_runtime_settings_currency', 'AWG', 8),
  ('organization_runtime_settings_currency', 'AZN', 9),
  ('organization_runtime_settings_currency', 'BAM', 10),
  ('organization_runtime_settings_currency', 'BBD', 11),
  ('organization_runtime_settings_currency', 'BDT', 12),
  ('organization_runtime_settings_currency', 'BHD', 13),
  ('organization_runtime_settings_currency', 'BIF', 14),
  ('organization_runtime_settings_currency', 'BMD', 15),
  ('organization_runtime_settings_currency', 'BND', 16),
  ('organization_runtime_settings_currency', 'BOB', 17),
  ('organization_runtime_settings_currency', 'BOV', 18),
  ('organization_runtime_settings_currency', 'BRL', 19),
  ('organization_runtime_settings_currency', 'BSD', 20),
  ('organization_runtime_settings_currency', 'BTN', 21),
  ('organization_runtime_settings_currency', 'BWP', 22),
  ('organization_runtime_settings_currency', 'BYN', 23),
  ('organization_runtime_settings_currency', 'BZD', 24),
  ('organization_runtime_settings_currency', 'CAD', 25),
  ('organization_runtime_settings_currency', 'CDF', 26),
  ('organization_runtime_settings_currency', 'CHE', 27),
  ('organization_runtime_settings_currency', 'CHF', 28),
  ('organization_runtime_settings_currency', 'CHW', 29),
  ('organization_runtime_settings_currency', 'CLF', 30),
  ('organization_runtime_settings_currency', 'CLP', 31),
  ('organization_runtime_settings_currency', 'CNY', 32),
  ('organization_runtime_settings_currency', 'COP', 33),
  ('organization_runtime_settings_currency', 'COU', 34),
  ('organization_runtime_settings_currency', 'CRC', 35),
  ('organization_runtime_settings_currency', 'CUP', 36),
  ('organization_runtime_settings_currency', 'CVE', 37),
  ('organization_runtime_settings_currency', 'CZK', 38),
  ('organization_runtime_settings_currency', 'DJF', 39),
  ('organization_runtime_settings_currency', 'DKK', 40),
  ('organization_runtime_settings_currency', 'DOP', 41),
  ('organization_runtime_settings_currency', 'DZD', 42),
  ('organization_runtime_settings_currency', 'EGP', 43),
  ('organization_runtime_settings_currency', 'ERN', 44),
  ('organization_runtime_settings_currency', 'ETB', 45),
  ('organization_runtime_settings_currency', 'EUR', 46),
  ('organization_runtime_settings_currency', 'FJD', 47),
  ('organization_runtime_settings_currency', 'FKP', 48),
  ('organization_runtime_settings_currency', 'GBP', 49),
  ('organization_runtime_settings_currency', 'GEL', 50),
  ('organization_runtime_settings_currency', 'GHS', 51),
  ('organization_runtime_settings_currency', 'GIP', 52),
  ('organization_runtime_settings_currency', 'GMD', 53),
  ('organization_runtime_settings_currency', 'GNF', 54),
  ('organization_runtime_settings_currency', 'GTQ', 55),
  ('organization_runtime_settings_currency', 'GYD', 56),
  ('organization_runtime_settings_currency', 'HKD', 57),
  ('organization_runtime_settings_currency', 'HNL', 58),
  ('organization_runtime_settings_currency', 'HTG', 59),
  ('organization_runtime_settings_currency', 'HUF', 60),
  ('organization_runtime_settings_currency', 'IDR', 61),
  ('organization_runtime_settings_currency', 'ILS', 62),
  ('organization_runtime_settings_currency', 'INR', 63),
  ('organization_runtime_settings_currency', 'IQD', 64),
  ('organization_runtime_settings_currency', 'IRR', 65),
  ('organization_runtime_settings_currency', 'ISK', 66),
  ('organization_runtime_settings_currency', 'JMD', 67),
  ('organization_runtime_settings_currency', 'JOD', 68),
  ('organization_runtime_settings_currency', 'JPY', 69),
  ('organization_runtime_settings_currency', 'KES', 70),
  ('organization_runtime_settings_currency', 'KGS', 71),
  ('organization_runtime_settings_currency', 'KHR', 72),
  ('organization_runtime_settings_currency', 'KMF', 73),
  ('organization_runtime_settings_currency', 'KPW', 74),
  ('organization_runtime_settings_currency', 'KRW', 75),
  ('organization_runtime_settings_currency', 'KWD', 76),
  ('organization_runtime_settings_currency', 'KYD', 77),
  ('organization_runtime_settings_currency', 'KZT', 78),
  ('organization_runtime_settings_currency', 'LAK', 79),
  ('organization_runtime_settings_currency', 'LBP', 80),
  ('organization_runtime_settings_currency', 'LKR', 81),
  ('organization_runtime_settings_currency', 'LRD', 82),
  ('organization_runtime_settings_currency', 'LSL', 83),
  ('organization_runtime_settings_currency', 'LYD', 84),
  ('organization_runtime_settings_currency', 'MAD', 85),
  ('organization_runtime_settings_currency', 'MDL', 86),
  ('organization_runtime_settings_currency', 'MGA', 87),
  ('organization_runtime_settings_currency', 'MKD', 88),
  ('organization_runtime_settings_currency', 'MMK', 89),
  ('organization_runtime_settings_currency', 'MNT', 90),
  ('organization_runtime_settings_currency', 'MOP', 91),
  ('organization_runtime_settings_currency', 'MRU', 92),
  ('organization_runtime_settings_currency', 'MUR', 93),
  ('organization_runtime_settings_currency', 'MVR', 94),
  ('organization_runtime_settings_currency', 'MWK', 95),
  ('organization_runtime_settings_currency', 'MXN', 96),
  ('organization_runtime_settings_currency', 'MXV', 97),
  ('organization_runtime_settings_currency', 'MYR', 98),
  ('organization_runtime_settings_currency', 'MZN', 99),
  ('organization_runtime_settings_currency', 'NAD', 100),
  ('organization_runtime_settings_currency', 'NGN', 101),
  ('organization_runtime_settings_currency', 'NIO', 102),
  ('organization_runtime_settings_currency', 'NOK', 103),
  ('organization_runtime_settings_currency', 'NPR', 104),
  ('organization_runtime_settings_currency', 'NZD', 105),
  ('organization_runtime_settings_currency', 'OMR', 106),
  ('organization_runtime_settings_currency', 'PAB', 107),
  ('organization_runtime_settings_currency', 'PEN', 108),
  ('organization_runtime_settings_currency', 'PGK', 109),
  ('organization_runtime_settings_currency', 'PHP', 110),
  ('organization_runtime_settings_currency', 'PKR', 111),
  ('organization_runtime_settings_currency', 'PLN', 112),
  ('organization_runtime_settings_currency', 'PYG', 113),
  ('organization_runtime_settings_currency', 'QAR', 114),
  ('organization_runtime_settings_currency', 'RON', 115),
  ('organization_runtime_settings_currency', 'RSD', 116),
  ('organization_runtime_settings_currency', 'RUB', 117),
  ('organization_runtime_settings_currency', 'RWF', 118),
  ('organization_runtime_settings_currency', 'SAR', 119),
  ('organization_runtime_settings_currency', 'SBD', 120),
  ('organization_runtime_settings_currency', 'SCR', 121),
  ('organization_runtime_settings_currency', 'SDG', 122),
  ('organization_runtime_settings_currency', 'SEK', 123),
  ('organization_runtime_settings_currency', 'SGD', 124),
  ('organization_runtime_settings_currency', 'SHP', 125),
  ('organization_runtime_settings_currency', 'SLE', 126),
  ('organization_runtime_settings_currency', 'SOS', 127),
  ('organization_runtime_settings_currency', 'SRD', 128),
  ('organization_runtime_settings_currency', 'SSP', 129),
  ('organization_runtime_settings_currency', 'STN', 130),
  ('organization_runtime_settings_currency', 'SVC', 131),
  ('organization_runtime_settings_currency', 'SYP', 132),
  ('organization_runtime_settings_currency', 'SZL', 133),
  ('organization_runtime_settings_currency', 'THB', 134),
  ('organization_runtime_settings_currency', 'TJS', 135),
  ('organization_runtime_settings_currency', 'TMT', 136),
  ('organization_runtime_settings_currency', 'TND', 137),
  ('organization_runtime_settings_currency', 'TOP', 138),
  ('organization_runtime_settings_currency', 'TRY', 139),
  ('organization_runtime_settings_currency', 'TTD', 140),
  ('organization_runtime_settings_currency', 'TWD', 141),
  ('organization_runtime_settings_currency', 'TZS', 142),
  ('organization_runtime_settings_currency', 'UAH', 143),
  ('organization_runtime_settings_currency', 'UGX', 144),
  ('organization_runtime_settings_currency', 'USD', 145),
  ('organization_runtime_settings_currency', 'USN', 146),
  ('organization_runtime_settings_currency', 'UYI', 147),
  ('organization_runtime_settings_currency', 'UYU', 148),
  ('organization_runtime_settings_currency', 'UYW', 149),
  ('organization_runtime_settings_currency', 'UZS', 150),
  ('organization_runtime_settings_currency', 'VED', 151),
  ('organization_runtime_settings_currency', 'VES', 152),
  ('organization_runtime_settings_currency', 'VND', 153),
  ('organization_runtime_settings_currency', 'VUV', 154),
  ('organization_runtime_settings_currency', 'WST', 155),
  ('organization_runtime_settings_currency', 'XAD', 156),
  ('organization_runtime_settings_currency', 'XAF', 157),
  ('organization_runtime_settings_currency', 'XAG', 158),
  ('organization_runtime_settings_currency', 'XAU', 159),
  ('organization_runtime_settings_currency', 'XBA', 160),
  ('organization_runtime_settings_currency', 'XBB', 161),
  ('organization_runtime_settings_currency', 'XBC', 162),
  ('organization_runtime_settings_currency', 'XBD', 163),
  ('organization_runtime_settings_currency', 'XCD', 164),
  ('organization_runtime_settings_currency', 'XCG', 165),
  ('organization_runtime_settings_currency', 'XDR', 166),
  ('organization_runtime_settings_currency', 'XOF', 167),
  ('organization_runtime_settings_currency', 'XPD', 168),
  ('organization_runtime_settings_currency', 'XPF', 169),
  ('organization_runtime_settings_currency', 'XPT', 170),
  ('organization_runtime_settings_currency', 'XSU', 171),
  ('organization_runtime_settings_currency', 'XTS', 172),
  ('organization_runtime_settings_currency', 'XUA', 173),
  ('organization_runtime_settings_currency', 'XXX', 174),
  ('organization_runtime_settings_currency', 'YER', 175),
  ('organization_runtime_settings_currency', 'ZAR', 176),
  ('organization_runtime_settings_currency', 'ZMW', 177),
  ('organization_runtime_settings_currency', 'ZWG', 178),
  ('organization_runtime_settings_date_format', 'short', 1),
  ('organization_runtime_settings_date_format', 'medium', 2),
  ('organization_runtime_settings_date_format', 'long', 3),
  ('organization_runtime_settings_date_format', 'full', 4),
  ('organization_runtime_settings_number_format', 'auto', 1),
  ('organization_runtime_settings_number_format', 'always', 2),
  ('organization_runtime_settings_number_format', 'min2', 3),
  ('organization_runtime_settings_number_format', 'never', 4)
;
-- END GENERATED: organization settings reference seed

alter table vortex_identity.organization_runtime_settings
  drop constraint organization_runtime_settings_currency_valid,
  drop constraint organization_runtime_settings_date_format_valid,
  drop constraint organization_runtime_settings_number_format_valid;

alter table vortex_identity.organization_runtime_settings
  add constraint organization_runtime_settings_currency_valid check (
    currency = any (
      vortex_access.validation_reference_list('organization_runtime_settings_currency')
    )
  ),
  add constraint organization_runtime_settings_date_format_valid check (
    date_format = any (
      vortex_access.validation_reference_list('organization_runtime_settings_date_format')
    )
  ),
  add constraint organization_runtime_settings_number_format_valid check (
    number_format = any (
      vortex_access.validation_reference_list('organization_runtime_settings_number_format')
    )
  );

set local role vortex_access_owner;
revoke execute on function vortex_access.validation_reference_list(text) from postgres;
reset role;

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

drop function vortex_access.update_organization_runtime_settings_for_administration(
  bigint, text, text, text, text, text
);
drop function vortex_access.set_organization_default_application_for_administration(
  uuid, bigint, uuid
);
-- These retired routines now belong to the Identity owner. Drop them as
-- that owner, then restore the migration role before dropping its table.
set local role vortex_identity_owner;

drop function vortex_identity.update_organization_runtime_settings_internal(
  uuid, bigint, text, text, text, text, text
);
drop function vortex_identity.update_organization_default_application_internal(
  uuid, bigint, uuid
);
drop function vortex_identity.read_staged_organization_runtime_settings_update();
drop function vortex_identity.stage_organization_runtime_settings_update(jsonb);
reset role;

drop table vortex_identity.organization_runtime_settings_update_staging;

commit;
