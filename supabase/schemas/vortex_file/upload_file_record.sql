create or replace function vortex_file.upload_file_record(p_file vortex_file.file_records)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'fileId', p_file.file_id,
    'organizationId', p_file.organization_id,
    'applicationRootId', p_file.application_root_id,
    'lifecycleState', p_file.lifecycle_state,
    'originalSafeDisplayName', p_file.original_safe_display_name,
    'detectedMediaType', p_file.detected_media_type,
    'extension', p_file.extension,
    'sizeBytes', p_file.size_bytes,
    'checksum', p_file.checksum,
    'storageKey', p_file.storage_key,
    'bucketId', p_file.bucket_id,
    'scannerName', p_file.scanner_name,
    'scannerVersion', p_file.scanner_version,
    'scannerResult', p_file.scanner_result,
    'previewReferences', p_file.preview_references,
    'uploadedBy', p_file.uploaded_by,
    'createdAt', vortex_context.format_timestamp_utc(p_file.created_at),
    'activatedAt', vortex_context.format_timestamp_utc(p_file.activated_at),
    'deletedAt', vortex_context.format_timestamp_utc(p_file.deleted_at),
    'removalDueAt', vortex_context.format_timestamp_utc(p_file.removal_due_at),
    'owningAttachmentReferences', pg_catalog.to_jsonb(p_file.owning_attachment_references),
    'ownerRecordTypeId', p_file.owner_record_type_id,
    'ownerRecordId', p_file.owner_record_id,
    'ownerFieldId', p_file.owner_field_id,
    'legalHold', pg_catalog.jsonb_build_object('isHeld', p_file.legal_hold)
  ))
$function$;

revoke execute on function vortex_file.upload_file_record(vortex_file.file_records) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.upload_file_record(vortex_file.file_records)
  to vortex_file_owner;

comment on function vortex_file.upload_file_record(vortex_file.file_records) is
  'Returns the canonical FileRecord projection with UTC timestamp values.';
