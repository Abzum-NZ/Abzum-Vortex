create or replace function vortex_platform.file_upload_operation(p_operation text, p_input jsonb)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_platform.upload_validated_context();
  actor_value jsonb := vortex_platform.upload_request_actor(context_value);
  organization_value uuid := (context_value ->> 'organizationId')::uuid;
  file_value vortex_platform.file_records%rowtype;
  state_value vortex_platform.file_uploads%rowtype;
  file_id_value uuid;
  authority_value jsonb;
  candidate jsonb;
  grant_value jsonb;
  settings_value jsonb;
  maximum_files integer;
  existing_count integer;
  evaluated_at timestamptz := pg_catalog.clock_timestamp();
begin
  if pg_catalog.jsonb_typeof(p_input) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Upload input must be an object';
  end if;
  if actor_value is null then raise exception using errcode = '42501', message = 'Upload actor unavailable'; end if;
  if p_operation = 'reserve' then
    candidate := p_input -> 'fileRecord';
    grant_value := p_input -> 'grant';
    file_id_value := (candidate ->> 'fileId')::uuid;
    authority_value := vortex_record.read_attachment_upload_authority(
      (candidate ->> 'ownerRecordTypeId')::uuid, (candidate ->> 'ownerRecordId')::uuid, (candidate ->> 'ownerFieldId')::uuid);
    if authority_value ->> 'outcome' is distinct from 'allowed'
      or (candidate ->> 'organizationId')::uuid is distinct from organization_value
      or (candidate ->> 'applicationRootId')::uuid is distinct from (context_value ->> 'applicationRootId')::uuid
      or candidate -> 'uploadedBy' is distinct from actor_value
      or grant_value -> 'actor' is distinct from actor_value
      or (grant_value ->> 'organizationId')::uuid is distinct from organization_value
      or grant_value ->> 'recordTypeId' is distinct from candidate ->> 'ownerRecordTypeId'
      or grant_value ->> 'recordId' is distinct from candidate ->> 'ownerRecordId'
      or grant_value ->> 'fieldId' is distinct from candidate ->> 'ownerFieldId'
      or (p_input ->> 'correlationId')::uuid is distinct from (context_value ->> 'correlationId')::uuid then
      raise exception using errcode = '42501', message = 'Upload scope unavailable';
    end if;
    settings_value := authority_value -> 'attachmentSettings';
    maximum_files := case when (settings_value ->> 'multiple')::boolean then (settings_value ->> 'maxFiles')::integer else 1 end;
    if maximum_files is null or (grant_value ->> 'maximumBytes')::bigint < 1
      or (grant_value ->> 'maximumBytes')::numeric > (settings_value ->> 'maxFileSizeMb')::numeric * 1048576
      or (grant_value ->> 'maximumBytes')::bigint > vortex_platform.upload_maximum_bytes_limit()
      or (grant_value ->> 'expiresAt')::timestamptz <= evaluated_at
      or (grant_value ->> 'expiresAt')::timestamptz > evaluated_at + interval '65 seconds'
      or (p_input ->> 'uploadExpiresAt')::timestamptz > evaluated_at + interval '24 hours 5 minutes'
      or (p_input ->> 'uploadExpiresAt')::timestamptz < (grant_value ->> 'expiresAt')::timestamptz
      or candidate ->> 'storageKey' !~ ('^' || organization_value::text || '/' || file_id_value::text || '/[0-9a-f]{32}$') then
      raise exception using errcode = '22023', message = 'Upload reservation invalid';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      organization_value::text || ':' || (candidate ->> 'ownerRecordTypeId') || ':' ||
      coalesce(candidate ->> 'ownerRecordId', actor_value::text) || ':' || (candidate ->> 'ownerFieldId'), 652));
    select pg_catalog.count(*) into existing_count from vortex_platform.file_records f
    where f.organization_id = organization_value and f.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and f.owner_record_type_id = (candidate ->> 'ownerRecordTypeId')::uuid
      and f.owner_record_id = (candidate ->> 'ownerRecordId')::uuid
      and f.owner_field_id = (candidate ->> 'ownerFieldId')::uuid and f.lifecycle_state = 'active';
    if p_input ? 'replacingFileId' and not exists (
      select 1 from vortex_platform.file_records f where f.file_id = (p_input ->> 'replacingFileId')::uuid
        and f.organization_id = organization_value and f.application_root_id = (context_value ->> 'applicationRootId')::uuid
        and f.owner_record_type_id = (candidate ->> 'ownerRecordTypeId')::uuid
        and f.owner_record_id = (candidate ->> 'ownerRecordId')::uuid
        and f.owner_field_id = (candidate ->> 'ownerFieldId')::uuid and f.lifecycle_state = 'active'
    ) then return vortex_platform.upload_refusal('replacement_file_not_found'); end if;
    if existing_count - (case when p_input ? 'replacingFileId' then 1 else 0 end) >= maximum_files then
      return vortex_platform.upload_refusal('field_capacity_exceeded'); end if;
    insert into vortex_platform.file_records(
      file_id,organization_id,application_root_id,owner_record_type_id,owner_record_id,owner_field_id,
      lifecycle_state,original_safe_display_name,detected_media_type,extension,size_bytes,checksum,
      storage_key,bucket_id,scanner_name,scanner_version,scanner_result,preview_references,uploaded_by,legal_hold,created_at,owning_attachment_references)
    values(file_id_value,organization_value,(context_value ->> 'applicationRootId')::uuid,
      (candidate ->> 'ownerRecordTypeId')::uuid,(candidate ->> 'ownerRecordId')::uuid,(candidate ->> 'ownerFieldId')::uuid,
      'pending',candidate ->> 'originalSafeDisplayName','application/octet-stream',candidate ->> 'extension',0,
      'sha256:' || pg_catalog.repeat('0',64),candidate ->> 'storageKey','private_files','vortex_file_preflight','1','pending','[]',actor_value,false,evaluated_at,'{}')
    returning * into file_value;
    insert into vortex_platform.file_uploads(file_id,maximum_bytes,upload_expires_at,replacing_file_id,correlation_id,grant_value)
    values(file_id_value,(grant_value ->> 'maximumBytes')::bigint,(p_input ->> 'uploadExpiresAt')::timestamptz,
      (p_input ->> 'replacingFileId')::uuid,(context_value ->> 'correlationId')::uuid,grant_value);
    return pg_catalog.jsonb_build_object('outcome','reserved','fileRecord',vortex_platform.upload_file_record(file_value));
  end if;
  file_id_value := (p_input ->> 'fileId')::uuid;
  if p_operation = 'claim' then
    select u.file_id into file_id_value from vortex_platform.file_uploads u
    where u.grant_value ->> 'oneTimeId' = p_input ->> 'oneTimeId';
  end if;
  select f.* into file_value from vortex_platform.file_records f
  where f.file_id = file_id_value and f.organization_id = organization_value
    and f.application_root_id = (context_value ->> 'applicationRootId')::uuid and f.uploaded_by = actor_value for update;
  if not found then return null; end if;
  select * into state_value from vortex_platform.file_uploads u where u.file_id = file_id_value for update;
  if not found then return null; end if;
  authority_value := vortex_record.read_attachment_upload_authority(file_value.owner_record_type_id,file_value.owner_record_id,file_value.owner_field_id);
  if authority_value ->> 'outcome' is distinct from 'allowed' then return null; end if;
  if p_operation = 'read' then
    return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'fileRecord',vortex_platform.upload_file_record(file_value),'uploader',actor_value,'maximumBytes',state_value.maximum_bytes,
      'uploadExpiresAt',vortex_platform.format_timestamp_utc(state_value.upload_expires_at),'replacingFileId',state_value.replacing_file_id,
      'currentGrantId',case when file_value.lifecycle_state = 'pending' then state_value.grant_value ->> 'oneTimeId' end,
      'correlationId',state_value.correlation_id,'revision',state_value.revision));
  end if;
  if state_value.upload_expires_at <= evaluated_at then return vortex_platform.upload_refusal('upload_expired'); end if;
  if p_operation = 'claim' then
    if file_value.lifecycle_state <> 'pending' or state_value.grant_claimed
      or (state_value.grant_value ->> 'expiresAt')::timestamptz <= evaluated_at then return null; end if;
    update vortex_platform.file_uploads set grant_claimed = true where file_id = file_id_value;
    return pg_catalog.jsonb_build_object('grant',state_value.grant_value,'fileRecord',vortex_platform.upload_file_record(file_value),'correlationId',state_value.correlation_id);
  end if;
  if state_value.revision <> (p_input ->> 'expectedRevision')::bigint then return vortex_platform.upload_refusal('revision_conflict'); end if;
  if file_value.lifecycle_state <> 'pending' then return vortex_platform.upload_refusal('invalid_lifecycle_state'); end if;
  if p_operation = 'renew' then
    grant_value := p_input -> 'grant';
    if state_value.grant_value ->> 'oneTimeId' is distinct from p_input ->> 'previousOneTimeId'
      or (grant_value - array['oneTimeId','policyFingerprint','expiresAt']) is distinct from (state_value.grant_value - array['oneTimeId','policyFingerprint','expiresAt'])
      or (grant_value ->> 'expiresAt')::timestamptz <= evaluated_at
      or (grant_value ->> 'expiresAt')::timestamptz > least(evaluated_at + interval '65 seconds',state_value.upload_expires_at) then
      return vortex_platform.upload_refusal('grant_mismatch'); end if;
    update vortex_platform.file_uploads set grant_value = p_input -> 'grant', grant_claimed = false, revision = revision + 1 where file_id = file_id_value;
    return pg_catalog.jsonb_build_object('outcome','renewed');
  end if;
  if p_operation = 'complete' then
    candidate := p_input -> 'fileRecord';
    if candidate ->> 'lifecycleState' not in ('scanning','quarantined')
      or candidate ->> 'scannerResult' not in ('clean','quarantined','refused')
      or (candidate ->> 'lifecycleState' = 'scanning') is distinct from (candidate ->> 'scannerResult' = 'clean')
      or (candidate ->> 'sizeBytes')::bigint > state_value.maximum_bytes
      or (candidate ->> 'sizeBytes')::bigint < 0 then
      raise exception using errcode = '22023', message = 'Upload inspection invalid'; end if;
    update vortex_platform.file_records set lifecycle_state = candidate ->> 'lifecycleState',
      detected_media_type = candidate ->> 'detectedMediaType',size_bytes = (candidate ->> 'sizeBytes')::bigint,
      checksum = candidate ->> 'checksum',scanner_name = candidate ->> 'scannerName',scanner_version = candidate ->> 'scannerVersion',scanner_result = candidate ->> 'scannerResult'
    where file_id = file_id_value returning * into file_value;
    update vortex_platform.file_uploads set revision = revision + 1, grant_claimed = true, completed_settings = authority_value -> 'attachmentSettings' where file_id = file_id_value;
    return pg_catalog.jsonb_build_object('outcome','recorded','fileRecord',vortex_platform.upload_file_record(file_value));
  end if;
  raise exception using errcode = '22023', message = 'Unknown file upload operation';
end
$function$;
alter function vortex_platform.file_upload_operation(text,jsonb) owner to vortex_owner;
revoke all on function vortex_platform.file_upload_operation(text,jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_platform.file_upload_operation(text,jsonb) to vortex_request;
