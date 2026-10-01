begin;

create or replace function vortex_module.list_active_application_roots_for_module_internal(
  p_organization_id uuid,
  p_module_root_id uuid
)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  application_roots uuid[];
begin
  if p_organization_id is null or p_organization_id = nil_uuid
    or p_module_root_id is null or p_module_root_id = nil_uuid then
    raise exception using errcode = '22023',
      message = 'Active Module consumer scope is invalid';
  end if;

  select coalesce(
    pg_catalog.array_agg(candidate.application_root_id order by candidate.application_root_id),
    array[]::uuid[]
  ) into application_roots
  from (
    select distinct binding.application_root_id
    from vortex_module.installation_bindings as binding
    where binding.organization_id = p_organization_id
      and binding.module_root_id = p_module_root_id
      and binding.state = 'active'
  ) as candidate;

  return application_roots;
end
$function$;

alter function vortex_module.list_active_application_roots_for_module_internal(uuid,uuid)
  owner to vortex_module_owner;
revoke all on function vortex_module.list_active_application_roots_for_module_internal(
  uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_event_owner, vortex_definition_owner, vortex_record_owner,
  vortex_record_adapter;
grant execute on function vortex_module.list_active_application_roots_for_module_internal(
  uuid, uuid
) to postgres;
comment on function vortex_module.list_active_application_roots_for_module_internal(uuid,uuid) is
  'Returns the distinct sorted active Application root candidates bound to one Module in one organisation; callers must resolve each candidate through the exact active-scope reader under the canonical binding lock.';


create or replace function vortex_event.append_record_occurrences_with_native_proof_internal(
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_occurrences jsonb,
  p_installation jsonb,
  p_native_proof jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  maximum_safe_revision constant bigint := 9007199254740991;
  context_value jsonb;
  installation jsonb;
  context_organization_id uuid;
  context_application_root_id uuid;
  context_actor_id uuid;
  context_correlation_id uuid;
  application_release_revision bigint;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  binding_value jsonb;
  binding_count integer;
  binding_module_root_id uuid;
  binding_module_release_revision bigint;
  binding_revision bigint;
  module_release vortex_definition.releases%rowtype;
  application_release vortex_definition.releases%rowtype;
  module_content jsonb;
  application_content jsonb;
  record_type jsonb;
  record_type_count integer;
  native_subject jsonb;
  native_subject_count integer;
  native_event_kind text;
  native_record_revision bigint;
  native_changed_attributes jsonb;
  native_before_version bigint;
  native_after_version bigint;
  native_activity_id uuid;
  native_operation text;
  native_expected_field_ids uuid[];
  native_expected_field_ids_json jsonb;
  native_revision_field_id uuid;
  native_organization_field_id uuid;
  native_occurrence jsonb;
  registered_source_count integer;
  locked_definition_revision bigint;
  locked_record_count integer;
  sequence_application_scope_id uuid;
  next_sequence bigint;
  occurrence_time timestamptz := pg_catalog.statement_timestamp();
  occurrence_time_text text;
  occurrence_item jsonb;
  occurrence_id uuid;
  descriptor jsonb;
  payload jsonb;
  event_kind text;
  owner_kind text;
  owner_root_id uuid;
  declared_event jsonb;
  declared_event_count integer;
  definition_release jsonb;
  field_item jsonb;
  field_id_text text;
  previous_field_id_text text;
  field_definition jsonb;
  queued_message_id bigint;
  envelope jsonb;
  envelopes jsonb := '[]'::jsonb;
begin
  if p_storage_contract_id is null or p_storage_contract_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or pg_catalog.jsonb_typeof(p_occurrences) is distinct from 'array'
    or (p_native_proof is not null and p_installation is null) then
    raise exception using errcode = '22023', message = 'Event append input is invalid';
  end if;

  if pg_catalog.jsonb_array_length(p_occurrences) = 0 then
    return envelopes;
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_occurrences) as candidate(value)
    where pg_catalog.jsonb_typeof(candidate.value) is distinct from 'object'
      or not candidate.value ?& array['occurrenceId', 'descriptor', 'payload']
      or candidate.value - array['occurrenceId', 'descriptor', 'payload'] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(candidate.value -> 'occurrenceId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(candidate.value -> 'descriptor') is distinct from 'object'
      or pg_catalog.jsonb_typeof(candidate.value -> 'payload') is distinct from 'object'
  ) then
    raise exception using errcode = '22023', message = 'Event occurrence batch is invalid';
  end if;

  begin
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_occurrences) as candidate(value)
      where (candidate.value ->> 'occurrenceId')::uuid = nil_uuid
    ) or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_array_elements(p_occurrences)
    ) <> (
      select pg_catalog.count(distinct (candidate.value ->> 'occurrenceId')::uuid)
      from pg_catalog.jsonb_array_elements(p_occurrences) as candidate(value)
    ) then
      raise exception using errcode = '22023', message = 'Event occurrence identities are invalid';
    end if;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Event occurrence identities are invalid';
  end;

  if p_native_proof is null then
    context_value := vortex_access.validated_human_request_context();
    if context_value ->> 'callerKind' is distinct from 'human'
      or not context_value ?& array[
        'organizationId', 'applicationRootId', 'organizationAccountId', 'correlationId'
      ] then
      raise exception using errcode = '42501', message = 'Human Application context is required';
    end if;
    context_actor_id := (context_value ->> 'organizationAccountId')::uuid;
    context_organization_id := (context_value ->> 'organizationId')::uuid;
    context_application_root_id := (context_value ->> 'applicationRootId')::uuid;
    context_correlation_id := (context_value ->> 'correlationId')::uuid;
  else
    if pg_catalog.jsonb_typeof(p_native_proof) is distinct from 'object'
      or not p_native_proof ?& array['kind', 'source', 'initiator', 'nativeChange']
      or p_native_proof - array['kind', 'source', 'initiator', 'nativeChange'] <> '{}'::jsonb
      or p_native_proof ->> 'kind' is distinct from 'native-projection-v1'
      or pg_catalog.jsonb_typeof(p_native_proof -> 'source') is distinct from 'object'
      or (p_native_proof -> 'source') - array[
        'protectedReadModelKey', 'readerSchema', 'readerFunction'
      ] <> '{}'::jsonb
      or not (p_native_proof -> 'source') ?& array[
        'protectedReadModelKey', 'readerSchema', 'readerFunction'
      ]
      or pg_catalog.jsonb_typeof(p_native_proof -> 'initiator') is distinct from 'object'
      or (p_native_proof -> 'initiator') - array[
        'kind', 'organizationId', 'organizationAccountId', 'correlationId',
        'accessVersionBefore', 'accessVersionAfter', 'authorityCheckedAt'
      ] <> '{}'::jsonb
      or not (p_native_proof -> 'initiator') ?& array[
        'kind', 'organizationId', 'organizationAccountId', 'correlationId',
        'accessVersionBefore', 'accessVersionAfter', 'authorityCheckedAt'
      ]
      or pg_catalog.jsonb_typeof(p_native_proof -> 'nativeChange') is distinct from 'object'
      or (p_native_proof -> 'nativeChange') - array[
        'operation', 'completedActivityId', 'subjects'
      ] <> '{}'::jsonb
      or not (p_native_proof -> 'nativeChange') ?& array[
        'operation', 'completedActivityId', 'subjects'
      ]
      or pg_catalog.jsonb_typeof(p_native_proof #> '{nativeChange,subjects}') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_native_proof #> '{nativeChange,subjects}') = 0
      or p_native_proof #>> '{initiator,kind}' is distinct from 'human'
      or pg_catalog.jsonb_typeof(p_native_proof #> '{nativeChange,subjects}') is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_native_proof #> '{nativeChange,subjects}') = 0 then
      raise exception using errcode = '42501', message = 'Native Event proof is unavailable';
    end if;
    if pg_catalog.jsonb_typeof(p_native_proof #> '{source,protectedReadModelKey}') is distinct from 'string'
      or pg_catalog.jsonb_typeof(p_native_proof #> '{source,readerSchema}') is distinct from 'string'
      or pg_catalog.jsonb_typeof(p_native_proof #> '{source,readerFunction}') is distinct from 'string'
      or pg_catalog.jsonb_typeof(p_native_proof #> '{initiator,organizationId}') is distinct from 'string'
      or pg_catalog.jsonb_typeof(p_native_proof #> '{initiator,organizationAccountId}') is distinct from 'string'
      or pg_catalog.jsonb_typeof(p_native_proof #> '{initiator,correlationId}') is distinct from 'string'
      or pg_catalog.jsonb_typeof(p_native_proof #> '{initiator,accessVersionBefore}') is distinct from 'number'
      or pg_catalog.jsonb_typeof(p_native_proof #> '{initiator,accessVersionAfter}') is distinct from 'number'
      or pg_catalog.jsonb_typeof(p_native_proof #> '{initiator,authorityCheckedAt}') is distinct from 'string'
      or pg_catalog.jsonb_typeof(p_native_proof #> '{nativeChange,operation}') is distinct from 'string'
      or pg_catalog.jsonb_typeof(p_native_proof #> '{nativeChange,completedActivityId}') is distinct from 'string'
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(p_native_proof #> '{nativeChange,subjects}') as subject(value)
        where pg_catalog.jsonb_typeof(subject.value) is distinct from 'object'
          or not subject.value ?& array[
            'recordId', 'nativeRevision', 'eventKind', 'changedProjectionAttributes'
          ]
          or subject.value - array[
            'recordId', 'nativeRevision', 'eventKind', 'changedProjectionAttributes'
          ] <> '{}'::jsonb
          or pg_catalog.jsonb_typeof(subject.value -> 'recordId') is distinct from 'string'
          or pg_catalog.jsonb_typeof(subject.value -> 'nativeRevision') is distinct from 'number'
          or pg_catalog.jsonb_typeof(subject.value -> 'eventKind') is distinct from 'string'
          or pg_catalog.jsonb_typeof(subject.value -> 'changedProjectionAttributes') is distinct from 'array'
          or not vortex_context.is_non_nil_uuid(subject.value ->> 'recordId')
      ) then
      raise exception using errcode = '42501', message = 'Native Event proof is unavailable';
    end if;
    begin
      context_actor_id := (p_native_proof #>> '{initiator,organizationAccountId}')::uuid;
      context_organization_id := (p_native_proof #>> '{initiator,organizationId}')::uuid;
      context_correlation_id := (p_native_proof #>> '{initiator,correlationId}')::uuid;
      native_before_version := (p_native_proof #>> '{initiator,accessVersionBefore}')::bigint;
      native_after_version := (p_native_proof #>> '{initiator,accessVersionAfter}')::bigint;
      native_activity_id := (p_native_proof #>> '{nativeChange,completedActivityId}')::uuid;
    exception when others then
      raise exception using errcode = '42501', message = 'Native Event proof is unavailable';
    end;
    native_operation := p_native_proof #>> '{nativeChange,operation}';
    if not vortex_context.is_non_nil_uuid(context_actor_id::text)
      or not vortex_context.is_non_nil_uuid(context_organization_id::text)
      or not vortex_context.is_non_nil_uuid(context_correlation_id::text)
      or not vortex_context.is_non_nil_uuid(native_activity_id::text)
      or native_before_version < 0 or native_before_version >= maximum_safe_revision
      or native_after_version is distinct from native_before_version + 1
      or native_after_version > maximum_safe_revision
      or pg_catalog.jsonb_typeof(p_native_proof #> '{initiator,accessVersionBefore}') is distinct from 'number'
      or pg_catalog.jsonb_typeof(p_native_proof #> '{initiator,accessVersionAfter}') is distinct from 'number'
      or pg_catalog.jsonb_typeof(p_native_proof #> '{nativeChange,operation}') is distinct from 'string'
      or native_operation is null or native_operation = '' then
      raise exception using errcode = '42501', message = 'Native Event proof is unavailable';
    end if;
    select pg_catalog.count(*) into registered_source_count
    from vortex_record.protected_read_model_views as registry
    where registry.protected_read_model_key = p_native_proof #>> '{source,protectedReadModelKey}'
      and registry.reader_schema = p_native_proof #>> '{source,readerSchema}'
      and registry.reader_function = p_native_proof #>> '{source,readerFunction}';
    if registered_source_count <> 1 then
      raise exception using errcode = '42501', message = 'Native Event source is unavailable';
    end if;
  end if;
  select catalogue.* into catalogue_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id;
  if not found
    or catalogue_row.state is distinct from 'active'
    or (p_native_proof is null
      and catalogue_row.physical_schema_token is distinct from 'record_data')
    or (p_native_proof is not null and (
      catalogue_row.physical_schema_token is distinct from 'system_projection'
      or catalogue_row.storage_scope is distinct from 'organization_shared'
      or catalogue_row.protected_read_model_key is distinct from
        (p_native_proof #>> '{source,protectedReadModelKey}')
    )) then
    raise exception using errcode = 'P0002', message = 'Event record is unavailable';
  end if;

  -- Coordinate with the approved installation lifecycle writer before trusting
  -- the exact Module binding. The actual generated row is locked below and is
  -- the ordering lock shared by every consuming Application.
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'vortex_module.binding:' || context_organization_id::text || ':' ||
        context_application_root_id::text || ':' || catalogue_row.module_root_id::text,
      0
    )
  );
  -- Installation evidence is resolved here, inside the protected region, and
  -- never before it.  A lifecycle detach that commits while this append waits
  -- for the canonical binding lock above is only observed by a read taken
  -- after that wait: this assignment is its own statement, so in read
  -- committed it sees the committed lifecycle state.  `p_installation` carries
  -- an exact pin-set only from a trusted reader that already resolved it while
  -- holding the same canonical lifecycle lock.
  if p_installation is null then
    if p_native_proof is not null then
      raise exception using errcode = '42501',
        message = 'Native Event installation is unavailable';
    end if;
    installation := vortex_module.read_current_active_installation();
  else
    installation := p_installation;
  end if;
  if p_native_proof is not null then
    if pg_catalog.jsonb_typeof(installation) is distinct from 'object'
      or pg_catalog.jsonb_typeof(installation -> 'applicationRootId') is distinct from 'string' then
      raise exception using errcode = '42501',
        message = 'Native Event installation is unavailable';
    end if;
    begin
      context_application_root_id := (installation ->> 'applicationRootId')::uuid;
    exception when others then
      raise exception using errcode = '42501',
        message = 'Native Event installation is unavailable';
    end;
  end if;
  if installation is null
    or pg_catalog.jsonb_typeof(installation) <> 'object'
    or not installation ?& array[
      'organizationId', 'applicationRootId', 'applicationReleaseRevision',
      'moduleBindings'
    ]
    or (installation ->> 'organizationId')::uuid is distinct from context_organization_id
    or (installation ->> 'applicationRootId')::uuid is distinct from context_application_root_id
    or pg_catalog.jsonb_typeof(installation -> 'moduleBindings') <> 'array' then
    raise exception using errcode = '42501', message = 'Resolved Event installation is unavailable';
  end if;
  application_release_revision :=
    (installation ->> 'applicationReleaseRevision')::bigint;
  -- Module's existing reader has already proved the complete binding set
  -- against the published dependency closure. Read the one exact binding from
  -- that result while its canonical lifecycle lock is held; do not add a
  -- second binding reader or broader cross-owner table grants.
  select pg_catalog.count(*), pg_catalog.jsonb_agg(item.value) -> 0
  into binding_count, binding_value
  from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
  where (item.value ->> 'moduleRootId')::uuid = catalogue_row.module_root_id;
  if binding_count <> 1 then
    raise exception using errcode = '55000', message = 'Installed Event binding is unavailable';
  end if;
  binding_module_root_id := (binding_value ->> 'moduleRootId')::uuid;
  binding_module_release_revision :=
    (binding_value ->> 'moduleReleaseRevision')::bigint;
  binding_revision := (binding_value ->> 'bindingRevision')::bigint;

  select release.* into module_release
  from vortex_definition.releases as release
  where release.root_id = binding_module_root_id
    and release.release_revision = binding_module_release_revision;
  if not found
    or not exists (
      select 1 from vortex_record.release_provisions as provision
      where provision.module_root_id = module_release.root_id
        and provision.release_revision = module_release.release_revision
        and p_storage_contract_id = any (provision.storage_contract_ids)
    ) then
    raise exception using errcode = '55000', message = 'Installed Event storage is unavailable';
  end if;
  module_content := module_release.compilation_output #> '{canonical,content}';

  select pg_catalog.count(*), pg_catalog.jsonb_agg(item.value) -> 0
  into record_type_count, record_type
  from pg_catalog.jsonb_array_elements(module_content -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = catalogue_row.record_type_id;
  if record_type_count <> 1
    or (record_type ->> 'storageContractId')::uuid is distinct from p_storage_contract_id
    or record_type ->> 'storageScope' is distinct from catalogue_row.storage_scope
    or (p_native_proof is not null and (
      record_type #>> '{systemProjection,protectedView}' is distinct from
        (p_native_proof #>> '{source,protectedReadModelKey}')
      or pg_catalog.jsonb_typeof(record_type -> 'systemProjection') is distinct from 'object'
    )) then
    raise exception using errcode = '55000', message = 'Installed Event record type is unavailable';
  end if;

  select release.* into application_release
  from vortex_definition.releases as release
  join vortex_definition.roots as root on root.root_id = release.root_id
  where release.root_id = context_application_root_id
    and release.release_revision = application_release_revision
    and root.organization_id = context_organization_id
    and root.kind = 'application';
  if not found then
    raise exception using errcode = '55000', message = 'Installed Application release is unavailable';
  end if;
  application_content := application_release.compilation_output #> '{canonical,content}';

  if p_native_proof is not null then
    if catalogue_row.storage_scope is distinct from 'organization_shared' then
      raise exception using errcode = '55000',
        message = 'Native Event storage scope is unavailable';
    end if;
    sequence_application_scope_id := null;
    locked_definition_revision := module_release.release_revision;
    locked_record_count := 1;
  elsif catalogue_row.storage_scope = 'organization_shared' then
    sequence_application_scope_id := null;
    locked_definition_revision := null;
    execute pg_catalog.format(
      'select stored.definition_revision
       from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.application_root_id is null
       for update',
      catalogue_row.physical_table_token
    ) into locked_definition_revision
    using context_organization_id, p_record_id;
    get diagnostics locked_record_count = row_count;
  else
    sequence_application_scope_id := context_application_root_id;
    locked_definition_revision := null;
    execute pg_catalog.format(
      'select stored.definition_revision
       from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.application_root_id = $3
       for update',
      catalogue_row.physical_table_token
    ) into locked_definition_revision
    using context_organization_id, p_record_id, context_application_root_id;
    get diagnostics locked_record_count = row_count;
  end if;
  if locked_record_count <> 1 or locked_definition_revision is null
    or locked_definition_revision < catalogue_row.first_compatible_release_revision
    or (catalogue_row.last_compatible_release_revision is not null
      and locked_definition_revision > catalogue_row.last_compatible_release_revision) then
    raise exception using errcode = 'P0002', message = 'Event record is unavailable';
  end if;

  if p_native_proof is not null then
    select pg_catalog.count(*), pg_catalog.jsonb_agg(subject.value) -> 0
    into native_subject_count, native_subject
    from pg_catalog.jsonb_array_elements(p_native_proof #> '{nativeChange,subjects}') as subject(value)
    where (subject.value ->> 'recordId')::uuid = p_record_id;
    if native_subject_count <> 1
      or pg_catalog.jsonb_typeof(native_subject -> 'nativeRevision') is distinct from 'number'
      or pg_catalog.jsonb_typeof(native_subject -> 'eventKind') is distinct from 'string'
      or pg_catalog.jsonb_typeof(native_subject -> 'changedProjectionAttributes') is distinct from 'array' then
      raise exception using errcode = '42501', message = 'Native Event subject is unavailable';
    end if;
    begin
      native_record_revision := (native_subject ->> 'nativeRevision')::bigint;
    exception when others then
      raise exception using errcode = '42501', message = 'Native Event subject is unavailable';
    end;
    native_event_kind := native_subject ->> 'eventKind';
    native_changed_attributes := native_subject -> 'changedProjectionAttributes';
    if native_record_revision < 1 or native_record_revision > maximum_safe_revision
      or native_event_kind not in ('created', 'changed')
      or pg_catalog.jsonb_typeof(native_subject -> 'eventKind') is distinct from 'string'
      or (native_event_kind = 'created' and native_changed_attributes <> '[]'::jsonb)
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(native_changed_attributes) as attribute(value)
        where pg_catalog.jsonb_typeof(attribute.value) is distinct from 'string'
      )
      or (select pg_catalog.count(*)
        from pg_catalog.jsonb_array_elements(native_changed_attributes))
        <> (select pg_catalog.count(distinct attribute.value #>> '{}')
          from pg_catalog.jsonb_array_elements(native_changed_attributes) as attribute(value)) then
      raise exception using errcode = '42501', message = 'Native Event subject is unavailable';
    end if;

    native_revision_field_id := (record_type #>> '{systemProjection,revisionFieldId}')::uuid;
    native_organization_field_id := (record_type #>> '{systemProjection,organizationFieldId}')::uuid;
    if not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
      where (field.value ->> 'fieldId')::uuid = native_revision_field_id
        and field.value ->> 'key' = 'revision'
        and field.value ->> 'required' = 'true'
    ) or not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
      where (field.value ->> 'fieldId')::uuid = native_organization_field_id
        and field.value ->> 'key' = 'organization_id'
    ) then
      raise exception using errcode = '55000',
        message = 'Installed system projection revision field is unavailable';
    end if;
    if native_event_kind = 'changed' then
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
        where field.value ->> 'key' in (
            select attribute.value #>> '{}'
            from pg_catalog.jsonb_array_elements(native_changed_attributes) as attribute(value)
          )
          and (field.value ->> 'fieldId')::uuid not in (
            native_organization_field_id, native_revision_field_id
          )
          and field.value ->> 'personalData' is distinct from 'none'
      ) then
        raise exception using errcode = '55000',
          message = 'Installed system projection fields are incompatible';
      end if;
      select coalesce(pg_catalog.array_agg(field_id order by field_id), array[]::uuid[])
      into native_expected_field_ids
      from (
        select distinct (field.value ->> 'fieldId')::uuid as field_id
        from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
        where (field.value ->> 'fieldId')::uuid = native_revision_field_id
          or (
            field.value ->> 'key' in (
              select attribute.value #>> '{}'
              from pg_catalog.jsonb_array_elements(native_changed_attributes) as attribute(value)
            )
            and (field.value ->> 'fieldId')::uuid not in (
              native_organization_field_id, native_revision_field_id
            )
            and field.value ->> 'personalData' = 'none'
          )
      ) as selected;
      if not (native_revision_field_id = any (native_expected_field_ids)) then
        raise exception using errcode = '55000',
          message = 'Installed system projection revision field is unavailable';
      end if;
    else
      native_expected_field_ids := array[]::uuid[];
    end if;
    select coalesce(
      pg_catalog.jsonb_agg(field_id::text order by field_id), '[]'::jsonb
    ) into native_expected_field_ids_json
    from pg_catalog.unnest(native_expected_field_ids) as item(field_id);

    if pg_catalog.jsonb_array_length(p_occurrences) <> 1 then
      raise exception using errcode = '42501',
        message = 'Native Event occurrence is unavailable';
    end if;
    native_occurrence := p_occurrences -> 0;
    if native_occurrence -> 'descriptor' is distinct from pg_catalog.jsonb_build_object(
        'kind', 'standard',
        'eventKind', native_event_kind,
        'recordTypeId', catalogue_row.record_type_id
      )
      or (native_event_kind = 'created'
        and native_occurrence -> 'payload' is distinct from
          pg_catalog.jsonb_build_object('kind', 'created'))
      or (native_event_kind = 'changed'
        and native_occurrence -> 'payload' is distinct from pg_catalog.jsonb_build_object(
          'kind', 'changed', 'changedFieldIds', native_expected_field_ids_json
        )) then
      raise exception using errcode = '42501',
        message = 'Native Event occurrence is unavailable';
    end if;
  end if;

  select coalesce(pg_catalog.max(stored.record_sequence), 0) + 1
  into next_sequence
  from vortex_event.event_outbox as stored
  where stored.organization_id = context_organization_id
    and stored.storage_contract_id = p_storage_contract_id
    and stored.sequence_application_root_id is not distinct from
      sequence_application_scope_id
    and stored.record_id = p_record_id;
  if next_sequence + pg_catalog.jsonb_array_length(p_occurrences) - 1 >
      maximum_safe_revision then
    raise exception using errcode = '22003', message = 'Event record sequence is exhausted';
  end if;

  occurrence_time_text := vortex_context.format_timestamp_utc(occurrence_time);

  for occurrence_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_occurrences) with ordinality as item(value, ordinal)
    order by item.ordinal
  loop
    occurrence_id := (occurrence_item ->> 'occurrenceId')::uuid;
    descriptor := occurrence_item -> 'descriptor';
    payload := occurrence_item -> 'payload';

    if descriptor ->> 'kind' = 'standard' then
      if not descriptor ?& array['kind', 'eventKind', 'recordTypeId']
        or descriptor - array['kind', 'eventKind', 'recordTypeId'] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(descriptor -> 'eventKind') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'recordTypeId') is distinct from 'string'
        or (descriptor ->> 'recordTypeId')::uuid is distinct from catalogue_row.record_type_id
        or descriptor ->> 'eventKind' is null
        or descriptor ->> 'eventKind' not in (
          'created', 'changed', 'deleted', 'linked', 'unlinked', 'reassigned',
          'state_changed'
        ) then
        raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
      end if;
      event_kind := descriptor ->> 'eventKind';

      if event_kind = 'changed' then
        if not payload ?& array['kind', 'changedFieldIds']
          or payload - array['kind', 'changedFieldIds'] <> '{}'::jsonb
          or payload ->> 'kind' is distinct from event_kind
          or pg_catalog.jsonb_typeof(payload -> 'changedFieldIds') is distinct from 'array'
          or pg_catalog.jsonb_array_length(payload -> 'changedFieldIds') = 0 then
          raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
        end if;
        previous_field_id_text := null;
        for field_item in
          select item.value
          from pg_catalog.jsonb_array_elements(payload -> 'changedFieldIds')
            with ordinality as item(value, ordinal)
          order by item.ordinal
        loop
          if pg_catalog.jsonb_typeof(field_item) is distinct from 'string' then
            raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
          end if;
          field_id_text := pg_catalog.lower(field_item #>> '{}');
          if previous_field_id_text is not null
              and previous_field_id_text >= field_id_text
            or not exists (
              select 1 from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
              where pg_catalog.lower(field.value ->> 'fieldId') = field_id_text
            ) then
            raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
          end if;
          previous_field_id_text := field_id_text;
        end loop;
      elsif event_kind = 'state_changed' then
        if not payload ?& array['kind', 'fieldId']
          or payload - array['kind', 'fieldId', 'previousValue', 'newValue'] <> '{}'::jsonb
          or payload ->> 'kind' is distinct from event_kind
          or pg_catalog.jsonb_typeof(payload -> 'fieldId') is distinct from 'string' then
          raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
        end if;
        select field.value into field_definition
        from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
        where (field.value ->> 'fieldId')::uuid = (payload ->> 'fieldId')::uuid;
        if not found
          or (field_definition ->> 'personalData' = 'none'
            and not (payload ? 'previousValue' or payload ? 'newValue'))
          or (field_definition ->> 'personalData' <> 'none'
            and (payload ? 'previousValue' or payload ? 'newValue')) then
          raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
        end if;
      elsif payload <> pg_catalog.jsonb_build_object('kind', event_kind) then
        raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
      end if;

      definition_release := pg_catalog.jsonb_build_object(
        'kind', 'module',
        'rootId', module_release.root_id,
        'releaseRevision', module_release.release_revision,
        'releaseVersion', module_release.release_version,
        'contentFingerprint', module_release.content_fingerprint,
        'resolutionFingerprint', module_release.resolution_fingerprint
      );
    elsif descriptor ->> 'kind' = 'declared' then
      if not descriptor ?& array[
          'kind', 'owner', 'declarationId', 'key', 'recordTypeId', 'carriedFieldIds'
        ]
        or descriptor - array[
          'kind', 'owner', 'declarationId', 'key', 'recordTypeId', 'carriedFieldIds'
        ] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(descriptor -> 'owner') is distinct from 'object'
        or pg_catalog.jsonb_typeof(descriptor -> 'declarationId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'key') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'recordTypeId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(descriptor -> 'carriedFieldIds') is distinct from 'array'
        or (descriptor ->> 'recordTypeId')::uuid is distinct from catalogue_row.record_type_id then
        raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
      end if;

      owner_kind := descriptor #>> '{owner,kind}';
      if owner_kind = 'application'
        and (descriptor -> 'owner') - array['kind', 'applicationRootId'] = '{}'::jsonb
        and (descriptor -> 'owner') ?& array['kind', 'applicationRootId']
        and pg_catalog.jsonb_typeof(
          descriptor #> '{owner,applicationRootId}'
        ) is not distinct from 'string' then
        owner_root_id := (descriptor #>> '{owner,applicationRootId}')::uuid;
        if owner_root_id <> context_application_root_id then
          raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
        end if;
        select pg_catalog.count(*), pg_catalog.jsonb_agg(event.value) -> 0
        into declared_event_count, declared_event
        from pg_catalog.jsonb_array_elements(application_content -> 'events') as event(value)
        where (event.value ->> 'eventId')::uuid = (descriptor ->> 'declarationId')::uuid
          and event.value ->> 'key' = descriptor ->> 'key';
        definition_release := pg_catalog.jsonb_build_object(
          'kind', 'application',
          'rootId', application_release.root_id,
          'releaseRevision', application_release.release_revision,
          'releaseVersion', application_release.release_version,
          'contentFingerprint', application_release.content_fingerprint,
          'resolutionFingerprint', application_release.resolution_fingerprint
        );
      elsif owner_kind = 'module'
        and (descriptor -> 'owner') - array['kind', 'moduleRootId'] = '{}'::jsonb
        and (descriptor -> 'owner') ?& array['kind', 'moduleRootId']
        and pg_catalog.jsonb_typeof(
          descriptor #> '{owner,moduleRootId}'
        ) is not distinct from 'string' then
        owner_root_id := (descriptor #>> '{owner,moduleRootId}')::uuid;
        if owner_root_id <> module_release.root_id then
          raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
        end if;
        select pg_catalog.count(*), pg_catalog.jsonb_agg(event.value) -> 0
        into declared_event_count, declared_event
        from pg_catalog.jsonb_array_elements(module_content -> 'events') as event(value)
        where (event.value ->> 'eventId')::uuid = (descriptor ->> 'declarationId')::uuid
          and event.value ->> 'key' = descriptor ->> 'key';
        definition_release := pg_catalog.jsonb_build_object(
          'kind', 'module',
          'rootId', module_release.root_id,
          'releaseRevision', module_release.release_revision,
          'releaseVersion', module_release.release_version,
          'contentFingerprint', module_release.content_fingerprint,
          'resolutionFingerprint', module_release.resolution_fingerprint
        );
      else
        raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
      end if;

      if declared_event_count <> 1
        or (declared_event ->> 'recordTypeId')::uuid <> catalogue_row.record_type_id
        or declared_event -> 'carriedFieldIds' is distinct from
          descriptor -> 'carriedFieldIds'
        or declared_event -> 'personalOrSensitiveValuesAllowed' is distinct from
          'false'::jsonb
        or not payload ?& array['kind', 'carriedValues']
        or payload - array['kind', 'carriedValues'] <> '{}'::jsonb
        or payload ->> 'kind' is distinct from 'declared'
        or pg_catalog.jsonb_typeof(payload -> 'carriedValues') is distinct from 'object' then
        raise exception using errcode = '22023', message = 'Installed Event declaration is invalid';
      end if;

      if exists (
        select 1
        from pg_catalog.jsonb_each(payload -> 'carriedValues') as carried(field_id, value)
        where not (descriptor -> 'carriedFieldIds') ? carried.field_id
          or not exists (
            select 1
            from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
            where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(carried.field_id)
              and field.value ->> 'personalData' = 'none'
          )
      ) then
        raise exception using errcode = '22023', message = 'Installed Event payload is invalid';
      end if;
    else
      raise exception using errcode = '22023', message = 'Installed Event descriptor is invalid';
    end if;

    envelope := pg_catalog.jsonb_build_object(
      'contractVersion', '2.0.0',
      'occurrenceId', occurrence_id,
      'organizationId', context_organization_id,
      'installation', pg_catalog.jsonb_build_object(
        'applicationRootId', context_application_root_id,
        'applicationReleaseRevision', application_release_revision,
        'moduleBinding', pg_catalog.jsonb_build_object(
          'moduleRootId', binding_module_root_id,
          'moduleReleaseRevision', binding_module_release_revision,
          'bindingRevision', binding_revision
        )
      ),
      'descriptor', descriptor,
      'definitionRelease', definition_release,
      'recordId', p_record_id,
      'occurredAt', occurrence_time_text,
      'actorId', context_actor_id,
      'correlationId', context_correlation_id,
      'recordSequence', next_sequence,
      'payload', payload
    );

    insert into vortex_event.event_outbox (
      occurrence_id, organization_id, storage_contract_id, storage_scope,
      sequence_application_root_id, record_id, record_sequence, occurred_at,
      envelope
    ) values (
      occurrence_id, context_organization_id, p_storage_contract_id,
      catalogue_row.storage_scope, sequence_application_scope_id, p_record_id,
      next_sequence, occurrence_time, envelope
    );

    select sent.msg_id into strict queued_message_id
    from pgmq.send(
      'vortex_event_occurrences',
      pg_catalog.jsonb_build_object(
        'contractVersion', '2.0.0', 'occurrenceId', occurrence_id
      )
    ) as sent(msg_id);
    if queued_message_id is null then
      raise exception using errcode = '55000', message = 'Event queue append failed';
    end if;

    envelopes := envelopes || pg_catalog.jsonb_build_array(envelope);
    next_sequence := next_sequence + 1;
  end loop;

  return envelopes;
end
$function$;

alter function vortex_event.append_record_occurrences_with_native_proof_internal(
  uuid, uuid, jsonb, jsonb, jsonb
) owner to postgres;
revoke all on function vortex_event.append_record_occurrences_with_native_proof_internal(
  uuid, uuid, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_event_owner, vortex_module_owner, vortex_definition_owner,
  vortex_record_owner, vortex_record_adapter;
comment on function vortex_event.append_record_occurrences_with_native_proof_internal(
  uuid, uuid, jsonb, jsonb, jsonb
) is
  'Appends validated record occurrences through the shared Event implementation; its postgres-only native proof branch supports read-only system projections without locking generated views, while the NULL-proof path preserves physical record validation.';


create or replace function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  p_storage_contract_id uuid,
  p_record_id uuid,
  p_occurrences jsonb,
  p_installation jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  return vortex_event.append_record_occurrences_with_native_proof_internal(
    p_storage_contract_id,
    p_record_id,
    p_occurrences,
    p_installation,
    null::jsonb
  );
end
$function$;

alter function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
) owner to postgres;
revoke all on function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter;
grant execute on function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
) to vortex_event_owner;
comment on function vortex_event.append_record_occurrences_for_resolved_installation_internal(
  uuid, uuid, jsonb, jsonb
) is
  'Appends an exact validated record occurrence batch through the shared Event implementation; this compatibility wrapper always supplies NULL native proof, so installation JSON cannot enter the system-projection path.';

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
          if exists (
            select 1
            from pg_catalog.jsonb_array_elements(record_type -> 'fields') as field(value)
            where field.value ->> 'key' in (
                select attribute.value #>> '{}'
                from pg_catalog.jsonb_array_elements(changed_attributes) as attribute(value)
              )
              and (field.value ->> 'fieldId')::uuid not in (
                organization_field_id, revision_field_id
              )
              and field.value ->> 'personalData' is distinct from 'none'
          ) then
            raise exception using errcode = '55000',
              message = 'Installed system projection fields are incompatible';
          end if;
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
                and field.value ->> 'personalData' = 'none'
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


create or replace function vortex_access.append_organization_group_membership_events_internal(
  p_operation text,
  p_captured_initiator jsonb,
  p_native_subjects jsonb,
  p_completed_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  maximum_safe_revision constant bigint := 9007199254740991;
  organization_id_value uuid;
  account_id_value uuid;
  correlation_id_value uuid;
  before_version bigint;
  after_version bigint;
  authority_checked_at timestamptz;
  version_row vortex_access.organization_access_versions%rowtype;
  activity_row vortex_activity.organization_activity_entries%rowtype;
  source_schema text;
  source_function text;
  expected_activity_action text;
  expected_subject_count integer;
  subject_item jsonb;
  subject_role text;
  subject_id uuid;
  subject_revision bigint;
  subject_ids uuid[] := array[]::uuid[];
  membership_fact vortex_access.organization_group_memberships%rowtype;
  renewal_group_id uuid;
  renewal_account_id uuid;
  expected_state text;
  event_kind text;
  changed_attributes jsonb;
  proof_subjects jsonb := '[]'::jsonb;
  native_proof jsonb;
begin
  if p_operation is null or p_operation not in (
      'add_membership', 'remove_membership', 'restore_membership',
      'renew_membership'
    )
    or p_completed_activity_id is null or p_completed_activity_id = nil_uuid
    or pg_catalog.jsonb_typeof(p_captured_initiator) is distinct from 'object'
    or not p_captured_initiator ?& array[
      'kind', 'organizationId', 'organizationAccountId', 'correlationId',
      'accessVersionBefore', 'authorityCheckedAt'
    ]
    or p_captured_initiator - array[
      'kind', 'organizationId', 'organizationAccountId', 'correlationId',
      'accessVersionBefore', 'authorityCheckedAt'
    ] <> '{}'::jsonb
    or p_captured_initiator ->> 'kind' is distinct from 'human'
    or pg_catalog.jsonb_typeof(p_captured_initiator -> 'organizationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_captured_initiator -> 'organizationAccountId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_captured_initiator -> 'correlationId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_captured_initiator -> 'accessVersionBefore') is distinct from 'number'
    or pg_catalog.jsonb_typeof(p_captured_initiator -> 'authorityCheckedAt') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_native_subjects) is distinct from 'array' then
    raise exception using errcode = '22023',
      message = 'Group membership Event input is invalid';
  end if;

  begin
    organization_id_value := (p_captured_initiator ->> 'organizationId')::uuid;
    account_id_value := (p_captured_initiator ->> 'organizationAccountId')::uuid;
    correlation_id_value := (p_captured_initiator ->> 'correlationId')::uuid;
    before_version := (p_captured_initiator ->> 'accessVersionBefore')::bigint;
    authority_checked_at := (p_captured_initiator ->> 'authorityCheckedAt')::timestamptz;
  exception when others then
    raise exception using errcode = '22023',
      message = 'Group membership Event initiator is invalid';
  end;

  if not vortex_context.is_non_nil_uuid(organization_id_value::text)
    or not vortex_context.is_non_nil_uuid(account_id_value::text)
    or not vortex_context.is_non_nil_uuid(correlation_id_value::text)
    or before_version < 0 or before_version >= maximum_safe_revision
    or authority_checked_at is null
    or authority_checked_at in ('-infinity'::timestamptz, 'infinity'::timestamptz) then
    raise exception using errcode = '22023',
      message = 'Group membership Event initiator is invalid';
  end if;

  expected_subject_count := case when p_operation = 'renew_membership' then 2 else 1 end;
  if pg_catalog.jsonb_array_length(p_native_subjects) <> expected_subject_count
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_native_subjects) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not item.value ?& array['role', 'membershipId', 'revision']
        or item.value - array['role', 'membershipId', 'revision'] <> '{}'::jsonb
        or pg_catalog.jsonb_typeof(item.value -> 'role') is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'membershipId') is distinct from 'string'
        or pg_catalog.jsonb_typeof(item.value -> 'revision') is distinct from 'number'
    ) then
    raise exception using errcode = '22023',
      message = 'Group membership Event subjects are invalid';
  end if;

  begin
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_native_subjects) as item(value)
      where not vortex_context.is_non_nil_uuid(item.value ->> 'membershipId')
        or (item.value ->> 'revision')::bigint < 1
        or (item.value ->> 'revision')::bigint > maximum_safe_revision
    ) then
      raise exception using errcode = '22023',
        message = 'Group membership Event subjects are invalid';
    end if;
  exception when others then
    raise exception using errcode = '22023',
      message = 'Group membership Event subjects are invalid';
  end;

  if exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_native_subjects) as item(value)
      where case p_operation
        when 'renew_membership' then item.value ->> 'role' not in (
          'predecessor', 'replacement'
        )
        else item.value ->> 'role' is distinct from 'membership'
      end
    )
    or (
      select pg_catalog.count(distinct (item.value ->> 'membershipId')::uuid)
      from pg_catalog.jsonb_array_elements(p_native_subjects) as item(value)
    ) <> expected_subject_count
    or (p_operation = 'renew_membership' and (
      (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(p_native_subjects) as item(value)
        where item.value ->> 'role' = 'predecessor') <> 1
      or (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(p_native_subjects) as item(value)
        where item.value ->> 'role' = 'replacement') <> 1
    )) then
    raise exception using errcode = '22023',
      message = 'Group membership Event subjects are invalid';
  end if;

  select registry.reader_schema, registry.reader_function
  into source_schema, source_function
  from vortex_record.protected_read_model_views as registry
  where registry.protected_read_model_key = 'people';
  if not found or source_schema is distinct from 'vortex_access'
    or source_function is distinct from 'list_organization_group_memberships_projection' then
    raise exception using errcode = '55000',
      message = 'Group membership projection source is unavailable';
  end if;

  select version.* into version_row
  from vortex_access.organization_access_versions as version
  where version.organization_id = organization_id_value
  for update;
  if not found then
    raise exception using errcode = '40001',
      message = 'Group membership Event Access evidence is stale';
  end if;
  after_version := version_row.current_version;
  if after_version is distinct from before_version + 1
    or version_row.current_version > maximum_safe_revision
    or version_row.changed_by is distinct from account_id_value
    or version_row.change_correlation_id is distinct from correlation_id_value
    or version_row.change_reason is distinct from 'group_membership_changed' then
    raise exception using errcode = '40001',
      message = 'Group membership Event Access evidence is stale';
  end if;

  expected_activity_action := case p_operation
    when 'add_membership' then 'add_group_membership'
    when 'remove_membership' then 'remove_group_membership'
    else p_operation
  end;
  select entry.* into activity_row
  from vortex_activity.organization_activity_entries as entry
  where entry.organization_id = organization_id_value
    and entry.activity_id = p_completed_activity_id;
  if not found
    or activity_row.outcome is distinct from 'completed'
    or activity_row.actor_kind is distinct from 'organization_account'
    or activity_row.actor_id is distinct from account_id_value
    or activity_row.correlation_id is distinct from correlation_id_value
    or activity_row.action is distinct from expected_activity_action
    or pg_catalog.cardinality(activity_row.subject_ids) <> expected_subject_count then
    raise exception using errcode = '40001',
      message = 'Group membership Event Activity is unavailable';
  end if;

  for subject_item in
    select item.value
    from pg_catalog.jsonb_array_elements(p_native_subjects) as item(value)
    order by (item.value ->> 'membershipId')::uuid
  loop
    subject_role := subject_item ->> 'role';
    subject_id := (subject_item ->> 'membershipId')::uuid;
    subject_revision := (subject_item ->> 'revision')::bigint;
    subject_ids := pg_catalog.array_append(subject_ids, subject_id);

    select membership.* into membership_fact
    from vortex_access.organization_group_memberships as membership
    where membership.organization_id = organization_id_value
      and membership.membership_id = subject_id
    for update;
    if not found
      or membership_fact.revision is distinct from subject_revision
      or membership_fact.changed_by is distinct from account_id_value
      or membership_fact.change_correlation_id is distinct from correlation_id_value then
      raise exception using errcode = '40001',
        message = 'Group membership Event subject is stale';
    end if;

    expected_state := case
      when p_operation = 'remove_membership' then 'revoked'
      when p_operation = 'renew_membership' and subject_role = 'predecessor' then 'revoked'
      else 'live'
    end;
    if membership_fact.state is distinct from expected_state then
      raise exception using errcode = '40001',
        message = 'Group membership Event subject is stale';
    end if;

    if p_operation = 'renew_membership' then
      if renewal_group_id is null then
        renewal_group_id := membership_fact.group_id;
        renewal_account_id := membership_fact.organization_account_id;
      elsif membership_fact.group_id is distinct from renewal_group_id
        or membership_fact.organization_account_id is distinct from renewal_account_id then
        raise exception using errcode = '40001',
          message = 'Group membership Event renewal is inconsistent';
      end if;
    end if;

    event_kind := case
      when p_operation = 'add_membership' then 'created'
      when p_operation = 'renew_membership' and subject_role = 'replacement' then 'created'
      else 'changed'
    end;
    changed_attributes := case when event_kind = 'created'
      then '[]'::jsonb else '["state", "temporal_state"]'::jsonb end;
    proof_subjects := proof_subjects || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordId', subject_id,
        'nativeRevision', subject_revision,
        'eventKind', event_kind,
        'changedProjectionAttributes', changed_attributes
      )
    );
  end loop;

  if not (activity_row.subject_ids @> subject_ids)
    or not (subject_ids @> activity_row.subject_ids) then
    raise exception using errcode = '40001',
      message = 'Group membership Event Activity is inconsistent';
  end if;

  native_proof := pg_catalog.jsonb_build_object(
    'kind', 'native-projection-v1',
    'source', pg_catalog.jsonb_build_object(
      'protectedReadModelKey', 'people',
      'readerSchema', source_schema,
      'readerFunction', source_function
    ),
    'initiator', pg_catalog.jsonb_build_object(
      'kind', 'human',
      'organizationId', organization_id_value,
      'organizationAccountId', account_id_value,
      'correlationId', correlation_id_value,
      'accessVersionBefore', before_version,
      'accessVersionAfter', after_version,
      'authorityCheckedAt', vortex_context.format_timestamp_utc(authority_checked_at)
    ),
    'nativeChange', pg_catalog.jsonb_build_object(
      'operation', p_operation,
      'completedActivityId', p_completed_activity_id,
      'subjects', proof_subjects
    )
  );

  perform vortex_event.append_system_projection_occurrences_internal(native_proof);
  return native_proof;
end
$function$;

alter function vortex_access.append_organization_group_membership_events_internal(
  text, jsonb, jsonb, uuid
) owner to postgres;
revoke all on function vortex_access.append_organization_group_membership_events_internal(
  text, jsonb, jsonb, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_event_owner, vortex_module_owner, vortex_definition_owner,
  vortex_record_owner, vortex_record_adapter;
comment on function vortex_access.append_organization_group_membership_events_internal(
  text, jsonb, jsonb, uuid
) is
  'Validates one completed human Group membership transaction and mints a closed native proof from retained Access-version, Activity, and membership facts before appending installed system projection occurrences.';


create or replace function vortex_access.coordinate_private_organization_group_membership_change(
  p_operation text,
  p_membership_id uuid,
  p_expected_membership_revision bigint,
  p_group_id uuid,
  p_organization_account_id uuid,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_replacement_membership_id uuid,
  p_activity_id uuid
)
returns table (
  outcome text,
  operation text,
  membership jsonb,
  closed_predecessor jsonb,
  access_version bigint,
  correlation_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  authority_checked_at timestamptz;
  target_group_id uuid;
  membership_fact vortex_access.organization_group_memberships%rowtype;
  authority_after jsonb;
  authority_requirement jsonb;
  decision record;
  changed record;
  activity_result text;
  subject_ids uuid[];
  operation_key text;
begin
  if p_operation is null
    or p_operation not in ('add_membership', 'restore_membership', 'renew_membership')
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Private Organization Group membership input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Private Organization Group membership change is unavailable';
  end if;

  if p_operation = 'add_membership' then
    target_group_id := p_group_id;
  else
    select stored.* into membership_fact
    from vortex_access.organization_group_memberships as stored
    where stored.organization_id = context_organization_id
      and stored.membership_id = p_membership_id
    for update;
    if not found
      or membership_fact.revision is distinct from p_expected_membership_revision
      or (p_operation = 'restore_membership' and membership_fact.state <> 'revoked')
      or (p_operation = 'renew_membership' and membership_fact.state <> 'live') then
      raise exception using errcode = '40001',
        message = 'Private Organization Group membership change is stale or unavailable';
    end if;
    target_group_id := membership_fact.group_id;
  end if;

  perform 1
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = context_organization_id
    and organization_group.group_id = target_group_id
    and organization_group.state = 'active'
  for update;
  if not found then
    raise exception using errcode = '40001',
      message = 'Private Organization Group membership source is unavailable';
  end if;

  authority_after := vortex_access.organization_group_reduction_authority(
    context_organization_id, target_group_id
  );
  authority_requirement := case authority_after ->> 'kind'
    when 'none' then pg_catalog.jsonb_build_object('kind', 'permission')
    else pg_catalog.jsonb_build_object(
      'kind', 'delegated_management',
      'before', pg_catalog.jsonb_build_object('kind', 'none'),
      'after', authority_after
    )
  end;
  operation_key := 'platform.organization.group_memberships.' ||
    case p_operation
      when 'add_membership' then 'add'
      when 'restore_membership' then 'restore'
      else 'renew'
    end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', operation_key,
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '6185dc64-464b-4776-97dc-c64a6f299550'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', authority_requirement
    )
  ) as evaluated;
  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from operation_key
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Private Organization Group membership change is unavailable';
  end if;

  authority_checked_at := decision.checked_at;

  select result.* into strict changed
  from vortex_access.coordinate_organization_group_membership_change(
    p_operation, context_organization_id, p_membership_id,
    p_expected_membership_revision, p_group_id, p_organization_account_id,
    p_starts_at, p_expires_at, p_replacement_membership_id,
    context_account_id, context_correlation_id
  ) as result;

  subject_ids := case when p_operation = 'renew_membership'
    then array[p_membership_id, p_replacement_membership_id]::uuid[]
    else array[p_membership_id]::uuid[] end;
  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.membership ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, p_operation,
    subject_ids, array[]::uuid[], vortex_context.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Private Organization Group membership Activity is stale';
  end if;

  perform vortex_access.append_organization_group_membership_events_internal(
    p_operation,
    pg_catalog.jsonb_build_object(
      'kind', 'human',
      'organizationId', context_organization_id,
      'organizationAccountId', context_account_id,
      'correlationId', context_correlation_id,
      'accessVersionBefore', context_access_version,
      'authorityCheckedAt', vortex_context.format_timestamp_utc(authority_checked_at)
    ),
    case when p_operation = 'renew_membership' then pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'role', 'predecessor',
        'membershipId', (changed.closed_predecessor ->> 'membershipId')::uuid,
        'revision', (changed.closed_predecessor ->> 'revision')::bigint
      ),
      pg_catalog.jsonb_build_object(
        'role', 'replacement',
        'membershipId', (changed.membership ->> 'membershipId')::uuid,
        'revision', (changed.membership ->> 'revision')::bigint
      )
    ) else pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'role', 'membership',
      'membershipId', (changed.membership ->> 'membershipId')::uuid,
      'revision', (changed.membership ->> 'revision')::bigint
    )) end,
    p_activity_id
  );

  return query select changed.outcome, changed.operation, changed.membership,
    changed.closed_predecessor, changed.access_version, changed.correlation_id;
end
$function$;

revoke execute on function vortex_access.coordinate_private_organization_group_membership_change(text, uuid, bigint, uuid, uuid, timestamptz, timestamptz, uuid, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_access.coordinate_private_organization_group_membership_change(text, uuid, bigint, uuid, uuid, timestamptz, timestamptz, uuid, uuid) is
  'Owner-only governed add, restore or renew Group membership composition for the later verified IAM action; it has no request-role grant.';


create or replace function vortex_access.add_organization_group_membership_for_administration(
  p_membership_id uuid,
  p_group_id uuid,
  p_organization_account_id uuid,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  membership_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  group_fact vortex_access.organization_groups%rowtype;
  authority_after jsonb;
  authority_requirement jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  checked_at timestamptz;
  authority_checked_at timestamptz;
  activity_result text;
begin
  if p_membership_id is null
    or p_membership_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_group_id is null
    or p_group_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_account_id is null
    or p_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_starts_at is null
    or p_starts_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or p_expires_at in ('-infinity'::timestamptz, 'infinity'::timestamptz)
    or (p_expires_at is not null and p_expires_at <= p_starts_at)
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group membership addition input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization Group membership addition is unavailable';
  end if;

  select organization_group.* into group_fact
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = context_organization_id
    and organization_group.group_id = p_group_id
  for update;
  if not found or group_fact.state <> 'active' then
    raise exception using errcode = '40001',
      message = 'Organization Group membership addition is stale or unavailable';
  end if;

  authority_after := vortex_access.organization_group_reduction_authority(
    context_organization_id, p_group_id
  );
  authority_requirement := case authority_after ->> 'kind'
    when 'none' then pg_catalog.jsonb_build_object('kind', 'permission')
    else pg_catalog.jsonb_build_object(
      'kind', 'delegated_management',
      'before', pg_catalog.jsonb_build_object('kind', 'none'),
      'after', authority_after
    )
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.group_memberships.add',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '6185dc64-464b-4776-97dc-c64a6f299550'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', authority_requirement
    )
  ) as evaluated;

  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.group_memberships.add'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_activity.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'add_group_membership',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_context.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization Group membership addition refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.group_memberships.add'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization Group membership addition is unavailable';
  end if;

  authority_checked_at := decision.checked_at;

  select result.* into strict changed
  from vortex_access.coordinate_organization_group_membership_change(
    'add_membership', context_organization_id, p_membership_id,
    null, p_group_id, p_organization_account_id, p_starts_at, p_expires_at,
    null, context_account_id, context_correlation_id
  ) as result;

  checked_at := pg_catalog.clock_timestamp();
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'membershipId', membership.membership_id,
    'groupId', membership.group_id,
    'organizationAccountId', membership.organization_account_id,
    'accountDisplayName', account.display_name,
    'revision', membership.revision,
    'startsAt', membership.starts_at,
    'expiresAt', membership.expires_at,
    'state', membership.state,
    'temporalState', case
      when membership.state = 'revoked' then 'revoked'
      when membership.starts_at > checked_at then 'scheduled'
      when membership.expires_at is not null
        and membership.expires_at <= checked_at then 'expired'
      else 'active'
    end
  )) into strict changed_summary
  from vortex_access.organization_group_memberships as membership
  join vortex_identity.organization_accounts as account
    on account.organization_id = membership.organization_id
    and account.organization_account_id = membership.organization_account_id
  where membership.organization_id = context_organization_id
    and membership.membership_id = p_membership_id;

  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.membership ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, 'add_group_membership',
    array[p_membership_id]::uuid[], array[]::uuid[], vortex_context.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization Group membership addition Activity is stale';
  end if;

  perform vortex_access.append_organization_group_membership_events_internal(
    'add_membership',
    pg_catalog.jsonb_build_object(
      'kind', 'human',
      'organizationId', context_organization_id,
      'organizationAccountId', context_account_id,
      'correlationId', context_correlation_id,
      'accessVersionBefore', context_access_version,
      'authorityCheckedAt', vortex_context.format_timestamp_utc(authority_checked_at)
    ),
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'role', 'membership',
      'membershipId', (changed.membership ->> 'membershipId')::uuid,
      'revision', (changed.membership ->> 'revision')::bigint
    )),
    p_activity_id
  );

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed.access_version;
end
$function$;

revoke execute on function vortex_access.add_organization_group_membership_for_administration(uuid, uuid, uuid, timestamptz, timestamptz, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.add_organization_group_membership_for_administration(uuid, uuid, uuid, timestamptz, timestamptz, uuid)
to vortex_request;

comment on function vortex_access.add_organization_group_membership_for_administration(uuid, uuid, uuid, timestamptz, timestamptz, uuid) is
  'Standalone request entry: performs add_membership after fixed protected checks of the caller current authority, the delegation subset and the target organisation account, with one atomic completed Activity or one content-free refused Activity row; no SQL function composes this result.';


create or replace function vortex_access.remove_organization_group_membership_for_administration(
  p_membership_id uuid,
  p_expected_membership_revision bigint,
  p_activity_id uuid
)
returns table (
  outcome text,
  organization_id uuid,
  membership_summary jsonb,
  access_version bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_account_id uuid;
  context_access_version bigint;
  context_correlation_id uuid;
  locked_access_version bigint;
  membership_fact vortex_access.organization_group_memberships%rowtype;
  authority_before jsonb;
  authority_requirement jsonb;
  decision record;
  changed record;
  changed_summary jsonb;
  authority_checked_at timestamptz;
  activity_result text;
begin
  if p_membership_id is null
    or p_membership_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_membership_revision is null
    or p_expected_membership_revision not between 1 and 9007199254740991
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Organization Group membership removal input is invalid';
  end if;

  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_account_id := (context_value ->> 'organizationAccountId')::uuid;
  context_access_version := (context_value ->> 'accessVersion')::bigint;
  context_correlation_id := (context_value ->> 'correlationId')::uuid;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = context_organization_id
    and organization.state = 'active'
    and tenant.state = 'active'
  for update of version;
  if not found or locked_access_version is distinct from context_access_version then
    raise exception using errcode = '42501',
      message = 'Organization Group membership removal is unavailable';
  end if;

  authority_checked_at := decision.checked_at;

  select membership.* into membership_fact
  from vortex_access.organization_group_memberships as membership
  where membership.organization_id = context_organization_id
    and membership.membership_id = p_membership_id
  for update;
  if not found or membership_fact.revision <> p_expected_membership_revision
    or membership_fact.state <> 'live' then
    raise exception using errcode = '40001',
      message = 'Organization Group membership removal is stale or unavailable';
  end if;

  perform 1
  from vortex_access.organization_groups as organization_group
  where organization_group.organization_id = context_organization_id
    and organization_group.group_id = membership_fact.group_id
  for update;
  if not found then
    raise exception using errcode = '40001',
      message = 'Organization Group membership source is unavailable';
  end if;

  authority_before := vortex_access.organization_group_reduction_authority(
    context_organization_id, membership_fact.group_id
  );
  authority_requirement := case authority_before ->> 'kind'
    when 'none' then pg_catalog.jsonb_build_object('kind', 'permission')
    else pg_catalog.jsonb_build_object(
      'kind', 'delegated_management',
      'before', authority_before,
      'after', pg_catalog.jsonb_build_object('kind', 'none')
    )
  end;

  select evaluated.* into strict decision
  from vortex_access.evaluate_organization_permission_eligibility(
    pg_catalog.jsonb_build_object(
      'operationKey', 'platform.organization.group_memberships.remove',
      'action', pg_catalog.jsonb_build_object('actionKind', 'manage'),
      'target', pg_catalog.jsonb_build_object('kind', 'organization'),
      'requiredPermission', pg_catalog.jsonb_build_object(
        'ownerKind', 'platform',
        'ownerId', 'cabe121e-0baf-4084-9471-cce915d460a8',
        'permissionId', '6185dc64-464b-4776-97dc-c64a6f299550'
      ),
      'recentAuthentication', pg_catalog.jsonb_build_object('kind', 'none'),
      'authority', authority_requirement
    )
  ) as evaluated;
  if decision.outcome = 'refused'
    and decision.operation_key = 'platform.organization.group_memberships.remove'
    and decision.target_kind = 'organization'
    and decision.target_application_root_id is null
    and decision.organization_id = context_organization_id
    and decision.organization_account_id = context_account_id
    and decision.access_version = context_access_version
    and decision.correlation_id = context_correlation_id
    and decision.reason_code in (
      'permission_unavailable', 'permission_not_effective',
      'authentication_unsatisfied', 'delegation_insufficient'
    ) then
    activity_result := vortex_activity.append_organization_activity_entry(
      context_organization_id, p_activity_id, decision.checked_at,
      'organization_account', context_account_id, 'remove_group_membership',
      array[context_organization_id]::uuid[], array[]::uuid[], vortex_context.channel(),
      context_correlation_id, 'refused'
    );
    if activity_result is distinct from 'inserted' then
      raise exception using errcode = '40001',
        message = 'Organization Group membership removal refusal Activity is stale';
    end if;
    return query select 'refused'::text, context_organization_id,
      null::jsonb, context_access_version;
    return;
  end if;

  if decision.outcome is distinct from 'eligible'
    or decision.operation_key is distinct from 'platform.organization.group_memberships.remove'
    or decision.target_kind is distinct from 'organization'
    or decision.target_application_root_id is not null
    or decision.organization_id is distinct from context_organization_id
    or decision.organization_account_id is distinct from context_account_id
    or decision.access_version is distinct from context_access_version
    or decision.correlation_id is distinct from context_correlation_id then
    raise exception using errcode = '42501',
      message = 'Organization Group membership removal is unavailable';
  end if;

  select result.* into strict changed
  from vortex_access.coordinate_organization_group_membership_change(
    'remove_membership', context_organization_id, p_membership_id,
    p_expected_membership_revision, null, null, null, null, null,
    context_account_id, context_correlation_id
  ) as result;

  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'membershipId', membership.membership_id,
    'groupId', membership.group_id,
    'organizationAccountId', membership.organization_account_id,
    'accountDisplayName', account.display_name,
    'revision', membership.revision,
    'startsAt', membership.starts_at,
    'expiresAt', membership.expires_at,
    'state', membership.state,
    'temporalState', 'revoked'
  )) into strict changed_summary
  from vortex_access.organization_group_memberships as membership
  join vortex_identity.organization_accounts as account
    on account.organization_id = membership.organization_id
    and account.organization_account_id = membership.organization_account_id
  where membership.organization_id = context_organization_id
    and membership.membership_id = p_membership_id;

  activity_result := vortex_activity.append_organization_activity_entry(
    context_organization_id, p_activity_id,
    (changed.membership ->> 'changedAt')::timestamptz,
    'organization_account', context_account_id, 'remove_group_membership',
    array[p_membership_id]::uuid[], array[]::uuid[], vortex_context.channel(),
    context_correlation_id, 'completed'
  );
  if activity_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Organization Group membership removal Activity is stale';
  end if;

  perform vortex_access.append_organization_group_membership_events_internal(
    'remove_membership',
    pg_catalog.jsonb_build_object(
      'kind', 'human',
      'organizationId', context_organization_id,
      'organizationAccountId', context_account_id,
      'correlationId', context_correlation_id,
      'accessVersionBefore', context_access_version,
      'authorityCheckedAt', vortex_context.format_timestamp_utc(authority_checked_at)
    ),
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'role', 'membership',
      'membershipId', (changed.membership ->> 'membershipId')::uuid,
      'revision', (changed.membership ->> 'revision')::bigint
    )),
    p_activity_id
  );

  return query select 'completed'::text, context_organization_id, changed_summary,
    changed.access_version;
end
$function$;

revoke execute on function vortex_access.remove_organization_group_membership_for_administration(uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_access.remove_organization_group_membership_for_administration(uuid, bigint, uuid)
to vortex_request;

comment on function vortex_access.remove_organization_group_membership_for_administration(uuid, bigint, uuid) is
  'Standalone request entry: performs remove_group_membership after fixed protected checks, records one atomic completed Activity or returns one content-free refused Activity row; no SQL function composes this result.';


commit;
