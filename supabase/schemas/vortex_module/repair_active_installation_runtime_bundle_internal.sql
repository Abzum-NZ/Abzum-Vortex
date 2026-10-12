create or replace function vortex_module.repair_active_installation_runtime_bundle_internal(
  p_expected_identity jsonb,
  p_parts jsonb
)
returns jsonb language plpgsql volatile security definer set search_path=''
as $function$
declare

  expected_sections constant text[] := array[
    'pages', 'navigation', 'flows', 'trigger_index', 'theme', 'component_registry',
    'access_plan', 'tool_bundle'
  ];
  checked_context jsonb;
  selected_organization_id uuid;
  part_item jsonb;
  section_value text;
  ordinal_value bigint;
  byte_size_value bigint;
  content_text text;
  content_bytes bytea;
  sha256_value text;
  total_size_value bigint := 0;
  parts_manifest jsonb;
  inserted_rows bigint;
  stored_bundle vortex_module.installation_runtime_bundles%rowtype;
  source_manifest jsonb;
  section_payloads jsonb := '{}'::jsonb;
  section_text text;
  application_content jsonb;
  expected_modules jsonb;
  expected_trigger_index jsonb;
  expected_access_plan jsonb;
  p_application_root_id uuid;
  p_application_release_revision bigint;
  p_bundle_format_version integer:=2;
  p_pin_fingerprint text;
  active_source jsonb;
  mapping jsonb;
  final_mapping jsonb;
  stable_plan jsonb;
