create or replace function vortex_identity.validate_privacy_notice_internal(p_metadata jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  current_version uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('vortex.privacy.notice', 0));
  select v.id into current_version
    from vortex_identity.privacy_notice_versions v
    where v.effective_at <= pg_catalog.clock_timestamp()
    order by v.publication_order desc limit 1;
  if not found then
    raise exception using errcode = 'P0001', message = 'privacy_notice_unavailable';
  end if;
  if (p_metadata -> 'privacy_notice_acknowledged') is distinct from 'true'::jsonb then
    raise exception using errcode = 'P0001', message = 'privacy_notice_required';
  end if;
  if (p_metadata ->> 'privacy_notice_version_id') is distinct from current_version::text then
    raise exception using errcode = 'P0001', message = 'privacy_notice_changed';
  end if;
  return current_version;
end
$function$;
revoke all on function vortex_identity.validate_privacy_notice_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
alter function vortex_identity.validate_privacy_notice_internal(jsonb) owner to vortex_owner;
