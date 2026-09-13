-- One private, Identity-owned runtime-settings row per organisation.  This is
-- deliberately not a Records table: the values govern application execution
-- and are obtained only through the fixed readers below.
create table vortex_identity.organization_runtime_settings (
  organization_id uuid primary key
    references vortex_identity.organizations (organization_id),
  language text not null,
  time_zone text not null,
  currency text not null,
  date_format text not null,
  number_format text not null,
  initialized_at timestamptz not null,
  changed_at timestamptz not null,
  revision bigint not null,
  constraint organization_runtime_settings_organization_non_nil check (
    organization_id <> '00000000-0000-0000-0000-000000000000'::uuid
  ),
  -- The current ISO-4217 set is deliberately pinned here as well as in the
  -- contract, so a direct protected SQL call cannot substitute an unsupported
  -- currency. Time-zone and language canonicalization remain checked by the
  -- trusted contract adapter; SQL additionally rejects malformed values.
  constraint organization_runtime_settings_language_valid check (
    language = pg_catalog.btrim(language)
    and pg_catalog.char_length(language) >= 2
  ),
  constraint organization_runtime_settings_time_zone_valid check (
    time_zone = pg_catalog.btrim(time_zone)
    and pg_catalog.char_length(time_zone) between 1 and 100
  ),
  constraint organization_runtime_settings_currency_valid check (
    currency = any (array[
      'AED','AFN','ALL','AMD','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT',
      'BHD','BIF','BMD','BND','BOB','BOV','BRL','BSD','BTN','BWP','BYN','BZD',
      'CAD','CDF','CHE','CHF','CHW','CLF','CLP','CNY','COP','COU','CRC','CUP',
      'CVE','CZK','DJF','DKK','DOP','DZD','EGP','ERN','ETB','EUR','FJD','FKP',
      'GBP','GEL','GHS','GIP','GMD','GNF','GTQ','GYD','HKD','HNL','HTG','HUF',
      'IDR','ILS','INR','IQD','IRR','ISK','JMD','JOD','JPY','KES','KGS','KHR',
      'KMF','KPW','KRW','KWD','KYD','KZT','LAK','LBP','LKR','LRD','LSL','LYD',
      'MAD','MDL','MGA','MKD','MMK','MNT','MOP','MRU','MUR','MVR','MWK','MXN',
      'MXV','MYR','MZN','NAD','NGN','NIO','NOK','NPR','NZD','OMR','PAB','PEN',
      'PGK','PHP','PKR','PLN','PYG','QAR','RON','RSD','RUB','RWF','SAR','SBD',
      'SCR','SDG','SEK','SGD','SHP','SLE','SOS','SRD','SSP','STN','SVC','SYP',
      'SZL','THB','TJS','TMT','TND','TOP','TRY','TTD','TWD','TZS','UAH','UGX',
      'USD','USN','UYI','UYU','UYW','UZS','VED','VES','VND','VUV','WST','XAD',
      'XAF','XAG','XAU','XBA','XBB','XBC','XBD','XCD','XCG','XDR','XOF','XPD',
      'XPF','XPT','XSU','XTS','XUA','XXX','YER','ZAR','ZMW','ZWG'
    ]::text[])
  ),
  constraint organization_runtime_settings_date_format_valid check (
    date_format in ('short', 'medium', 'long', 'full')
  ),
  constraint organization_runtime_settings_number_format_valid check (
    number_format in ('auto', 'always', 'min2', 'never')
  ),
  constraint organization_runtime_settings_time_order check (
    changed_at >= initialized_at
  ),
  constraint organization_runtime_settings_revision_range check (
    revision between 1 and 9007199254740991
  )
);

alter table vortex_identity.organization_runtime_settings enable row level security;
alter table vortex_identity.organization_runtime_settings force row level security;

-- A typed runtime service stages one validated update before it drops to the
-- request role.  The row is bound to one backend and top-level transaction,
-- just like request context, so request SQL cannot forge values or reuse a
-- prior command. It is not a queue or a persisted command log.
create unlogged table vortex_identity.organization_runtime_settings_update_staging (
  backend_pid integer not null,
  transaction_id xid8 not null,
  settings jsonb not null,
  constraint organization_runtime_settings_update_staging_pk primary key (backend_pid),
  constraint organization_runtime_settings_update_staging_object check (
    pg_catalog.jsonb_typeof(settings) = 'object'
  )
);
alter table vortex_identity.organization_runtime_settings_update_staging enable row level security;
alter table vortex_identity.organization_runtime_settings_update_staging force row level security;

