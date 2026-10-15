set local role vortex_owner;

-- The runtime settings projection declares language sortable, but its bounded reader accepted only record_id, so every exact-id facts lookup (which passes the first sortable field) was refused and fresh demo:setup failed initialising Landing Zone.
create or replace function vortex_access.list_organization_runtime_settings_projection(
  p_record_ids uuid[], p_sort_key text, p_direction text, p_after jsonb,
  p_limit integer
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
  settings_extension_values jsonb;
begin
  -- One settings row per organisation, so ordering is irrelevant: record_id and the projection's
  -- declared sortable field (language) are both accepted.
  if p_sort_key is null or p_sort_key not in ('record_id', 'language')
    or p_direction not in ('ascending', 'descending')
    or p_direction is null
    or (p_limit is not null and p_limit < 1) then
    raise exception using errcode = '22023', message = 'Runtime settings projection bounds are invalid';
  end if;
  if p_after is not null and (
    pg_catalog.jsonb_typeof(p_after) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_after -> 'recordId') is distinct from 'string'
  ) then
    raise exception using errcode = '22023', message = 'Runtime settings projection cursor is invalid';
  end if;
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
  if p_record_ids is not null
    and not (settings_row.organization_id = any(p_record_ids)) then
    return;
  end if;
  if p_after is not null then
    begin
      if (p_direction = 'ascending'
          and settings_row.organization_id <= (p_after ->> 'recordId')::uuid)
        or (p_direction = 'descending'
          and settings_row.organization_id >= (p_after ->> 'recordId')::uuid) then
        return;
      end if;
    exception when invalid_text_representation then
      raise exception using errcode = '22023', message = 'Runtime settings projection cursor is invalid';
    end;
  end if;
  select settings.default_application_root_id, settings.extension_values
  into settings_default_application_root_id, settings_extension_values
  from vortex_identity.organization_runtime_settings as settings
  where settings.organization_id = settings_row.organization_id;
  return query select
    settings_row.organization_id,
    settings_row.organization_id,
    settings_row.revision,
    coalesce(settings_extension_values, '{}'::jsonb) || pg_catalog.jsonb_build_object(
      'language', settings_row.language,
      'time_zone', settings_row.time_zone,
      'currency', settings_row.currency,
      'date_format', settings_row.date_format,
      'number_format', settings_row.number_format,
      'default_application_root_id', settings_default_application_root_id
    );
end
$function$;

create or replace function vortex_access.list_organization_runtime_settings_projection(
  p_record_id uuid, p_page_size integer
)
returns table (
  organization_id uuid, record_id uuid, revision bigint, attribute_values jsonb
)
language sql volatile security definer set search_path = ''
as $function$
  select projected.*
  from vortex_access.list_organization_runtime_settings_projection(
    case when p_record_id is null then null else array[p_record_id] end,
    'record_id', 'ascending', null, null
  ) as projected
$function$;

revoke all on function vortex_access.list_organization_runtime_settings_projection(uuid[], text, text, jsonb, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.list_organization_runtime_settings_projection(uuid[], text, text, jsonb, integer)
  to vortex_owner, vortex_record_adapter, postgres;
alter function vortex_access.list_organization_runtime_settings_projection(uuid[], text, text, jsonb, integer)
  owner to vortex_owner;

revoke all on function vortex_access.list_organization_runtime_settings_projection(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function vortex_access.list_organization_runtime_settings_projection(
  uuid, integer
) to vortex_owner, vortex_record_adapter;

comment on function vortex_access.list_organization_runtime_settings_projection(uuid, integer) is
  'Registered runtime-settings projection with the original single-row visibility; delegates to the bounded reader.';

alter function vortex_access.list_organization_runtime_settings_projection(p_record_id uuid, p_page_size integer) owner to vortex_owner;

grant execute on function vortex_access.list_organization_runtime_settings_projection(p_record_id uuid, p_page_size integer) to postgres;

reset role;
