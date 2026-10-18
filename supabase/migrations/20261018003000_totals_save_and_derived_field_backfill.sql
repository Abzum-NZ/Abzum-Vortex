-- A record type holding a total saves through the base save (#2860): a save of the record itself
-- never moves its totals, so the base save no longer refuses such a record type; a new record
-- starts with totals over no related records.
-- Existing records get a release's new totals and stored calculations (#2861): one server-only
-- reader and writer the platform's backfill uses after an upgrade activates a release and after a
-- preview is seeded, in that installation's own context.
set local role vortex_record_adapter;

create or replace function vortex_record.prepare_base_record_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  installation jsonb;
  application_content jsonb;
  unsupported boolean := false;
  context_value jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  effective_command_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  receipt_claim jsonb;
  projection jsonb;
  decision jsonb;
  bounds jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_operation not in ('create', 'update')
    or p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_submitted_values) is distinct from 'object'
    or (p_operation = 'create' and (
      p_record_id is not null or p_expected_concurrency_number is not null
    ))
    or (p_operation = 'update' and (
      p_record_id is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or p_selected_group_id is not null
    )) then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', effective_command_id, true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_id_value
      );
    end if;
    projection := vortex_record.read_record(
      p_record_type_id, (receipt_claim ->> 'recordId')::uuid
    );
    if projection ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', correlation_id_value
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'saved',
      'recordId', projection -> 'recordId',
      'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values',
      'correlationId', correlation_id_value,
      'backgroundDelivery', case when preview_installation is null
        then 'pending' else 'none' end,
      'replayed', true
    );
  end if;

  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  );
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
    or (preview_installation is not null and meta ? 'recordType'
      and meta -> 'recordType' ? 'systemProjection') then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  installation := case when preview_installation is null
    then vortex_definition.read_current_active_installation()
    else preview_installation end;

  select release.record_content
  into strict application_content
  from vortex_definition.runtime_releases as release
  where release.root_id = (meta -> 'context' ->> 'applicationRootId')::uuid
    and release.release_revision =
      (installation ->> 'applicationReleaseRevision')::bigint;

  -- A record type holding a total saves here too: a save of the record itself never moves its
  -- totals, so a new record starts with totals over no related records and an update keeps them.
  unsupported := exists (
    -- #578: Record evaluates the owning Module release's rules (`beforeSaveRules`);
    -- an Application rule on this record type cannot be evaluated and refuses.
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(application_content -> 'rules', '[]'::jsonb)
    ) as item(value)
    where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
      pg_catalog.lower(p_record_type_id::text)
  );

  if unsupported then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported',
      'correlationId', meta -> 'context' -> 'correlationId'
    );
  end if;

  if meta -> 'recordType' ? 'systemProjection' then
    if p_operation <> 'update'
      or meta #>> '{recordType,key}' <> 'organization_settings'
      or meta #>> '{recordType,systemProjection,protectedView}' <>
        'organization_runtime_settings'
      or not coalesce(
        (meta #> '{recordType,standardActions}') ? 'update', false
      )
      or not vortex_definition.is_system_projection_module_internal(
        (meta ->> 'moduleRootId')::uuid, organization_id_value
      )
      or p_record_id is distinct from
        (meta -> 'context' ->> 'organizationId')::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;

    -- Do not execute application before-save rules for this projection until
    -- the platform settings-manage permission has passed its own current check.
    if not vortex_access.organization_runtime_settings_manage_is_current() then
      perform vortex_record.append_base_save_activity_internal(
        p_activity_id, 'update', organization_id_value,
        array[]::uuid[], 'refused'
      );
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded',
        'correlationId', correlation_id_value
      );
    end if;

    -- The writable system projection is prepared through its protected read
    -- model. Its final write remains inside apply_record_changes.
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'read', p_record_id, null, null::jsonb
    );
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if (loaded ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if preview_installation is null then
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_base_save_activity_internal(
          p_activity_id, 'update', organization_id_value,
          array[]::uuid[], 'refused'
        );
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    end if;
    bounds := bounds || pg_catalog.jsonb_build_object(
      'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
        loaded -> 'facts' -> 'recordTypes', p_record_type_id,
        bounds -> 'readableFieldIds'
      )
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'recordType', meta -> 'recordType',
      'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
        (meta ->> 'moduleRootId')::uuid,
        (meta ->> 'moduleReleaseRevision')::bigint,
        p_record_type_id
      ),
      'correlationId', correlation_id_value,
      'readableFieldIds', bounds -> 'readableFieldIds',
      'existingValues', loaded -> 'fieldValues'
    );
  end if;

  if p_operation = 'update' then
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'update', p_record_id, p_expected_concurrency_number, null::jsonb
    );
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', meta -> 'context' -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;
    if loaded ? 'previewInstallationId' then
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        p_record_type_id, (meta ->> 'storageContractId')::uuid,
        meta -> 'recordType'
      );
      if preview_bounds is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      bounds := preview_bounds;
    else
      decision := vortex_access.evaluate_organization_record_access_internal(
        loaded -> 'declaration', p_record_id, loaded -> 'facts'
      );
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_base_save_activity_internal(
          p_activity_id, 'update', organization_id_value,
          array[]::uuid[], 'refused'
        );
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    end if;
    bounds := bounds || pg_catalog.jsonb_build_object(
      'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
        loaded -> 'facts' -> 'recordTypes', p_record_type_id,
        bounds -> 'readableFieldIds'
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'recordType', meta -> 'recordType',
    -- #578: the owning Module release's rules for this record type, evaluated by Record.
    'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'correlationId', meta -> 'context' -> 'correlationId',
    'readableFieldIds', case when p_operation = 'update'
      then bounds -> 'readableFieldIds' else '[]'::jsonb end,
    'existingValues', case when p_operation = 'update'
      then loaded -> 'fieldValues' else '{}'::jsonb end
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    get stacked diagnostics
      failure_sqlstate = returned_sqlstate,
      failure_message = message_text;
    raise log 'Record save preparation refused: % (%)', failure_message, failure_sqlstate;
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.prepare_base_record_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.prepare_base_record_save(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Server-only operation-scoped preparation read for one exact active installed or owner-validated preview base Record save.';

create or replace function vortex_record.derived_field_backfill_scope_internal()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  preview_installation jsonb;
  installation jsonb;
  plan jsonb;
  binding_item jsonb;
  module_content jsonb;
  record_type_item jsonb;
  record_type_key text;
  type_meta jsonb;
  field_ids jsonb;
  definitions jsonb := '{}'::jsonb;
  targets jsonb := '{}'::jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Derived field backfill requires an application context';
  end if;
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null and preview_installation ->> 'outcome' = 'refused' then
    raise exception using errcode = '42501', message = 'Preview Record context is unavailable';
  end if;
  installation := case when preview_installation is null
    then vortex_definition.read_current_active_installation()
    else preview_installation end;
  plan := vortex_record.resolve_installation_access_plan_internal(installation);

  for binding_item in
    select item.value
    from pg_catalog.jsonb_array_elements(installation -> 'moduleBindings') as item(value)
    order by item.value ->> 'moduleRootId'
  loop
    select release.record_content into strict module_content
    from vortex_definition.runtime_releases as release
    where release.root_id = (binding_item ->> 'moduleRootId')::uuid
      and release.release_revision = (binding_item ->> 'moduleReleaseRevision')::bigint;
    for record_type_item in
      select item.value
      from pg_catalog.jsonb_array_elements(coalesce(module_content -> 'recordTypes', '[]'::jsonb))
        as item(value)
    loop
      record_type_key := pg_catalog.lower(record_type_item ->> 'recordTypeId');
      type_meta := plan -> 'recordTypes' -> record_type_key;
      continue when type_meta is null
        or coalesce((type_meta ->> 'isSystemProjection')::boolean, false);
      definitions := definitions || pg_catalog.jsonb_build_object(record_type_key, record_type_item);
      -- The fields a backfill works out: every total and every stored calculation. A preview's
      -- storage is new, so all of them; a live upgrade only those this exact Module release
      -- brought into storage, since a published field's formula never changes afterwards.
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.lower(field.value ->> 'fieldId')
          order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"), '[]'::jsonb)
      into field_ids
      from pg_catalog.jsonb_array_elements(record_type_item -> 'fields') as field(value)
      where (field.value ->> 'type' = 'total'
          or (field.value ->> 'type' = 'calculation'
            and field.value #>> '{settings,evaluation}' is distinct from 'read_time'))
        and (preview_installation is not null or exists (
          select 1
          from vortex_record.field_storage_mappings as mapping
          where mapping.storage_contract_id = (type_meta ->> 'storageContractId')::uuid
            and mapping.field_id = (field.value ->> 'fieldId')::uuid
            and mapping.state = 'active'
            and mapping.introduced_by_module_root_id = (type_meta ->> 'moduleRootId')::uuid
            and mapping.introduced_at_release_revision = (type_meta ->> 'releaseRevision')::bigint
        ));
      if pg_catalog.jsonb_array_length(field_ids) > 0 then
        targets := targets || pg_catalog.jsonb_build_object(record_type_key, field_ids);
      end if;
    end loop;
  end loop;

  return pg_catalog.jsonb_build_object(
    'organizationId', context_value -> 'organizationId',
    'applicationRootId', context_value -> 'applicationRootId',
    'plan', plan,
    'definitions', definitions,
    'targets', targets
  );
end
$function$;

alter function vortex_record.derived_field_backfill_scope_internal() owner to vortex_record_adapter;

revoke all on function vortex_record.derived_field_backfill_scope_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.derived_field_backfill_scope_internal()
  to vortex_record_adapter;
comment on function vortex_record.derived_field_backfill_scope_internal() is
  'Private derived-field backfill scope of the request''s live or preview installation: each record type''s definition and the totals and stored calculations a backfill works out for its existing records.';

create or replace function vortex_record.read_derived_field_backfill(
  p_record_type_id uuid,
  p_after_record_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  -- One page of existing records; the caller asks for the next page after the last record.
  page_size constant integer := 100;
  scope jsonb;
  record_type_key text;
  type_meta jsonb;
  definition jsonb;
  field_ids jsonb;
  application_scope uuid;
  records jsonb;
  page_ids uuid[];
  relationship_id_value text;
  relationship_value jsonb;
  source_key text;
  source_meta jsonb;
  source_definition jsonb;
  link_token text;
  source_scope uuid;
  related jsonb;
  sources jsonb := '[]'::jsonb;
  related_by_relationship jsonb := '{}'::jsonb;
begin
  scope := vortex_record.derived_field_backfill_scope_internal();
  -- Without a record type: the record types whose existing records a backfill works out.
  if p_record_type_id is null then
    return pg_catalog.jsonb_build_object('recordTypeIds', coalesce((
      select pg_catalog.jsonb_agg(target.key order by target.key collate "C")
      from pg_catalog.jsonb_object_keys(scope -> 'targets') as target(key)
    ), '[]'::jsonb));
  end if;
  record_type_key := pg_catalog.lower(p_record_type_id::text);
  field_ids := scope -> 'targets' -> record_type_key;
  if field_ids is null then
    return pg_catalog.jsonb_build_object('records', '[]'::jsonb);
  end if;
  type_meta := scope -> 'plan' -> 'recordTypes' -> record_type_key;
  definition := scope -> 'definitions' -> record_type_key;
  application_scope := case when type_meta ->> 'storageScope' = 'application_contained'
    then (scope ->> 'applicationRootId')::uuid else null end;

  -- The page is locked, so no save changes a record between this read and its backfill write.
  execute pg_catalog.format(
    'select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         ''recordId'', page.record_id,
         ''concurrencyNumber'', page.concurrency_number,
         ''values'', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%s))
       ) order by page.record_id), ''[]''::jsonb),
       coalesce(pg_catalog.array_agg(page.record_id order by page.record_id), array[]::uuid[])
     from (
       select stored.* from record_data.%I as stored
       where stored.organisation_id = $1
         and stored.application_root_id is not distinct from $2
         and stored.lifecycle_state = ''active''
         and ($3::uuid is null or stored.record_id > $3)
       order by stored.record_id
       limit %s
       for update
     ) as page',
    type_meta ->> 'valueExpression', type_meta ->> 'table', page_size
  ) into records, page_ids
  using (scope ->> 'organizationId')::uuid, application_scope, p_after_record_id;

  -- Each total's related records: the active records whose link names one of the page's records.
  for relationship_id_value in
    select distinct pg_catalog.lower(field.value #>> '{settings,relationshipId}')
    from pg_catalog.jsonb_array_elements(definition -> 'fields') as field(value)
    where field.value ->> 'type' = 'total'
  loop
    relationship_value := scope -> 'plan' -> 'relationships' -> relationship_id_value;
    source_key := pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
    source_meta := scope -> 'plan' -> 'recordTypes' -> source_key;
    source_definition := scope -> 'definitions' -> source_key;
    if relationship_value is null or source_meta is null or source_definition is null then
      raise exception using errcode = '55000',
        message = 'Derived field backfill relationship is not installed';
    end if;
    select source_meta -> 'columns' -> pg_catalog.lower(declared.value ->> 'fromFieldId') ->> 'token'
    into link_token
    from pg_catalog.jsonb_array_elements(source_definition -> 'relationships') as declared(value)
    where pg_catalog.lower(declared.value ->> 'relationshipId') = relationship_id_value;
    if link_token is null then
      raise exception using errcode = '55000',
        message = 'Derived field backfill relationship is not installed';
    end if;
    source_scope := case when source_meta ->> 'storageScope' = 'application_contained'
      then (scope ->> 'applicationRootId')::uuid else null end;
    execute pg_catalog.format(
      'select coalesce(pg_catalog.jsonb_object_agg(grouped.parent_id, grouped.records), ''{}''::jsonb)
       from (
         select pg_catalog.lower(stored.%1$I ->> ''recordId'') as parent_id,
           pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             ''fieldValues'', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%2$s))
           ) order by stored.record_id) as records
         from record_data.%3$I as stored
         where stored.organisation_id = $1
           and stored.application_root_id is not distinct from $2
           and stored.lifecycle_state = ''active''
           and pg_catalog.lower(stored.%1$I ->> ''recordTypeId'') = $3
           and pg_catalog.lower(stored.%1$I ->> ''recordId'') = any ($4)
         group by 1
       ) as grouped',
      link_token, source_meta ->> 'valueExpression', source_meta ->> 'table'
    ) into related
    using (scope ->> 'organizationId')::uuid, source_scope, record_type_key,
      (select coalesce(pg_catalog.array_agg(pg_catalog.lower(id::text)), array[]::text[])
       from pg_catalog.unnest(page_ids) as id);
    sources := sources || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'relationshipId', relationship_value -> 'relationshipId',
      'sourceRecordType', source_definition
    ));
    related_by_relationship := related_by_relationship
      || pg_catalog.jsonb_build_object(relationship_id_value, related);
  end loop;

  return pg_catalog.jsonb_build_object(
    'recordType', definition,
    'fieldIds', field_ids,
    'sources', sources,
    'records', records,
    'related', related_by_relationship
  );