begin
  if pg_catalog.jsonb_typeof(p_expected_identity) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_parts) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_parts)<pg_catalog.cardinality(expected_sections) then
    raise exception using errcode='22023', message='Active runtime repair command is invalid';
  end if;
  -- This current HUMAN viewer path deliberately has no installation/manage
  -- decision, delegated installer scope or provisioned-binding authority.
  mapping:=vortex_module.lock_active_installation_runtime_mapping_internal(p_expected_identity);
  stable_plan:=vortex_record.resolve_active_bundle_record_access_plan_internal(p_expected_identity);
  p_application_root_id:=(mapping #>> '{identity,applicationRootId}')::uuid;
  p_application_release_revision:=(mapping #>> '{identity,applicationReleaseRevision}')::bigint;
  p_pin_fingerprint:=mapping #>> '{identity,pinFingerprint}';
  selected_organization_id:=(mapping #>> '{identity,organizationId}')::uuid;
  active_source:=pg_catalog.jsonb_build_object(
    'organizationId',mapping #> '{identity,organizationId}',
    'applicationRootId',mapping #> '{identity,applicationRootId}',
    'applicationReleaseRevision',mapping #> '{identity,applicationReleaseRevision}',
    'pinFingerprint',mapping #> '{identity,pinFingerprint}',
    'application',mapping -> 'application','modules',mapping -> 'modules',
    'preparedRecordAccessPlan',stable_plan);
  -- Exclusive bundle lock follows already-held binding and storage locks.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'vortex_module.runtime_bundle:' || selected_organization_id::text || ':' ||
      p_application_root_id::text || ':' || p_application_release_revision::text || ':2',0));
  final_mapping:=vortex_module.lock_active_installation_runtime_mapping_internal(p_expected_identity);
  if final_mapping is distinct from mapping then
    raise exception using errcode='40001', message='Active runtime repair changed while waiting';
  end if;
  source_manifest := pg_catalog.jsonb_build_object(
    'bundleFormatVersion', 2,
    'application', pg_catalog.jsonb_build_object(
      'rootId', active_source #> '{application,rootId}',
      'definitionKey', active_source #> '{application,key}',
      'releaseRevision', active_source #> '{application,releaseRevision}',
      'releaseVersion', active_source #> '{application,releaseVersion}',
      'validationContractVersion', active_source #> '{application,validationContractVersion}',
      'contentFingerprint', active_source #> '{application,contentFingerprint}',
      'resolutionFingerprint', active_source #> '{application,resolutionFingerprint}'
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
      from pg_catalog.jsonb_array_elements(active_source -> 'modules') as module(value)
    ), '[]'::jsonb),
    'pinFingerprint', active_source -> 'pinFingerprint',
    'preparedRecordAccessPlan', pg_catalog.jsonb_build_object(
      'planKey', active_source #> '{preparedRecordAccessPlan,planKey}',
      'mappingFingerprint', active_source #> '{preparedRecordAccessPlan,mappingFingerprint}'
    )
  );
  for section_value in
    select required.section
    from pg_catalog.unnest(expected_sections) as required(section)
  loop
    select pg_catalog.string_agg(item.value ->> 'content', '' order by
      (item.value ->> 'ordinal')::integer)
    into section_text
    from pg_catalog.jsonb_array_elements(p_parts) as item(value)
    where item.value ->> 'section' = section_value;
    if section_text is null then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle section is unavailable';
    end if;
    begin
      section_payloads := section_payloads || pg_catalog.jsonb_build_object(
        section_value, section_text::jsonb
      );
    exception when others then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle section is invalid';
    end;
  end loop;
  application_content := active_source #> '{application,compilationOutput,canonical,content}';
  if application_content is null then
    raise exception using errcode = '55000',
      message = 'Installation runtime bundle Application content is unavailable';
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'identity', pg_catalog.jsonb_build_object(
        'kind', module.value -> 'kind',
        'organizationId', module.value -> 'organizationId',
        'rootId', module.value -> 'rootId',
        'definitionKey', module.value -> 'key',
        'releaseRevision', module.value -> 'releaseRevision',
        'releaseVersion', module.value -> 'releaseVersion',
        'validationContractVersion', module.value -> 'validationContractVersion',
        'contentFingerprint', module.value -> 'contentFingerprint',
        'resolutionFingerprint', module.value -> 'resolutionFingerprint',
        'dependencyManifest', module.value -> 'dependencyManifest'
      ),
      'content', module.value #> '{compilationOutput,canonical,content}'
    ) order by (module.value ->> 'rootId') collate "C"), '[]'::jsonb)
  into expected_modules
  from pg_catalog.jsonb_array_elements(active_source -> 'modules') as module(value);
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'flowId', flow.value -> 'id', 'trigger', trigger.value
    ) order by (flow.value ->> 'id') collate "C", (trigger.value ->> 'id') collate "C"), '[]'::jsonb)
  into expected_trigger_index
  from pg_catalog.jsonb_array_elements(application_content -> 'flows') as flow(value)
  cross join lateral pg_catalog.jsonb_array_elements(flow.value -> 'triggers') as trigger(value);
  select pg_catalog.jsonb_build_object(
    'preparedRecordAccessPlan', active_source -> 'preparedRecordAccessPlan',
    'declaredPermissions', pg_catalog.jsonb_build_object(
      'application', application_content -> 'permissions',
      'modules', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'rootId', module.value -> 'rootId',
            'permissions', module.value #> '{compilationOutput,canonical,content,permissions}'
          ) order by (module.value ->> 'rootId') collate "C")
        from pg_catalog.jsonb_array_elements(active_source -> 'modules') as module(value)
      ), '[]'::jsonb)
    )
  ) into expected_access_plan;
  if section_payloads -> 'navigation' is distinct from application_content -> 'navigation'
    or section_payloads -> 'flows' is distinct from pg_catalog.jsonb_build_object(
      'flows', application_content -> 'flows',
      'flowBindings', application_content -> 'flowBindings'
    )
    or section_payloads -> 'trigger_index' is distinct from expected_trigger_index
    or section_payloads -> 'theme' is distinct from application_content -> 'theme'
    or section_payloads -> 'component_registry' is distinct from application_content -> 'platformBlockDependencies'
    or section_payloads -> 'tool_bundle' is distinct from active_source #> '{application,compilationOutput,toolBundle}'
    or section_payloads -> 'access_plan' is distinct from expected_access_plan
    or section_payloads #> '{pages,application,identity}' is distinct from (
      pg_catalog.jsonb_build_object(
        'kind', active_source #> '{application,kind}',
        'organizationId', active_source #> '{application,organizationId}',
        'rootId', active_source #> '{application,rootId}',
        'definitionKey', active_source #> '{application,key}',
        'releaseRevision', active_source #> '{application,releaseRevision}',
        'releaseVersion', active_source #> '{application,releaseVersion}',
        'validationContractVersion', active_source #> '{application,validationContractVersion}',
        'contentFingerprint', active_source #> '{application,contentFingerprint}',
        'resolutionFingerprint', active_source #> '{application,resolutionFingerprint}',
        'dependencyManifest', active_source #> '{application,dependencyManifest}'
      )
      || case
        when active_source #> '{application,compilationOutput,platformCompatibilityVersion}' is null
          then '{}'::jsonb
        else pg_catalog.jsonb_build_object(
          'platformCompatibilityVersion',
          active_source #> '{application,compilationOutput,platformCompatibilityVersion}'
        )
      end
    )
    or section_payloads #> '{pages,application,content}' is distinct from
      application_content - array[
        'navigation', 'flows', 'flowBindings', 'theme',
        'platformBlockDependencies', 'shells', 'pages'
      ]::text[]
    or section_payloads #> '{pages,application,shells}' is distinct from application_content -> 'shells'
    or section_payloads #> '{pages,application,pages}' is distinct from application_content -> 'pages'
    or section_payloads #> '{pages,modules}' is distinct from expected_modules
    or pg_catalog.jsonb_typeof(section_payloads #> '{pages,resolvedCompositions}') is distinct from 'array'
    or pg_catalog.jsonb_array_length(section_payloads #> '{pages,resolvedCompositions}') <>
      pg_catalog.jsonb_array_length(application_content -> 'pages') then
    raise exception using errcode = '23514',
      message = 'Installation runtime bundle sections do not match current immutable source';
  end if;
  for part_item in
    select item.value from pg_catalog.jsonb_array_elements(p_parts) as item(value)
  loop
    if pg_catalog.jsonb_typeof(part_item) is distinct from 'object' then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;
    if not (part_item ?& array['section', 'ordinal', 'byteSize', 'sha256', 'content'])
      or part_item - array['section', 'ordinal', 'byteSize', 'sha256', 'content'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(part_item -> 'section') is distinct from 'string'
      or pg_catalog.jsonb_typeof(part_item -> 'ordinal') is distinct from 'number'
      or pg_catalog.jsonb_typeof(part_item -> 'byteSize') is distinct from 'number'
      or pg_catalog.jsonb_typeof(part_item -> 'sha256') is distinct from 'string'
      or pg_catalog.jsonb_typeof(part_item -> 'content') is distinct from 'string' then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;

    section_value := part_item ->> 'section';
    if not (section_value = any (expected_sections))
      or (part_item ->> 'ordinal') !~ '^(0|[1-9][0-9]*)$'
      or pg_catalog.length(part_item ->> 'ordinal') > 10
      or (part_item ->> 'byteSize') !~ '^[1-9][0-9]*$'
      or pg_catalog.length(part_item ->> 'byteSize') > 7 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part is invalid';
    end if;
    ordinal_value := (part_item ->> 'ordinal')::bigint;
    byte_size_value := (part_item ->> 'byteSize')::bigint;
    content_text := part_item ->> 'content';
    if ordinal_value > 2147483647 or byte_size_value > 1048575 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part exceeds its limit';
    end if;

    content_bytes := pg_catalog.convert_to(content_text, 'UTF8');
    if pg_catalog.octet_length(content_bytes) <> byte_size_value then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part size is invalid';
    end if;
    sha256_value := 'sha256:' || pg_catalog.encode(
      extensions.digest(content_bytes, 'sha256'), 'hex'
    );
    if (part_item ->> 'sha256') !~ '^sha256:[a-f0-9]{64}$'
      or sha256_value <> (part_item ->> 'sha256') then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle part fingerprint is invalid';
    end if;
    total_size_value := total_size_value + byte_size_value;
    if total_size_value > 9007199254740991 then
      raise exception using errcode = '22023',
        message = 'Installation runtime bundle is too large';
    end if;
  end loop;

  if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_parts) as item(value)
      group by item.value ->> 'section', (item.value ->> 'ordinal')::integer
      having pg_catalog.count(*) > 1
    )
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_parts) as item(value)
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
        from pg_catalog.jsonb_array_elements(p_parts) as item(value)
        where item.value ->> 'section' = required.section
      )
    ) then
    raise exception using errcode = '22023',
      message = 'Installation runtime bundle sections are incomplete';
  end if;

  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'section', item.value ->> 'section',
      'ordinal', (item.value ->> 'ordinal')::integer,
      'byteSize', (item.value ->> 'byteSize')::bigint,
      'sha256', item.value ->> 'sha256'
    ) order by pg_catalog.array_position(
      expected_sections, item.value ->> 'section'
    ), (item.value ->> 'ordinal')::integer
  )
  into parts_manifest
  from pg_catalog.jsonb_array_elements(p_parts) as item(value);

  insert into vortex_module.installation_runtime_bundles (
    organization_id, application_root_id, application_release_revision,
    bundle_format_version, pin_fingerprint, source_manifest, parts, total_size_bytes
  ) values (
    selected_organization_id, p_application_root_id, p_application_release_revision,
    p_bundle_format_version, p_pin_fingerprint, source_manifest, parts_manifest, total_size_value
  ) on conflict (
    organization_id, application_root_id, application_release_revision, bundle_format_version
  ) do nothing;
  get diagnostics inserted_rows = row_count;

  if inserted_rows = 0 then
    select stored.* into stored_bundle
    from vortex_module.installation_runtime_bundles as stored
    where stored.organization_id = selected_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.application_release_revision = p_application_release_revision
      and stored.bundle_format_version = p_bundle_format_version;
    if not found then
      raise exception using errcode = '40001',
        message = 'Installation runtime bundle changed concurrently';
    end if;
    if stored_bundle.pin_fingerprint <> p_pin_fingerprint
      or stored_bundle.source_manifest is distinct from source_manifest
      or stored_bundle.parts is distinct from parts_manifest
      or stored_bundle.total_size_bytes is distinct from total_size_value
      or (select pg_catalog.count(*) from vortex_module.installation_runtime_bundle_parts as part
        where part.organization_id = selected_organization_id
          and part.application_root_id = p_application_root_id
          and part.application_release_revision = p_application_release_revision
          and part.bundle_format_version = p_bundle_format_version)
        <> pg_catalog.jsonb_array_length(p_parts)
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_parts) as item(value)
        left join vortex_module.installation_runtime_bundle_parts as part
          on part.organization_id = selected_organization_id
          and part.application_root_id = p_application_root_id
          and part.application_release_revision = p_application_release_revision
          and part.bundle_format_version = p_bundle_format_version
          and part.section = item.value ->> 'section'
          and part.ordinal = (item.value ->> 'ordinal')::integer
        where part.content_bytes is distinct from pg_catalog.convert_to(item.value ->> 'content', 'UTF8')
      ) then
      raise exception using errcode = '23505',
        message = 'Installation runtime bundle pin fingerprint differs';
    end if;
  else
    for part_item in
      select item.value from pg_catalog.jsonb_array_elements(p_parts) as item(value)
    loop
      insert into vortex_module.installation_runtime_bundle_parts (
        organization_id, application_root_id, application_release_revision,
        bundle_format_version, section, ordinal, content_bytes
      ) values (
        selected_organization_id, p_application_root_id, p_application_release_revision,
        p_bundle_format_version, part_item ->> 'section',
        (part_item ->> 'ordinal')::integer,
        pg_catalog.convert_to(part_item ->> 'content', 'UTF8')
      );
    end loop;

    select stored.* into strict stored_bundle
    from vortex_module.installation_runtime_bundles as stored
    where stored.organization_id = selected_organization_id
      and stored.application_root_id = p_application_root_id
      and stored.application_release_revision = p_application_release_revision
      and stored.bundle_format_version = p_bundle_format_version;
  end if;

  final_mapping:=vortex_module.lock_active_installation_runtime_mapping_internal(p_expected_identity);
  if final_mapping is distinct from mapping then
    raise exception using errcode='40001', message='Active runtime repair identity changed';
  end if;
  return pg_catalog.jsonb_build_object(
    'organizationId', stored_bundle.organization_id,
    'applicationRootId', stored_bundle.application_root_id,
    'applicationReleaseRevision', stored_bundle.application_release_revision,
    'bundleFormatVersion', stored_bundle.bundle_format_version,
    'pinFingerprint', stored_bundle.pin_fingerprint,
    'sourceManifest', stored_bundle.source_manifest,
    'parts', stored_bundle.parts,
    'totalSizeBytes', stored_bundle.total_size_bytes,
    'builtAt', stored_bundle.built_at
  );
exception
  when no_data_found then
    raise exception using errcode = 'P0002',
      message = 'Installation runtime bundle evidence is unavailable';
  when too_many_rows then
    raise exception using errcode = '55000',
      message = 'Installation runtime bundle evidence is ambiguous';
end
$function$;


alter function vortex_module.repair_active_installation_runtime_bundle_internal(jsonb,jsonb) owner to vortex_module_owner;
revoke all on function vortex_module.repair_active_installation_runtime_bundle_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner, vortex_definition_owner;
grant execute on function vortex_module.repair_active_installation_runtime_bundle_internal(jsonb,jsonb) to vortex_module_owner, vortex_request;
comment on function vortex_module.repair_active_installation_runtime_bundle_internal(jsonb,jsonb) is 'Atomically repairs only the current active immutable format2 bundle under a current HUMAN viewer transaction, with complete source and byte replay equality and no installation authority.';