create or replace function vortex_event.append_system_projection_occurrences_internal(
  p_native_change_proof jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  maximum_safe_revision constant bigint := 9007199254740991;
  source_key text;
  registry_schema text;
  registry_function text;
  organization_id_value uuid;
  account_id_value uuid;
  correlation_id_value uuid;
  before_version bigint;
  after_version bigint;
  operation_value text;
  activity_id uuid;
  authority_checked_at timestamptz;
  proof_subject jsonb;
  previous_record_id uuid;
  record_id_value uuid;
  native_revision bigint;
  event_kind_value text;
  changed_attributes jsonb;
  attribute_item text;
  previous_attribute text;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  installation jsonb;
  application_root_id uuid;
  active_application_roots uuid[];
  module_binding jsonb;
  binding_count integer;
  module_root_id uuid;
  module_release_revision bigint;
  module_release vortex_definition.releases%rowtype;
  module_content jsonb;
  record_type jsonb;
  record_type_count integer;
  provisioned boolean;
  revision_field_id uuid;
  organization_field_id uuid;
  changed_field_ids uuid[];
  changed_field_ids_json jsonb;
  occurrences jsonb;
  occurrence_envelopes jsonb := '[]'::jsonb;
  append_result jsonb;
begin
  if pg_catalog.jsonb_typeof(p_native_change_proof) is distinct from 'object'
    or not p_native_change_proof ?& array['kind', 'source', 'initiator', 'nativeChange']
    or p_native_change_proof - array['kind', 'source', 'initiator', 'nativeChange'] <> '{}'::jsonb
    or p_native_change_proof ->> 'kind' is distinct from 'native-projection-v1'
    or pg_catalog.jsonb_typeof(p_native_change_proof -> 'source') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_native_change_proof -> 'initiator') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_native_change_proof -> 'nativeChange') is distinct from 'object'
    or (p_native_change_proof -> 'source') - array[
      'protectedReadModelKey', 'readerSchema', 'readerFunction'
    ] <> '{}'::jsonb
    or not (p_native_change_proof -> 'source') ?& array[
      'protectedReadModelKey', 'readerSchema', 'readerFunction'
    ]
    or (p_native_change_proof -> 'initiator') - array[
      'kind', 'organizationId', 'organizationAccountId', 'correlationId',
      'accessVersionBefore', 'accessVersionAfter', 'authorityCheckedAt'
    ] <> '{}'::jsonb
    or not (p_native_change_proof -> 'initiator') ?& array[
      'kind', 'organizationId', 'organizationAccountId', 'correlationId',
      'accessVersionBefore', 'accessVersionAfter', 'authorityCheckedAt'
    ]
    or (p_native_change_proof -> 'nativeChange') - array[
      'operation', 'completedActivityId', 'subjects'
    ] <> '{}'::jsonb
    or not (p_native_change_proof -> 'nativeChange') ?& array[
      'operation', 'completedActivityId', 'subjects'
    ]
    or pg_catalog.jsonb_typeof(p_native_change_proof #> '{nativeChange,subjects}') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_native_change_proof #> '{nativeChange,subjects}') = 0 then
    raise exception using errcode = '22023',
      message = 'Native Event proof is invalid';
  end if;

  begin
    organization_id_value := (p_native_change_proof #>> '{initiator,organizationId}')::uuid;
    account_id_value := (p_native_change_proof #>> '{initiator,organizationAccountId}')::uuid;
    correlation_id_value := (p_native_change_proof #>> '{initiator,correlationId}')::uuid;
    before_version := (p_native_change_proof #>> '{initiator,accessVersionBefore}')::bigint;
    after_version := (p_native_change_proof #>> '{initiator,accessVersionAfter}')::bigint;
    authority_checked_at := (p_native_change_proof #>> '{initiator,authorityCheckedAt}')::timestamptz;
    activity_id := (p_native_change_proof #>> '{nativeChange,completedActivityId}')::uuid;
  exception when others then
    raise exception using errcode = '22023', message = 'Native Event proof is invalid';
  end;

  source_key := p_native_change_proof #>> '{source,protectedReadModelKey}';
  operation_value := p_native_change_proof #>> '{nativeChange,operation}';
  if source_key is null or source_key !~ '^[a-z][a-z0-9_]*$'
    or p_native_change_proof #>> '{initiator,kind}' is distinct from 'human'
    or operation_value is null or operation_value = ''
    or not vortex_context.is_non_nil_uuid(organization_id_value::text)
    or not vortex_context.is_non_nil_uuid(account_id_value::text)
    or not vortex_context.is_non_nil_uuid(correlation_id_value::text)
    or not vortex_context.is_non_nil_uuid(activity_id::text)
    or before_version < 0 or before_version >= maximum_safe_revision
    or after_version is distinct from before_version + 1
    or after_version > maximum_safe_revision
    or authority_checked_at is null
    or authority_checked_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or pg_catalog.jsonb_typeof(p_native_change_proof #> '{initiator,accessVersionBefore}') is distinct from 'number'
    or pg_catalog.jsonb_typeof(p_native_change_proof #> '{initiator,accessVersionAfter}') is distinct from 'number'
    or pg_catalog.jsonb_typeof(p_native_change_proof #> '{initiator,authorityCheckedAt}') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_native_change_proof #> '{nativeChange,operation}') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_native_change_proof #> '{nativeChange,completedActivityId}') is distinct from 'string' then
    raise exception using errcode = '22023', message = 'Native Event proof is invalid';
  end if;

  select registry.reader_schema, registry.reader_function
  into registry_schema, registry_function
  from vortex_record.protected_read_model_views as registry
  where registry.protected_read_model_key = source_key;
  if not found
    or p_native_change_proof #>> '{source,readerSchema}' is distinct from registry_schema
    or p_native_change_proof #>> '{source,readerFunction}' is distinct from registry_function then
    raise exception using errcode = '55000',
      message = 'Native Event source is unavailable';
  end if;

  previous_record_id := null;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_native_change_proof #> '{nativeChange,subjects}') as item(value)
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or not item.value ?& array[
        'recordId', 'nativeRevision', 'eventKind', 'changedProjectionAttributes'
      ]
      or item.value - array[
        'recordId', 'nativeRevision', 'eventKind', 'changedProjectionAttributes'
      ] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(item.value -> 'recordId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'nativeRevision') is distinct from 'number'
      or pg_catalog.jsonb_typeof(item.value -> 'eventKind') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item.value -> 'changedProjectionAttributes') is distinct from 'array'
      or not vortex_context.is_non_nil_uuid(item.value ->> 'recordId')
  ) then
    raise exception using errcode = '22023', message = 'Native Event subject is invalid';
  end if;
  for proof_subject in
    select item.value
    from pg_catalog.jsonb_array_elements(p_native_change_proof #> '{nativeChange,subjects}') as item(value)
    order by (item.value ->> 'recordId')::uuid
  loop
    if pg_catalog.jsonb_typeof(proof_subject) is distinct from 'object'
      or not proof_subject ?& array[
        'recordId', 'nativeRevision', 'eventKind', 'changedProjectionAttributes'
      ]
      or proof_subject - array[
        'recordId', 'nativeRevision', 'eventKind', 'changedProjectionAttributes'
      ] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(proof_subject -> 'recordId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(proof_subject -> 'nativeRevision') is distinct from 'number'
      or pg_catalog.jsonb_typeof(proof_subject -> 'eventKind') is distinct from 'string'
      or pg_catalog.jsonb_typeof(proof_subject -> 'changedProjectionAttributes') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'Native Event subject is invalid';
    end if;
    begin
      record_id_value := (proof_subject ->> 'recordId')::uuid;
      native_revision := (proof_subject ->> 'nativeRevision')::bigint;
    exception when others then
      raise exception using errcode = '22023', message = 'Native Event subject is invalid';
    end;
    event_kind_value := proof_subject ->> 'eventKind';
    changed_attributes := proof_subject -> 'changedProjectionAttributes';
    if not vortex_context.is_non_nil_uuid(record_id_value::text)
      or native_revision < 1 or native_revision > maximum_safe_revision
      or (previous_record_id is not null and previous_record_id >= record_id_value)
      or (event_kind_value not in ('created', 'changed'))
      or pg_catalog.jsonb_typeof(proof_subject -> 'eventKind') is distinct from 'string'
      or (event_kind_value = 'created'
        and pg_catalog.jsonb_array_length(changed_attributes) <> 0)
      or (event_kind_value = 'changed' and (
        exists (
          select 1 from pg_catalog.jsonb_array_elements(changed_attributes) as item(value)
          where pg_catalog.jsonb_typeof(item.value) is distinct from 'string'
        )
        or (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(changed_attributes))
          <> (select pg_catalog.count(distinct item.value #>> '{}')
            from pg_catalog.jsonb_array_elements(changed_attributes) as item(value))
      )) then
      raise exception using errcode = '22023', message = 'Native Event subject is invalid';
    end if;
    previous_attribute := null;
    for attribute_item in
      select item.value #>> '{}'
      from pg_catalog.jsonb_array_elements(changed_attributes) as item(value)
      order by item.value #>> '{}'
    loop
      if previous_attribute is not null and previous_attribute >= attribute_item then
        raise exception using errcode = '22023', message = 'Native Event subject is invalid';
      end if;
      previous_attribute := attribute_item;
    end loop;
    previous_record_id := record_id_value;
  end loop;

  for catalogue_row in
    select catalogue.*
    from vortex_record.storage_catalogue as catalogue
    where catalogue.state = 'active'
      and catalogue.physical_schema_token = 'system_projection'
      and catalogue.storage_scope = 'organization_shared'
      and catalogue.protected_read_model_key = source_key
    order by catalogue.storage_contract_id
  loop
    active_application_roots := vortex_module.list_active_application_roots_for_module_internal(
      organization_id_value, catalogue_row.module_root_id
    );
    foreach application_root_id in array active_application_roots loop
      perform pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtextextended(
          'vortex_module.binding:' || organization_id_value::text || ':' ||
            application_root_id::text || ':' || catalogue_row.module_root_id::text,
          0
        )
      );

      if not exists (
        select 1 from vortex_module.installation_bindings as binding
        where binding.organization_id = organization_id_value
          and binding.application_root_id = application_root_id
          and binding.module_root_id = catalogue_row.module_root_id
          and binding.state = 'active'
      ) then
        continue;
      end if;

      installation := vortex_module.read_active_installation_for_scope_internal(
        organization_id_value, application_root_id
      );
      select pg_catalog.count(*), pg_catalog.jsonb_agg(item.value) -> 0
      into binding_count, module_binding
      from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
      where (item.value ->> 'moduleRootId')::uuid = catalogue_row.module_root_id;
      if binding_count <> 1 then
        raise exception using errcode = '55000',
          message = 'Active projection binding is unavailable';
      end if;
      module_root_id := (module_binding ->> 'moduleRootId')::uuid;
      module_release_revision := (module_binding ->> 'moduleReleaseRevision')::bigint;

      select release.* into module_release
      from vortex_definition.releases as release
      where release.root_id = module_root_id
        and release.release_revision = module_release_revision;
      if not found then
        raise exception using errcode = '55000',
          message = 'Active projection Module release is unavailable';
      end if;
      module_content := module_release.compilation_output #> '{canonical,content}';

      select pg_catalog.count(*), pg_catalog.jsonb_agg(item.value) -> 0
      into record_type_count, record_type
      from pg_catalog.jsonb_array_elements(module_content -> 'recordTypes') as item(value)
      where (item.value ->> 'recordTypeId')::uuid = catalogue_row.record_type_id;
      if record_type_count = 0 then
        -- A catalogue provisioned by a newer immutable Module release is not
        -- part of this older active Application release.
        continue;
      end if;
      if record_type_count <> 1
        or (record_type ->> 'storageContractId')::uuid is distinct from catalogue_row.storage_contract_id
        or record_type ->> 'storageScope' is distinct from catalogue_row.storage_scope
        or record_type #>> '{systemProjection,protectedView}' is distinct from source_key
        or catalogue_row.protected_read_model_key is distinct from
          (record_type #>> '{systemProjection,protectedView}') then
        raise exception using errcode = '55000',
          message = 'Installed system projection declaration is incompatible';
      end if;

      select exists (
        select 1 from vortex_record.release_provisions as provision
        where provision.module_root_id = module_release.root_id
          and provision.release_revision = module_release.release_revision
          and catalogue_row.storage_contract_id = any (provision.storage_contract_ids)
      ) into provisioned;
      if not provisioned
        or module_release.release_revision < catalogue_row.first_compatible_release_revision
        or (catalogue_row.last_compatible_release_revision is not null
          and module_release.release_revision > catalogue_row.last_compatible_release_revision) then
        raise exception using errcode = '55000',
          message = 'Installed system projection storage is incompatible';
      end if;

      revision_field_id := (record_type #>> '{systemProjection,revisionFieldId}')::uuid;
      organization_field_id := (record_type #>> '{systemProjection,organizationFieldId}')::uuid;
      if not exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
        where (field.value ->> 'fieldId')::uuid = revision_field_id
          and field.value ->> 'key' = 'revision'
          and field.value ->> 'required' = 'true'
      ) or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
        where (field.value ->> 'fieldId')::uuid = organization_field_id
          and field.value ->> 'key' = 'organization_id'
      ) then
        raise exception using errcode = '55000',
          message = 'Installed system projection fields are incompatible';
      end if;

      for proof_subject in
        select item.value
        from pg_catalog.jsonb_array_elements(p_native_change_proof #> '{nativeChange,subjects}') as item(value)
        order by (item.value ->> 'recordId')::uuid
      loop
        record_id_value := (proof_subject ->> 'recordId')::uuid;
        event_kind_value := proof_subject ->> 'eventKind';
        changed_attributes := proof_subject -> 'changedProjectionAttributes';
        changed_field_ids := array[]::uuid[];
        if event_kind_value = 'changed' then
          -- Changed carries installed field identities, never classified values.
          select coalesce(pg_catalog.array_agg(field_id order by field_id), array[]::uuid[])
          into changed_field_ids
          from (
            select distinct (field.value ->> 'fieldId')::uuid as field_id
            from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
            where (field.value ->> 'fieldId')::uuid = revision_field_id
              or (
                field.value ->> 'key' in (
                  select attribute.value #>> '{}'
                  from pg_catalog.jsonb_array_elements(changed_attributes) as attribute(value)
                )
                and (field.value ->> 'fieldId')::uuid not in (
                  organization_field_id, revision_field_id
                )
              )
          ) as selected;
          if not (revision_field_id = any (changed_field_ids)) then
            raise exception using errcode = '55000',
              message = 'Installed system projection revision field is unavailable';
          end if;
        else
          changed_field_ids := array[]::uuid[];
        end if;
        select coalesce(
          pg_catalog.jsonb_agg(to_jsonb(field_id::text) order by field_id),
          '[]'::jsonb
        ) into changed_field_ids_json
        from pg_catalog.unnest(changed_field_ids) as item(field_id);

        occurrences := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', pg_catalog.gen_random_uuid(),
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard',
            'eventKind', event_kind_value,
            'recordTypeId', catalogue_row.record_type_id
          ),
          'payload', case when event_kind_value = 'created'
            then pg_catalog.jsonb_build_object('kind', 'created')
            else pg_catalog.jsonb_build_object(
              'kind', 'changed', 'changedFieldIds', changed_field_ids_json
            ) end
        ));
        append_result := vortex_event.append_record_occurrences_with_native_proof_internal(
          catalogue_row.storage_contract_id,
          record_id_value,
          occurrences,
          installation,
          p_native_change_proof
        );
        occurrence_envelopes := occurrence_envelopes || append_result;
      end loop;
    end loop;
  end loop;

  return occurrence_envelopes;
end
$function$;

alter function vortex_event.append_system_projection_occurrences_internal(jsonb)
  owner to postgres;
revoke all on function vortex_event.append_system_projection_occurrences_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_event_owner, vortex_module_owner, vortex_definition_owner,
    vortex_record_owner, vortex_record_adapter;
comment on function vortex_event.append_system_projection_occurrences_internal(jsonb) is
  'Validates closed native projection proof, enumerates every active matching projection catalogue and exact active Application binding, and appends content-free standard occurrences through the shared Event core.';