end
$function$;

alter function vortex_record.read_derived_field_backfill(uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.read_derived_field_backfill(uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_derived_field_backfill(uuid, uuid)
  to vortex_runtime;
comment on function vortex_record.read_derived_field_backfill(uuid, uuid) is
  'Server-only derived-field backfill read: one locked page of a record type''s existing records in the request''s live or preview installation, with every value and each total''s related records, for the platform to work out the totals and stored calculations it has just provisioned.';

create or replace function vortex_record.apply_derived_field_backfill(
  p_record_type_id uuid,
  p_records jsonb
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope jsonb;
  record_type_key text;
  type_meta jsonb;
  field_ids jsonb;
  application_scope uuid;
  record_item jsonb;
  entry record;
  column_value jsonb;
  assignments text[];
  written_record_id uuid;
  written integer := 0;
begin
  if p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_records) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_records) > 100 then
    raise exception using errcode = '22023', message = 'Derived field backfill is invalid';
  end if;
  scope := vortex_record.derived_field_backfill_scope_internal();
  record_type_key := pg_catalog.lower(p_record_type_id::text);
  field_ids := scope -> 'targets' -> record_type_key;
  type_meta := scope -> 'plan' -> 'recordTypes' -> record_type_key;
  if field_ids is null or type_meta is null then
    raise exception using errcode = '42501', message = 'Derived field backfill target is unavailable';
  end if;
  application_scope := case when type_meta ->> 'storageScope' = 'application_contained'
    then (scope ->> 'applicationRootId')::uuid else null end;

  for record_item in
    select item.value from pg_catalog.jsonb_array_elements(p_records) as item(value)
  loop
    if pg_catalog.jsonb_typeof(record_item) is distinct from 'object'
      or not record_item ?& array['recordId', 'expectedConcurrencyNumber', 'values']
      or pg_catalog.jsonb_typeof(record_item -> 'values') is distinct from 'object'
      or record_item -> 'values' = '{}'::jsonb then
      raise exception using errcode = '22023', message = 'Derived field backfill is invalid';
    end if;
    assignments := array[]::text[];
    -- Only the fields this backfill works out, each value in its column's canonical form.
    for entry in
      select pg_catalog.lower(item.key) as key, item.value
      from pg_catalog.jsonb_each(record_item -> 'values') as item(key, value)
    loop
      column_value := type_meta -> 'columns' -> entry.key;
      if not field_ids ? entry.key or column_value is null
        or not vortex_record.canonical_record_value_matches(
          entry.value, column_value ->> 'type', column_value ->> 'databaseValueType'
        ) then
        raise exception using errcode = '23514', message = 'Derived field backfill value is invalid';
      end if;
      assignments := pg_catalog.array_append(assignments, pg_catalog.format(
        '%I = %s', column_value ->> 'token',
        case when pg_catalog.jsonb_typeof(entry.value) = 'null' then 'null'
        else case column_value ->> 'databaseValueType'
          when 'decimal' then pg_catalog.format('%L::numeric', entry.value #>> '{}')
          when 'timestamp_with_time_zone' then pg_catalog.format('%L::timestamptz', entry.value #>> '{}')
          when 'date' then pg_catalog.format('%L::date', entry.value #>> '{}')
          when 'integer' then pg_catalog.format('%L::bigint', entry.value #>> '{}')
          when 'boolean' then pg_catalog.format('%L::boolean', entry.value #>> '{}')
          when 'json' then pg_catalog.format('%L::jsonb', entry.value::text)
          else pg_catalog.format('%L::text', entry.value #>> '{}') end end
      ));
    end loop;
    -- Working out a new field is not a change anyone made: no Activity or Event, and the
    -- record's last change stays as it was. Its revision moves, so an open form refreshes.
    execute pg_catalog.format(
      'update record_data.%I as stored set %s, concurrency_number = stored.concurrency_number + 1
       where stored.organisation_id = $1
         and stored.application_root_id is not distinct from $2
         and stored.record_id = $3
         and stored.concurrency_number = $4
         and stored.lifecycle_state = ''active''
       returning stored.record_id',
      type_meta ->> 'table', pg_catalog.array_to_string(assignments, ', ')
    ) into written_record_id
    using (scope ->> 'organizationId')::uuid, application_scope,
      (record_item ->> 'recordId')::uuid, (record_item ->> 'expectedConcurrencyNumber')::bigint;
    if written_record_id is null then
      raise exception using errcode = '40001', message = 'Derived field backfill record changed';
    end if;
    written := written + 1;
  end loop;

  if written > 0 then
    perform vortex_record.bump_record_data_version_internal(
      (scope ->> 'organizationId')::uuid, (type_meta ->> 'storageContractId')::uuid,
      application_scope
    );
  end if;
  return written;
end
$function$;

alter function vortex_record.apply_derived_field_backfill(uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_derived_field_backfill(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_derived_field_backfill(uuid, jsonb)
  to vortex_runtime;
comment on function vortex_record.apply_derived_field_backfill(uuid, jsonb) is
  'Server-only derived-field backfill write: stores the totals and stored calculations the platform worked out for a page of existing records it read with read_derived_field_backfill, only for the fields the backfill provisions.';

reset role;
