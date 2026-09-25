create or replace function vortex_record.read_time_clock_internal()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  zone_value text;
  instant_value timestamp with time zone := pg_catalog.statement_timestamp();
begin
  context_value := vortex_access.validated_human_request_context();
  -- No time zone is ever assumed: without the organisation's own settings the
  -- local date is unknown, so a date deadline is withheld or refused rather
  -- than worked out in the wrong zone. Exact-instant deadlines need no zone.
  zone_value := vortex_identity.read_organization_time_zone_internal(
    (context_value ->> 'organizationId')::uuid
  );
  return pg_catalog.jsonb_build_object(
    'instant', pg_catalog.to_char(
      pg_catalog.timezone('UTC', instant_value), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'organizationLocalDate', case when zone_value is null then null else pg_catalog.to_char(
      pg_catalog.timezone(zone_value, instant_value), 'YYYY-MM-DD'
    ) end,
    'timeZone', zone_value
  );
end
$function$;

revoke all on function vortex_record.read_time_clock_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

comment on function vortex_record.read_time_clock_internal() is
  'The one statement timestamp and the current date in the organisation time zone of the validated request context (null when the organisation has no time zone), which every read-time calculation in a statement uses; owner-only.';
