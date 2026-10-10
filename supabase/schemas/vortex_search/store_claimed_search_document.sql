create or replace function vortex_search.store_claimed_search_document(
  p_occurrence_id uuid,
  p_claim_cursor uuid,
  p_organization_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_application_root_id uuid,
  p_source_record_version bigint,
  p_deleted boolean,
  p_entries jsonb,
  p_content_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  authority jsonb;
  source_before jsonb;
  source_after jsonb;
  record_type jsonb;
  snapshot jsonb;
  entry jsonb;
  field jsonb;
  selected_field_ids text[] := array[]::text[];
  expected_weight integer;
  stored_outcome text;
  database_time timestamptz;
begin
  if p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_claim_cursor is null or p_claim_cursor = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_id is null or p_record_type_id is null or p_record_id is null
    or p_application_root_id is null or p_source_record_version not between 1 and 9007199254740991
    or p_deleted is null or p_entries is null
    or (p_deleted and (p_entries is distinct from '[]'::jsonb or p_content_fingerprint is not null))
    or (not p_deleted and (p_content_fingerprint is null
      or p_content_fingerprint !~ '^sha256:[0-9a-f]{64}$'
      or not vortex_search.document_entries_are_valid(p_entries))) then
    raise exception using errcode = '22023', message = 'Search store command is invalid';
  end if;

  context_value := vortex_context.current_context();
  if context_value ->> 'callerKind' is distinct from 'system'
    or context_value ->> 'channel' is distinct from 'system'
    or context_value ? 'supportContext'
    or context_value ->> 'organizationId' is distinct from p_organization_id::text
    or context_value ->> 'applicationRootId' is distinct from p_application_root_id::text then
    raise exception using errcode = '42501', message = 'Search store authority is unavailable';
  end if;
  authority := vortex_access.validated_search_index_request_context_internal(
    p_occurrence_id, p_claim_cursor
  );
  if authority ->> 'organizationId' is distinct from p_organization_id::text
    or authority ->> 'applicationRootId' is distinct from p_application_root_id::text
    or authority ->> 'storageScope' is distinct from 'application_contained'
    or authority ->> 'sequenceApplicationRootId' is distinct from p_application_root_id::text then
    raise exception using errcode = '42501', message = 'Search store claim is unavailable';
  end if;

  source_before := vortex_module.read_search_index_source(p_occurrence_id, p_claim_cursor);
  record_type := source_before -> 'recordType';
  snapshot := source_before -> 'snapshot';
  if pg_catalog.jsonb_typeof(record_type) is distinct from 'object'
    or pg_catalog.jsonb_typeof(record_type -> 'fields') is distinct from 'array'
    or snapshot ->> 'indexOrganisationId' is distinct from p_organization_id::text
    or snapshot ->> 'ownerOrganisationId' is distinct from p_organization_id::text
    or snapshot ->> 'applicationRootId' is distinct from p_application_root_id::text
    or snapshot ->> 'recordTypeId' is distinct from p_record_type_id::text
    or snapshot ->> 'recordId' is distinct from p_record_id::text
    or (snapshot ->> 'recordVersion')::bigint is distinct from p_source_record_version
    or ((snapshot ->> 'lifecycle') = 'deleted') is distinct from p_deleted then
    raise exception using errcode = '42501', message = 'Search store source is unavailable';
  end if;

  if not p_deleted then
    for entry in
      select item.value from pg_catalog.jsonb_array_elements(p_entries) as item(value)
    loop
      select field.value into field
      from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') =
        pg_catalog.lower(entry ->> 'fieldId');
      if not found
        or field ->> 'personalData' is distinct from 'none'
        or field ->> 'searchPriority' is distinct from entry ->> 'priority'
        or field ->> 'type' not in (
          'text', 'long_text', 'formatted_text', 'whole_number', 'decimal_number', 'date',
          'date_time', 'choice', 'several_choices', 'reference_number', 'email_address',
          'phone_number', 'web_address'
        ) then
        raise exception using errcode = '42501', message = 'Search entry is not source-authorized';
      end if;
      expected_weight := case field ->> 'searchPriority'
        when 'first' then 3 when 'normal' then 2 when 'last' then 1 else null end;
      if (entry ->> 'weight')::numeric is distinct from expected_weight::numeric
        or (entry ->> 'fieldId') <> pg_catalog.lower(entry ->> 'fieldId')
        or (entry ->> 'fieldId') = any (selected_field_ids) then
        raise exception using errcode = '42501', message = 'Search entry is not canonical';
      end if;
      selected_field_ids := selected_field_ids || (entry ->> 'fieldId');
    end loop;
  end if;

  select stored.outcome into stored_outcome
  from vortex_search.put_document(
    p_organization_id,
    p_record_type_id,
    p_record_id,
    p_application_root_id,
    p_source_record_version,
    p_deleted,
    p_entries,
    p_content_fingerprint
  ) as stored;
  if stored_outcome not in (
    'stored', 'replaced', 'rebuilt', 'replayed', 'ignored_older', 'ignored_deleted'
  ) then
    raise exception using errcode = '55000', message = 'Search store outcome is unavailable';
  end if;

  source_after := vortex_module.read_search_index_source(p_occurrence_id, p_claim_cursor);
  database_time := pg_catalog.clock_timestamp();
  if source_after is distinct from source_before
    or (authority ->> 'leaseExpiresAt')::timestamptz <= database_time
    or (context_value ->> 'expiresAt')::timestamptz <= database_time then
    raise exception using errcode = '42501', message = 'Search claim expired or source changed';
  end if;
  perform vortex_access.validated_search_index_request_context_internal(
    p_occurrence_id, p_claim_cursor
  );

  return pg_catalog.jsonb_build_object('outcome', stored_outcome);
end
$function$;

alter function vortex_search.store_claimed_search_document(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) owner to vortex_search_owner;
revoke all on function vortex_search.store_claimed_search_document(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner,
  vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_search.store_claimed_search_document(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) to vortex_request;
comment on function vortex_search.store_claimed_search_document(
  uuid, uuid, uuid, uuid, uuid, uuid, bigint, boolean, jsonb, text
) is
  'Stores one bounded current document for the exact live Search claim and installed source in its SYSTEM transaction; ownership, scope, version, field identity and completion are revalidated around the canonical writer.';
