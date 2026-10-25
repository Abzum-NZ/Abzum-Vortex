create or replace function vortex_identity.read_current_privacy_notice(p_version_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  notice vortex_identity.privacy_notice_versions;
begin
  select v.* into notice
  from vortex_identity.privacy_notice_versions v
  where (p_version_id is null or v.id = p_version_id)
    and v.effective_at <= pg_catalog.statement_timestamp()
  order by v.publication_order desc limit 1;
  if not found then
    raise exception using errcode = '55000', message = 'privacy_notice_unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'id', notice.id, 'versionLabel', notice.version_label,
    'locator', notice.locator, 'contentSha256', notice.content_sha256,
    'effectiveAt', pg_catalog.to_char(notice.effective_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'content', notice.content
  );
end
$function$;
revoke all on function vortex_identity.read_current_privacy_notice(uuid)
  from public, anon, authenticated, service_role, vortex_request, vortex_record_adapter;
grant execute on function vortex_identity.read_current_privacy_notice(uuid) to vortex_runtime, postgres;
alter function vortex_identity.read_current_privacy_notice(uuid) owner to vortex_owner;
