create or replace function vortex_module.assert_prepared_installation_runtime_bundle(
  p_application_root_id uuid,
  p_application_release_revision bigint,
  p_expected_module_bindings jsonb,
  p_pin_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  expected_sections constant text[] := array[
    'pages', 'navigation', 'flows', 'trigger_index', 'theme', 'component_registry',
    'access_plan', 'tool_bundle'
  ];
  checked_context jsonb;
  selected_organization_id uuid;
  prepared_source jsonb;
  source_manifest jsonb;
  application_content jsonb;
  expected_access_plan jsonb;
  access_plan_text text;
  access_plan_value jsonb;
  stored_bundle vortex_module.installation_runtime_bundles%rowtype;
  part_item record;
  metadata_item jsonb;
  metadata_count integer;
  stored_part_count integer;
  section_value text;
  ordinal_value bigint;
  byte_size_value bigint;
  total_size_value bigint := 0;
begin
  if p_application_root_id is null
    or p_application_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_application_release_revision is null
    or p_application_release_revision not between 1 and 9007199254740991
    or p_pin_fingerprint is null
    or p_pin_fingerprint !~ '^sha256:[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_expected_module_bindings) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_expected_module_bindings) < 1 then
    raise exception using errcode = '22023',
      message = 'Prepared runtime bundle assertion is invalid';
  end if;
  checked_context := vortex_access.validated_human_request_context();
  selected_organization_id := (checked_context ->> 'organizationId')::uuid;
  if selected_organization_id is null then
    raise exception using errcode = '42501',
      message = 'Prepared runtime bundle authority is unavailable';
  end if;
  prepared_source := vortex_module.read_prepared_installation_runtime_source(
    p_application_root_id,
    p_application_release_revision,
    p_expected_module_bindings
  );
  if prepared_source is null
    or (prepared_source ->> 'organizationId')::uuid is distinct from selected_organization_id
    or prepared_source ->> 'pinFingerprint' is distinct from p_pin_fingerprint then
    raise exception using errcode = '40001',
      message = 'Prepared runtime bundle source changed';
  end if;
  source_manifest := pg_catalog.jsonb_build_object(
    'bundleFormatVersion', 2,
    'application', pg_catalog.jsonb_build_object(
      'rootId', prepared_source #> '{application,rootId}',
      'definitionKey', prepared_source #> '{application,key}',
      'releaseRevision', prepared_source #> '{application,releaseRevision}',
      'releaseVersion', prepared_source #> '{application,releaseVersion}',
      'validationContractVersion', prepared_source #> '{application,validationContractVersion}',
      'contentFingerprint', prepared_source #> '{application,contentFingerprint}',
      'resolutionFingerprint', prepared_source #> '{application,resolutionFingerprint}'
    ),
    'modules', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'rootId', module.value -> 'rootId',
          'definitionKey', module.value -> 'key',
          'releaseRevision', module.value -> 'releaseRevision',
          'releaseVersion', module.value -> 'releaseVersion',
          'validationContractVersion', module.value -> 'validationContractVersion',
          'contentFingerprint', module.value -> 'contentFingerprint',
          'resolutionFingerprint', module.value -> 'resolutionFingerprint'
        ) order by (module.value ->> 'rootId') collate "C")
      from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value)
    ), '[]'::jsonb),
    'pinFingerprint', prepared_source -> 'pinFingerprint',
    'preparedRecordAccessPlan', pg_catalog.jsonb_build_object(
      'planKey', prepared_source #> '{preparedRecordAccessPlan,planKey}',
      'mappingFingerprint', prepared_source #> '{preparedRecordAccessPlan,mappingFingerprint}'
    )
  );
  select stored.* into strict stored_bundle
  from vortex_module.installation_runtime_bundles as stored
  where stored.organization_id = selected_organization_id
    and stored.application_root_id = p_application_root_id
    and stored.application_release_revision = p_application_release_revision
    and stored.bundle_format_version = 2;
  if stored_bundle.pin_fingerprint is distinct from p_pin_fingerprint
    or stored_bundle.source_manifest is distinct from source_manifest then
    raise exception using errcode = '23505',
      message = 'Prepared runtime bundle identity differs';
  end if;

  if pg_catalog.jsonb_typeof(stored_bundle.parts) is distinct from 'array'
    or pg_catalog.jsonb_array_length(stored_bundle.parts) < pg_catalog.cardinality(expected_sections)
    or exists (
      select 1
      from pg_catalog.unnest(expected_sections) as required(section)
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
        where item.value ->> 'section' = required.section
      )
    ) then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle parts are incomplete';
  end if;
  select pg_catalog.count(*)::integer into metadata_count
  from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value);
  select pg_catalog.count(*)::integer into stored_part_count
  from vortex_module.installation_runtime_bundle_parts as part
  where part.organization_id = selected_organization_id
    and part.application_root_id = p_application_root_id
    and part.application_release_revision = p_application_release_revision
    and part.bundle_format_version = 2;
  if metadata_count is distinct from stored_part_count then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle part count differs';
  end if;
  for metadata_item in
    select item.value from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
  loop
    if pg_catalog.jsonb_typeof(metadata_item) is distinct from 'object'
      or not metadata_item ?& array['section','ordinal','byteSize','sha256']
      or metadata_item - array['section','ordinal','byteSize','sha256'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(metadata_item -> 'section') is distinct from 'string'
      or pg_catalog.jsonb_typeof(metadata_item -> 'ordinal') is distinct from 'number'
      or pg_catalog.jsonb_typeof(metadata_item -> 'byteSize') is distinct from 'number'
      or pg_catalog.jsonb_typeof(metadata_item -> 'sha256') is distinct from 'string'
      or not (metadata_item ->> 'section' = any (expected_sections))
      or (metadata_item ->> 'ordinal') !~ '^(0|[1-9][0-9]*)$'
      or pg_catalog.length(metadata_item ->> 'ordinal') > 10
      or (metadata_item ->> 'byteSize') !~ '^[1-9][0-9]*$'
      or pg_catalog.length(metadata_item ->> 'byteSize') > 7
      or (metadata_item ->> 'sha256') !~ '^sha256:[a-f0-9]{64}$' then
      raise exception using errcode = '55000',
        message = 'Prepared runtime bundle part metadata is invalid';
    end if;
    section_value := metadata_item ->> 'section';
    ordinal_value := (metadata_item ->> 'ordinal')::bigint;
    byte_size_value := (metadata_item ->> 'byteSize')::bigint;
    if ordinal_value > 2147483647 or byte_size_value > 1048575 then
      raise exception using errcode = '55000',
        message = 'Prepared runtime bundle part metadata exceeds its limit';
    end if;
    total_size_value := total_size_value + byte_size_value;
    if total_size_value > 9007199254740991 then
      raise exception using errcode = '55000',
        message = 'Prepared runtime bundle total size exceeds its limit';
    end if;
    select part.* into strict part_item
    from vortex_module.installation_runtime_bundle_parts as part
    where part.organization_id = selected_organization_id
      and part.application_root_id = p_application_root_id
      and part.application_release_revision = p_application_release_revision
      and part.bundle_format_version = 2
      and part.section = section_value
      and part.ordinal = ordinal_value::integer;
    if pg_catalog.octet_length(part_item.content_bytes) is distinct from byte_size_value
      or ('sha256:' || pg_catalog.encode(
        extensions.digest(part_item.content_bytes, 'sha256'), 'hex'
      )) is distinct from metadata_item ->> 'sha256' then
      raise exception using errcode = '55000',
        message = 'Prepared runtime bundle bytes do not match their manifest';
    end if;
  end loop;
  if total_size_value is distinct from stored_bundle.total_size_bytes
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
      group by item.value ->> 'section', (item.value ->> 'ordinal')::integer
      having pg_catalog.count(*) > 1
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
      group by item.value ->> 'section'
      having pg_catalog.min((item.value ->> 'ordinal')::integer) <> 0
        or pg_catalog.max((item.value ->> 'ordinal')::integer) <>
          pg_catalog.count(*) - 1
    )
    or exists (
      select 1
      from pg_catalog.unnest(expected_sections) as required(section)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(stored_bundle.parts) as item(value)
        where item.value ->> 'section' = required.section
      )
    ) then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle metadata is incomplete';
  end if;

  application_content := prepared_source #> '{application,compilationOutput,canonical,content}';
  select pg_catalog.jsonb_build_object(
    'preparedRecordAccessPlan', prepared_source -> 'preparedRecordAccessPlan',
    'declaredPermissions', pg_catalog.jsonb_build_object(
      'application', application_content -> 'permissions',
      'modules', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'rootId', module.value -> 'rootId',
            'permissions', module.value #> '{compilationOutput,canonical,content,permissions}'
          ) order by (module.value ->> 'rootId') collate "C")
        from pg_catalog.jsonb_array_elements(prepared_source -> 'modules') as module(value)
      ), '[]'::jsonb)
    )
  ) into expected_access_plan;
  select pg_catalog.string_agg(pg_catalog.convert_from(part.content_bytes, 'UTF8'), ''
    order by part.ordinal)
  into access_plan_text
  from vortex_module.installation_runtime_bundle_parts as part
  where part.organization_id = selected_organization_id
    and part.application_root_id = p_application_root_id
    and part.application_release_revision = p_application_release_revision
    and part.bundle_format_version = 2
    and part.section = 'access_plan';
  begin
    access_plan_value := access_plan_text::jsonb;
  exception when others then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle access plan is invalid';
  end;
  if access_plan_value is distinct from expected_access_plan then
    raise exception using errcode = '23505',
      message = 'Prepared runtime bundle Record plan differs from current source';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'verified',
    'organizationId', selected_organization_id,
    'applicationRootId', p_application_root_id,
    'applicationReleaseRevision', p_application_release_revision,
    'bundleFormatVersion', 2,
    'pinFingerprint', stored_bundle.pin_fingerprint,
    'sourceManifest', stored_bundle.source_manifest
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Prepared runtime bundle is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Prepared runtime bundle evidence is ambiguous';
end
$function$;

alter function vortex_module.assert_prepared_installation_runtime_bundle(uuid,bigint,jsonb,text)
  owner to vortex_module_owner;
revoke all on function vortex_module.assert_prepared_installation_runtime_bundle(uuid,bigint,jsonb,text)
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_record_owner, vortex_record_adapter;
grant execute on function vortex_module.assert_prepared_installation_runtime_bundle(uuid,bigint,jsonb,text)
  to vortex_request;
comment on function vortex_module.assert_prepared_installation_runtime_bundle(uuid,bigint,jsonb,text) is
  'Re-derives first-install source and plan identity, then verifies the complete immutable format-2 bundle and its stored bytes before activation.';
