create or replace function vortex_module.read_search_index_source(
  p_occurrence_id uuid,
  p_claim_cursor uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  authority jsonb;
  occurrence jsonb;
  initial_installation jsonb;
  current_installation jsonb;
  current_binding jsonb;
  current_application_release vortex_definition.releases%rowtype;
  retained_application_release vortex_definition.releases%rowtype;
  current_module_release vortex_definition.releases%rowtype;
  retained_module_release vortex_definition.releases%rowtype;
  historical_record_type jsonb;
  current_record_type jsonb;
  projected_record_type jsonb;
  selected_fields jsonb;
  projected_snapshot jsonb;
  selected_field_ids uuid[];
  trusted_record_plan jsonb;
  record_snapshot jsonb;
  selected_organization_id uuid;
  selected_application_root_id uuid;
  selected_module_root_id uuid;
  selected_record_type_id uuid;
  selected_storage_contract_id uuid;
  selected_application_release_revision bigint;
  selected_module_release_revision bigint;
  selected_binding_revision bigint;
  binding_item jsonb;
  binding_row vortex_module.installation_bindings%rowtype;
  retained_record_types jsonb;
  current_record_types jsonb;
  matched_count integer;
begin
  if p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_claim_cursor is null or p_claim_cursor = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'Search occurrence selector is invalid';
  end if;

  authority := vortex_access.validated_search_index_request_context_internal(
    p_occurrence_id, p_claim_cursor
  );
  occurrence := authority -> 'occurrence';
  selected_organization_id := (authority ->> 'organizationId')::uuid;
  selected_application_root_id := (authority ->> 'applicationRootId')::uuid;
  selected_module_root_id := (occurrence #>> '{installation,moduleBinding,moduleRootId}')::uuid;
  selected_application_release_revision :=
    (occurrence #>> '{installation,applicationReleaseRevision}')::bigint;
  selected_module_release_revision :=
    (occurrence #>> '{installation,moduleBinding,moduleReleaseRevision}')::bigint;
  selected_binding_revision :=
    (occurrence #>> '{installation,moduleBinding,bindingRevision}')::bigint;
  selected_record_type_id := (occurrence #>> '{descriptor,recordTypeId}')::uuid;
  selected_storage_contract_id := (authority ->> 'storageContractId')::uuid;

  if occurrence ->> 'contractVersion' is distinct from '2.0.0'
    or occurrence #>> '{descriptor,kind}' is distinct from 'standard'
    or occurrence #>> '{descriptor,recordTypeId}' is distinct from selected_record_type_id::text
    or occurrence #>> '{definitionRelease,kind}' is distinct from 'module'
    or occurrence #>> '{definitionRelease,rootId}' is distinct from selected_module_root_id::text
    or (occurrence #>> '{definitionRelease,releaseRevision}')::bigint
      is distinct from selected_module_release_revision
    or occurrence ->> 'organizationId' is distinct from selected_organization_id::text
    or selected_application_release_revision not between 1 and 9007199254740991
    or selected_module_release_revision not between 1 and 9007199254740991
    or selected_binding_revision not between 1 and 9007199254740991
    or authority ->> 'storageScope' is distinct from 'application_contained'
    or authority ->> 'sequenceApplicationRootId' is distinct from selected_application_root_id::text
    or occurrence #>> '{installation,applicationRootId}' is distinct from selected_application_root_id::text
    or occurrence #>> '{descriptor,eventKind}' not in (
      'created', 'changed', 'deleted', 'state_changed', 'reassigned'
    ) then
    raise exception using errcode = '42501', message = 'Search source is unavailable';
  end if;

  initial_installation := vortex_module.read_active_installation_for_scope_internal(
    selected_organization_id, selected_application_root_id
  );
  if initial_installation ->> 'organizationId' is distinct from selected_organization_id::text
    or initial_installation ->> 'applicationRootId' is distinct from selected_application_root_id::text
    or initial_installation ->> 'applicationReleaseRevision' is null
    or pg_catalog.jsonb_typeof(initial_installation -> 'moduleBindings') is distinct from 'array' then
    raise exception using errcode = '42501', message = 'Search installation is unavailable';
  end if;

  -- Match the installation lifecycle's canonical advisory identity and UUID ordering.
  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(initial_installation -> 'moduleBindings') as item(value)
    order by (item.value ->> 'moduleRootId') collate "C"
  loop
    perform pg_catalog.pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended(
        'vortex_module.binding:' || selected_organization_id::text || ':' ||
          selected_application_root_id::text || ':' || (binding_item ->> 'moduleRootId'),
        0
      )
    );
  end loop;

  perform 1
  from vortex_module.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = selected_application_root_id
    and binding.state = 'active'
  order by binding.module_root_id
  for share of binding;

  current_installation := vortex_module.read_active_installation_for_scope_internal(
    selected_organization_id, selected_application_root_id
  );
  if current_installation is distinct from initial_installation then
    raise exception using errcode = '42501', message = 'Search installation changed';
  end if;

  select release.* into retained_application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = selected_application_root_id
    and release.release_revision = selected_application_release_revision
    and root.organization_id = selected_organization_id
    and root.kind = 'application';
  if not found
    or retained_application_release.validation_contract_version <>
      all (vortex_definition.accepted_contract_version('application'))
    or retained_application_release.source_contract_version is distinct from
      retained_application_release.validation_contract_version
    or retained_application_release.compilation_output #>> '{kind}' is distinct from 'application'
    or retained_application_release.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from selected_application_root_id::text
    or retained_application_release.compilation_output #>> '{validationContractVersion}'
      is distinct from retained_application_release.validation_contract_version then
    raise exception using errcode = '42501', message = 'Search retained Application release is unavailable';
  end if;

  select binding.* into binding_row
  from vortex_module.installation_bindings as binding
  where binding.organization_id = selected_organization_id
    and binding.application_root_id = selected_application_root_id
    and binding.module_root_id = selected_module_root_id
    and binding.state = 'active'
    and binding.application_release_revision =
      (current_installation ->> 'applicationReleaseRevision')::bigint
  for share of binding;
  if not found
    or binding_row.binding_revision not between 1 and 9007199254740991
    or binding_row.module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '42501', message = 'Search binding is unavailable';
  end if;
  select item.value into current_binding
  from pg_catalog.jsonb_array_elements(current_installation -> 'moduleBindings') as item(value)
  where item.value ->> 'moduleRootId' = selected_module_root_id::text;
  if not found
    or current_binding ->> 'organizationId' is distinct from selected_organization_id::text
    or current_binding ->> 'applicationRootId' is distinct from selected_application_root_id::text
    or current_binding ->> 'moduleRootId' is distinct from selected_module_root_id::text
    or current_binding ->> 'bindingRevision' is distinct from binding_row.binding_revision::text
    or current_binding ->> 'applicationReleaseRevision' is distinct from
      binding_row.application_release_revision::text
    or current_binding ->> 'moduleReleaseRevision' is distinct from
      binding_row.module_release_revision::text
    or current_binding ->> 'state' is distinct from 'active' then
    raise exception using errcode = '42501', message = 'Search active binding closure is unavailable';
  end if;

  select release.* into current_application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = selected_application_root_id
    and release.release_revision = binding_row.application_release_revision
    and root.organization_id = selected_organization_id
    and root.kind = 'application';
  if not found
    or current_application_release.validation_contract_version <>
      all (vortex_definition.accepted_contract_version('application'))
    or current_application_release.source_contract_version is distinct from
      current_application_release.validation_contract_version
    or current_application_release.compilation_output #>> '{kind}' is distinct from 'application'
    or current_application_release.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from selected_application_root_id::text
    or current_application_release.compilation_output #>> '{validationContractVersion}'
      is distinct from current_application_release.validation_contract_version then
    raise exception using errcode = '42501', message = 'Search Application release is unavailable';
  end if;

  select release.* into current_module_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = selected_module_root_id
    and release.release_revision = binding_row.module_release_revision
    and root.kind = 'module';
  if not found
    or current_module_release.validation_contract_version <>
      all (vortex_definition.accepted_contract_version('module'))
    or current_module_release.source_contract_version is distinct from
      current_module_release.validation_contract_version
    or current_module_release.compilation_output #>> '{kind}' is distinct from 'module'
    or current_module_release.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from selected_module_root_id::text
    or current_module_release.compilation_output #>> '{validationContractVersion}'
      is distinct from current_module_release.validation_contract_version then
    raise exception using errcode = '42501', message = 'Search Module release is unavailable';
  end if;

  select release.* into retained_module_release
  from vortex_definition.releases as release
  where release.root_id = selected_module_root_id
    and release.release_revision = selected_module_release_revision;
  if not found
    or retained_module_release.release_version is distinct from
      occurrence #>> '{definitionRelease,releaseVersion}'
    or retained_module_release.content_fingerprint is distinct from
      occurrence #>> '{definitionRelease,contentFingerprint}'
    or retained_module_release.resolution_fingerprint is distinct from
      occurrence #>> '{definitionRelease,resolutionFingerprint}'
    or retained_module_release.validation_contract_version <>
      all (vortex_definition.accepted_contract_version('module'))
    or retained_module_release.source_contract_version is distinct from
      retained_module_release.validation_contract_version
    or retained_module_release.compilation_output #>> '{kind}' is distinct from 'module'
    or retained_module_release.compilation_output #>> '{canonical,envelope,rootId}'
      is distinct from selected_module_root_id::text
    or retained_module_release.compilation_output #>> '{validationContractVersion}'
      is distinct from retained_module_release.validation_contract_version then
    raise exception using errcode = '42501', message = 'Search retained Module release is unavailable';
  end if;

  retained_record_types := retained_module_release.compilation_output #> '{canonical,content,recordTypes}';
  current_record_types := current_module_release.compilation_output #> '{canonical,content,recordTypes}';
  if pg_catalog.jsonb_typeof(retained_record_types) is distinct from 'array'
    or pg_catalog.jsonb_typeof(current_record_types) is distinct from 'array' then
    raise exception using errcode = '42501', message = 'Search Record type is unavailable';
  end if;

  select item.value into historical_record_type
  from pg_catalog.jsonb_array_elements(retained_record_types) as item(value)
  where item.value ->> 'recordTypeId' = selected_record_type_id::text
    and item.value ->> 'storageContractId' = selected_storage_contract_id::text;
  if not found or (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(retained_record_types) as item(value)
    where item.value ->> 'recordTypeId' = selected_record_type_id::text
      and item.value ->> 'storageContractId' = selected_storage_contract_id::text
  ) <> 1 then
    raise exception using errcode = '42501', message = 'Search retained Record type is unavailable';
  end if;

  select item.value into current_record_type
  from pg_catalog.jsonb_array_elements(current_record_types) as item(value)
  where item.value ->> 'recordTypeId' = selected_record_type_id::text
    and item.value ->> 'storageContractId' = selected_storage_contract_id::text;
  if not found or (
    select pg_catalog.count(*)
    from pg_catalog.jsonb_array_elements(current_record_types) as item(value)
    where item.value ->> 'recordTypeId' = selected_record_type_id::text
      and item.value ->> 'storageContractId' = selected_storage_contract_id::text
  ) <> 1
    or current_record_type ->> 'storageScope' is distinct from 'application_contained'
    or historical_record_type ->> 'storageScope' is distinct from 'application_contained'
    or pg_catalog.jsonb_typeof(current_record_type -> 'fields') is distinct from 'array'
    or pg_catalog.jsonb_typeof(historical_record_type -> 'fields') is distinct from 'array' then
    raise exception using errcode = '42501', message = 'Search current Record type is unavailable';
  end if;

  select coalesce(pg_catalog.array_agg((field.value ->> 'fieldId')::uuid order by
      pg_catalog.lower(field.value ->> 'fieldId') collate "C"), array[]::uuid[]),
    coalesce(pg_catalog.jsonb_agg(field.value order by
      pg_catalog.lower(field.value ->> 'fieldId') collate "C"), '[]'::jsonb)
  into selected_field_ids, selected_fields
  from pg_catalog.jsonb_array_elements(current_record_type -> 'fields') as field(value)
  where field.value ->> 'personalData' = 'none'
    and field.value ->> 'searchPriority' in ('first', 'normal', 'last')
    and field.value ->> 'type' in (
      'text', 'long_text', 'formatted_text', 'whole_number', 'decimal_number', 'date',
      'date_time', 'choice', 'several_choices', 'reference_number', 'email_address',
      'phone_number', 'web_address'
    )
    and vortex_context.is_non_nil_uuid(field.value ->> 'fieldId');

  if selected_fields is null or pg_catalog.jsonb_array_length(selected_fields) > 100 then
    raise exception using errcode = '42501', message = 'Search fields are unavailable';
  end if;
  projected_record_type := pg_catalog.jsonb_build_object(
    'recordTypeId', selected_record_type_id,
    'fields', selected_fields
  );

  trusted_record_plan := pg_catalog.jsonb_build_object(
    'occurrenceId', p_occurrence_id,
    'claimCursor', p_claim_cursor,
    'organizationId', selected_organization_id,
    'applicationRootId', selected_application_root_id,
    'applicationReleaseRevision', binding_row.application_release_revision,
    'moduleRootId', selected_module_root_id,
    'moduleReleaseRevision', binding_row.module_release_revision,
    'bindingRevision', binding_row.binding_revision,
    'storageContractId', selected_storage_contract_id,
    'recordTypeId', selected_record_type_id,
    'recordId', (occurrence ->> 'recordId')::uuid,
    'recordType', current_record_type,
    'fieldIds', pg_catalog.to_jsonb(selected_field_ids)
  );
  record_snapshot := vortex_record.read_search_index_record_internal(trusted_record_plan);

  if pg_catalog.jsonb_typeof(record_snapshot) is distinct from 'object'
    or record_snapshot ->> 'recordId' is distinct from occurrence ->> 'recordId'
    or record_snapshot ->> 'recordTypeId' is distinct from selected_record_type_id::text
    or record_snapshot ->> 'indexOrganisationId' is distinct from selected_organization_id::text
    or record_snapshot ->> 'ownerOrganisationId' is distinct from selected_organization_id::text
    or record_snapshot ->> 'applicationRootId' is distinct from selected_application_root_id::text
    or (record_snapshot ->> 'definitionRevision')::bigint not between 1 and 9007199254740991 then
    raise exception using errcode = '42501', message = 'Search Record snapshot is unavailable';
  end if;

  projected_snapshot := pg_catalog.jsonb_build_object(
    'indexOrganisationId', record_snapshot -> 'indexOrganisationId',
    'ownerOrganisationId', record_snapshot -> 'ownerOrganisationId',
    'applicationRootId', record_snapshot -> 'applicationRootId',
    'recordTypeId', record_snapshot -> 'recordTypeId',
    'recordId', record_snapshot -> 'recordId',
    'recordVersion', record_snapshot -> 'recordVersion',
    'lifecycle', record_snapshot -> 'lifecycle',
    'fieldValues', record_snapshot -> 'fieldValues'
  );

  return pg_catalog.jsonb_build_object(
    'occurrence', occurrence,
    'recordType', projected_record_type,
    'snapshot', projected_snapshot
  );
end
$function$;

alter function vortex_module.read_search_index_source(uuid, uuid)
  owner to vortex_module_owner;
revoke all on function vortex_module.read_search_index_source(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner,
    vortex_event_owner, vortex_search_owner, vortex_access_owner, vortex_identity_owner;
grant execute on function vortex_module.read_search_index_source(uuid, uuid)
  to vortex_request, vortex_search_owner;
comment on function vortex_module.read_search_index_source(uuid, uuid) is
  'Returns only the current exact installed application-contained Search event source and bounded direct nonpersonal Record snapshot for one retained live SYSTEM claim; all selectors derive from immutable Event evidence and the current locked installation.';
