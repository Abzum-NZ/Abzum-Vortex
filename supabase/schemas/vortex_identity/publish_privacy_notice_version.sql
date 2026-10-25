create or replace function vortex_identity.publish_privacy_notice_version(
  p_publisher_identity_id uuid,
  p_version_label text,
  p_effective_at timestamptz,
  p_content jsonb,
  p_content_sha256 text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  version_id uuid := pg_catalog.gen_random_uuid();
  published_at timestamptz;
begin
  -- Shares the publication lock with signup validation, so a version cannot change mid-insert.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('vortex.privacy.notice', 0));
  perform 1 from vortex_identity.identity_projections p
    where p.identity_id = p_publisher_identity_id and p.state = 'active' for share;
  published_at := pg_catalog.clock_timestamp();
  if not found or vortex_identity.resolve_active_vortex_super_administrator_assignment_internal(
    p_publisher_identity_id, published_at
  ) is null then
    raise exception using errcode = '42501', message = 'Privacy notice publication is unavailable';
  end if;
  if p_version_label is null or pg_catalog.length(p_version_label) not between 1 and 100
    or p_effective_at is null or not pg_catalog.isfinite(p_effective_at)
    or p_effective_at > published_at
    or p_content is null or pg_catalog.jsonb_typeof(p_content) <> 'object'
    or pg_catalog.jsonb_typeof(p_content -> 'title') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_content -> 'collectionNotice') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_content -> 'paragraphs') is distinct from 'array'
    or p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Privacy notice publication input is invalid';
  end if;
  insert into vortex_identity.privacy_notice_versions (
    id, version_label, locator, content, content_sha256, effective_at, published_at,
    published_by, correlation_id
  ) values (
    version_id, p_version_label, '/auth/privacy?version=' || version_id::text,
    p_content, p_content_sha256, p_effective_at, published_at,
    p_publisher_identity_id, pg_catalog.gen_random_uuid()
  );
  return version_id;
end
$function$;
revoke all on function vortex_identity.publish_privacy_notice_version(uuid, text, timestamptz, jsonb, text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
-- The operational command is server-only; no browser role can name a publisher or publish content.
grant execute on function vortex_identity.publish_privacy_notice_version(uuid, text, timestamptz, jsonb, text) to postgres;
alter function vortex_identity.publish_privacy_notice_version(uuid, text, timestamptz, jsonb, text) owner to vortex_owner;
