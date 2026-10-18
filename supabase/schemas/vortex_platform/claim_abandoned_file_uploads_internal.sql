create or replace function vortex_platform.claim_abandoned_file_uploads_internal(p_limit integer, p_storage_project text)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  candidate record;
  file_value vortex_platform.file_records%rowtype;
  claim_id uuid;
  claim_until timestamptz := pg_catalog.clock_timestamp() + interval '5 minutes';
  result jsonb := '[]'::jsonb;
begin
  if p_storage_project is null or (select project_ref from vortex_platform.storage_destination where singleton)
    is distinct from p_storage_project then
    raise exception using errcode = '55000', message = 'Upload cleanup Storage destination has not been provisioned';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception using errcode = '22023', message = 'Upload cleanup batch must be between 1 and 25';
  end if;
  -- Lock in the same order as completion and record activation: file, then upload.
  -- Abandonment commits before Storage deletion and permanently excludes activation.
  for candidate in
    select f.file_id, u.upload_expires_at, u.correlation_id
    from vortex_platform.file_uploads u
    join vortex_platform.file_records f on f.file_id = u.file_id
    where u.upload_expires_at <= pg_catalog.clock_timestamp()
      and (u.cleanup_claim_until is null or u.cleanup_claim_until <= pg_catalog.clock_timestamp())
      and f.lifecycle_state in ('pending', 'uploaded', 'scanning', 'quarantined', 'abandoned')
      and f.activated_at is null and pg_catalog.cardinality(f.owning_attachment_references) = 0
      and f.preview_references = '[]'::jsonb and not f.legal_hold
    order by u.upload_expires_at, f.file_id
    limit p_limit for update of f skip locked
  loop
    perform 1 from vortex_platform.file_uploads u
    where u.file_id = candidate.file_id and u.upload_expires_at <= pg_catalog.clock_timestamp()
      and (u.cleanup_claim_until is null or u.cleanup_claim_until <= pg_catalog.clock_timestamp())
    for update;
    if not found then continue; end if;
    claim_id := pg_catalog.gen_random_uuid();
    update vortex_platform.file_uploads set cleanup_claim_id = claim_id,
      cleanup_claim_until = claim_until, grant_claimed = true, revision = revision + 1
    where file_id = candidate.file_id;
    update vortex_platform.file_records set lifecycle_state = 'abandoned'
    where file_id = candidate.file_id returning * into file_value;
    result := result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'fileRecord', vortex_platform.upload_file_record(file_value),
      'uploadExpiresAt', vortex_platform.format_timestamp_utc(candidate.upload_expires_at),
      'correlationId', candidate.correlation_id, 'claimId', claim_id,
      'validUntil', vortex_platform.format_timestamp_utc(claim_until)));
  end loop;
  return result;
end
$function$;
alter function vortex_platform.claim_abandoned_file_uploads_internal(integer,text) owner to vortex_owner;
revoke all on function vortex_platform.claim_abandoned_file_uploads_internal(integer,text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_platform.claim_abandoned_file_uploads_internal(integer,text) to vortex_runtime;
comment on function vortex_platform.claim_abandoned_file_uploads_internal(integer,text) is
  'Claims a bounded batch of expired never-activated uploads, including clean and rejected inspections; abandoned claims retry after five minutes.';