-- This private helper keeps all writers on the same shape checks.  The
-- authoritative contract validation happens before the runtime invokes these
-- functions; SQL retains the boundary checks needed for its own inputs.
create function vortex_identity.assert_organization_runtime_settings_values(
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
    -- This function receives its full JSON only through the transaction-bound
    -- staging operation below; do not invent a second, incomplete BCP parser.
    or p_time_zone is null
    or p_time_zone <> pg_catalog.btrim(p_time_zone)
    or pg_catalog.char_length(p_time_zone) not between 1 and 100
    -- The same applies to the pinned IANA zone list: pg_timezone_names admits
    -- aliases that the contract deliberately rejects.
    or p_currency is null
    or p_currency <> all (array[
      'AED','AFN','ALL','AMD','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT',
      'BHD','BIF','BMD','BND','BOB','BOV','BRL','BSD','BTN','BWP','BYN','BZD',
      'CAD','CDF','CHE','CHF','CHW','CLF','CLP','CNY','COP','COU','CRC','CUP',
      'CVE','CZK','DJF','DKK','DOP','DZD','EGP','ERN','ETB','EUR','FJD','FKP',
      'GBP','GEL','GHS','GIP','GMD','GNF','GTQ','GYD','HKD','HNL','HTG','HUF',
      'IDR','ILS','INR','IQD','IRR','ISK','JMD','JOD','JPY','KES','KGS','KHR',
      'KMF','KPW','KRW','KWD','KYD','KZT','LAK','LBP','LKR','LRD','LSL','LYD',
      'MAD','MDL','MGA','MKD','MMK','MNT','MOP','MRU','MUR','MVR','MWK','MXN',
      'MXV','MYR','MZN','NAD','NGN','NIO','NOK','NPR','NZD','OMR','PAB','PEN',
      'PGK','PHP','PKR','PLN','PYG','QAR','RON','RSD','RUB','RWF','SAR','SBD',
      'SCR','SDG','SEK','SGD','SHP','SLE','SOS','SRD','SSP','STN','SVC','SYP',
      'SZL','THB','TJS','TMT','TND','TOP','TRY','TTD','TWD','TZS','UAH','UGX',
      'USD','USN','UYI','UYU','UYW','UZS','VED','VES','VND','VUV','WST','XAD',
      'XAF','XAG','XAU','XBA','XBB','XBC','XBD','XCD','XCG','XDR','XOF','XPD',
      'XPF','XPT','XSU','XTS','XUA','XXX','YER','ZAR','ZMW','ZWG'
    ]::text[])
    or p_date_format is null
    or p_date_format not in ('short', 'medium', 'long', 'full')
    or p_number_format is null
    or p_number_format not in ('auto', 'always', 'min2', 'never') then
    raise exception using errcode = '22023',
      message = 'Organization runtime settings are invalid';
  end if;
end
$function$;

create function vortex_identity.stage_organization_runtime_settings_update(
  p_settings jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_settings is null or pg_catalog.jsonb_typeof(p_settings) <> 'object'
    or not p_settings ?& array[
      'organizationId', 'language', 'timeZone', 'currency', 'dateFormat',
      'numberFormat', 'revision'
    ]
    or p_settings - array[
      'organizationId', 'language', 'timeZone', 'currency', 'dateFormat',
      'numberFormat', 'revision'
    ] <> '{}'::jsonb then
    raise exception using errcode = '22023',
      message = 'Organization runtime settings staging is invalid';
  end if;

  insert into vortex_identity.organization_runtime_settings_update_staging as staged (
    backend_pid, transaction_id, settings
  ) values (
    pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), p_settings
  ) on conflict on constraint organization_runtime_settings_update_staging_pk do update
    set transaction_id = excluded.transaction_id, settings = excluded.settings
    where staged.transaction_id <> excluded.transaction_id;
  if not found then
    raise exception using errcode = '55000',
      message = 'Organization runtime settings update is already staged';
  end if;
end
$function$;

create function vortex_identity.read_staged_organization_runtime_settings_update()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  staged jsonb;
begin
  select row_value.settings into staged
  from vortex_identity.organization_runtime_settings_update_staging as row_value
  where row_value.backend_pid = pg_catalog.pg_backend_pid()
    and row_value.transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  if staged is null then
    raise exception using errcode = '42501',
      message = 'Organization runtime settings update is unavailable';
  end if;
  return staged;
end
$function$;

-- Trusted setup is explicit: callers must supply every value. An identical
-- retry returns the current existing row; a conflicting retry fails instead
-- of changing configuration implicitly.
create function vortex_identity.initialize_organization_runtime_settings(
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

-- Private write primitive.  The Access-owned protected wrapper supplies its
-- fixed authorization decision and the request's organisation; no caller may
-- choose a permission or write another organisation's row.
create function vortex_identity.update_organization_runtime_settings_internal(
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

-- Identity's private reader accepts only the exact organisation ID supplied
-- by the Access-owned request wrapper below; it is not independently callable.
create function vortex_identity.read_current_organization_runtime_settings_internal(
  p_organization_id uuid
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
stable
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization runtime settings read is invalid';
  end if;
  return query
  select settings.organization_id, settings.language, settings.time_zone,
    settings.currency, settings.date_format, settings.number_format,
    settings.revision
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = p_organization_id;
end
$function$;

-- The request role may read only the one organisation already established by
-- its validated human context.  This leaves Identity tables/functions private
-- while making the real RequestDatabaseTransaction path callable.
create function vortex_access.read_current_organization_runtime_settings_for_application()
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
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  return query
  select * from vortex_identity.read_current_organization_runtime_settings_internal(
    (context_value ->> 'organizationId')::uuid
  );
end
$function$;

-- Access owns the protected human operation.  It has one fixed permission,
-- never increments Access version, and delegates the private storage mutation
-- to Identity only after the context and permission are both current.
create function vortex_access.update_organization_runtime_settings_for_administration(
  p_expected_revision bigint
)
returns table (
  organization_id uuid,
  settings jsonb
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  decision record;
  changed record;
  staged_settings jsonb;
begin
  -- First establish the request identity, then take the same organisation
  -- Access-version lock used by governance changes.  Revalidate while the
  -- lock is held so a revocation that committed while this operation waited
  -- cannot reach permission evaluation or the settings write.
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  perform 1
  from vortex_access.organization_access_versions as access_version
  where access_version.organization_id = context_organization_id
  for update;
  if not found then
    raise exception using errcode = '42501',
      message = 'Organization runtime settings update is unavailable';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.runtime_settings.update',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', 'c658c254-2884-414a-9012-512c0cfe4b34'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', pg_catalog.jsonb_build_object('kind', 'permission')
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from
      'platform.organization.runtime_settings.update'
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization runtime settings update is unavailable';
  end if;

  staged_settings := vortex_identity.read_staged_organization_runtime_settings_update();
  if (staged_settings ->> 'organizationId')::uuid is distinct from context_organization_id
    or (staged_settings ->> 'revision')::bigint is distinct from p_expected_revision then
    raise exception using errcode = '42501',
      message = 'Organization runtime settings update is unavailable';
  end if;

  select updated.* into strict changed
  from vortex_identity.update_organization_runtime_settings_internal(
    context_organization_id, p_expected_revision,
    staged_settings ->> 'language', staged_settings ->> 'timeZone',
    staged_settings ->> 'currency', staged_settings ->> 'dateFormat',
    staged_settings ->> 'numberFormat'
  ) as updated;

  return query select changed.organization_id,
    pg_catalog.jsonb_build_object(
      'organizationId', changed.organization_id,
      'language', changed.language,
      'timeZone', changed.time_zone,
      'currency', changed.currency,
      'dateFormat', changed.date_format,
      'numberFormat', changed.number_format,
      'revision', changed.revision
    );
end
$function$;

revoke all on table vortex_identity.organization_runtime_settings
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;
revoke all on table vortex_identity.organization_runtime_settings_update_staging
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;
revoke execute on function vortex_identity.assert_organization_runtime_settings_values(
  text, text, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke execute on function vortex_identity.initialize_organization_runtime_settings(
  uuid, text, text, text, text, text
) from public, anon, authenticated, service_role, vortex_request, vortex_record_owner;
revoke execute on function vortex_identity.update_organization_runtime_settings_internal(
  uuid, bigint, text, text, text, text, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;
revoke execute on function vortex_identity.read_current_organization_runtime_settings_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;
revoke execute on function vortex_identity.stage_organization_runtime_settings_update(jsonb)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_owner;
revoke execute on function vortex_identity.read_staged_organization_runtime_settings_update()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;
revoke execute on function vortex_access.read_current_organization_runtime_settings_for_application()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner;
revoke execute on function vortex_access.update_organization_runtime_settings_for_administration(
  bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner;

grant execute on function vortex_identity.initialize_organization_runtime_settings(
  uuid, text, text, text, text, text
) to vortex_runtime;
grant execute on function vortex_identity.stage_organization_runtime_settings_update(jsonb)
  to vortex_runtime;
grant execute on function vortex_access.read_current_organization_runtime_settings_for_application()
  to vortex_request;
grant execute on function vortex_access.update_organization_runtime_settings_for_administration(
  bigint
) to vortex_request;

comment on table vortex_identity.organization_runtime_settings is
  'One private revisioned execution-settings row per organisation; never a Record or Data API resource.';
comment on function vortex_identity.initialize_organization_runtime_settings(
  uuid, text, text, text, text, text
) is 'Trusted explicit Identity setup for one organisation runtime-settings row; identical retries return the current existing row and conflicting retries refuse.';
comment on function vortex_access.read_current_organization_runtime_settings_for_application() is
  'Narrow request-role reader for an already-authorised application transaction; it reads only its established organisation and returns absence when setup is incomplete.';
comment on function vortex_access.update_organization_runtime_settings_for_administration(
  bigint
) is 'Fixed protected organisation settings update requiring runtime-settings.manage and an exact current revision. Values are contract-validated and staged by the trusted runtime before request role is entered; it never changes Access version.';
