set role vortex_owner;

grant update on vortex_record.relationship_edges to vortex_record_adapter;
create policy relationship_edges_adapter_update on vortex_record.relationship_edges
  for update to vortex_record_adapter
  using (from_organisation_id = (select vortex_platform.organization_id()))
  with check (
    from_organisation_id = (select vortex_platform.organization_id())
    and to_organisation_id = (select vortex_platform.organization_id())
  );

alter table vortex_record.organization_activity_entries
  add column agent_channel text,
  add constraint organization_activity_entries_agent_channel_valid check (agent_channel = 'webmcp');
-- The in-page agent records its own channel; no external MCP surface exists. The only
-- producer of 'mcp' was the in-page agent route, so its entries are rewritten as webmcp.
alter table vortex_record.organization_activity_entries
  drop constraint organization_activity_entries_source_valid;
alter table vortex_record.organization_activity_entries disable trigger organization_activity_entries_immutable;
update vortex_record.organization_activity_entries set source = 'webmcp' where source = 'mcp';
alter table vortex_record.organization_activity_entries enable trigger organization_activity_entries_immutable;
alter table vortex_record.organization_activity_entries
  add constraint organization_activity_entries_source_valid check (source = any (array[
    'web', 'webmcp', 'programmatic_interface', 'connection', 'federation', 'durable_workflow', 'system'
  ]));
comment on column vortex_record.organization_activity_entries.agent_channel is
  'Trusted agent channel acting for the unchanged actor: webmcp for an agent in the person''s open page; null otherwise.';

create or replace function vortex_record.append_organization_activity_entry(
  p_organization_id uuid,
  p_activity_id uuid,
  p_occurred_at timestamptz,
  p_actor_kind text,
  p_actor_id uuid,
  p_action text,
  p_subject_ids uuid[],
  p_changed_field_ids uuid[],
  p_source text,
  p_correlation_id uuid,
  p_outcome text
)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  inserted_activity_id uuid;
  existing_entry vortex_record.organization_activity_entries%rowtype;
  channel_value text := vortex_platform.channel();
  agent_channel_value text;
begin
  agent_channel_value := case when channel_value = 'webmcp' then channel_value else null end;
  if p_source is null
    or p_source <> all (array[
      'web', 'webmcp', 'programmatic_interface', 'connection', 'federation',
      'system'
    ]) then
    raise exception using errcode = '22023', message = 'Activity source channel is invalid';
  end if;

  insert into vortex_record.organization_activity_entries (
    organization_id, activity_id, occurred_at, actor_kind, actor_id, action,
    subject_ids, changed_field_ids, source, correlation_id, outcome, agent_channel
  ) values (
    p_organization_id, p_activity_id, p_occurred_at, p_actor_kind, p_actor_id,
    p_action, p_subject_ids, p_changed_field_ids, p_source, p_correlation_id,
    p_outcome, agent_channel_value
  )
  on conflict (organization_id, activity_id) do nothing
  returning activity_id into inserted_activity_id;

  if inserted_activity_id is not null then
    return 'inserted';
  end if;

  select entry.*
  into strict existing_entry
  from vortex_record.organization_activity_entries as entry
  where entry.organization_id = p_organization_id
    and entry.activity_id = p_activity_id;

  if existing_entry.occurred_at is distinct from p_occurred_at
    or existing_entry.actor_kind is distinct from p_actor_kind
    or existing_entry.actor_id is distinct from p_actor_id
    or existing_entry.agent_channel is distinct from agent_channel_value
    or existing_entry.action is distinct from p_action
    or existing_entry.subject_ids is distinct from p_subject_ids
    or existing_entry.changed_field_ids is distinct from p_changed_field_ids
    or existing_entry.source is distinct from p_source
    or existing_entry.correlation_id is distinct from p_correlation_id
    or existing_entry.outcome is distinct from p_outcome then
    raise exception using
      errcode = '22023',
      message = 'Activity identity already records different evidence';
  end if;

  return 'already_recorded';
end
$function$;

revoke all on function vortex_record.append_organization_activity_entry(
  uuid, uuid, timestamptz, text, uuid, text, uuid[], uuid[], text, uuid, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

comment on function vortex_record.append_organization_activity_entry(
  uuid, uuid, timestamptz, text, uuid, text, uuid[], uuid[], text, uuid, text
) is
  'Private content-free Activity append over the one channel vocabulary; an exact retry replays and different evidence under one identity is refused.';

alter function vortex_record.append_organization_activity_entry(p_organization_id uuid, p_activity_id uuid, p_occurred_at timestamp with time zone, p_actor_kind text, p_actor_id uuid, p_action text, p_subject_ids uuid[], p_changed_field_ids uuid[], p_source text, p_correlation_id uuid, p_outcome text) owner to vortex_owner;

grant execute on function vortex_record.append_organization_activity_entry(p_organization_id uuid, p_activity_id uuid, p_occurred_at timestamp with time zone, p_actor_kind text, p_actor_id uuid, p_action text, p_subject_ids uuid[], p_changed_field_ids uuid[], p_source text, p_correlation_id uuid, p_outcome text) to postgres;

alter function vortex_record.append_organization_activity_entry(p_organization_id uuid, p_activity_id uuid, p_occurred_at timestamp with time zone, p_actor_kind text, p_actor_id uuid, p_action text, p_subject_ids uuid[], p_changed_field_ids uuid[], p_source text, p_correlation_id uuid, p_outcome text) owner to vortex_owner;

grant execute on function vortex_record.append_organization_activity_entry(p_organization_id uuid, p_activity_id uuid, p_occurred_at timestamp with time zone, p_actor_kind text, p_actor_id uuid, p_action text, p_subject_ids uuid[], p_changed_field_ids uuid[], p_source text, p_correlation_id uuid, p_outcome text) to postgres;

create or replace function vortex_record.append_record_activity_internal(
  p_activity_id uuid,
  p_action text,
  p_subject_ids uuid[],
  p_changed_field_ids uuid[],
  p_outcome text
)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  occurred_at_value timestamptz := pg_catalog.statement_timestamp();
  append_result text;
begin
  if p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action is null
    or p_action not in (
      'create_record', 'update_record', 'execute_named_action', 'delete_record',
      'restore_record', 'transfer_record_ownership', 'manage_record_lifecycle_policy'
    )
    or p_subject_ids is null
    or pg_catalog.cardinality(p_subject_ids) = 0
    or pg_catalog.array_position(p_subject_ids, null::uuid) is not null
    or '00000000-0000-0000-0000-000000000000'::uuid = any (p_subject_ids)
    or p_subject_ids is distinct from (
      select pg_catalog.array_agg(value order by value)
      from (select distinct value
        from pg_catalog.unnest(p_subject_ids) as item(value)) as canonical
    )
    or p_changed_field_ids is null
    or pg_catalog.array_position(p_changed_field_ids, null::uuid) is not null
    or p_changed_field_ids is distinct from (
      select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[])
      from (select distinct value
        from pg_catalog.unnest(p_changed_field_ids) as item(value)) as canonical
    )
    or p_outcome is null
    or p_outcome not in ('completed', 'refused') then
    raise exception using errcode = '22023', message = 'Record Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if p_action in (
      'create_record', 'update_record', 'delete_record', 'restore_record',
      'transfer_record_ownership'
    )
    and not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record Activity requires an Application context';
  end if;
  append_result := vortex_record.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id, occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    p_action, p_subject_ids, p_changed_field_ids, vortex_platform.channel(),
    (context_value ->> 'correlationId')::uuid, p_outcome
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Record Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

alter function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text)
  owner to vortex_owner;
revoke all on function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text)
  to vortex_owner, vortex_record_adapter;
comment on function vortex_record.append_record_activity_internal(uuid, text, uuid[], uuid[], text) is
  'The one Record Activity composer: derives the organisation, account, correlation and channel from the validated request context and appends one entry for a record save, named action, delete, restore, ownership transfer or lifecycle policy change. The append records webmcp as the agent channel while the actor remains the person.';

set role vortex_record_adapter;

create or replace function vortex_record.prepare_settings_record_change_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  read_decision jsonb;
  read_bounds jsonb;
  record_type_value jsonb;
  field_item jsonb;
  field_id text;
  field_key text;
  field_type text;
  database_type text;
  field_value jsonb;
  candidate_values jsonb;
  core_values jsonb := '{}'::jsonb;
  extension_values jsonb := '{}'::jsonb;
  changed_field_ids uuid[] := array[]::uuid[];
  correlation_id_value uuid;
  application_root_id_value uuid;
begin
  if vortex_record.read_current_preview_installation_internal() is not null
    or not vortex_access.organization_runtime_settings_manage_is_current() then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'settings_permission_unavailable');
  end if;
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
  record_type_value := meta -> 'recordType';
  if record_type_value #>> '{systemProjection,protectedView}' is distinct from
      'organization_runtime_settings'
    or not coalesce((record_type_value -> 'standardActions') ? 'update', false)
    or not vortex_definition.is_platform_system_module_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta -> 'context' ->> 'organizationId')::uuid
    ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;

  correlation_id_value := (meta -> 'context' ->> 'correlationId')::uuid;
  application_root_id_value := (meta -> 'context' ->> 'applicationRootId')::uuid;
  if p_record_id is distinct from (meta -> 'context' ->> 'organizationId')::uuid then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;

  loaded := (vortex_record.load_record_access_facts_internal('read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', p_record_type_id, 'recordId', p_record_id))) -> 0);
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;
  read_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', loaded -> 'declaration', 'recordId', p_record_id, 'facts', loaded -> 'facts'))) -> 0);
  if read_decision ->> 'outcome' is distinct from 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', correlation_id_value
    );
  end if;
  read_bounds := vortex_record.decide_record_field_bounds_internal(read_decision);
  if exists (
    select 1
    from (
      select supplied.key
      from pg_catalog.jsonb_object_keys(p_submitted_values) as supplied(key)
      union
      select supplied.key
      from pg_catalog.jsonb_object_keys(p_final_values) as supplied(key)
    ) as supplied
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        read_bounds -> 'readableFieldIds'
      ) as readable(field_id)
      where pg_catalog.lower(readable.field_id) = pg_catalog.lower(supplied.key)
    )
  ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'field_refused',
      'correlationId', correlation_id_value
    );
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_final_values) as supplied(key)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(supplied.key)
    )
  ) or exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_submitted_values) as supplied(key)
    where not exists (
      select 1
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as field(value)
      where pg_catalog.lower(field.value ->> 'fieldId') = pg_catalog.lower(supplied.key)
    )
  ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid',
      'correlationId', correlation_id_value
    );
  end if;

  candidate_values := (loaded -> 'fieldValues') || p_final_values;
  for field_item in
    select item.value
    from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
    order by item.value ->> 'fieldId'
  loop
    field_id := pg_catalog.lower(field_item ->> 'fieldId');
    field_key := field_item ->> 'key';
    field_type := field_item ->> 'type';
    database_type := meta #>> array['columns', field_id, 'databaseValueType'];
    if database_type is null then
      raise exception using errcode = '55000',
        message = 'Organization settings field storage is unavailable';
    end if;

    if (field_item ->> 'required')::boolean
      and (not (candidate_values ? field_id)
        or pg_catalog.jsonb_typeof(candidate_values -> field_id) = 'null') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'required_field_missing',
        'correlationId', correlation_id_value
      );
    end if;
    if not (p_final_values ? field_id) then
      continue;
    end if;

    field_value := p_final_values -> field_id;
    if field_key in ('organization_id', 'revision')
      or field_type in (
        'reference_number', 'table', 'link', 'link_to_one_of_several', 'total',
        'attachment', 'calculation'
      )
      or not vortex_record.canonical_record_value_matches(
        field_value, field_type, database_type
      ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;

    if field_type = 'choice'
      and pg_catalog.jsonb_typeof(field_value) <> 'null'
      and not exists (
        select 1
        from pg_catalog.jsonb_array_elements(field_item #> '{settings,options}') as option(value)
        where option.value ->> 'value' = field_value #>> '{}'
      ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;
    if field_type = 'several_choices'
      and pg_catalog.jsonb_typeof(field_value) <> 'null'
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements_text(field_value) as selected(value)
        where not exists (
          select 1
          from pg_catalog.jsonb_array_elements(field_item #> '{settings,options}') as option(value)
          where option.value ->> 'value' = selected.value
        )
      ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;
    if field_type in ('text', 'long_text', 'choice', 'email_address', 'phone_number', 'web_address')
      and field_item #> '{settings,maxLength}' is not null
      and pg_catalog.jsonb_typeof(field_value) = 'string'
      and pg_catalog.char_length(field_value #>> '{}') >
        (field_item #>> '{settings,maxLength}')::integer then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_refused',
        'correlationId', correlation_id_value
      );
    end if;

    if field_key in (
      'language', 'time_zone', 'currency', 'date_format', 'number_format',
      'default_application_root_id'
    ) then
      core_values := core_values || pg_catalog.jsonb_build_object(field_key, field_value);
    else
      extension_values := extension_values || pg_catalog.jsonb_build_object(field_key, field_value);
    end if;
  end loop;

  select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
  into changed_field_ids
  from pg_catalog.jsonb_object_keys(p_final_values) as key;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'recordId', p_record_id,
    'coreValues', core_values, 'extensionValues', extension_values,
    'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids), 'meta', meta,
    'currentConcurrencyNumber', loaded -> 'concurrencyNumber',
    'concurrencyNumber', p_expected_concurrency_number + 1
  );
end
$function$;
alter function vortex_record.prepare_settings_record_change_internal(uuid,uuid,bigint,jsonb,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_settings_record_change_internal(uuid,uuid,bigint,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_settings_record_change_internal(uuid,uuid,bigint,jsonb,jsonb) is
  'Private settings projection preparation: current settings-manage and read authority, exact platform declaration, revision and field policy, without a record write or receipt.';

alter table vortex_record.record_lifecycle_command_effects
  add column previous_value jsonb,
  drop constraint record_lifecycle_command_effects_kind_valid,
  add constraint record_lifecycle_command_effects_kind_valid
    check (effect_kind in ('soft_deleted', 'optional_cleared', 'restored', 'links_restored')),
  add constraint record_lifecycle_command_effects_previous_value_valid check (
    previous_value is null or (
      effect_kind = 'optional_cleared'
      and pg_catalog.jsonb_typeof(previous_value) = 'object'
      and previous_value ?& array['recordTypeId', 'recordId']
      and previous_value - array['recordTypeId', 'recordId']::text[] = '{}'::jsonb
      and vortex_platform.is_non_nil_uuid(previous_value ->> 'recordTypeId')
      and vortex_platform.is_non_nil_uuid(previous_value ->> 'recordId')
    )
  );
alter table vortex_record.record_lifecycle_command_effects
  add column restores_command_id uuid,
  add constraint record_lifecycle_effects_restores_command_valid check (
    restores_command_id is null or effect_kind in ('restored', 'links_restored')
  );
comment on column vortex_record.record_lifecycle_command_effects.restores_command_id is
  'The delete command reversed by this restore effect, so another root can distinguish earlier restoration from an intervening edit.';

alter table vortex_record.record_lifecycle_command_effects add column delete_roots jsonb;
-- Existing commands have one root, recorded in their completed receipt. Rebuild
-- their journal into the same root format used by new sets.
update vortex_record.record_lifecycle_command_effects as effect
set delete_roots = (
  select pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'recordTypeId', root.record_type_id, 'recordId', root.record_id
  ))
  from vortex_record.command_receipts as receipt
  join lateral (
    select candidate.record_type_id, candidate.record_id
    from vortex_record.record_lifecycle_command_effects as candidate
    where candidate.command_id = receipt.command_id
      and candidate.record_id = (receipt.result ->> 'recordId')::uuid
    order by candidate.effect_sequence desc limit 1
  ) as root on true
  where receipt.command_id = effect.command_id
);
alter table vortex_record.record_lifecycle_command_effects
  alter column delete_roots set not null,
  add constraint record_lifecycle_command_effects_roots_valid
    check (pg_catalog.jsonb_typeof(delete_roots) = 'array' and delete_roots <> '[]'::jsonb);
comment on column vortex_record.record_lifecycle_command_effects.delete_roots is
  'Every delete root whose closure reached this effect; restoring one root selects only its effects.';

comment on table vortex_record.record_lifecycle_command_effects is
  'Private lifecycle command journal: affected record identities, revisions and the targets of optional links cleared by deletion.';
comment on column vortex_record.record_lifecycle_command_effects.previous_value is
  'The link target before an optional clear; restore recovers available snapshots and reports the count without one.';

drop function vortex_record.complete_command_receipt_internal(text,uuid,uuid,bigint,text);
drop function vortex_record.append_record_lifecycle_effect_internal(text,uuid,uuid,uuid,bigint,uuid);
drop function vortex_record.change_record(uuid,uuid,bigint,jsonb,uuid[]);
drop function vortex_record.soft_delete_record_recursive_internal(uuid,uuid,bigint,text[]);
drop function vortex_record.apply_record_lifecycle_generated_values_internal(jsonb,boolean,jsonb);
drop function vortex_record.prepare_record_lifecycle_totals_internal(text,uuid,uuid,uuid,jsonb);

create or replace function vortex_record.append_record_lifecycle_effect_internal(p_effects jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  bound_command_id uuid;
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
  next_sequence integer;
  receipt_kind text;
  effects jsonb;
begin
  bound_command_id := nullif(
    pg_catalog.current_setting('vortex_record.lifecycle_command_id', true), ''
  )::uuid;
  if bound_command_id is null then return; end if;
  if pg_catalog.jsonb_typeof(p_effects) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Record lifecycle effects are invalid';
  end if;
  if pg_catalog.jsonb_array_length(p_effects) = 0 then return; end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_effects) as item(value)
    where not (item.value ?& array['effectKind', 'storageContractId', 'recordTypeId', 'recordId', 'preConcurrencyNumber', 'relationshipId', 'previousValue', 'deleteRoots', 'restoresCommandId'])
      or item.value ->> 'effectKind' not in ('soft_deleted', 'optional_cleared', 'restored', 'links_restored')
      or pg_catalog.jsonb_typeof(item.value -> 'deleteRoots') is distinct from 'array'
      or item.value -> 'deleteRoots' = '[]'::jsonb
      or exists (
        select 1 from pg_catalog.jsonb_array_elements(case
          when pg_catalog.jsonb_typeof(item.value -> 'deleteRoots') = 'array'
            then item.value -> 'deleteRoots' else '[]'::jsonb end) as root(value)
        where pg_catalog.jsonb_typeof(root.value) is distinct from 'object'
          or not (root.value ?& array['recordTypeId', 'recordId'])
          or root.value - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
          or not vortex_platform.is_non_nil_uuid(root.value ->> 'recordTypeId')
          or not vortex_platform.is_non_nil_uuid(root.value ->> 'recordId')
      )
      or (item.value ->> 'effectKind' in ('restored', 'links_restored')
        and not vortex_platform.is_non_nil_uuid(item.value ->> 'restoresCommandId'))
      or (item.value ->> 'effectKind' in ('soft_deleted', 'optional_cleared')
        and item.value -> 'restoresCommandId' <> 'null'::jsonb)
      or (item.value ->> 'effectKind' = 'optional_cleared' and (
        pg_catalog.jsonb_typeof(item.value -> 'previousValue') is distinct from 'object'
        or not ((item.value -> 'previousValue') ?& array['recordTypeId', 'recordId'])
        or (item.value -> 'previousValue') - array['recordTypeId', 'recordId']::text[] <> '{}'::jsonb
        or not vortex_platform.is_non_nil_uuid(item.value #>> '{previousValue,recordTypeId}')
        or not vortex_platform.is_non_nil_uuid(item.value #>> '{previousValue,recordId}')
      ))
      or (item.value ->> 'effectKind' <> 'optional_cleared' and item.value -> 'previousValue' <> 'null'::jsonb)
  ) then
    raise exception using errcode = '22023', message = 'Record lifecycle effects are invalid';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_effects) as item(value)
    group by item.value -> 'effectKind', item.value -> 'storageContractId',
      item.value -> 'recordId', item.value -> 'relationshipId'
    having pg_catalog.count(distinct (item.value - 'deleteRoots')) > 1
  ) then
    raise exception using errcode = '40001', message = 'Shared lifecycle effects disagree';
  end if;
  -- One affected row/relationship has one journal effect, even when several
  -- roots reached it. Keep every reaching root on that effect.
  select pg_catalog.jsonb_agg(grouped.effect || pg_catalog.jsonb_build_object(
    'deleteRoots', (
      select pg_catalog.jsonb_agg(roots.value order by roots.value ->> 'recordTypeId', roots.value ->> 'recordId')
      from (
        select distinct root.value
        from pg_catalog.jsonb_array_elements(p_effects) as item(value)
        cross join lateral pg_catalog.jsonb_array_elements(item.value -> 'deleteRoots') as root(value)
        where item.value - 'deleteRoots' = grouped.effect
      ) as roots
    )
  ) order by grouped.position) into effects
  from (
    select item.value - 'deleteRoots' as effect, pg_catalog.min(item.ordinality) as position
    from pg_catalog.jsonb_array_elements(p_effects) with ordinality as item(value, ordinality)
    group by item.value - 'deleteRoots'
  ) as grouped;
  context_value := vortex_access.validated_human_request_context();
  select stored.command_kind into receipt_kind
  from vortex_record.command_receipts as stored where stored.command_id = bound_command_id;
  if receipt_kind not in ('record_delete', 'record_restore', 'record_changes')
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_effects) as item(value)
      where (receipt_kind = 'record_delete' and item.value ->> 'effectKind' not in ('soft_deleted', 'optional_cleared'))
        or (receipt_kind = 'record_restore' and item.value ->> 'effectKind' not in ('restored', 'links_restored'))
    ) then
    raise exception using errcode = '42501', message = 'Record lifecycle command kind is invalid';
  end if;
  receipt := vortex_record.lock_command_receipt_internal(receipt_kind, bound_command_id);
  if receipt.command_id is null or receipt.result is not null then
    raise exception using errcode = '42501', message = 'Record lifecycle effect journal is unavailable';
  end if;
  select coalesce(pg_catalog.max(effect.effect_sequence), 0) into next_sequence
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = (context_value ->> 'organizationId')::uuid
    and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
    and effect.command_id = receipt.command_id;
  insert into vortex_record.record_lifecycle_command_effects (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, effect_sequence, effect_kind, storage_contract_id,
    record_type_id, record_id, relationship_id,
    pre_concurrency_number, post_concurrency_number, previous_value, delete_roots, restores_command_id
  )
  select (context_value ->> 'organizationId')::uuid, (context_value ->> 'applicationRootId')::uuid,
    (context_value ->> 'organizationAccountId')::uuid, receipt.command_id,
    next_sequence + item.ordinality::integer, item.value ->> 'effectKind',
    (item.value ->> 'storageContractId')::uuid, (item.value ->> 'recordTypeId')::uuid,
    (item.value ->> 'recordId')::uuid, (item.value ->> 'relationshipId')::uuid,
    (item.value ->> 'preConcurrencyNumber')::bigint,
    (item.value ->> 'preConcurrencyNumber')::bigint + 1,
    nullif(item.value -> 'previousValue', 'null'::jsonb), item.value -> 'deleteRoots',
    (item.value ->> 'restoresCommandId')::uuid
  from pg_catalog.jsonb_array_elements(effects) with ordinality as item(value, ordinality);
end
$function$;

alter function vortex_record.append_record_lifecycle_effect_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.append_record_lifecycle_effect_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.append_record_lifecycle_effect_internal(jsonb) is
  'Appends the prepared lifecycle effects in one journal write for the command bound to this transaction, retaining cleared link targets for exact recovery.';

create or replace function vortex_record.apply_lifecycle_record_changes(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
  correlation_id_value uuid;
begin
  -- Ownership transfer is an Access command with its own exact authority.
  -- Record deletion and restore enter only through the common record writer.
  if p_operation is distinct from 'transfer_ownership'
    or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
    or coalesce(pg_catalog.jsonb_path_exists(
      p_mutations, '$[*] ? (@.kind == "offboarding_transfer")'
    ), false) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  result_value := vortex_record.apply_record_mutations_internal(
    p_command_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_mutations, p_activity_id, p_occurrence_id
  );
  if result_value ->> 'outcome' = 'saved' then
    return result_value - array['values', 'backgroundDelivery']::text[]
      || pg_catalog.jsonb_build_object('outcome', 'transferred');
  end if;
  if result_value ->> 'outcome' in ('conflict', 'refused') then
    correlation_id_value :=
      (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
    return result_value || pg_catalog.jsonb_build_object('correlationId', correlation_id_value);
  end if;
  return result_value;
end
$function$;

alter function vortex_record.apply_lifecycle_record_changes(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_lifecycle_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_lifecycle_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_request;
comment on function vortex_record.apply_lifecycle_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Protected ownership-transfer entry: refuses record commands and account offboarding transfers, and delegates to the shared mutation core under the transfer authority.';

create or replace function vortex_record.apply_lifecycle_record_changes_internal(
  p_operation text,
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
  event_result jsonb;
  target_kind text;
  target_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  receipt_claim jsonb;
  installation jsonb;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  ownership_mode text;
  previous_owner_id uuid;
  updated_record_id uuid;
  updated_concurrency_number bigint;
  changed_rows integer;
  notice_sequence bigint;
  context_after jsonb;
  shared_consumers_initial jsonb;
  shared_consumers_final jsonb;
  target_item jsonb;
  module_item jsonb;
  target_application_root_id uuid;
  previous_target_application_root_id uuid;
  target_module_root_id uuid;
  previous_target_module_root_id uuid;
  target_module_binding_count integer;
  origin_application_is_consumer boolean;
begin
  if p_operation = 'transfer_ownership' then
    -- The transfer's target is the command's ordered mutation list; it carries
    -- one transfer_ownership mutation with the exact installed target kind and
    -- identifier, never an authority.
    if pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_mutations) <> 1
      or pg_catalog.jsonb_typeof(p_mutations -> 0) is distinct from 'object'
      or not ((p_mutations -> 0) ?& array['kind', 'targetKind', 'targetId'])
      or (p_mutations -> 0) - array['kind', 'targetKind', 'targetId']::text[] <> '{}'::jsonb
      or (p_mutations -> 0 ->> 'kind') is distinct from 'transfer_ownership'
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetKind') is distinct from 'string'
      or (p_mutations -> 0 ->> 'targetKind') not in ('organization_account', 'group')
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_mutations -> 0 ->> 'targetId', 'uuid') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    target_kind := p_mutations -> 0 ->> 'targetKind';
    target_id := (p_mutations -> 0 ->> 'targetId')::uuid;
    if p_command_id is null or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_type_id is null or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_id is null or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or target_kind is null
      or target_kind not in ('organization_account', 'group')
      or target_id is null or target_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    context_value := vortex_access.lock_human_request_access_version_internal();
    if not context_value ? 'applicationRootId' then
      raise exception using errcode = '42501', message = 'Record ownership transfer requires an Application context';
    end if;
    organization_id_value := (context_value ->> 'organizationId')::uuid;
    application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
    actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', p_command_id, false
    );
    if receipt_claim ->> 'status' is distinct from 'claimed' then
      if receipt_claim ->> 'status' = 'identity_conflict' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      if receipt_claim ->> 'status' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
        );
      end if;
      -- A replay reprojects from current access and intentionally never returns
      -- owner metadata (including the prior target).
      loaded := (vortex_record.read_record(
        p_record_type_id, (receipt_claim -> 'result' ->> 'recordId')::uuid
      )) -> 'record';
      if loaded ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'transferred', 'recordId', loaded -> 'recordId',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', context_value -> 'correlationId', 'replayed', true
      );
    end if;
    -- The closed transfer authority is its own exact record permission decision;
    -- it is evaluated under the record lock, while owner columns remain
    -- unavailable to the ordinary update writer.
    -- Public transfer is active-installation-only.  It deliberately never calls
    -- the retained/detached reader, so a detached record cannot leak its current
    -- revision through the ordinary conflict response.
    begin
      installation := vortex_definition.read_current_active_installation();
    exception
      when no_data_found then
        perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
    end;
    loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number, installation
    );
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
    select item.value into record_type_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
    if record_fact is null or record_type_fact is null
      or record_fact ->> 'lifecycleState' <> 'active' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    ownership_mode := record_type_fact ->> 'ownershipMode';
    decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', loaded -> 'declaration',
        'recordId', p_record_id,
        'facts', loaded -> 'facts'
      )
    )) -> 0);
    if decision ->> 'outcome' = 'refused' then
      perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    elsif decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Record ownership transfer authority is unavailable';
    end if;
    if ownership_mode = 'organization_account' then
      previous_owner_id := (record_fact ->> 'ownerOrganizationAccountId')::uuid;
    elsif ownership_mode = 'group' then
      previous_owner_id := (record_fact ->> 'ownerGroupId')::uuid;
    else
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'ownership_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if (ownership_mode = 'organization_account' and target_kind <> 'organization_account')
      or (ownership_mode = 'group' and target_kind <> 'group')
      or previous_owner_id is null or previous_owner_id = target_id
      or not vortex_access.lock_active_record_ownership_target_internal(target_kind, target_id) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'owner_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    execute pg_catalog.format(
      'update record_data.%I as stored set owner_organisation_account_id = $3,
         owner_group_id = $4, concurrency_number = concurrency_number + 1,
         updated_at = pg_catalog.statement_timestamp(), updated_by = $5
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.concurrency_number = $6 returning stored.record_id, stored.concurrency_number',
      loaded ->> 'table'
    ) into updated_record_id, updated_concurrency_number using organization_id_value, p_record_id,
      case when target_kind = 'organization_account' then target_id else null end,
      case when target_kind = 'group' then target_id else null end,
      actor_id_value, p_expected_concurrency_number;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Record ownership transfer revision changed';
    end if;
    if updated_record_id is distinct from p_record_id
      or updated_concurrency_number is null
      or updated_concurrency_number not between 1 and 9007199254740991 then
      raise exception using errcode = '55000', message = 'Record ownership transfer saved identity is unavailable';
    end if;
    perform vortex_access.invalidate_preview_installations_internal(organization_id_value);
    perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[p_record_id]::uuid[], array[]::uuid[], 'completed');
    event_result := vortex_platform.append_record_occurrences(
      (record_type_fact ->> 'storageContractId')::uuid,
      p_record_id, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', 'reassigned', 'recordTypeId', p_record_type_id
        ), 'payload', pg_catalog.jsonb_build_object('kind', 'reassigned')
      ))
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    perform vortex_record.complete_command_receipt_internal(
      'record_save', p_command_id,
      pg_catalog.jsonb_build_object('recordId', p_record_id, 'concurrencyNumber', updated_concurrency_number),
      'Record ownership transfer receipt is stale'
    );
    if record_fact #>> '{recordScope,storageScope}' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          updated_record_id, updated_concurrency_number, 'changed',
          notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
        );
      exception when others then
        -- Invalidation is advisory after the protected transfer is complete.
        null;
      end;
    elsif record_fact #>> '{recordScope,storageScope}' = 'organization_shared' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
          raise exception using errcode = '22003',
            message = 'Shared ownership transfer notice sequence is unavailable';
        end if;

        if record_fact -> 'recordScope' ->> 'moduleRootId'
            is distinct from record_type_fact ->> 'moduleRootId'
          or record_fact -> 'recordScope' ->> 'storageContractId'
            is distinct from record_type_fact ->> 'storageContractId'
          or not vortex_platform.is_non_nil_uuid(record_fact -> 'recordScope' ->> 'moduleRootId')
          or not vortex_platform.is_non_nil_uuid(record_type_fact ->> 'storageContractId') then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer record lineage is unavailable';
        end if;

        shared_consumers_initial := vortex_definition.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if pg_catalog.jsonb_typeof(shared_consumers_initial) is distinct from 'object'
          or not (shared_consumers_initial ?& array['organizationId', 'accessVersion', 'targets'])
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(shared_consumers_initial)) <> 3
          or shared_consumers_initial ->> 'organizationId' is distinct from organization_id_value::text
          or not pg_catalog.pg_input_is_valid(shared_consumers_initial ->> 'accessVersion', 'bigint')
          or (shared_consumers_initial ->> 'accessVersion')::bigint
            is distinct from (context_value ->> 'accessVersion')::bigint
          or pg_catalog.jsonb_typeof(shared_consumers_initial -> 'targets') is distinct from 'array'
          or pg_catalog.jsonb_array_length(shared_consumers_initial -> 'targets') = 0 then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer consumer selection is malformed';
        end if;

        previous_target_application_root_id := null;
        origin_application_is_consumer := false;
        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          if pg_catalog.jsonb_typeof(target_item) is distinct from 'object'
            or not (target_item ?& array[
              'applicationRootId', 'applicationReleaseRevision', 'moduleRootId',
              'moduleReleaseRevision', 'bindingRevision', 'recordTypeId',
              'storageContractId', 'registrationRevision', 'definitionKey',
              'releaseVersion', 'validationContractVersion', 'contentFingerprint',
              'resolutionFingerprint', 'catalogueFingerprint', 'moduleBindings'
            ])
            or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(target_item)) <> 15
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'applicationRootId')
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'moduleRootId')
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'storageContractId')
            or not pg_catalog.pg_input_is_valid(target_item ->> 'applicationReleaseRevision', 'bigint')
            or (target_item ->> 'applicationReleaseRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'moduleRootId' is distinct from record_fact -> 'recordScope' ->> 'moduleRootId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'moduleReleaseRevision', 'bigint')
            or (target_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
            or not pg_catalog.pg_input_is_valid(target_item ->> 'bindingRevision', 'bigint')
            or (target_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'recordTypeId' is distinct from p_record_type_id::text
            or target_item ->> 'storageContractId'
              is distinct from record_type_fact ->> 'storageContractId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'registrationRevision', 'bigint')
            or (target_item ->> 'registrationRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'definitionKey' is null or target_item ->> 'definitionKey' = ''
            or target_item ->> 'releaseVersion' is null or target_item ->> 'releaseVersion' = ''
            or target_item ->> 'validationContractVersion' is null
            or target_item ->> 'validationContractVersion' = ''
            or target_item ->> 'contentFingerprint' is null
            or target_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'resolutionFingerprint' is null
            or target_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'catalogueFingerprint' is null
            or target_item ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or pg_catalog.jsonb_typeof(target_item -> 'moduleBindings') is distinct from 'array'
            or pg_catalog.jsonb_array_length(target_item -> 'moduleBindings') = 0 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer evidence is malformed';
          end if;

          target_application_root_id := (target_item ->> 'applicationRootId')::uuid;
          if previous_target_application_root_id is not null
            and target_application_root_id <= previous_target_application_root_id then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer set is not unique and ordered';
          end if;
          previous_target_application_root_id := target_application_root_id;
          if target_application_root_id = application_root_id_value then
            origin_application_is_consumer := true;
          end if;

          previous_target_module_root_id := null;
          target_module_binding_count := 0;
          for module_item in
            select binding.value
            from pg_catalog.jsonb_array_elements(target_item -> 'moduleBindings') as binding(value)
            order by (binding.value ->> 'moduleRootId')::uuid
          loop
            if pg_catalog.jsonb_typeof(module_item) is distinct from 'object'
              or not (module_item ?& array[
                'moduleRootId', 'bindingRevision', 'applicationReleaseRevision',
                'moduleReleaseRevision', 'state', 'contentFingerprint',
                'resolutionFingerprint', 'generatorContractVersion', 'storageContractIds'
              ])
              or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(module_item)) <> 9
              or not vortex_platform.is_non_nil_uuid(module_item ->> 'moduleRootId')
              or not pg_catalog.pg_input_is_valid(module_item ->> 'bindingRevision', 'bigint')
              or (module_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
              or not pg_catalog.pg_input_is_valid(module_item ->> 'applicationReleaseRevision', 'bigint')
              or (module_item ->> 'applicationReleaseRevision')::bigint
                is distinct from (target_item ->> 'applicationReleaseRevision')::bigint
              or not pg_catalog.pg_input_is_valid(module_item ->> 'moduleReleaseRevision', 'bigint')
              or (module_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
              or module_item ->> 'state' is distinct from 'active'
              or module_item ->> 'contentFingerprint' is null
              or module_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'resolutionFingerprint' is null
              or module_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'generatorContractVersion' is distinct from '1.0.0'
              or pg_catalog.jsonb_typeof(module_item -> 'storageContractIds') is distinct from 'array'
              or pg_catalog.jsonb_array_length(module_item -> 'storageContractIds') = 0
              or exists (
                select 1
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                where pg_catalog.jsonb_typeof(contract.value) is distinct from 'string'
                  or not vortex_platform.is_non_nil_uuid(contract.value #>> '{}')
              )
              or exists (
                select contract.value
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                group by contract.value having pg_catalog.count(*) <> 1
              )
              or module_item -> 'storageContractIds' is distinct from (
                select pg_catalog.jsonb_agg(contract.value order by (contract.value #>> '{}')::uuid)
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
              ) then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module binding evidence is malformed';
            end if;

            target_module_root_id := (module_item ->> 'moduleRootId')::uuid;
            if previous_target_module_root_id is not null
              and target_module_root_id <= previous_target_module_root_id then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module bindings are not unique and ordered';
            end if;
            previous_target_module_root_id := target_module_root_id;
            if target_module_root_id = (target_item ->> 'moduleRootId')::uuid then
              target_module_binding_count := target_module_binding_count + 1;
              if (module_item ->> 'moduleReleaseRevision')::bigint
                  is distinct from (target_item ->> 'moduleReleaseRevision')::bigint
                or (module_item ->> 'bindingRevision')::bigint
                  is distinct from (target_item ->> 'bindingRevision')::bigint
                or not exists (
                  select 1
                  from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                  where contract.value #>> '{}' = target_item ->> 'storageContractId'
                ) then
                raise exception using errcode = '55000',
                  message = 'Shared ownership transfer target binding does not match its complete Module lineage';
              end if;
            end if;
          end loop;
          if target_module_binding_count <> 1 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer target Module binding is ambiguous';
          end if;
        end loop;

        if not origin_application_is_consumer then
          raise exception using errcode = '42501',
            message = 'Origin Application is not a proved shared record consumer';
        end if;

        shared_consumers_final := vortex_definition.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if shared_consumers_final is distinct from shared_consumers_initial then
          raise exception using errcode = '40001',
            message = 'Shared ownership transfer consumer snapshot changed before publication';
        end if;
        context_after := vortex_access.validated_human_request_context();
        if context_after is distinct from context_value then
          raise exception using errcode = '40001',
            message = 'Human ownership transfer context changed before publication';
        end if;

        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          perform vortex_platform.publish_change_notice(
            organization_id_value, (target_item ->> 'applicationRootId')::uuid,
            p_record_type_id, updated_record_id, updated_concurrency_number, 'changed',
            notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
          );
        end loop;
      exception when others then
        -- The completed transfer is structural. All App-scoped notices are one
        -- advisory subtransaction, so a failure rolls back every send together.
        null;
      end;
    else
      raise exception using errcode = '55000',
        message = 'Ownership transfer storage scope is unavailable';
    end if;
    -- This is deliberately an undisclosed result: an authorised transfer may
    -- remove the operator's read path.  A post-write projection would turn that
    -- valid committed mutation into a rollback.  Exact replay still applies
    -- current disclosure separately above.
    return pg_catalog.jsonb_build_object(
      'outcome', 'transferred', 'recordId', updated_record_id,
      'concurrencyNumber', updated_concurrency_number,
      'correlationId', context_value -> 'correlationId', 'replayed', false
    );
  end if;

  return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
end
$function$;

alter function vortex_record.apply_lifecycle_record_changes_internal(text,uuid,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_record_adapter;
comment on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Private ownership-transfer implementation reached through the shared mutation core, retaining its exact transfer authority, receipt, Activity and Event checks.';

create or replace function vortex_record.prepare_record_update_internal(
  p_command_id uuid,
  p_command_kind text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_final_values jsonb,
  p_activity_id uuid,
  p_action jsonb,
  p_meta jsonb,
  p_loaded jsonb default null,
  p_memo jsonb default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_mode boolean := p_action is not null;
  receipt_kind text := p_command_kind;
  action_owner_kind text := p_action ->> 'ownerKind';
  action_owner_id uuid := (p_action ->> 'ownerId')::uuid;
  action_release_revision bigint := (p_action ->> 'releaseRevision')::bigint;
  action_id_value uuid := (p_action ->> 'actionId')::uuid;
  preview_installation jsonb := vortex_record.read_current_preview_installation_internal();
  effective_command_id uuid := p_command_id;
  organization_id_value uuid := (vortex_access.validated_human_request_context() ->> 'organizationId')::uuid;
  application_root_id_value uuid := (vortex_access.validated_human_request_context() ->> 'applicationRootId')::uuid;
  meta jsonb := p_meta;
  loaded jsonb;
  decision jsonb;
  mutation jsonb;
  relationship_changes jsonb := '[]'::jsonb;
  final_values jsonb := p_final_values;
  value_final_values jsonb := '{}'::jsonb;
  value_submitted_field_ids uuid[] := array[]::uuid[];
  relationship_change jsonb;
  storage_change jsonb;
  prepared_relationship jsonb;
  prepared_relationships jsonb;
  update_bounds jsonb;
  proposed_field_values jsonb;
  proposed_records jsonb;
  proposed_edges jsonb;
  proposed_facts jsonb;
  target_record_type_id uuid;
  target_record_id uuid;
  target_loaded jsonb;
  target_decision jsonb;
  activity_time timestamptz := pg_catalog.statement_timestamp();
  classification_value jsonb;
begin
  classification_value := vortex_record.classify_record_change_values_internal(
    p_record_type_id, final_values, meta, p_submitted_values,
    organization_id_value, application_root_id_value, receipt_kind, effective_command_id
  );
  if classification_value ->> 'outcome' <> 'classified' then
    return classification_value;
  end if;
  relationship_changes := classification_value -> 'relationshipChanges';
  value_final_values := classification_value -> 'valueFinalValues';
  select coalesce(pg_catalog.array_agg(item.value::uuid order by item.ordinality), array[]::uuid[])
  into value_submitted_field_ids
  from pg_catalog.jsonb_array_elements_text(classification_value -> 'valueSubmittedFieldIds')
    with ordinality item(value, ordinality);

  if action_mode then
    loaded := vortex_record.load_named_action_facts_internal(
      action_owner_kind, action_owner_id, action_release_revision,
      action_id_value, p_record_type_id, p_record_id, p_expected_concurrency_number
    );
  else
    loaded := coalesce(p_loaded, (vortex_record.load_record_access_facts_internal('update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', p_record_type_id, 'recordId', p_record_id, 'expectedConcurrencyNumber', p_expected_concurrency_number))) -> 0));
  end if;
  if loaded ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict',
      'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or (preview_installation is null
      and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object') then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  if preview_installation is null then
    decision := vortex_record.decide_record_access_internal(
      p_memo, meta -> 'declaration', p_record_id,
      (loaded -> 'facts') || pg_catalog.jsonb_build_object( 'binding', meta -> 'declaration' -> 'recordBinding' )
    );
    if decision ->> 'outcome' = 'refused' then
      if action_mode then
        activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
      else
        activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      end if;
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable'
      );
    elsif decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501',
        message = 'Record save authority is unavailable';
    end if;
    update_bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  else
    update_bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (meta ->> 'storageContractId')::uuid,
      meta -> 'recordType'
    );
    if update_bounds is null then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
  end if;
  for relationship_change in
    select item.value
    from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
    order by item.value ->> 'fieldId'
  loop
    if not exists (
      select 1
      from pg_catalog.jsonb_array_elements_text(
        update_bounds -> 'changeableFieldIds'
      ) as allowed(value)
      where pg_catalog.lower(allowed.value) =
        pg_catalog.lower(relationship_change ->> 'fieldId')
    ) then
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  -- Build the complete proposed source facts before the first mutation. A
  -- changed fixed relationship replaces its old edge; the exact validated
  -- target's private facts are loaded only inside this operation and are
  -- never returned. The same current update declaration must still allow the
  -- source under the complete proposed values and graph.
  proposed_field_values := (loaded -> 'fieldValues') || final_values;
  proposed_records := loaded -> 'facts' -> 'records';
  proposed_edges := loaded -> 'facts' -> 'edges';

  for relationship_change in
    select item.value
    from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
    order by item.value ->> 'fieldId'
  loop
    if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'null' then
      if pg_catalog.jsonb_typeof(relationship_change -> 'value') <> 'object'
        or not ((relationship_change -> 'value') ?& array['recordTypeId', 'recordId'])
        or (relationship_change -> 'value') - array['recordTypeId', 'recordId'] <> '{}'::jsonb
        or not pg_catalog.pg_input_is_valid(
          relationship_change -> 'value' ->> 'recordTypeId', 'uuid'
        )
        or not pg_catalog.pg_input_is_valid(
          relationship_change -> 'value' ->> 'recordId', 'uuid'
        )
        or (relationship_change -> 'value' ->> 'recordTypeId')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid
        or (relationship_change -> 'value' ->> 'recordId')::uuid =
          '00000000-0000-0000-0000-000000000000'::uuid then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
        );
      end if;
      target_record_type_id := (relationship_change -> 'value' ->> 'recordTypeId')::uuid;
      target_record_id := (relationship_change -> 'value' ->> 'recordId')::uuid;
      if not vortex_record.relationship_declares_target_internal(
        relationship_change -> 'relationship', target_record_type_id
      ) then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
        );
      end if;

      target_loaded := (vortex_record.load_record_access_facts_internal('read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', target_record_type_id, 'recordId', target_record_id))) -> 0);
      if target_loaded ->> 'outcome' <> 'loaded'
        or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
        );
      end if;
      -- Only a record of this application's own Module uses preview-owner authority.
      -- Borrowed records and live projections still need the builder's current permission.
      if preview_installation is not null
        and target_loaded ->> 'previewInstallationId' = preview_installation ->> 'previewInstallationId'
        and exists (
          select 1 from vortex_definition.roots as root
          where root.root_id = (target_loaded #>> '{recordTypeMeta,moduleRootId}')::uuid
            and root.owner_application_root_id = application_root_id_value
        ) then
        target_decision := pg_catalog.jsonb_build_object('outcome', 'allowed');
      else
        if pg_catalog.jsonb_array_length(
          target_loaded #> '{declaration,requiredPermissions}'
        ) = 0 then
          perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
          );
        end if;
        target_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', pg_catalog.jsonb_set(target_loaded -> 'declaration', '{authority}', '{"kind":"permission"}'::jsonb), 'recordId', target_record_id, 'facts', target_loaded -> 'facts'))) -> 0);
      end if;
      if target_decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_unavailable'
        );
      end if;

      proposed_records := proposed_records || (target_loaded -> 'facts' -> 'records');
      proposed_edges := proposed_edges || (target_loaded -> 'facts' -> 'edges');
    end if;
  end loop;

  -- The one canonical lock prelude: every changed link's target row is
  -- share-locked in relationship identity order here, after each target has
  -- passed the same access decision the writer re-checks and before any
  -- source data version or relationship edge identity is taken. Keeping all
  -- target row locks in one place means no writer orders them on its own.
  perform vortex_record.lock_record_change_targets_internal(
    meta -> 'recordType', organization_id_value, final_values
  );

  -- Target closures may reach the source through a currently permitted
  -- relationship route. Assemble all trusted closures first, then make the
  -- source authoritative exactly once so an old source copy cannot compete
  -- with the proposed values. Other repeated closure records are collapsed by
  -- their permanent Record identity.
  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case when unique_record.record_id = p_record_id
        then unique_record.value || pg_catalog.jsonb_build_object(
          'fieldValues', proposed_field_values
        )
        else unique_record.value end
      order by unique_record.record_id
    )
    from (
      select distinct on (
        (record.value -> 'recordScope' ->> 'recordId')::uuid
      )
        (record.value -> 'recordScope' ->> 'recordId')::uuid as record_id,
        record.value
      from pg_catalog.jsonb_array_elements(proposed_records) as record(value)
      order by (record.value -> 'recordScope' ->> 'recordId')::uuid,
        record.value::text collate "C"
    ) as unique_record
  ), '[]'::jsonb);

  -- Apply every changed fixed relationship after closure assembly. This one
  -- replacement pass removes old source edges even when a target closure
  -- contained them, then adds only the submitted non-null replacements.
  proposed_edges := coalesce((
    with retained_edges as (
      select edge.value
      from pg_catalog.jsonb_array_elements(proposed_edges) as edge(value)
      where not exists (
        select 1
        from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
        where (changed.value ->> 'relationshipId')::uuid =
            (edge.value ->> 'relationshipId')::uuid
          and (edge.value ->> 'fromRecordId')::uuid = p_record_id
      )
    ), replacement_edges as (
      select pg_catalog.jsonb_build_object(
        'relationshipId', changed.value -> 'relationshipId',
        'fromRecordId', p_record_id,
        'toRecordId', (changed.value -> 'value' ->> 'recordId')::uuid
      ) as value
      from pg_catalog.jsonb_array_elements(relationship_changes) as changed(value)
      where pg_catalog.jsonb_typeof(changed.value -> 'value') <> 'null'
    ), unique_edges as (
      select distinct candidate.value
      from (
        select retained.value from retained_edges as retained
        union all
        select replacement.value from replacement_edges as replacement
      ) as candidate(value)
    )
    select pg_catalog.jsonb_agg(unique_edge.value order by unique_edge.value)
    from unique_edges as unique_edge
  ), '[]'::jsonb);

  proposed_facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'records', proposed_records,
    'edges', proposed_edges
  );
  if preview_installation is null then
    decision := vortex_record.decide_record_access_internal(p_memo, loaded -> 'declaration', p_record_id, proposed_facts);
    if decision ->> 'outcome' <> 'allowed' then
      if action_mode then
        activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'execute_named_action', array[p_record_id]::uuid[], array[]::uuid[], 'refused');
      else
        activity_time := vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      end if;
      perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'proposed_record_refused'
      );
    end if;
  end if;
  if final_values = '{}'::jsonb then
    perform vortex_record.release_command_receipt_internal(receipt_kind, effective_command_id);
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'empty_base_update'
    );
  end if;
  if action_mode then
    mutation := vortex_record.prepare_named_action_record_change_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number,
      value_final_values, value_submitted_field_ids,
      action_owner_kind, action_owner_id, action_release_revision, action_id_value
    );
  else
    mutation := vortex_record.prepare_record_change_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number,
      value_final_values, value_submitted_field_ids, loaded, p_memo
    );
  end if;

  if mutation ->> 'outcome' = 'allowed' then
    storage_change := mutation -> 'storageChange';
    prepared_relationships := '[]'::jsonb;
    if preview_installation is null and pg_catalog.jsonb_array_length(relationship_changes) > 0 then
      perform vortex_record.bump_record_data_version_internal(
        organization_id_value, (meta ->> 'storageContractId')::uuid,
        case when meta ->> 'storageScope' = 'application_contained'
          then application_root_id_value else null end
      );
    end if;
    for relationship_change in
      select item.value
      from pg_catalog.jsonb_array_elements(relationship_changes) as item(value)
      order by (item.value ->> 'relationshipId')::uuid
    loop
      prepared_relationship := vortex_record.prepare_relationship_value_internal(
        p_record_type_id, p_record_id,
        (relationship_change ->> 'relationshipId')::uuid,
        relationship_change -> 'value', false
      );
      storage_change := pg_catalog.jsonb_set(storage_change, '{values}',
        (storage_change -> 'values') || pg_catalog.jsonb_build_object(
          prepared_relationship ->> 'column', prepared_relationship -> 'value'
        )
      );
      prepared_relationships := prepared_relationships ||
        pg_catalog.jsonb_build_array(prepared_relationship);
    end loop;
    mutation := mutation || pg_catalog.jsonb_build_object(
      'storageChange', storage_change, 'edgeChanges', prepared_relationships
    );
  end if;
  return mutation;
end
$function$;
alter function vortex_record.prepare_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb)
  owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_update_internal(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb) is
  'Private common update preparation for ordinary and named-action records: locks the current revision and relationship targets, checks current and proposed authority and field bounds, and returns one combined scalar/link storage mutation and its edges.';

create or replace function vortex_record.apply_record_mutations_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb,
  p_activity_id uuid,
  p_occurrence_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  preview_installation jsonb;
  offboarding_scope record;
  offboarding_transfer jsonb;
begin
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', case when preview_installation ->> 'outcome' = 'refused'
        then 'record_unavailable' else 'preview_effect_refused' end
    );
  end if;

  -- An account offboarding transfer of a retained row or of a detached installation's record has
  -- its own facts and the accounts.manage authority of the offboarding inventory, rechecked here
  -- for every record against the access version the inventory was disclosed at.
  if pg_catalog.jsonb_typeof(p_mutations) = 'array'
    and pg_catalog.jsonb_array_length(p_mutations) = 1
    and p_mutations -> 0 ->> 'kind' = 'offboarding_transfer' then
    offboarding_transfer := p_mutations -> 0;
    if pg_catalog.jsonb_typeof(offboarding_transfer -> 'expectedAccessVersion') is distinct from 'number'
      or pg_catalog.jsonb_typeof(offboarding_transfer -> 'sourceOrganizationAccountId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(offboarding_transfer -> 'targetId') is distinct from 'string' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    select authorized.* into strict offboarding_scope
    from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;
    if offboarding_scope.access_version
      is distinct from (offboarding_transfer ->> 'expectedAccessVersion')::bigint then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'access_changed');
    end if;
    return vortex_record.transfer_record_ownership_for_offboarding_internal(
      p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
      offboarding_transfer ->> 'targetKind', (offboarding_transfer ->> 'targetId')::uuid,
      p_activity_id, p_occurrence_id,
      (offboarding_transfer ->> 'sourceOrganizationAccountId')::uuid
    );
  end if;

  -- Access ownership transfer retains its exact protected authority and receipt.
  return vortex_record.apply_lifecycle_record_changes_internal(
    'transfer_ownership', p_command_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_mutations, p_activity_id, p_occurrence_id
  );
end
$function$;

alter function vortex_record.apply_record_mutations_internal(uuid,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_record_mutations_internal(
  uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_record_mutations_internal(
  uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_record_adapter;

comment on function vortex_record.apply_record_mutations_internal(
  uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'The private ownership-transfer core shared by the Access ownership and offboarding entries: an offboarding transfer rechecks the accounts.manage inventory scope and its access version; an ownership transfer applies through the protected lifecycle preparation. Record commands use apply_record_changes; previews refuse transfers.';

create or replace function vortex_record.complete_record_lifecycle_set_internal(
  p_command_id uuid,
  p_preparation jsonb,
  p_written jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  plan jsonb;
  subject_ids uuid[];
  event_kind text;
  event_result jsonb;
  revision_value bigint;
  notice_sequence bigint;
  storage_value record;
begin
  -- The journal has already deduplicated shared closures. Each effect emits
  -- once, irrespective of how many explicit roots reached the affected row.
  for effect_row in
    select effect.* from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = (context_value ->> 'organizationId')::uuid
      and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = p_command_id
    order by effect.effect_sequence
  loop
    if effect_row.effect_kind in ('soft_deleted', 'optional_cleared') then
      event_kind := case effect_row.effect_kind when 'soft_deleted' then 'deleted' else 'unlinked' end;
      event_result := vortex_platform.append_record_occurrences(
        effect_row.storage_contract_id, effect_row.record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', pg_catalog.gen_random_uuid(),
          'descriptor', pg_catalog.jsonb_build_object('kind', 'standard',
            'eventKind', event_kind, 'recordTypeId', effect_row.record_type_id),
          'payload', pg_catalog.jsonb_build_object('kind', event_kind)
        ))
      );
      if pg_catalog.jsonb_typeof(event_result) is distinct from 'array'
        or pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
        raise exception using errcode = '55000', message = 'Record lifecycle Event append failed';
      end if;
    end if;
  end loop;
  -- Restore has no standard Event contract yet. Every changed lifecycle row
  -- still publishes its revision, including optional links cleared or recovered.
  for storage_value in
    select effect.record_type_id, effect.record_id, effect.storage_contract_id,
      storage.storage_scope, pg_catalog.bool_or(effect.effect_kind = 'soft_deleted') as deleted
    from vortex_record.record_lifecycle_command_effects as effect
    join vortex_record.storage_catalogue as storage using (storage_contract_id)
    where effect.organization_id = (context_value ->> 'organizationId')::uuid
      and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = p_command_id
    group by effect.record_type_id, effect.record_id, effect.storage_contract_id, storage.storage_scope
  loop
    select (item.value ->> 'concurrencyNumber')::bigint into strict revision_value
    from pg_catalog.jsonb_array_elements(p_written) as item(value)
    where (item.value ->> 'storageContractId')::uuid = storage_value.storage_contract_id
      and (item.value ->> 'recordId')::uuid = storage_value.record_id;
    if storage_value.storage_scope = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::pg_catalog.regclass);
        perform vortex_platform.publish_change_notice(
          (context_value ->> 'organizationId')::uuid, (context_value ->> 'applicationRootId')::uuid,
          storage_value.record_type_id, storage_value.record_id, revision_value,
          case when storage_value.deleted then 'deleted' else 'changed' end,
          notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
        );
      exception when others then
        raise warning 'Record lifecycle notice failed: [%] %', sqlstate, sqlerrm;
      end;
    end if;
  end loop;
  for storage_value in
    select distinct effect.storage_contract_id, storage.storage_scope
    from vortex_record.record_lifecycle_command_effects as effect
    join vortex_record.storage_catalogue as storage using (storage_contract_id)
    where effect.organization_id = (context_value ->> 'organizationId')::uuid
      and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = p_command_id and (storage.storage_scope <> 'application_contained'
        or effect.effect_kind in ('optional_cleared', 'links_restored'))
  loop
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid, storage_value.storage_contract_id,
      case when storage_value.storage_scope = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end
    );
  end loop;
  for plan in select item.value from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
    where item.value #>> '{subject,operation}' in ('delete', 'restore')
  loop
    select pg_catalog.array_agg(distinct effect.record_id order by effect.record_id) into subject_ids
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = (context_value ->> 'organizationId')::uuid
      and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = p_command_id
      and effect.delete_roots @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', plan #> '{subject,recordTypeId}', 'recordId', plan #> '{subject,recordId}'
      ));
    if subject_ids is null then
      raise exception using errcode = '55000', message = 'Record lifecycle effects are unavailable';
    end if;
    perform vortex_record.append_record_activity_internal(
      (plan #>> '{subject,activityId}')::uuid,
      case plan #>> '{subject,operation}' when 'delete' then 'delete_record' else 'restore_record' end,
      subject_ids, array[]::uuid[], 'completed'
    );
  end loop;
end
$function$;
alter function vortex_record.complete_record_lifecycle_set_internal(uuid,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.complete_record_lifecycle_set_internal(uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.complete_record_lifecycle_set_internal(uuid,jsonb,jsonb) is
  'Completes the common record command lifecycle effects: one Event per deduplicated delete effect, current revisions and data versions for changed rows, and Activity for each explicit lifecycle root.';

create or replace function vortex_record.apply_record_changes(
  p_command_id uuid,
  p_subjects jsonb,
  p_parent_mutations jsonb,
  p_named jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  calculation jsonb;
  receipt jsonb;
  prepared jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  parent_value jsonb;
  parent_record jsonb;
  parent_plan jsonb;
  parent_plans jsonb := '[]'::jsonb;
  reduced_values jsonb;
  catalogue jsonb;
  persisted jsonb;
  plan jsonb;
  subject jsonb;
  saved jsonb;
  projection jsonb;
  result_values jsonb := '[]'::jsonb;
  receipt_results jsonb := '[]'::jsonb;
  changed_fields uuid[];
  event_result jsonb;
  notice_sequence bigint;
  effective_command_id uuid;
  preview_installation jsonb;
  storage_set jsonb;
  previous_lifecycle_command text;
  named_roles jsonb;
  named_subject jsonb;
  named_results jsonb := '[]'::jsonb;
  named_receipt jsonb := '[]'::jsonb;
  persisted_results jsonb := '[]'::jsonb;
  projections jsonb := '{}'::jsonb;
  batch_projection jsonb;
  batch_type record;
begin
  if pg_catalog.jsonb_typeof(p_parent_mutations) is distinct from 'array'
    or (p_named is not null and pg_catalog.jsonb_typeof(p_named) is distinct from 'object') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  preview_installation := vortex_record.read_current_preview_installation_internal();
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'preview_unavailable');
  end if;
  -- The locked preparation of this command earlier in this transaction: its rows stay locked,
  -- so only revisions are checked again below, by the change-set preparation.
  calculation := vortex_record.retain_record_change_preparation_internal(
    effective_command_id, p_subjects, p_named, null
  );
  if calculation is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_calculation_changed');
  end if;
  -- The writer independently derives the exact affected parent identities,
  -- revisions and generated fields; the caller cannot omit or add a parent.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'recordTypeId', item.value -> 'recordTypeId', 'recordId', item.value -> 'recordId',
    'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
    'finalFieldIds', coalesce((select pg_catalog.jsonb_agg(field.value ->> 'fieldId' order by field.value ->> 'fieldId')
      from pg_catalog.jsonb_array_elements(item.value #> '{recordType,fields}') as field(value)
      where field.value ->> 'type' in ('total', 'calculation')), '[]'::jsonb)
  ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'), '[]'::jsonb)
  into expected_parents
  from pg_catalog.jsonb_array_elements(calculation -> 'records') as item(value)
  where not exists (select 1 from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as root(value, ordinality)
    where 'intent:' || (root.ordinality - 1)::text = item.value ->> 'recordKey'
      and root.value ->> 'operation' in ('create', 'update'))
    and not exists (select 1 from pg_catalog.jsonb_array_elements(calculation -> 'lifecycleChanges') as changed(value)
      where changed.value -> 'recordKey' = item.value -> 'recordKey' and changed.value ->> 'operation' = 'delete');
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'recordTypeId', item.value -> 'recordTypeId', 'recordId', item.value -> 'recordId',
    'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
    'finalFieldIds', coalesce((select pg_catalog.jsonb_agg(field.key order by field.key)
      from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') as field(key)), '[]'::jsonb)
  ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'), '[]'::jsonb)
  into supplied_parents
  from pg_catalog.jsonb_array_elements(p_parent_mutations) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and item.value ?& array['recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues']
    and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
  if supplied_parents is distinct from expected_parents
    or pg_catalog.jsonb_array_length(supplied_parents) <> pg_catalog.jsonb_array_length(p_parent_mutations) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_calculation_changed');
  end if;
  receipt := vortex_record.claim_command_receipt_internal('record_changes', effective_command_id, false);
  if receipt ->> 'status' = 'completed' then
    return vortex_record.replay_record_changes_internal(effective_command_id, receipt -> 'result');
  elsif receipt ->> 'status' is distinct from 'claimed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_identity_conflict');
  end if;
  named_roles := calculation -> 'namedRoles';
  if pg_catalog.jsonb_typeof(named_roles) is distinct from 'object' then named_roles := null; end if;
  if pg_catalog.jsonb_array_length(p_subjects) = 0 then
    prepared := pg_catalog.jsonb_build_object('outcome', 'prepared', 'plans', '[]'::jsonb,
      'storageChanges', '[]'::jsonb, 'edgeChanges', '[]'::jsonb, 'effects', '[]'::jsonb);
  else
    prepared := vortex_record.prepare_record_change_set_internal(effective_command_id, p_subjects, named_roles);
  end if;
  if prepared ->> 'outcome' is distinct from 'prepared' then
    perform vortex_record.release_command_receipt_internal('record_changes', effective_command_id);
    return prepared;
  end if;
  -- A subject the action deletes announces against the values it held; the
  -- delete itself is one of this command's lifecycle intents.
  if named_roles is not null and preview_installation is null then
    for named_subject in
      select item.value from pg_catalog.jsonb_array_elements(named_roles -> 'subjects') as item(value)
      where (item.value ->> 'deletes')::boolean
    loop
      perform vortex_record.complete_named_record_subject_internal(named_roles, named_subject,
        named_subject -> 'existingValues');
    end loop;
  end if;
  catalogue := case when pg_catalog.jsonb_array_length(p_parent_mutations) > 0
    then vortex_record.relationship_total_catalogue_internal() else '{}'::jsonb end;
  if pg_catalog.jsonb_array_length(prepared -> 'effects') > 0 then
    -- Proposed snapshots are needed for restored rows, still deleted on disk.
    storage_set := vortex_record.prepare_record_storage_set_internal((
      select pg_catalog.jsonb_agg(item.value)
      from pg_catalog.jsonb_array_elements(prepared -> 'storageChanges') as item(value)
      where exists (select 1 from pg_catalog.jsonb_array_elements(prepared -> 'effects') as effect(value)
        where effect.value -> 'storageContractId' = item.value -> 'storageContractId'
          and effect.value -> 'recordId' = item.value -> 'recordId')
    ));
    catalogue := catalogue || pg_catalog.jsonb_build_object('proposedRecords', storage_set -> 'proposedRecords');
    previous_lifecycle_command := pg_catalog.current_setting('vortex_record.lifecycle_command_id', true);
    perform pg_catalog.set_config('vortex_record.lifecycle_command_id', effective_command_id::text, true);
    perform vortex_record.append_record_lifecycle_effect_internal(prepared -> 'effects');
    perform pg_catalog.set_config('vortex_record.lifecycle_command_id', coalesce(previous_lifecycle_command, ''), true);
  end if;
  for parent_value in select item.value from pg_catalog.jsonb_array_elements(p_parent_mutations) as item(value)
  loop
    select item.value into strict parent_record
    from pg_catalog.jsonb_array_elements(calculation -> 'records') as item(value)
    where item.value -> 'recordTypeId' = parent_value -> 'recordTypeId'
      and item.value -> 'recordId' = parent_value -> 'recordId';
    select coalesce(pg_catalog.jsonb_object_agg(field.key, field.value), '{}'::jsonb) into reduced_values
    from pg_catalog.jsonb_each(parent_value -> 'finalValues') as field(key, value)
    where field.value is distinct from coalesce(parent_record -> 'existingValues' -> field.key, 'null'::jsonb);
    parent_plan := vortex_record.prepare_relationship_total_parent_internal(
      (parent_value ->> 'recordTypeId')::uuid, (parent_value ->> 'recordId')::uuid,
      (parent_value ->> 'expectedConcurrencyNumber')::bigint, reduced_values, catalogue
    );
    if parent_plan is not null then
      parent_plans := parent_plans || pg_catalog.jsonb_build_array(parent_plan);
      prepared := pg_catalog.jsonb_set(prepared, '{storageChanges}',
        (prepared -> 'storageChanges') || pg_catalog.jsonb_build_array(parent_plan -> 'storageChange'));
    end if;
  end loop;
  if pg_catalog.jsonb_array_length(prepared -> 'plans') > 0 then
    persisted := vortex_record.apply_prepared_record_set_internal(prepared);
    persisted_results := persisted -> 'results';
  end if;
  if pg_catalog.jsonb_array_length(prepared -> 'effects') > 0 then
    perform vortex_record.complete_record_lifecycle_set_internal(effective_command_id, prepared, persisted -> 'written');
  end if;
  -- The result answers with each saved record's projection, read once per record type for the
  -- whole set with one access decision pass; capabilities are not read here.
  for batch_type in
    select (item.value #>> '{subject,recordTypeId}')::uuid as record_type_id,
      (pg_catalog.array_agg(item.value #>> '{meta,storageContractId}'))[1]::uuid as storage_contract_id,
      (pg_catalog.array_agg(item.value #> '{meta,recordType}'))[1] as record_type_item,
      pg_catalog.array_agg((persisted_results -> (item.value ->> 'index')::integer ->> 'recordId')::uuid
        order by (item.value ->> 'index')::integer) as record_ids
    from pg_catalog.jsonb_array_elements(prepared -> 'plans') as item(value)
    where item.value #>> '{subject,operation}' in ('create', 'update')
    group by (item.value #>> '{subject,recordTypeId}')::uuid
  loop
    select pg_catalog.jsonb_object_agg(read.record_id::text, read.result) into batch_projection
    from vortex_record.read_record_batch_internal(
      batch_type.record_type_id, batch_type.record_ids, preview_installation is not null,
      batch_type.storage_contract_id, batch_type.record_type_item
    ) as read;
    projections := projections || coalesce(batch_projection, '{}'::jsonb);
  end loop;
  for plan in select item.value from pg_catalog.jsonb_array_elements(prepared -> 'plans') as item(value)
    order by (item.value ->> 'index')::integer
  loop
    subject := plan -> 'subject';
    saved := persisted_results -> (plan ->> 'index')::integer;
    if subject ->> 'operation' in ('delete', 'restore') then
      receipt_results := receipt_results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'operation', subject -> 'operation', 'recordTypeId', subject -> 'recordTypeId',
        'recordId', saved -> 'recordId', 'concurrencyNumber', saved -> 'concurrencyNumber',
        'unrestoredLinkCount', coalesce(plan #> '{prepared,unrestoredLinkCount}', '0'::jsonb)
      ));
      result_values := result_values || pg_catalog.jsonb_build_array(saved || pg_catalog.jsonb_build_object(
        'correlationId', context_value -> 'correlationId', 'replayed', false,
        'unrestoredLinkCount', coalesce(plan #> '{prepared,unrestoredLinkCount}', '0'::jsonb)
      ));
      continue;
    end if;
    perform vortex_platform.attach_record_files_internal(
      (subject ->> 'recordTypeId')::uuid, (saved ->> 'recordId')::uuid,
      plan #> '{meta,recordType}', subject -> 'finalValues'
    );
    select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[]) into changed_fields
    from pg_catalog.jsonb_object_keys(case when subject ->> 'operation' = 'create'
      then saved -> 'values' else subject -> 'finalValues' end) as key;
    if preview_installation is null then
      perform vortex_record.append_record_activity_internal(
        (subject ->> 'activityId')::uuid,
        case when plan ? 'role' and plan -> 'role' <> 'null'::jsonb then 'execute_named_action'
          when subject ->> 'operation' = 'create' then 'create_record' else 'update_record' end,
        array[(saved ->> 'recordId')::uuid], changed_fields, 'completed'
      );
      event_result := vortex_platform.append_record_occurrences(
        (plan #>> '{meta,storageContractId}')::uuid, (saved ->> 'recordId')::uuid,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', subject -> 'occurrenceId',
          'descriptor', pg_catalog.jsonb_build_object(
            'kind', 'standard', 'recordTypeId', subject -> 'recordTypeId',
            'eventKind', case when subject ->> 'operation' = 'create' then 'created' else 'changed' end
          ),
          'payload', case when subject ->> 'operation' = 'create'
            then pg_catalog.jsonb_build_object('kind', 'created')
            else pg_catalog.jsonb_build_object('kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_fields)) end
        ))
      );
      if pg_catalog.jsonb_typeof(event_result) is distinct from 'array'
        or pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
        raise exception using errcode = '55000', message = 'Record change Event append failed';
      end if;
      if subject ->> 'operation' = 'update' and (
        plan #>> '{meta,storageScope}' = 'application_contained'
        or plan #>> '{meta,recordType,systemProjection,protectedView}' = 'organization_runtime_settings'
      ) then
        begin
          notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::pg_catalog.regclass);
          perform vortex_platform.publish_change_notice(
            (context_value ->> 'organizationId')::uuid, (context_value ->> 'applicationRootId')::uuid,
            (subject ->> 'recordTypeId')::uuid, (saved ->> 'recordId')::uuid,
            (saved ->> 'concurrencyNumber')::bigint, 'changed', notice_sequence, notice_sequence,
            (context_value ->> 'correlationId')::uuid
          );
        exception when others then
          raise warning 'Record change notice failed: [%] %', sqlstate, sqlerrm;
        end;
      end if;
    end if;
    projection := projections -> (saved ->> 'recordId');
    if projection ->> 'outcome' is distinct from 'allowed' then
      raise exception using errcode = '42501', message = 'Changed record projection is unavailable';
    end if;
    receipt_results := receipt_results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'operation', subject -> 'operation', 'recordTypeId', subject -> 'recordTypeId', 'recordId', saved -> 'recordId',
      'concurrencyNumber', saved -> 'concurrencyNumber'
    ));
    result_values := result_values || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'outcome', 'saved', 'recordTypeId', subject -> 'recordTypeId', 'recordId', saved -> 'recordId',
      'concurrencyNumber', saved -> 'concurrencyNumber', 'values', projection -> 'values',
      'correlationId', context_value -> 'correlationId',
      'backgroundDelivery', case when preview_installation is null then 'pending' else 'none' end,
      'replayed', false
    ));
  end loop;
  for parent_plan in select item.value from pg_catalog.jsonb_array_elements(parent_plans) as item(value)
    where not exists (select 1 from pg_catalog.jsonb_array_elements(calculation -> 'lifecycleProposals') as changed(value)
      where changed.value -> 'recordTypeId' = item.value -> 'recordTypeId'
        and changed.value -> 'recordId' = item.value -> 'recordId')
  loop
    perform vortex_record.complete_relationship_total_parent_internal(parent_plan);
  end loop;
  -- Each named subject records the action once, announces its declared Events
  -- against the values it was left with, and answers through the action's projection.
  if named_roles is not null then
    for named_subject in
      select item.value from pg_catalog.jsonb_array_elements(named_roles -> 'subjects') as item(value)
      order by (item.value ->> 'position')::integer
    loop
      if (named_subject ->> 'deletes')::boolean then
        named_results := named_results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'outcome', 'completed', 'recordId', named_subject -> 'recordId',
          'concurrencyNumber', (named_subject ->> 'expectedConcurrencyNumber')::bigint + 1,
          'values', '{}'::jsonb, 'correlationId', context_value -> 'correlationId',
          'backgroundDelivery', 'pending', 'replayed', false
        ));
        named_receipt := named_receipt || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'recordId', named_subject -> 'recordId', 'deleted', true,
          'concurrencyNumber', (named_subject ->> 'expectedConcurrencyNumber')::bigint + 1
        ));
        continue;
      end if;
      if preview_installation is null then
        perform vortex_record.complete_named_record_subject_internal(named_roles, named_subject, null);
      end if;
      projection := vortex_record.project_named_action_record_internal(
        named_subject #>> '{action,ownerKind}', (named_subject #>> '{action,ownerId}')::uuid,
        (named_subject #>> '{action,releaseRevision}')::bigint, (named_subject #>> '{action,actionId}')::uuid,
        (named_roles ->> 'recordTypeId')::uuid, (named_subject ->> 'recordId')::uuid
      );
      if projection ->> 'outcome' is distinct from 'completed' then
        raise exception using errcode = '42501', message = 'Named action subject projection is unavailable';
      end if;
      named_results := named_results || pg_catalog.jsonb_build_array(projection || pg_catalog.jsonb_build_object(
        'correlationId', context_value -> 'correlationId', 'replayed', false
      ));
      named_receipt := named_receipt || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordId', named_subject -> 'recordId', 'deleted', false
      ));
    end loop;
  end if;
  perform vortex_record.complete_command_receipt_internal(
    'record_changes', effective_command_id, pg_catalog.jsonb_build_object('results', receipt_results)
      || case when named_roles is null then '{}'::jsonb else pg_catalog.jsonb_build_object('named',
        pg_catalog.jsonb_build_object('action', p_named -> 'action', 'recordTypeId', named_roles -> 'recordTypeId',
          'subjects', named_receipt)) end,
    'Record change receipt is stale'
  );
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'results', result_values, 'replayed', false,
    'recordCount', calculation -> 'recordCount')
    || case when named_roles is null then '{}'::jsonb
      else pg_catalog.jsonb_build_object('namedResults', named_results) end;
end
$function$;
alter function vortex_record.apply_record_changes(uuid,jsonb,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.apply_record_changes(uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_record_changes(uuid,jsonb,jsonb,jsonb) to vortex_request;
comment on function vortex_record.apply_record_changes(uuid,jsonb,jsonb,jsonb) is
  'Protected record-set persistence, the one public record writer (ordinary, or one named action over up to 200 subjects): takes the locked calculation its transaction prepared, re-checks revisions and all current authority, claims one receipt, merges roots and generated parents once per storage table, appends effects and completes the whole result atomically.';

create or replace function vortex_record.apply_record_storage_changes_internal(
  p_changes jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  storage_group record;
  storage_row vortex_record.storage_catalogue%rowtype;
  column_names text;
  source_columns text;
  assignments text;
  result_value jsonb := '[]'::jsonb;
  written jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Record storage changes are invalid';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or not (item.value ?& array['storageContractId', 'recordId', 'expectedConcurrencyNumber', 'values'])
      or item.value - array['storageContractId', 'recordId', 'expectedConcurrencyNumber', 'values']::text[] <> '{}'::jsonb
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'storageContractId')
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordId')
      or pg_catalog.jsonb_typeof(item.value -> 'values') is distinct from 'object'
      or (item.value -> 'values') ?| array['organisation_id', 'record_id']
      or (item.value -> 'expectedConcurrencyNumber' <> 'null'::jsonb and (
        pg_catalog.jsonb_typeof(item.value -> 'expectedConcurrencyNumber') <> 'number'
        or not pg_catalog.pg_input_is_valid(item.value ->> 'expectedConcurrencyNumber', 'bigint')
      ))
  ) or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by item.value -> 'storageContractId', item.value -> 'recordId'
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Record storage changes are invalid';
  end if;

  -- Callers have checked current and proposed authority, field policy and all
  -- relationship constraints. Storage identities come from those preparations;
  -- the request role cannot call this primitive or supply a physical table.
  for storage_group in
    select (item.value ->> 'storageContractId')::uuid as storage_contract_id,
      pg_catalog.jsonb_agg(item.value order by item.value ->> 'recordId') as changes
    from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by (item.value ->> 'storageContractId')::uuid
    order by (item.value ->> 'storageContractId')::uuid
  loop
    select storage.* into strict storage_row
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = storage_group.storage_contract_id;
    if storage_row.physical_schema_token is distinct from 'record_data'
      or storage_row.physical_table_token is null then
      raise exception using errcode = '55000', message = 'Record storage is unavailable';
    end if;
    select
      pg_catalog.string_agg(pg_catalog.format('%I', attribute.attname), ', ' order by attribute.attnum),
      pg_catalog.string_agg(pg_catalog.format('source.%I', attribute.attname), ', ' order by attribute.attnum),
      pg_catalog.string_agg(pg_catalog.format('%I = source.%I', attribute.attname, attribute.attname), ', ' order by attribute.attnum)
        filter (where attribute.attname not in ('organisation_id', 'record_id'))
    into column_names, source_columns, assignments
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = pg_catalog.to_regclass(pg_catalog.format(
      '%I.%I', storage_row.physical_schema_token, storage_row.physical_table_token
    )) and attribute.attnum > 0 and not attribute.attisdropped;
    if column_names is null or exists (
      select 1
      from pg_catalog.jsonb_array_elements(storage_group.changes) as item(value)
      cross join lateral pg_catalog.jsonb_object_keys(item.value -> 'values') as supplied(name)
      where not exists (
        select 1 from pg_catalog.pg_attribute as attribute
        where attribute.attrelid = pg_catalog.to_regclass(pg_catalog.format(
          '%I.%I', storage_row.physical_schema_token, storage_row.physical_table_token
        )) and attribute.attnum > 0 and not attribute.attisdropped
          and attribute.attname = supplied.name
      )
    ) then
      raise exception using errcode = '55000', message = 'Record storage columns disagree with the prepared change';
    end if;

    -- MERGE gives creates and updates of the same storage table one physical
    -- write statement. A missing update or an existing create matches neither
    -- permitted branch, so the count check rejects the entire transaction.
    execute pg_catalog.format(
      'with written as (
        merge into %1$I.%2$I as stored
        using (
          select (item.value ->> ''expectedConcurrencyNumber'')::bigint as expected_revision,
            candidate.*
          from pg_catalog.jsonb_array_elements($1) as item(value)
          left join %1$I.%2$I as current_record
            on current_record.organisation_id = $2
            and current_record.record_id = (item.value ->> ''recordId'')::uuid
          cross join lateral pg_catalog.jsonb_populate_record(null::%1$I.%2$I,
            coalesce(pg_catalog.to_jsonb(current_record), ''{}''::jsonb)
              || (item.value -> ''values'')
              || pg_catalog.jsonb_build_object(
                ''organisation_id'', $2, ''record_id'', item.value -> ''recordId'',
                ''concurrency_number'', coalesce((item.value ->> ''expectedConcurrencyNumber'')::bigint, 0) + 1,
                ''updated_at'', pg_catalog.statement_timestamp(), ''updated_by'', $3
              )
          ) as candidate
        ) as source
        on stored.organisation_id = $2 and stored.record_id = source.record_id
        when matched and source.expected_revision is not null
          and stored.concurrency_number = source.expected_revision
          then update set %3$s
        when not matched and source.expected_revision is null
          then insert (%4$s) values (%5$s)
        returning pg_catalog.jsonb_build_object(
          ''recordId'', stored.record_id, ''storageContractId'', stored.storage_contract_id,
          ''concurrencyNumber'', stored.concurrency_number
        ) as result
      ) select coalesce(pg_catalog.jsonb_agg(written.result), ''[]''::jsonb) from written',
      storage_row.physical_schema_token, storage_row.physical_table_token,
      assignments, column_names, source_columns
    ) into written using storage_group.changes, (context_value ->> 'organizationId')::uuid,
      (context_value ->> 'organizationAccountId')::uuid;
    if pg_catalog.jsonb_array_length(written) <> pg_catalog.jsonb_array_length(storage_group.changes) then
      raise exception using errcode = '40001', message = 'Record storage change revision is stale';
    end if;
    result_value := result_value || written;
  end loop;
  return result_value;
end
$function$;

alter function vortex_record.apply_record_storage_changes_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.apply_record_storage_changes_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.apply_record_storage_changes_internal(jsonb) is
  'Private physical record mutation primitive: merges already-authorized changes with one write per storage table, preserving unsupplied columns and rejecting stale revisions atomically.';

create or replace function vortex_record.apply_relationship_edges_internal(p_changes jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  organization_id_value uuid;
  changed_parent record;
begin
  organization_id_value := (vortex_access.validated_human_request_context() ->> 'organizationId')::uuid;
  if pg_catalog.jsonb_typeof(p_changes) is distinct from 'array' or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Relationship changes are invalid';
  end if;

  -- Every source is one declared fixed link. The shared participant locks and
  -- target eligibility checks have already run in relationship preparation.
  merge into vortex_record.relationship_edges as edge
  using (
    select (item.value ->> 'relationshipId')::uuid as relationship_id,
      (item.value ->> 'sourceStorageContractId')::uuid as source_storage_contract_id,
      (item.value ->> 'sourceRecordId')::uuid as source_record_id,
      (item.value ->> 'sourceApplicationRootId')::uuid as source_application_root_id,
      (item.value ->> 'targetStorageContractId')::uuid as target_storage_contract_id,
      (item.value ->> 'targetRecordId')::uuid as target_record_id,
      (item.value ->> 'targetApplicationRootId')::uuid as target_application_root_id
    from pg_catalog.jsonb_array_elements(p_changes) as item(value)
  ) as change
  on edge.relationship_id = change.relationship_id
    and edge.from_organisation_id = organization_id_value
    and edge.from_storage_contract_id = change.source_storage_contract_id
    and edge.from_record_id = change.source_record_id
  when matched and change.target_record_id is null then delete
  when matched then update set
    to_storage_contract_id = change.target_storage_contract_id,
    to_record_id = change.target_record_id,
    from_application_root_id = change.source_application_root_id,
    to_application_root_id = change.target_application_root_id
  when not matched and change.target_record_id is not null then insert (
    relationship_id, from_organisation_id, to_organisation_id,
    from_application_root_id, to_application_root_id,
    from_storage_contract_id, from_record_id, to_storage_contract_id, to_record_id
  ) values (
    change.relationship_id, organization_id_value, organization_id_value,
    change.source_application_root_id, change.target_application_root_id,
    change.source_storage_contract_id, change.source_record_id,
    change.target_storage_contract_id, change.target_record_id
  );

  -- Check the final set too: two newly supplied links must not each pass a
  -- check against the old graph and claim the same one-to-one target.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    join vortex_record.relationship_edges as edge
      on edge.relationship_id = (item.value ->> 'relationshipId')::uuid
      and edge.to_organisation_id = organization_id_value
      and edge.to_storage_contract_id = (item.value ->> 'targetStorageContractId')::uuid
      and edge.to_record_id = (item.value ->> 'targetRecordId')::uuid
      and edge.from_storage_contract_id = (item.value ->> 'sourceStorageContractId')::uuid
    where item.value ->> 'cardinality' = 'one_to_one'
    group by item.value
    having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '23514', message = 'Relationship cardinality is exceeded';
  end if;

  -- Checking each proposal against the old graph cannot detect a cycle formed
  -- by several proposals together. Reuse the parent checker on the final graph;
  -- preparation already holds its relationship-wide transaction lock.
  for changed_parent in
    select distinct (item.value ->> 'relationshipId')::uuid as relationship_id,
      (item.value ->> 'sourceStorageContractId')::uuid as storage_contract_id,
      (item.value ->> 'sourceRecordId')::uuid as source_record_id,
      (item.value ->> 'targetRecordId')::uuid as target_record_id,
      (relationship.value ->> 'fromFieldId')::uuid as field_id
    from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    join vortex_record.storage_catalogue as storage
      on storage.storage_contract_id = (item.value ->> 'sourceStorageContractId')::uuid
    cross join lateral pg_catalog.jsonb_array_elements(
      storage.record_type_definition -> 'relationships'
    ) as relationship(value)
    where relationship.value ->> 'relationshipId' = item.value ->> 'relationshipId'
      and relationship.value ->> 'cardinality' = 'many_to_one'
      and item.value -> 'sourceStorageContractId' = item.value -> 'targetStorageContractId'
      and item.value ->> 'targetRecordId' is not null
    order by relationship_id, storage_contract_id, source_record_id
  loop
    perform vortex_record.assert_relationship_acyclic_internal(
      changed_parent.relationship_id, organization_id_value,
      changed_parent.storage_contract_id, changed_parent.field_id,
      changed_parent.source_record_id, changed_parent.target_record_id
    );
  end loop;
end
$function$;

alter function vortex_record.apply_relationship_edges_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.apply_relationship_edges_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.apply_relationship_edges_internal(jsonb) is
  'Private set-based edge writer: applies prepared fixed-link replacements in one MERGE and checks cardinality and parent cycles on the final graph.';




create or replace function vortex_record.claim_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid,
  p_replay_only boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  tenant_id_value uuid;
  actor_id_value uuid;
  inserted_command_id uuid;
  receipt vortex_record.command_receipts%rowtype;
begin
  context_value := vortex_access.validated_human_request_context();
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  tenant_id_value := (context_value ->> 'tenantId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;

  -- The command id is claimed as pending (no result yet). A claim that finds an
  -- existing receipt locks it and classifies it; a replay-only read classifies
  -- without inserting or locking.
  if not p_replay_only then
    insert into vortex_record.command_receipts (
      command_id, organization_id, tenant_id, actor_id, command_kind
    ) values (
      p_command_id, organization_id_value, tenant_id_value, actor_id_value, p_command_kind
    )
    on conflict (command_id) do nothing
    returning command_id into inserted_command_id;
    if inserted_command_id is not null then
      return pg_catalog.jsonb_build_object('status', 'claimed');
    end if;
    select stored.* into receipt
    from vortex_record.command_receipts as stored
    where stored.command_id = p_command_id
    for update;
    if not found then
      raise exception using errcode = '40001',
        message = 'Command receipt was released while it was claimed';
    end if;
  else
    select stored.* into receipt
    from vortex_record.command_receipts as stored
    where stored.command_id = p_command_id;
    if not found then
      return pg_catalog.jsonb_build_object('status', 'none');
    end if;
  end if;

  -- A command id replays only inside the scope that stored it.
  if receipt.organization_id is distinct from organization_id_value
    or receipt.tenant_id is distinct from tenant_id_value
    or receipt.actor_id is distinct from actor_id_value
    or receipt.command_kind is distinct from p_command_kind then
    return pg_catalog.jsonb_build_object('status', 'identity_conflict');
  end if;
  if receipt.result is null then
    return pg_catalog.jsonb_build_object('status', 'pending');
  end if;
  return pg_catalog.jsonb_build_object(
    'status', 'completed',
    'result', receipt.result
  );
end
$function$;

alter function vortex_record.claim_command_receipt_internal(text,uuid,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.claim_command_receipt_internal(
  text, uuid, boolean
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.claim_command_receipt_internal(
  text, uuid, boolean
) to vortex_record_adapter;
comment on function vortex_record.claim_command_receipt_internal(
  text, uuid, boolean
) is
  'The one command-receipt claim and replay classifier. Claims the command id as pending, or classifies its receipt as identity_conflict (stored under another organisation, tenant, actor or command kind), pending or completed with its stored result; with p_replay_only it only reads, returning none when there is no receipt.';

create or replace function vortex_record.complete_command_receipt_internal(
  p_command_kind text,
  p_command_id uuid,
  p_result jsonb,
  p_stale_message text
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
begin
  if p_result is null then
    raise exception using errcode = '22023', message = 'Command result must not be null';
  end if;
  context_value := vortex_access.validated_human_request_context();
  update vortex_record.command_receipts as stored
  set result = p_result
  where stored.command_id = p_command_id
    and stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.tenant_id = (context_value ->> 'tenantId')::uuid
    and stored.actor_id = (context_value ->> 'organizationAccountId')::uuid
    and stored.command_kind = p_command_kind
    and stored.result is null;
  if not found then
    raise exception using errcode = '40001', message = p_stale_message;
  end if;
end
$function$;

alter function vortex_record.complete_command_receipt_internal(text,uuid,jsonb,text) owner to vortex_record_adapter;

revoke all on function vortex_record.complete_command_receipt_internal(
  text, uuid, jsonb, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.complete_command_receipt_internal(
  text, uuid, jsonb, text
) to vortex_record_adapter;
comment on function vortex_record.complete_command_receipt_internal(
  text, uuid, jsonb, text
) is
  'Completes the request scope''s pending command receipt with its result, or raises a 40001 stale-receipt error carrying the caller''s message when no pending receipt is left.';


create or replace function vortex_record.complete_relationship_total_parent_internal(p_prepared jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  snapshot jsonb := p_prepared -> 'snapshot';
  saved_record_id uuid := (p_prepared ->> 'recordId')::uuid;
  new_revision bigint := (p_prepared ->> 'concurrencyNumber')::bigint;
  changed_field_ids uuid[];
  preview_installation jsonb;
  pending_exact_notice boolean := false;
  notice_sequence bigint;
  event_result jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  select pg_catalog.array_agg(value::uuid) into changed_field_ids
  from pg_catalog.jsonb_array_elements_text(p_prepared -> 'changedFieldIds') as field(value);
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation is null
    and snapshot #>> '{recordType,storageScope}' = 'application_contained' then
    pending_exact_notice := true;
  else
    perform vortex_record.bump_record_data_version_internal(
      (context_value ->> 'organizationId')::uuid,
      (snapshot ->> 'storageContractId')::uuid,
      case when snapshot #>> '{recordType,storageScope}' = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end
    );
  end if;
  perform vortex_record.append_record_activity_internal(pg_catalog.gen_random_uuid(), 'update_record', array[saved_record_id]::uuid[], changed_field_ids, 'completed');
  event_result := vortex_platform.append_record_occurrences(
    (snapshot ->> 'storageContractId')::uuid, saved_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', pg_catalog.gen_random_uuid(),
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'changed', 'recordTypeId', (p_prepared ->> 'recordTypeId')::uuid
      ),
      'payload', pg_catalog.jsonb_build_object(
        'kind', 'changed', 'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids)
      )
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000', message = 'Relationship total parent Event append failed';
  end if;
  if pending_exact_notice then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      perform vortex_platform.publish_change_notice(
        (context_value ->> 'organizationId')::uuid,
        (context_value ->> 'applicationRootId')::uuid,
        (p_prepared ->> 'recordTypeId')::uuid, saved_record_id, new_revision, 'changed',
        notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
      );
    exception
      when others then
        -- Invalidation is advisory; a lost notice must not refuse the parent write.
        raise warning 'Generated record notice failed: [%] %', sqlstate, sqlerrm;
    end;
  end if;
end
$function$;

alter function vortex_record.complete_relationship_total_parent_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.complete_relationship_total_parent_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.complete_relationship_total_parent_internal(jsonb) is
  'Appends the Activity, standard Event and invalidation for a protected generated-field update after the shared record storage writer has applied it.';

create or replace function vortex_record.prepare_record_create_internal(
  p_record_type_id uuid,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
  p_selected_group_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  meta jsonb;
  context_value jsonb;
  record_type_value jsonb;
  record_id_value uuid := pg_catalog.gen_random_uuid();
  ownership_mode text;
  owner_account_id uuid;
  owner_group_id uuid;
  field_item jsonb;
  field_id_value uuid;
  column_value jsonb;
  input_value jsonb;
  final_values jsonb := coalesce(p_final_values, '{}'::jsonb);
  physical_values jsonb := '{}'::jsonb;
  edge_changes jsonb := '[]'::jsonb;
  storage_change jsonb;
  preview_installation jsonb;
  relationship_value jsonb;
  app_scope uuid;
  refusal_reason text := 'record_create_refused';
begin
  if p_record_type_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null
    or pg_catalog.cardinality(p_submitted_field_ids) <>
      (select pg_catalog.count(distinct value) from pg_catalog.unnest(p_submitted_field_ids) as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;

  begin
    meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'create');
    preview_installation :=
      vortex_record.read_current_preview_installation_internal();
    if pg_catalog.jsonb_typeof(meta -> 'recordType') <> 'object'
      or (preview_installation is null
        and pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object')
      or (preview_installation is not null
        and (preview_installation ->> 'outcome' = 'refused'
          or meta -> 'recordType' ? 'systemProjection')) then
      refusal_reason := 'record_unavailable';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;
    context_value := meta -> 'context';
    record_type_value := meta -> 'recordType';
    ownership_mode := record_type_value ->> 'ownershipMode';
    app_scope := case when meta ->> 'storageScope' = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end;
    if ownership_mode = 'organization_account' then
      if p_selected_group_id is not null then
        refusal_reason := 'owner_invalid';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_account_id := (context_value ->> 'organizationAccountId')::uuid;
    elsif ownership_mode = 'group' then
      if not vortex_access.lock_current_record_owner_group_internal(p_selected_group_id) then
        refusal_reason := 'owner_unavailable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      owner_group_id := p_selected_group_id;
    elsif p_selected_group_id is not null then
      refusal_reason := 'owner_invalid';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;

    -- Every supplied value names one exact field.  Reference numbers are
    -- generated here and cannot be supplied by a form or caller.
    if exists (
      select 1 from pg_catalog.jsonb_object_keys(final_values) as supplied(key)
      where not (meta -> 'columns' ? pg_catalog.lower(supplied.key))
    ) then
      refusal_reason := 'unknown_field';
      raise exception using errcode = 'P4020', message = refusal_reason;
    end if;

    for field_item in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      field_id_value := (field_item ->> 'fieldId')::uuid;
      column_value := meta -> 'columns' -> pg_catalog.lower(field_id_value::text);
      if field_item ->> 'type' = 'reference_number' then
        if final_values ? pg_catalog.lower(field_id_value::text)
          or field_id_value = any (p_submitted_field_ids) then
          refusal_reason := 'generated_field_not_submittable';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        input_value := pg_catalog.to_jsonb(case when preview_installation is null
          then vortex_record.allocate_reference_number_internal(
            (context_value ->> 'organizationId')::uuid,
            (meta ->> 'storageContractId')::uuid,
            field_id_value, app_scope, field_item -> 'settings'
          )
          else vortex_record.allocate_preview_reference_number_internal(
            (preview_installation ->> 'previewInstallationId')::uuid,
            (meta ->> 'storageContractId')::uuid,
            field_id_value, field_item -> 'settings'
          ) end);
        final_values := final_values || pg_catalog.jsonb_build_object(
          pg_catalog.lower(field_id_value::text), input_value
        );
      elsif final_values ? pg_catalog.lower(field_id_value::text) then
        input_value := final_values -> pg_catalog.lower(field_id_value::text);
        if (field_item ->> 'required')::boolean
          and pg_catalog.jsonb_typeof(input_value) = 'null' then
          refusal_reason := 'required_field_missing';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        if not vortex_record.canonical_record_value_matches(
          input_value, field_item ->> 'type', column_value ->> 'databaseValueType'
        ) then
          refusal_reason := 'value_invalid';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
      else
        if (field_item ->> 'required')::boolean then
          refusal_reason := 'required_field_missing';
          raise exception using errcode = 'P4020', message = refusal_reason;
        end if;
        continue;
      end if;

      physical_values := physical_values || pg_catalog.jsonb_build_object(
        column_value ->> 'token', input_value
      );
    end loop;

    storage_change := pg_catalog.jsonb_build_object(
        'storageContractId', meta -> 'storageContractId', 'recordId', record_id_value,
        'expectedConcurrencyNumber', null,
        'values', physical_values || pg_catalog.jsonb_build_object(
          'module_root_id', meta -> 'moduleRootId', 'record_type_id', p_record_type_id,
          'storage_contract_id', meta -> 'storageContractId', 'application_root_id', app_scope,
          'definition_revision', meta -> 'moduleReleaseRevision',
          'owner_organisation_account_id', owner_account_id, 'owner_group_id', owner_group_id,
          'lifecycle_state', 'active', 'created_at', pg_catalog.statement_timestamp(),
          'created_by', context_value -> 'organizationAccountId'
        )
    );

    -- The canonical link-target share-lock prelude is written once in
    -- lock_record_change_targets_internal. Every created link's target row is
    -- locked here before any edge identity, so a multi-link create uses the
    -- same lock order as the update writer. A malformed or undeclared link
    -- is left to the writer's own validation.
    perform vortex_record.lock_record_change_targets_internal(
      record_type_value, (context_value ->> 'organizationId')::uuid, final_values
    );
    for relationship_value in
      select item.value from pg_catalog.jsonb_array_elements(record_type_value -> 'relationships') as item(value)
      order by (item.value ->> 'relationshipId')::uuid
    loop
      field_id_value := (relationship_value ->> 'fromFieldId')::uuid;
      if final_values ? pg_catalog.lower(field_id_value::text) then
        edge_changes := edge_changes || pg_catalog.jsonb_build_array(
          vortex_record.prepare_relationship_value_internal(
            p_record_type_id, record_id_value,
            (relationship_value ->> 'relationshipId')::uuid,
            final_values -> pg_catalog.lower(field_id_value::text), false
          )
        );
      elsif ownership_mode = 'inherited'
        and (record_type_value ->> 'ownershipRelationshipId')::uuid =
          (relationship_value ->> 'relationshipId')::uuid then
        refusal_reason := 'required_owner_relationship_missing';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;

    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared', 'recordTypeId', p_record_type_id,
      'recordId', record_id_value, 'values', final_values,
      'submittedFieldIds', pg_catalog.to_jsonb(p_submitted_field_ids),
      'storageChange', storage_change, 'edgeChanges', edge_changes
    );
  exception
    when sqlstate 'P4020' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', refusal_reason
      );
    when no_data_found or too_many_rows or object_not_in_prerequisite_state then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
  end;
end
$function$;

alter function vortex_record.prepare_record_create_internal(uuid,jsonb,uuid[],uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_record_create_internal(uuid, jsonb, uuid[], uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.prepare_record_create_internal(uuid, jsonb, uuid[], uuid) is
  'Private create preparation: derives trusted scope, ownership and generated references, validates typed fields and relationship targets, and returns storage and edge mutations without inserting the record.';

create or replace function vortex_record.complete_record_creates_internal(p_prepared jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  prepared_value jsonb;
  prepared_position integer;
  type_id uuid;
  record_id_value uuid;
  metas jsonb := '{}'::jsonb;
  meta jsonb;
  context_value jsonb;
  targets jsonb;
  loaded_set jsonb;
  decision_set jsonb;
  decision jsonb;
  facts jsonb;
  bounds jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  changeable text[];
  submitted_id uuid;
  refusal_reason text;
  notice_sequence bigint;
  results jsonb := '[]'::jsonb;
begin
  preview_installation := vortex_record.read_current_preview_installation_internal();
  -- One context per record type, one facts load and one decision for every created record.
  for type_id in
    select distinct (item.value ->> 'recordTypeId')::uuid
    from pg_catalog.jsonb_array_elements(p_prepared) as item(value)
  loop
    metas := metas || pg_catalog.jsonb_build_object(
      type_id::text, vortex_record.resolve_record_action_context_internal(type_id, 'create')
    );
  end loop;
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'recordTypeId', item.value -> 'recordTypeId', 'recordId', item.value -> 'recordId'
  ) order by item.ordinality)
  into targets
  from pg_catalog.jsonb_array_elements(p_prepared) with ordinality as item(value, ordinality);
  if targets is null then return results; end if;
  loaded_set := vortex_record.load_record_access_facts_internal('create', targets);
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(loaded_set) as item(value)
    where item.value ->> 'outcome' <> 'loaded'
  ) then
    refusal_reason := 'record_unavailable';
    raise exception using errcode = 'P4020', message = refusal_reason;
  end if;
  if preview_installation is null then
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'declaration', metas -> (targets -> (loaded.ordinality - 1)::integer ->> 'recordTypeId') -> 'declaration',
      'recordId', targets -> (loaded.ordinality - 1)::integer -> 'recordId',
      'facts', (loaded.value -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', metas -> (targets -> (loaded.ordinality - 1)::integer ->> 'recordTypeId') -> 'declaration' -> 'recordBinding'
      )
    ) order by loaded.ordinality)
    into decision_set
    from pg_catalog.jsonb_array_elements(loaded_set) with ordinality as loaded(value, ordinality);
    decision_set := vortex_access.evaluate_organization_record_access_internal(decision_set);
  end if;
  prepared_position := 0;
  for prepared_value in select item.value from pg_catalog.jsonb_array_elements(p_prepared) as item(value)
  loop
    type_id := (prepared_value ->> 'recordTypeId')::uuid;
    record_id_value := (prepared_value ->> 'recordId')::uuid;
    meta := metas -> type_id::text;
    context_value := meta -> 'context';
    if preview_installation is null then
      decision := decision_set -> prepared_position;
      if decision ->> 'outcome' <> 'allowed' then
        refusal_reason := 'access_refused';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      bounds := vortex_access.resolve_record_field_bounds_internal(decision);
    else
      preview_bounds := vortex_record.preview_record_field_bounds_internal(
        type_id, (meta ->> 'storageContractId')::uuid, meta -> 'recordType'
      );
      if preview_bounds is null then
        refusal_reason := 'record_unavailable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      bounds := preview_bounds;
    end if;
    select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
    into changeable
    from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);
    for submitted_id in
      select item.value::uuid from pg_catalog.jsonb_array_elements_text(prepared_value -> 'submittedFieldIds') as item(value)
    loop
      if not (meta -> 'columns' ? pg_catalog.lower(submitted_id::text)) then
        refusal_reason := 'unknown_field';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
      if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
        refusal_reason := 'field_not_changeable';
        raise exception using errcode = 'P4020', message = refusal_reason;
      end if;
    end loop;
    if preview_installation is null and meta ->> 'storageScope' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::pg_catalog.regclass);
        perform vortex_platform.publish_change_notice(
          (context_value ->> 'organizationId')::uuid,
          (context_value ->> 'applicationRootId')::uuid, type_id,
          record_id_value, 1, 'created', notice_sequence, notice_sequence,
          (context_value ->> 'correlationId')::uuid
        );
      exception when others then
        raise warning 'Record create notice failed: [%] %', sqlstate, sqlerrm;
      end;
    end if;
    results := results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'outcome', 'completed', 'recordId', record_id_value,
      'concurrencyNumber', 1, 'values', prepared_value -> 'values'
    ));
    prepared_position := prepared_position + 1;
  end loop;
  return results;
end
$function$;
alter function vortex_record.complete_record_creates_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.complete_record_creates_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.complete_record_creates_internal(jsonb) is
  'Private create finalisation for every created record of one command: evaluates create authority with one facts load and one decision for the set, checks submitted field bounds over the persisted proposed graph, raises a refusal to roll back the set, and publishes each advisory invalidation.';



create or replace function vortex_record.prepare_record_values_internal(
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
security invoker
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  context_value jsonb;
  preview_installation jsonb;
  preview_bounds jsonb;
  organization_id_value uuid;
  correlation_id_value uuid;
  decision jsonb;
  bounds jsonb;
  failure_sqlstate text;
  failure_message text;
begin
  if p_operation not in ('create', 'update')
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
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null
    and preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  meta := vortex_record.resolve_record_action_context_internal(
    p_record_type_id, p_operation
  );
  if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
    or (preview_installation is not null and meta ? 'recordType'
      and meta -> 'recordType' ? 'systemProjection') then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  -- Ordinary saves require the explicit operation; named actions use their own preparation.
  if not coalesce((meta #> '{recordType,standardActions}') ? p_operation, false) then
    raise log 'Record save preparation refused: standard operation % is not declared', p_operation;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'correlationId', correlation_id_value
    );
  end if;
  if meta -> 'recordType' ? 'systemProjection' then
    if p_operation <> 'update'
      or meta #>> '{recordType,systemProjection,protectedView}' <>
        'organization_runtime_settings'
      or not coalesce(
        (meta #> '{recordType,standardActions}') ? 'update', false
      )
      or not vortex_definition.is_platform_system_module_internal(
        (meta ->> 'moduleRootId')::uuid, organization_id_value
      )
      or p_record_id is distinct from
        (meta -> 'context' ->> 'organizationId')::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused');
    end if;

    -- Do not execute application before-save rules for this projection until
    -- the platform settings-manage permission has passed its own current check.
    if not vortex_access.organization_runtime_settings_manage_is_current() then
      perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded',
        'correlationId', correlation_id_value
      );
    end if;

    -- The writable system projection is prepared through its protected read
    -- model. Its final write remains inside apply_record_changes.
    loaded := (vortex_record.load_record_access_facts_internal(
      'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id
      ))
    ) -> 0);
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
      decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'declaration', loaded -> 'declaration',
          'recordId', p_record_id,
          'facts', loaded -> 'facts'
        )
      )) -> 0);
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_record.decide_record_field_bounds_internal(decision);
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
    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared',
      'recordType', meta -> 'recordType',
      'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
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
    loaded := (vortex_record.load_record_access_facts_internal(
      'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id,
        'expectedConcurrencyNumber', p_expected_concurrency_number
      ))
    ) -> 0);
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
      decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'declaration', loaded -> 'declaration',
          'recordId', p_record_id,
          'facts', loaded -> 'facts'
        )
      )) -> 0);
      if decision ->> 'outcome' <> 'allowed' then
        perform vortex_record.append_record_activity_internal(p_activity_id, 'update_record', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused_recorded',
          'correlationId', correlation_id_value
        );
      end if;
      bounds := vortex_record.decide_record_field_bounds_internal(decision);
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'recordType', meta -> 'recordType',
    -- The owning Module release's BeforeSave flows for this record type, run by Record.
    'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
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

alter function vortex_record.prepare_record_values_internal(text,uuid,uuid,bigint,jsonb,uuid,uuid)
  owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_values_internal(text,uuid,uuid,bigint,jsonb,uuid,uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_values_internal(text,uuid,uuid,bigint,jsonb,uuid,uuid) is
  'Private operation-scoped value and BeforeSave preparation under current authority; receipt handling belongs to the enclosing record command.';



create or replace function vortex_record.prepare_record_change_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
  p_loaded jsonb default null,
  p_memo jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  meta jsonb;
  context_value jsonb;
  columns_value jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_values jsonb;
  proposed_facts jsonb;
  proposed_records jsonb;
  entry_key text;
  entry_value jsonb;
  column_entry jsonb;
  field_type text;
  storage_type text;
  submitted_id uuid;
  physical_values jsonb := '{}'::jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_final_values is null
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  loaded := coalesce(p_loaded, (vortex_record.load_record_access_facts_internal(
    'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id,
      'recordId', p_record_id,
      'expectedConcurrencyNumber', p_expected_concurrency_number
    ))
  ) -> 0));
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or (not (loaded ? 'previewInstallationId')
      and pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  context_value := loaded -> 'context';
  columns_value := loaded -> 'columns';

  if loaded ? 'previewInstallationId' then
    meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'update'
    );
    bounds := vortex_record.preview_record_field_bounds_internal(
      p_record_type_id, (meta ->> 'storageContractId')::uuid,
      meta -> 'recordType'
    );
    if bounds is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
  else
    decision := vortex_record.decide_record_access_internal(
      p_memo, loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable'
      );
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
  end if;
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);

  foreach submitted_id in array p_submitted_field_ids loop
    if not (columns_value ? pg_catalog.lower(submitted_id::text)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  proposed_values := loaded -> 'fieldValues';
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    column_entry := columns_value -> entry_key;
    if column_entry is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    field_type := column_entry ->> 'type';
    storage_type := column_entry ->> 'databaseValueType';
    if field_type in ('link', 'link_to_one_of_several') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'link_change_unsupported'
      );
    end if;
    if not vortex_record.canonical_record_value_matches(
      entry_value, field_type, storage_type
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'value_invalid'
      );
    end if;

    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
    physical_values := physical_values || pg_catalog.jsonb_build_object(
      column_entry ->> 'token', entry_value
    );
  end loop;

  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  proposed_facts := (loaded -> 'facts')
    || pg_catalog.jsonb_build_object('records', proposed_records);

  if not (loaded ? 'previewInstallationId') then
    decision := vortex_record.decide_record_access_internal(
      p_memo, loaded -> 'declaration', p_record_id, proposed_facts
    );
    if decision ->> 'outcome' <> 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'proposed_record_refused'
      );
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
  end if;

  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, proposed_values -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', p_record_id,
    'concurrencyNumber', p_expected_concurrency_number + 1,
    'values', values_value,
    'storageChange', pg_catalog.jsonb_build_object(
      'storageContractId', loaded #> '{recordTypeMeta,storageContractId}',
      'recordId', p_record_id, 'expectedConcurrencyNumber', p_expected_concurrency_number,
      'values', physical_values || pg_catalog.jsonb_build_object(
        'definition_revision', loaded -> 'moduleReleaseRevision'
      )
    )
  );
end
$function$;
alter function vortex_record.prepare_record_change_internal(uuid,uuid,bigint,jsonb,uuid[],jsonb,jsonb) owner to vortex_record_adapter;


alter function vortex_record.prepare_record_change_internal(uuid, uuid, bigint, jsonb, uuid[], jsonb, jsonb)
  owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_record_change_internal(uuid, uuid, bigint, jsonb, uuid[], jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_change_internal(uuid, uuid, bigint, jsonb, uuid[], jsonb, jsonb) is
  'Private record update preparation. Locks the current revision, checks current and proposed authority and field bounds, and returns the storage mutation and permitted projection for the set writer.';

create or replace function vortex_record.prepare_record_delete_closure_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_visited text[]
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  meta jsonb;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  context_value jsonb;
  record_fact jsonb;
  identity_value text;
  incoming record;
  relationship_value jsonb;
  source_field_id uuid;
  on_parent_delete text;
  source_catalogue vortex_record.storage_catalogue%rowtype;
  source_meta jsonb;
  source_loaded jsonb;
  source_decision jsonb;
  source_record_type jsonb;
  source_concurrency bigint;
  source_link_column text;
  source_link_value jsonb;
  source_identity text;
  source_action_kind text;
  storage_changes jsonb := '[]'::jsonb;
  edge_changes jsonb := '[]'::jsonb;
  effects jsonb := '[]'::jsonb;
  dependent_plan jsonb;
  edge_change jsonb;
begin
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'delete');
  context_value := meta -> 'context';
  identity_value := pg_catalog.lower((meta ->> 'storageContractId')) || ':'
    || pg_catalog.lower(p_record_id::text);
  if identity_value = any (p_visited) then
    raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
  end if;
  p_visited := pg_catalog.array_append(p_visited, identity_value);

  loaded := (vortex_record.load_record_access_facts_internal(
    'delete', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id,
      'recordId', p_record_id,
      'expectedConcurrencyNumber', p_expected_concurrency_number
    ))
  ) -> 0);
  if loaded ->> 'outcome' = 'conflict' then
    raise exception using errcode = '40001', message = 'Record delete revision is stale';
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  if record_fact ->> 'lifecycleState' <> 'active' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
    'binding', meta -> 'declaration' -> 'recordBinding'
  );
  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', meta -> 'declaration',
      'recordId', p_record_id,
      'facts', facts
    )
  )) -> 0);
  if decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;

  -- Incoming edges are canonicalised before any child lock.  Every affected
  -- child is then reloaded and locked by the fixed record loader.
  for incoming in
    select edge.*
    from vortex_record.relationship_edges as edge
    where edge.to_organisation_id = (context_value ->> 'organizationId')::uuid
      and edge.to_storage_contract_id = (meta ->> 'storageContractId')::uuid
      and edge.to_record_id = p_record_id
    order by edge.from_storage_contract_id, edge.from_record_id, edge.relationship_id
  loop
    select catalogue.* into strict source_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = incoming.from_storage_contract_id;
    -- Preview-only relationships have no installed mapping. The edge's exact source
    -- storage declares the field and deletion policy, just as it declares edge integrity.
    select relationship.value into strict relationship_value
    from pg_catalog.jsonb_array_elements(
      source_catalogue.record_type_definition -> 'relationships'
    ) as relationship(value)
    where (relationship.value ->> 'relationshipId')::uuid = incoming.relationship_id;
    source_field_id := (relationship_value ->> 'fromFieldId')::uuid;
    on_parent_delete := relationship_value ->> 'onParentDelete';
    source_identity := pg_catalog.lower(incoming.from_storage_contract_id::text) || ':'
      || pg_catalog.lower(incoming.from_record_id::text);
    if source_identity = any (p_visited) then
      raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
    end if;

    -- A child retained by another Application cannot be silently modified
    -- under this Application's request context.  It is therefore a safe
    -- blocking relationship, not an authority bypass.
    source_action_kind := case
      when on_parent_delete = 'empty_optional' then 'update'
      when on_parent_delete = 'soft_delete_dependent' then 'delete'
      else 'read'
    end;
    begin
      source_meta := vortex_record.resolve_record_action_context_internal(
        source_catalogue.record_type_id, source_action_kind
      );
    exception when others then
      raise warning 'Delete relationship declaration unavailable: [%] %', sqlstate, sqlerrm;
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end;
    if (source_meta ->> 'storageContractId')::uuid is distinct from
      incoming.from_storage_contract_id then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end if;

    select field_mapping.physical_column_token into strict source_link_column
    from vortex_record.field_storage_mappings as field_mapping
    where field_mapping.storage_contract_id = incoming.from_storage_contract_id
      and field_mapping.field_id = source_field_id
      and field_mapping.state = 'active'
      and field_mapping.introduced_at_release_revision <=
        (source_meta ->> 'moduleReleaseRevision')::bigint;

    execute pg_catalog.format(
      'select concurrency_number, %I from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active'' for update',
      source_link_column, source_meta ->> 'table'
    ) into source_concurrency, source_link_value using
      (context_value ->> 'organizationId')::uuid, incoming.from_record_id;
    if source_concurrency is null then
      continue;
    end if;
    -- The incoming-edge cursor may have been opened before a concurrent link
    -- change committed. The source row lock returns the current tuple, so
    -- re-check its exact field before applying parent-delete behaviour. This
    -- prevents a stale edge snapshot from clearing or revising the source a
    -- second time after that link was already removed or redirected.
    if pg_catalog.jsonb_typeof(source_link_value) <> 'object'
      or source_link_value ->> 'recordId' is distinct from p_record_id::text then
      continue;
    end if;
    source_loaded := (vortex_record.load_record_access_facts_internal(
      source_action_kind, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', source_catalogue.record_type_id,
        'recordId', incoming.from_record_id,
        'expectedConcurrencyNumber', source_concurrency
      ))
    ) -> 0);
    if source_loaded ->> 'outcome' <> 'loaded' then
      continue;
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(source_loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = incoming.from_record_id;
    if record_fact ->> 'lifecycleState' <> 'active' then
      continue;
    end if;
    if on_parent_delete = 'refuse' then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end if;
    if pg_catalog.jsonb_typeof(source_meta -> 'declaration') <> 'object' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;
    source_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', source_meta -> 'declaration',
        'recordId', incoming.from_record_id,
        'facts', (source_loaded -> 'facts') || pg_catalog.jsonb_build_object( 'binding', source_meta -> 'declaration' -> 'recordBinding' )
      )
    )) -> 0);
    if source_decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;

    if on_parent_delete = 'empty_optional' then
      effects := effects || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'effectKind', 'optional_cleared', 'storageContractId', incoming.from_storage_contract_id,
        'recordTypeId', source_catalogue.record_type_id, 'recordId', incoming.from_record_id,
        'preConcurrencyNumber', source_concurrency, 'relationshipId', incoming.relationship_id,
        'previousValue', source_link_value
      ));
      edge_change := vortex_record.prepare_relationship_value_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        incoming.relationship_id, 'null'::jsonb, false
      );
      edge_changes := edge_changes || pg_catalog.jsonb_build_array(edge_change);
      storage_changes := storage_changes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'storageContractId', incoming.from_storage_contract_id, 'recordId', incoming.from_record_id,
        'expectedConcurrencyNumber', source_concurrency,
        'values', pg_catalog.jsonb_build_object(
          source_link_column, null, 'definition_revision', source_meta -> 'moduleReleaseRevision'
        )
      ));
    elsif on_parent_delete = 'soft_delete_dependent' then
      source_record_type := source_meta -> 'recordType';
      if source_record_type ->> 'ownershipMode' <> 'inherited'
        or not source_record_type ? 'ownershipRelationshipId'
        or (source_record_type ->> 'ownershipRelationshipId')::uuid <>
          incoming.relationship_id then
        raise exception using errcode = '23514', message = 'Dependent deletion is not declared';
      end if;
      dependent_plan := vortex_record.prepare_record_delete_closure_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, p_visited
      );
      storage_changes := storage_changes || (dependent_plan -> 'storageChanges');
      edge_changes := edge_changes || (dependent_plan -> 'edgeChanges');
      effects := effects || (dependent_plan -> 'effects');
    else
      raise exception using errcode = '23514', message = 'Parent deletion behavior is invalid';
    end if;
  end loop;

  storage_changes := storage_changes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'storageContractId', meta -> 'storageContractId', 'recordId', p_record_id,
    'expectedConcurrencyNumber', p_expected_concurrency_number,
    'values', pg_catalog.jsonb_build_object(
      'lifecycle_state', 'soft_deleted',
      'deleted_at', pg_catalog.statement_timestamp(), 'deleted_by', context_value -> 'organizationAccountId',
      'removal_due_at', null, 'definition_revision', meta -> 'moduleReleaseRevision'
    )
  ));
  effects := effects || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'effectKind', 'soft_deleted', 'storageContractId', meta -> 'storageContractId',
    'recordTypeId', p_record_type_id, 'recordId', p_record_id,
    'preConcurrencyNumber', p_expected_concurrency_number, 'relationshipId', null, 'previousValue', null
  ));
  -- Each outer root replaces the recursive root tags with its own identity.
  -- The set preparation unions these tags when closures share an effect.
  select coalesce(pg_catalog.jsonb_agg(item.value || pg_catalog.jsonb_build_object(
    'restoresCommandId', null,
    'deleteRoots', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id, 'recordId', p_record_id
    ))
  ) order by item.ordinality), '[]'::jsonb) into effects
  from pg_catalog.jsonb_array_elements(effects) with ordinality as item(value, ordinality);
  return pg_catalog.jsonb_build_object(
    'storageChanges', storage_changes, 'edgeChanges', edge_changes, 'effects', effects
  );
end
$function$;

alter function vortex_record.prepare_record_delete_closure_internal(uuid,uuid,bigint,text[]) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_record_delete_closure_internal(uuid,uuid,bigint,text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.prepare_record_delete_closure_internal(uuid,uuid,bigint,text[]) is
  'Private delete closure preparation: locks and authorizes the root, dependent records and cleared optional links, returning their complete storage, edge and journal changes without writing records.';





create or replace function vortex_record.prepare_record_restore_closure_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  delete_command_id uuid;
  effects jsonb;
  subjects jsonb := '[]'::jsonb;
  subject jsonb;
  effect jsonb;
  meta jsonb;
  loaded jsonb;
  facts jsonb;
  decision jsonb;
  stored_fact jsonb;
  relationship_value jsonb;
  bounds jsonb;
  restored_values jsonb;
  physical_values jsonb;
  missing_links integer;
  current_lifecycle text;
  current_revision bigint;
  restored_revision_count bigint;
  prior_restore boolean;
begin
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record restore requires an Application context';
  end if;
  -- The current root revision identifies the delete that removed this record.
  -- A different actor may restore it only under their own current permissions.
  select entry.command_id into delete_command_id
  from vortex_record.record_lifecycle_command_effects as entry
  where entry.organization_id = (context_value ->> 'organizationId')::uuid
    and entry.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and entry.record_type_id = p_record_type_id
    and entry.record_id = p_record_id
    and entry.effect_kind = 'soft_deleted'
    and entry.post_concurrency_number = p_expected_concurrency_number
    and entry.delete_roots @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id, 'recordId', p_record_id
    ));
  if delete_command_id is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(entry) order by entry.effect_sequence),
    pg_catalog.count(*) filter (
      where entry.effect_kind = 'optional_cleared' and entry.previous_value is null
    )::integer
  into effects, missing_links
  from vortex_record.record_lifecycle_command_effects as entry
  where entry.organization_id = (context_value ->> 'organizationId')::uuid
    and entry.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and entry.command_id = delete_command_id
    and entry.delete_roots @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', p_record_type_id, 'recordId', p_record_id
    ));

  -- Lock the complete affected set before changing any row. A cleared-link
  -- source can occur more than once; its last journaled revision is authoritative.
  for subject in
    select pg_catalog.jsonb_build_object(
      'storageContractId', item.value -> 'storage_contract_id',
      'recordTypeId', item.value -> 'record_type_id',
      'recordId', item.value -> 'record_id',
      'expectedConcurrencyNumber', pg_catalog.max((item.value ->> 'post_concurrency_number')::bigint),
      'deleted', pg_catalog.bool_or(item.value ->> 'effect_kind' = 'soft_deleted'),
      'shared', pg_catalog.bool_or(pg_catalog.jsonb_array_length(item.value -> 'delete_roots') > 1)
    )
    from pg_catalog.jsonb_array_elements(effects) as item(value)
    where item.value ->> 'effect_kind' = 'soft_deleted'
      or item.value -> 'previous_value' <> 'null'::jsonb
    group by item.value -> 'storage_contract_id', item.value -> 'record_type_id',
      item.value -> 'record_id'
    order by item.value -> 'storage_contract_id', item.value -> 'record_id'
  loop
    meta := vortex_record.resolve_record_action_context_internal(
      (subject ->> 'recordTypeId')::uuid,
      case when (subject ->> 'deleted')::boolean then 'restore' else 'update' end
    );
    -- A shared closure row restored through another root stays active; it is
    -- not rewritten and its later edits are preserved. The requested root must
    -- itself still be deleted at the displayed revision.
    execute pg_catalog.format(
      'select stored.lifecycle_state, stored.concurrency_number from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2 for update',
      meta ->> 'table'
    ) into current_lifecycle, current_revision
    using (context_value ->> 'organizationId')::uuid, (subject ->> 'recordId')::uuid;
    if (subject ->> 'deleted')::boolean and (subject ->> 'shared')::boolean
      and current_lifecycle = 'active'
      and ((subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid)
        is distinct from (p_record_type_id, p_record_id) then
      continue;
    end if;
    prior_restore := false;
    if not (subject ->> 'deleted')::boolean
      and current_lifecycle = 'active'
      and current_revision > (subject ->> 'expectedConcurrencyNumber')::bigint then
      -- Other roots may already have recovered different links on this row.
      -- Accept only a complete revision chain of restores of this exact delete;
      -- an ordinary edit leaves a gap and still refuses the closure.
      select pg_catalog.count(distinct entry.pre_concurrency_number)
      into restored_revision_count
      from vortex_record.record_lifecycle_command_effects as entry
      where entry.organization_id = (context_value ->> 'organizationId')::uuid
        and entry.application_root_id = (context_value ->> 'applicationRootId')::uuid
        and entry.storage_contract_id = (subject ->> 'storageContractId')::uuid
        and entry.record_id = (subject ->> 'recordId')::uuid
        and entry.effect_kind = 'links_restored'
        and entry.restores_command_id = delete_command_id
        and entry.pre_concurrency_number >= (subject ->> 'expectedConcurrencyNumber')::bigint
        and entry.post_concurrency_number <= current_revision;
      if restored_revision_count = current_revision - (subject ->> 'expectedConcurrencyNumber')::bigint then
        prior_restore := true;
        subject := subject || pg_catalog.jsonb_build_object('expectedConcurrencyNumber', current_revision);
      end if;
    end if;
    loaded := (vortex_record.load_record_access_facts_internal(case when (subject ->> 'deleted')::boolean then 'restore' else 'update' end, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', (subject ->> 'recordTypeId')::uuid, 'recordId', (subject ->> 'recordId')::uuid, 'expectedConcurrencyNumber', (subject ->> 'expectedConcurrencyNumber')::bigint))) -> 0);
    if loaded ->> 'outcome' = 'conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'restore_closure_changed',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' is distinct from 'loaded'
      or pg_catalog.jsonb_typeof(meta -> 'declaration') is distinct from 'object'
      or meta -> 'storageContractId' is distinct from subject -> 'storageContractId' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    select item.value into strict stored_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where item.value #>> '{recordScope,recordId}' = subject ->> 'recordId';
    if stored_fact ->> 'lifecycleState' is distinct from
      (case when (subject ->> 'deleted')::boolean then 'soft_deleted' else 'active' end) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'restore_closure_changed',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    -- Inherited ownership and permission conditions see the same complete
    -- restored closure, not a partially restored parent or child.
    facts := (loaded -> 'facts') || pg_catalog.jsonb_build_object(
      'binding', meta #> '{declaration,recordBinding}',
      'records', (
        select pg_catalog.jsonb_agg(case when exists (
          select 1 from pg_catalog.jsonb_array_elements(effects) as deleted(value)
          where deleted.value ->> 'effect_kind' = 'soft_deleted'
            and deleted.value ->> 'record_id' = item.value #>> '{recordScope,recordId}'
            and deleted.value ->> 'storage_contract_id' = item.value #>> '{recordScope,storageContractId}'
        ) then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active')
          else item.value end order by item.ordinality)
        from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
          with ordinality as item(value, ordinality)
      )
    );
    decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', meta -> 'declaration', 'recordId', (subject ->> 'recordId')::uuid, 'facts', facts))) -> 0);
    if decision ->> 'outcome' is distinct from 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
    restored_values := loaded -> 'fieldValues';
    physical_values := '{}'::jsonb;
    for effect in
      select item.value from pg_catalog.jsonb_array_elements(effects) as item(value)
      where item.value ->> 'effect_kind' = 'optional_cleared'
        and item.value ->> 'storage_contract_id' = subject ->> 'storageContractId'
        and item.value ->> 'record_id' = subject ->> 'recordId'
        and item.value -> 'previous_value' <> 'null'::jsonb
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(meta #> '{recordType,relationships}') as item(value)
      where item.value ->> 'relationshipId' = effect ->> 'relationship_id';
      if prior_restore and pg_catalog.jsonb_array_length(effect -> 'delete_roots') > 1
        and loaded -> 'fieldValues' -> (relationship_value ->> 'fromFieldId') = effect -> 'previous_value' then
        continue;
      end if;
      if relationship_value is null
        or not (bounds -> 'changeableFieldIds') ? (relationship_value ->> 'fromFieldId')
        or coalesce(loaded -> 'fieldValues' -> (relationship_value ->> 'fromFieldId'), 'null'::jsonb)
          <> 'null'::jsonb then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'restore_closure_changed',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      restored_values := restored_values || pg_catalog.jsonb_build_object(
        relationship_value ->> 'fromFieldId', effect -> 'previous_value'
      );
      physical_values := physical_values || pg_catalog.jsonb_build_object(
        meta -> 'columns' -> (relationship_value ->> 'fromFieldId') ->> 'token',
        effect -> 'previous_value'
      );
    end loop;
    if not (subject ->> 'deleted')::boolean and physical_values = '{}'::jsonb then
      continue;
    end if;
    subjects := subjects || pg_catalog.jsonb_build_array(subject || pg_catalog.jsonb_build_object(
      'table', meta -> 'table', 'releaseRevision', meta -> 'moduleReleaseRevision',
      'recordType', meta -> 'recordType', 'columns', meta -> 'columns',
      'values', restored_values,
      'storageChange', pg_catalog.jsonb_build_object(
        'storageContractId', subject -> 'storageContractId', 'recordId', subject -> 'recordId',
        'expectedConcurrencyNumber', subject -> 'expectedConcurrencyNumber',
        'values', physical_values || pg_catalog.jsonb_build_object(
          'definition_revision', meta -> 'moduleReleaseRevision'
        ) || case when (subject ->> 'deleted')::boolean then pg_catalog.jsonb_build_object(
          'lifecycle_state', 'active', 'deleted_at', null, 'deleted_by', null, 'removal_due_at', null
        ) else '{}'::jsonb end
      )
    ));
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'deleteCommandId', delete_command_id, 'subjects', subjects,
    'storageChanges', (select pg_catalog.jsonb_agg(item.value -> 'storageChange')
      from pg_catalog.jsonb_array_elements(subjects) as item(value)),
    'unrestoredLinkCount', missing_links
  );
end
$function$;

alter function vortex_record.prepare_record_restore_closure_internal(uuid,uuid,bigint) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_restore_closure_internal(uuid,uuid,bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_restore_closure_internal(uuid,uuid,bigint) is
  'Private restore closure preparation: locates the deleting command and locks its unchanged retained records and recoverable optional links under current authority, without writing records.';



create or replace function vortex_record.combine_record_storage_changes_internal(p_changes jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  storage_changes jsonb;
begin
  if pg_catalog.jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Prepared record storage changes are invalid';
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by item.value -> 'storageContractId', item.value -> 'recordId'
    having pg_catalog.count(distinct item.value -> 'expectedConcurrencyNumber') > 1
  ) then
    raise exception using errcode = '40001', message = 'Prepared record revisions disagree';
  end if;

  -- Different closure members may change separate fields on the same record.
  -- Compose those changes before the one physical write.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'storageContractId', subject.storage_id, 'recordId', subject.record_id,
    'expectedConcurrencyNumber', subject.revision,
    'values', (
      select pg_catalog.jsonb_object_agg(field.key, field.value order by item.ordinality)
      from pg_catalog.jsonb_array_elements(p_changes) with ordinality as item(value, ordinality)
      cross join lateral pg_catalog.jsonb_each(item.value -> 'values') as field(key, value)
      where item.value -> 'storageContractId' = subject.storage_id
        and item.value -> 'recordId' = subject.record_id
    )
  ) order by subject.storage_id, subject.record_id), '[]'::jsonb) into storage_changes
  from (
    select item.value -> 'storageContractId' as storage_id,
      item.value -> 'recordId' as record_id,
      pg_catalog.max((item.value ->> 'expectedConcurrencyNumber')::bigint) as revision
    from pg_catalog.jsonb_array_elements(p_changes) as item(value)
    group by item.value -> 'storageContractId', item.value -> 'recordId'
  ) as subject;

  return storage_changes;
end
$function$;
alter function vortex_record.combine_record_storage_changes_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.combine_record_storage_changes_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.combine_record_storage_changes_internal(jsonb) is
  'Combines prepared field deltas for each storage and record identity, preserving one expected revision and ordered final values for its single physical write.';

create or replace function vortex_record.prepare_record_storage_set_internal(p_changes jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  storage_changes jsonb;
  change_value jsonb;
  record_type_id_value uuid;
  loaded jsonb;
  record_fact jsonb;
  proposed_values jsonb;
  proposed_records jsonb := '[]'::jsonb;
begin
  storage_changes := vortex_record.combine_record_storage_changes_internal(p_changes);

  for change_value in select item.value from pg_catalog.jsonb_array_elements(storage_changes) as item(value)
  loop
    select storage.record_type_id into strict record_type_id_value
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = (change_value ->> 'storageContractId')::uuid;
    loaded := (vortex_record.load_record_access_facts_internal('update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', record_type_id_value, 'recordId', (change_value ->> 'recordId')::uuid, 'expectedConcurrencyNumber', (change_value ->> 'expectedConcurrencyNumber')::bigint))) -> 0);
    if loaded ->> 'outcome' is distinct from 'loaded'
      or loaded #> '{recordTypeMeta,storageContractId}' is distinct from change_value -> 'storageContractId' then
      raise exception using errcode = '40001', message = 'Prepared record storage closure changed';
    end if;
    select item.value into strict record_fact
    from pg_catalog.jsonb_array_elements(loaded #> '{facts,records}') as item(value)
    where item.value #>> '{recordScope,recordId}' = change_value ->> 'recordId';
    select (loaded -> 'fieldValues') || coalesce(pg_catalog.jsonb_object_agg(
      field.key, change_value -> 'values' -> (field.value ->> 'token')
    ), '{}'::jsonb) into proposed_values
    from pg_catalog.jsonb_each(loaded -> 'columns') as field(key, value)
    where (change_value -> 'values') ? (field.value ->> 'token');
    proposed_records := proposed_records || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordTypeId', record_type_id_value, 'storageContractId', change_value -> 'storageContractId',
      'recordId', change_value -> 'recordId', 'concurrencyNumber', loaded -> 'concurrencyNumber',
      'existingValues', proposed_values,
      'lifecycleState', coalesce(change_value #>> '{values,lifecycle_state}', record_fact ->> 'lifecycleState')
    ));
  end loop;
  return pg_catalog.jsonb_build_object('storageChanges', storage_changes, 'proposedRecords', proposed_records);
end
$function$;

alter function vortex_record.prepare_record_storage_set_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_storage_set_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_storage_set_internal(jsonb) is
  'Private preparation of an already-authorized lifecycle closure: composes repeated record changes and supplies proposed logical snapshots for generated-field calculation before any physical write.';

create or replace function vortex_record.prepare_relationship_total_parent_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_catalogue jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  catalogue jsonb;
  snapshot jsonb;
  field_value jsonb;
  column_value jsonb;
  entry record;
  physical_values jsonb := '{}'::jsonb;
  changed_field_ids uuid[] := array[]::uuid[];
begin
  if pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    raise exception using errcode = '22023', message = 'Relationship total parent mutation is invalid';
  end if;
  if p_final_values = '{}'::jsonb then return null; end if;
  catalogue := p_catalogue;
  snapshot := vortex_record.relationship_total_record_snapshot_internal(
    catalogue, p_record_type_id, p_record_id, true
  );
  if snapshot is null or (snapshot ->> 'concurrencyNumber')::bigint <> p_expected_concurrency_number then
    raise exception using errcode = '40001', message = 'Relationship total parent revision changed';
  end if;
  for entry in select pg_catalog.lower(key) as key, value from pg_catalog.jsonb_each(p_final_values)
  loop
    select field.value into field_value
    from pg_catalog.jsonb_array_elements(snapshot -> 'recordType' -> 'fields') field(value)
    where pg_catalog.lower(field.value ->> 'fieldId') = entry.key;
    if field_value is null or field_value ->> 'type' not in ('total', 'calculation') then
      raise exception using errcode = '42501', message = 'Relationship total parent field is unavailable';
    end if;
    select pg_catalog.jsonb_build_object(
      'token', mapping.physical_column_token,
      'databaseValueType', mapping.database_value_type
    ) into column_value
    from vortex_record.field_storage_mappings mapping
    where mapping.storage_contract_id = (snapshot ->> 'storageContractId')::uuid
      and mapping.field_id = entry.key::uuid and mapping.state = 'active';
    if column_value is null or not vortex_record.canonical_record_value_matches(
      entry.value, field_value ->> 'type', column_value ->> 'databaseValueType'
    ) then
      raise exception using errcode = '23514', message = 'Relationship total parent value is invalid';
    end if;
    physical_values := physical_values || pg_catalog.jsonb_build_object(column_value ->> 'token', entry.value);
    changed_field_ids := pg_catalog.array_append(changed_field_ids, entry.key::uuid);
  end loop;
  select pg_catalog.array_agg(distinct value order by value) into changed_field_ids
  from pg_catalog.unnest(changed_field_ids) item(value);
  return pg_catalog.jsonb_build_object(
    'recordTypeId', p_record_type_id, 'recordId', p_record_id,
    'concurrencyNumber', p_expected_concurrency_number + 1,
    'changedFieldIds', pg_catalog.to_jsonb(changed_field_ids), 'snapshot', snapshot,
    'storageChange', pg_catalog.jsonb_build_object(
      'storageContractId', snapshot -> 'storageContractId', 'recordId', p_record_id,
      'expectedConcurrencyNumber', p_expected_concurrency_number,
      'values', physical_values || pg_catalog.jsonb_build_object('definition_revision', snapshot -> 'definitionRevision')
    )
  );
end
$function$;

alter function vortex_record.prepare_relationship_total_parent_internal(uuid,uuid,bigint,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_relationship_total_parent_internal(uuid,uuid,bigint,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_relationship_total_parent_internal(uuid,uuid,bigint,jsonb,jsonb) is
  'Prepares protected generated totals and calculations against a locked current or proposed snapshot for the shared record storage writer.';

-- Private Record-adapter routine; migrations install the complete canonical body
-- under its owner with schema CREATE granted only for that migration transaction.
create or replace function vortex_record.prepare_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_bump_data_version boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  source_meta jsonb;
  source_context jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_value jsonb;
  field_column jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  source_application_root_id uuid;
  target_application_root_id uuid;
  mapping_row vortex_record.relationship_storage_mappings%rowtype;
  application_root_required boolean;

begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null or p_bump_data_version is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
  end if;
  source_meta := vortex_record.resolve_record_action_context_internal(
    p_source_record_type_id, 'read'
  );
  source_context := source_meta -> 'context';
  source_type := source_meta -> 'recordType';
  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(source_type -> 'relationships') as item(value)
  where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
  if not found then
    raise exception using errcode = '23514',
      message = 'Relationship is not declared by the active record type';
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(source_type -> 'fields') as item(value)
  where (item.value ->> 'fieldId')::uuid = (relationship_value ->> 'fromFieldId')::uuid;
  if not found or field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
    raise exception using errcode = '55000',
      message = 'Relationship field definition is unavailable';
  end if;
  field_column := source_meta -> 'columns' -> pg_catalog.lower(field_value ->> 'fieldId');

  if source_meta ? 'previewInstallationId' then
    -- The exact owner-validated preview definition is its mapping. A live mapping's single
    -- relationship identity must never be repointed at a preview's isolated storage.
    mapping_row.source_storage_contract_id := (source_meta ->> 'storageContractId')::uuid;
    mapping_row.cardinality := relationship_value ->> 'cardinality';
    mapping_row.on_parent_delete := relationship_value ->> 'onParentDelete';
    select pg_catalog.array_agg((target.value ->> 'recordTypeId')::uuid)
    into mapping_row.target_record_type_ids
    from pg_catalog.jsonb_array_elements(case when relationship_value ? 'toRecordType'
      then pg_catalog.jsonb_build_array(relationship_value -> 'toRecordType')
      else relationship_value -> 'toRecordTypes' end) as target(value);
  else
    select mapping.* into mapping_row
    from vortex_record.relationship_storage_mappings as mapping
    where mapping.relationship_id = p_relationship_id
      and mapping.source_storage_contract_id =
        (source_meta ->> 'storageContractId')::uuid
      and mapping.source_field_id = (field_value ->> 'fieldId')::uuid
      and mapping.release_revision <= (source_meta ->> 'moduleReleaseRevision')::bigint;
    if not found
      or mapping_row.cardinality is distinct from (relationship_value ->> 'cardinality')
      or mapping_row.on_parent_delete is distinct from (relationship_value ->> 'onParentDelete') then
      raise exception using errcode = '55000',
        message = 'Relationship storage disagrees with the active definition';
    end if;
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    if p_bump_data_version then
      perform vortex_record.bump_record_data_version_internal(
        (source_context ->> 'organizationId')::uuid,
        (source_meta ->> 'storageContractId')::uuid,
        case when source_meta ->> 'storageScope' = 'application_contained'
          then (source_context ->> 'applicationRootId')::uuid else null end
      );
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    return pg_catalog.jsonb_build_object(
      'relationshipId', p_relationship_id,
      'sourceRecordId', p_source_record_id,
      'sourceStorageContractId', source_meta -> 'storageContractId',
      'sourceApplicationRootId', case when source_meta ->> 'storageScope' = 'application_contained'
        then source_context -> 'applicationRootId' else null end,
      'table', source_meta -> 'table', 'column', field_column -> 'token',
      'value', p_target_value, 'cardinality', mapping_row.cardinality
    );
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) <> 'object'
    or not (p_target_value ?& array['recordTypeId', 'recordId'])
    or p_target_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end if;
  begin
    target_type_id := (p_target_value ->> 'recordTypeId')::uuid;
    target_record_id := (p_target_value ->> 'recordId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end;
  if target_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_type_id <> all (mapping_row.target_record_type_ids) then
    raise exception using errcode = '23514', message = 'Relationship target is unavailable';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  source_application_root_id := case when source_meta ->> 'storageScope' = 'application_contained'
    then (source_context ->> 'applicationRootId')::uuid else null end;
  application_root_required := coalesce(
    (field_value #>> '{settings,applicationRootIdRequired}')::boolean, false
  );
  if application_root_required
    and (target_meta #>> '{recordType,systemProjection,protectedView}')
      is distinct from 'organization_accounts' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- Lock the protected row behind either ordinary record storage or a
  -- registered system projection before rebuilding eligibility from current
  -- facts. The lock is held until commit, so the target cannot disappear while
  -- the unconstrainted relationship edge is installed.
  perform vortex_record.lock_relationship_target_row_internal(
    target_type_id, target_record_id,
    (source_context ->> 'organizationId')::uuid
  );

  target_loaded := (vortex_record.load_record_access_facts_internal('read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', target_type_id, 'recordId', target_record_id))) -> 0);
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  if source_meta ? 'previewInstallationId'
    and target_loaded ->> 'previewInstallationId' = source_meta ->> 'previewInstallationId'
    and exists (
      select 1 from vortex_definition.roots as root
      where root.root_id = (target_loaded #>> '{recordTypeMeta,moduleRootId}')::uuid
        and root.owner_application_root_id = (source_context ->> 'applicationRootId')::uuid
    ) then
    target_decision := pg_catalog.jsonb_build_object('outcome', 'allowed');
  else
    if pg_catalog.jsonb_array_length(
      target_loaded #> '{declaration,requiredPermissions}'
    ) = 0 then
      raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
    end if;
    target_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', pg_catalog.jsonb_set(target_loaded -> 'declaration', '{authority}', '{"kind":"permission"}'::jsonb), 'recordId', target_record_id, 'facts', target_loaded -> 'facts'))) -> 0);
  end if;
  if target_decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  select item.value into target_record
  from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = target_record_id;
  target_scope := target_record -> 'recordScope';
  target_application_root_id := case when target_meta ->> 'storageScope' = 'application_contained'
    then (target_scope ->> 'applicationRootId')::uuid else null end;
  if target_record is null or target_record ->> 'lifecycleState' <> 'active'
    or (target_scope ->> 'organizationId')::uuid <>
      (source_context ->> 'organizationId')::uuid
    or (source_application_root_id is not null and target_application_root_id is not null
      and source_application_root_id <> target_application_root_id) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  if application_root_required
    and not vortex_access.organization_account_has_current_application_access_internal(
      (source_context ->> 'organizationId')::uuid,
      target_record_id,
      (source_context ->> 'applicationRootId')::uuid
    ) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- The target row is share-locked and eligible. The source data version is
  -- taken next, then the shared edge identities last.
  if p_bump_data_version then
    perform vortex_record.bump_record_data_version_internal(
      (source_context ->> 'organizationId')::uuid,
      (source_meta ->> 'storageContractId')::uuid,
      source_application_root_id
    );
  end if;
  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );
  -- Parent proposals serialize before storage and edge writes, but cardinality
  -- and cycles are checked by the edge writer on the complete resulting graph.
  -- Checking the old graph here would reject valid swaps within one set.
  if mapping_row.cardinality = 'many_to_one' and target_type_id = p_source_record_type_id then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'parent:' || (source_context ->> 'organizationId') || ':' || p_relationship_id::text, 0
    ));
  end if;

  return pg_catalog.jsonb_build_object(
    'relationshipId', p_relationship_id,
    'sourceRecordId', p_source_record_id,
    'sourceStorageContractId', source_meta -> 'storageContractId',
    'sourceApplicationRootId', source_application_root_id,
    'targetStorageContractId', target_meta -> 'storageContractId',
    'targetRecordId', target_record_id,
    'targetApplicationRootId', target_application_root_id,
    'table', source_meta -> 'table', 'column', field_column -> 'token',
    'value', p_target_value, 'cardinality', mapping_row.cardinality
  );
end
$function$;

alter function vortex_record.prepare_relationship_value_internal(uuid,uuid,uuid,jsonb,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.prepare_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.prepare_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean) is
  'Private relationship preparation: validates the declared relationship and target eligibility, locks target and edge identities, and returns the typed field and edge mutation for the record writer.';


create or replace function vortex_record.relationship_total_record_snapshot_internal(
  p_catalogue jsonb,
  p_record_type_id uuid,
  p_record_id uuid,
  p_lock boolean
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  columns_value jsonb;
  value_expression text;
  load_sql text;
  result_value jsonb;
  proposed_record jsonb;
begin
  if p_record_type_id is null or p_record_id is null or p_lock is null
    or pg_catalog.jsonb_typeof(p_catalogue -> 'recordTypes') <> 'array' then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  select item.value into record_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if record_type is null then return null; end if;

  -- The record writer may supply its already-locked proposed closure while
  -- preparing generated fields. This lets a delete or restore calculate its
  -- final totals before its one physical write, using the same snapshot path.
  select item.value into proposed_record
  from pg_catalog.jsonb_array_elements(coalesce(p_catalogue -> 'proposedRecords', '[]'::jsonb)) as item(value)
  where item.value ->> 'recordTypeId' = p_record_type_id::text
    and item.value ->> 'recordId' = p_record_id::text;
  if proposed_record is not null then
    if proposed_record ->> 'lifecycleState' <> 'active' then return null; end if;
    return (proposed_record - 'lifecycleState') || pg_catalog.jsonb_build_object(
      'recordType', record_type - 'moduleReleaseRevision',
      'definitionRevision', record_type -> 'moduleReleaseRevision'
    );
  end if;

  select stored.* into catalogue_row
  from vortex_record.storage_catalogue stored
  where stored.storage_contract_id = (record_type ->> 'storageContractId')::uuid
    and stored.record_type_id = p_record_type_id
    and stored.state = 'active';
  if not found then return null; end if;

  select pg_catalog.jsonb_object_agg(
    pg_catalog.lower(field.value ->> 'fieldId'),
    pg_catalog.jsonb_build_object(
      'token', mapping.physical_column_token,
      'databaseValueType', mapping.database_value_type,
      'type', field.value ->> 'type'
    )
  ) into columns_value
  from pg_catalog.jsonb_array_elements(record_type -> 'fields') field(value)
  join vortex_record.field_storage_mappings mapping
    on mapping.storage_contract_id = (record_type ->> 'storageContractId')::uuid
   and mapping.field_id = (field.value ->> 'fieldId')::uuid
   and mapping.state = 'active';
  if (select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(coalesce(columns_value, '{}'::jsonb))) <>
      pg_catalog.jsonb_array_length(record_type -> 'fields') then
    return null;
  end if;

  select pg_catalog.string_agg(
    field_chunk.pairs_text,
    ') || pg_catalog.jsonb_build_object(' order by field_chunk.chunk_index
  )
  into value_expression
  from (
    select (ordered_fields.field_number - 1) / 50 as chunk_index,
      pg_catalog.string_agg(
        pg_catalog.format(
          '%L, %s', ordered_fields.key,
          case ordered_fields.value ->> 'databaseValueType'
            when 'decimal' then pg_catalog.format('pg_catalog.to_jsonb(stored.%I::text)', ordered_fields.value ->> 'token')
            when 'timestamp_with_time_zone' then pg_catalog.format(
              'pg_catalog.to_jsonb(vortex_platform.format_timestamp_utc(stored.%I))',
              ordered_fields.value ->> 'token'
            )
            when 'date' then pg_catalog.format(
              'pg_catalog.to_jsonb(pg_catalog.to_char(stored.%I, ''YYYY-MM-DD''))',
              ordered_fields.value ->> 'token'
            )
            else pg_catalog.format('pg_catalog.to_jsonb(stored.%I)', ordered_fields.value ->> 'token')
          end
        ), ', ' order by ordered_fields.key collate "C"
      ) as pairs_text
    from (
      select entry.key, entry.value,
        pg_catalog.row_number() over (
          order by entry.key collate "C"
        ) as field_number
      from pg_catalog.jsonb_each(columns_value) entry(key, value)
    ) as ordered_fields
    group by (ordered_fields.field_number - 1) / 50
  ) as field_chunk;

  load_sql := pg_catalog.format(
    'select pg_catalog.jsonb_build_object(
       ''recordType'', $3 - ''moduleReleaseRevision'',
       ''recordTypeId'', %L::uuid,
       ''storageContractId'', %L::uuid,
       ''recordId'', stored.record_id,
       ''concurrencyNumber'', stored.concurrency_number,
       ''definitionRevision'', %L::bigint,
       ''existingValues'', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(%s))
     )
     from record_data.%I stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.lifecycle_state = ''active''
       and stored.application_root_id is not distinct from %s%s',
    p_record_type_id,
    (record_type ->> 'storageContractId')::uuid,
    (record_type ->> 'moduleReleaseRevision')::bigint,
    value_expression,
    catalogue_row.physical_table_token,
    case when record_type ->> 'storageScope' = 'application_contained'
      then '$4::uuid' else 'null::uuid' end,
    case when p_lock then ' for update' else '' end
  );
  execute load_sql into result_value using
    (context_value ->> 'organizationId')::uuid,
    p_record_id,
    record_type,
    (context_value ->> 'applicationRootId')::uuid;
  return result_value;
end
$function$;

alter function vortex_record.relationship_total_record_snapshot_internal(jsonb,uuid,uuid,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.relationship_total_record_snapshot_internal(
  jsonb, uuid, uuid, boolean
)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.relationship_total_record_snapshot_internal(
  jsonb, uuid, uuid, boolean
)
  to vortex_record_adapter;
comment on function vortex_record.relationship_total_record_snapshot_internal(
  jsonb, uuid, uuid, boolean
) is
  'Private locked-or-read snapshot of one record for the validated human Application request context.';

CREATE OR REPLACE FUNCTION vortex_record.relationship_total_source_is_retained_internal(p_catalogue jsonb, p_record_type_id uuid, p_record_id uuid, p_organization_id uuid, p_application_root_id uuid) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $_$
declare
  record_type jsonb;
  catalogue_row vortex_record.storage_catalogue%rowtype;
  lifecycle_state_value text;
begin
  if p_record_type_id is null or p_record_id is null or p_organization_id is null
    or pg_catalog.jsonb_typeof(p_catalogue -> 'recordTypes') is distinct from 'array' then
    return false;
  end if;
  select item.value into record_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text);
  if record_type is null then
    return false;
  end if;
  select item.value ->> 'lifecycleState' into lifecycle_state_value
  from pg_catalog.jsonb_array_elements(coalesce(p_catalogue -> 'proposedRecords', '[]'::jsonb)) as item(value)
  where item.value ->> 'recordTypeId' = p_record_type_id::text
    and item.value ->> 'recordId' = p_record_id::text;
  if found then return lifecycle_state_value <> 'active'; end if;
  select stored.* into catalogue_row
  from vortex_record.storage_catalogue as stored
  where stored.storage_contract_id = (record_type ->> 'storageContractId')::uuid
    and stored.record_type_id = p_record_type_id
    and stored.state = 'active';
  if not found then
    return false;
  end if;
  execute pg_catalog.format(
    'select stored.lifecycle_state from record_data.%I as stored
     where stored.organisation_id = $1 and stored.record_id = $2
       and stored.application_root_id is not distinct from $3',
    catalogue_row.physical_table_token
  ) into lifecycle_state_value using
    p_organization_id, p_record_id,
    case when record_type ->> 'storageScope' = 'application_contained'
      then p_application_root_id else null end;
  return lifecycle_state_value is not null and lifecycle_state_value <> 'active';
end
$_$;
alter function vortex_record.relationship_total_source_is_retained_internal(jsonb,uuid,uuid,uuid,uuid) owner to vortex_record_adapter;


REVOKE ALL ON FUNCTION vortex_record.relationship_total_source_is_retained_internal(p_catalogue jsonb, p_record_type_id uuid, p_record_id uuid, p_organization_id uuid, p_application_root_id uuid) FROM PUBLIC;

create or replace function vortex_record.transfer_record_ownership_for_offboarding_internal(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_target_kind text,
  p_target_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_source_organization_account_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb; organization_id_value uuid; application_root_id_value uuid;
  actor_id_value uuid; receipt_claim jsonb;
  loaded jsonb; decision jsonb; record_fact jsonb; type_fact jsonb;
  previous_owner uuid; updated_concurrency bigint; changed_rows integer; event_result jsonb;
  evaluation_facts jsonb;
  updated_record_id uuid; updated_organization_id uuid; updated_application_root_id uuid;
  storage_scope_value text; preview_installation jsonb;
  exact_notice boolean := false; notice_sequence bigint;
  correlation_id_value uuid;
begin
  if p_command_id is null or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_kind is distinct from 'organization_account' or p_target_id is null
    or p_activity_id is null or p_occurrence_id is null
    or p_source_organization_account_id is null
    or p_source_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.lock_human_request_access_version_internal();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Offboarding ownership transfer requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  if correlation_id_value is null or not vortex_platform.is_non_nil_uuid(correlation_id_value::text) then
    raise exception using errcode='42501',message='Offboarding ownership transfer authority is unavailable';
  end if;
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','command_identity_conflict','correlationId',context_value -> 'correlationId');
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome','conflict','correlationId',context_value -> 'correlationId');
    end if;
    return pg_catalog.jsonb_build_object('outcome','transferred','recordId',(receipt_claim -> 'result' ->> 'recordId')::uuid,
      'concurrencyNumber',(receipt_claim -> 'result' ->> 'concurrencyNumber')::bigint,'correlationId',context_value -> 'correlationId','replayed',true);
  end if;
  loaded := vortex_record.load_offboarding_ownership_transfer_facts_internal(
    p_record_type_id,p_record_id,p_expected_concurrency_number);
  if loaded ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','conflict','concurrencyNumber',loaded -> 'concurrencyNumber','correlationId',context_value -> 'correlationId');
  end if;
  if loaded ->> 'outcome' is distinct from 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object'
    or loaded ->> 'installationState' is null
    or loaded ->> 'installationState' not in ('active', 'detached')
    or pg_catalog.jsonb_typeof(loaded -> 'facts') is distinct from 'object'
    or pg_catalog.jsonb_typeof(loaded #> '{facts,records}') is distinct from 'array'
    or pg_catalog.jsonb_typeof(loaded #> '{facts,recordTypes}') is distinct from 'array' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  select item.value into record_fact from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  select item.value into type_fact from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
  storage_scope_value := record_fact #>> '{recordScope,storageScope}';
  if pg_catalog.jsonb_typeof(record_fact) is distinct from 'object'
    or pg_catalog.jsonb_typeof(type_fact) is distinct from 'object'
    or record_fact ->> 'lifecycleState' is null
    or record_fact ->> 'lifecycleState' not in ('active','soft_deleted')
    or (loaded ->> 'installationState' = 'active' and record_fact ->> 'lifecycleState' is distinct from 'soft_deleted')
    or type_fact ->> 'ownershipMode' is distinct from 'organization_account'
    or storage_scope_value is null
    or storage_scope_value not in ('application_contained', 'organization_shared')
    or (record_fact #>> '{recordScope,organizationId}')::uuid is distinct from organization_id_value
    or (record_fact #>> '{recordScope,recordTypeId}')::uuid is distinct from p_record_type_id
    or (record_fact #>> '{recordScope,storageContractId}')::uuid is distinct from (type_fact ->> 'storageContractId')::uuid
    or type_fact ->> 'storageContractId' is null
    or not vortex_platform.is_non_nil_uuid(type_fact ->> 'storageContractId')
    or (storage_scope_value = 'application_contained'
      and (record_fact #>> '{recordScope,applicationRootId}')::uuid is distinct from application_root_id_value)
    or (record_fact ->> 'ownerOrganizationAccountId')::uuid is distinct from p_source_organization_account_id then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','owner_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  -- Retained rows are never restored.  The unchanged complete Access
  -- evaluator sees only this locked target as active in an in-memory facts
  -- view, preserving every existing transfer route and condition.
  evaluation_facts := loaded -> 'facts';
  if record_fact ->> 'lifecycleState' = 'soft_deleted' then
    evaluation_facts := evaluation_facts || pg_catalog.jsonb_build_object(
      'records',
      (
        select pg_catalog.jsonb_agg(
          case
            when (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id
              then pg_catalog.jsonb_set(
                item.value, '{lifecycleState}', '"active"'::jsonb, false
              )
            else item.value
          end
          order by item.ordinal
        )
        from pg_catalog.jsonb_array_elements(evaluation_facts -> 'records')
          with ordinality as item(value, ordinal)
      )
    );
  end if;
  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', loaded -> 'declaration',
      'recordId', p_record_id,
      'facts', evaluation_facts
    )
  )) -> 0);
  if decision ->> 'outcome' = 'refused' then
    perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[organization_id_value]::uuid[], array[]::uuid[], 'refused');
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused_recorded','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  elsif decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode='42501', message='Offboarding ownership transfer authority is unavailable';
  end if;
  if not vortex_access.lock_active_record_ownership_target_internal('organization_account',p_target_id)
    or p_target_id = p_source_organization_account_id then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','owner_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  execute pg_catalog.format(
    'update record_data.%I as stored set owner_organisation_account_id=$3,owner_group_id=null,concurrency_number=concurrency_number+1,updated_at=pg_catalog.statement_timestamp(),updated_by=$4 where stored.organisation_id=$1 and stored.record_id=$2 and stored.concurrency_number=$5 returning stored.record_id,stored.concurrency_number,stored.organisation_id,%s',
    loaded ->> 'table',
    case when storage_scope_value = 'application_contained'
      then 'stored.application_root_id' else 'null::uuid' end
  ) into updated_record_id,updated_concurrency,updated_organization_id,updated_application_root_id
    using organization_id_value,p_record_id,p_target_id,actor_id_value,p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then raise exception using errcode='40001',message='Offboarding ownership transfer revision changed'; end if;
  if updated_record_id is distinct from p_record_id
    or not vortex_platform.is_non_nil_uuid(updated_record_id::text)
    or updated_organization_id is distinct from organization_id_value
    or updated_concurrency is null
    or updated_concurrency not between 1 and 9007199254740991
    or (storage_scope_value = 'application_contained'
      and updated_application_root_id is distinct from application_root_id_value) then
    raise exception using errcode='40001',message='Offboarding ownership transfer revision changed';
  end if;
  perform vortex_access.invalidate_preview_installations_internal(organization_id_value);
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation ->> 'outcome' = 'refused' then
    raise exception using errcode='42501',message='Preview Record context is unavailable';
  end if;
  exact_notice := preview_installation is null
    and loaded ->> 'installationState' = 'active'
    and storage_scope_value = 'application_contained';
  if exact_notice then
    -- Defer the exact notice until the protected transfer is complete.
    null;
  else
    perform vortex_record.bump_record_data_version_internal(
      organization_id_value, (type_fact ->> 'storageContractId')::uuid,
      case when storage_scope_value = 'application_contained'
        then application_root_id_value else null end
    );
  end if;
  perform vortex_record.append_record_activity_internal(p_activity_id, 'transfer_record_ownership', array[p_record_id]::uuid[], array[]::uuid[], 'completed');
  if loaded ->> 'installationState' = 'detached' then
    event_result := vortex_platform.append_detached_offboarding_reassignment_internal(
      (type_fact ->> 'storageContractId')::uuid, p_record_id, p_record_type_id, p_occurrence_id
    );
  else
    event_result := vortex_platform.append_record_occurrences(
      (type_fact ->> 'storageContractId')::uuid, p_record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId',p_occurrence_id,
        'descriptor',pg_catalog.jsonb_build_object(
          'kind','standard','eventKind','reassigned','recordTypeId',p_record_type_id
        ),
        'payload',pg_catalog.jsonb_build_object('kind','reassigned')
      ))
    );
  end if;
  if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
    raise exception using errcode='55000',message='Offboarding ownership transfer Event append failed';
  end if;
  if pg_catalog.jsonb_array_length(event_result) <> 1 then raise exception using errcode='55000',message='Offboarding ownership transfer Event append failed'; end if;
  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id,
    pg_catalog.jsonb_build_object('recordId', updated_record_id, 'concurrencyNumber', updated_concurrency),
    'Offboarding ownership transfer receipt is stale'
  );
  if exact_notice then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
        raise exception using errcode='22023',message='Invalidation notice command is invalid';
      end if;
      perform vortex_platform.publish_change_notice(
        updated_organization_id, updated_application_root_id, p_record_type_id,
        updated_record_id, updated_concurrency, 'changed',
        notice_sequence, notice_sequence, correlation_id_value
      );
    exception when others then
      -- Notice allocation and publication are advisory after the protected transfer is complete.
      null;
    end;
  end if;
  return pg_catalog.jsonb_build_object('outcome','transferred','recordId',updated_record_id,
    'concurrencyNumber',updated_concurrency,'correlationId',context_value -> 'correlationId','replayed',false);
end
$function$;

alter function vortex_record.transfer_record_ownership_for_offboarding_internal(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.transfer_record_ownership_for_offboarding_internal(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.transfer_record_ownership_for_offboarding_internal(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) is
  'Private offboarding single-record ownership transfer: the public transfer contract, with the command receipt, Activity and Event, for a named source owner.';

create or replace function vortex_record.prepare_record_restore_edges_internal(p_subjects jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  subject jsonb;
  field_value jsonb;
  retained_value jsonb;
  relationship_value jsonb;
  edge_changes jsonb := '[]'::jsonb;
begin
  -- Storage has restored the complete proposed closure. Validate retained fields
  -- and collect its links before the command applies all relationship changes.
  for subject in select item.value from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
  loop
    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(subject #> '{recordType,fields}') as item(value)
    loop
      if not (subject ->> 'deleted')::boolean
        and not (subject #> '{storageChange,values}') ? (
          subject -> 'columns' -> (field_value ->> 'fieldId') ->> 'token'
        ) then continue; end if;
      retained_value := coalesce(subject -> 'values' -> (field_value ->> 'fieldId'), 'null'::jsonb);
      if (field_value ->> 'required')::boolean and retained_value = 'null'::jsonb then
        raise exception using errcode = '23514', message = 'Required retained value is unavailable';
      end if;
      if retained_value = 'null'::jsonb then continue; end if;
      if not vortex_record.canonical_record_value_matches(
        retained_value, field_value ->> 'type',
        subject -> 'columns' -> (field_value ->> 'fieldId') ->> 'databaseValueType'
      ) then
        raise exception using errcode = '23514', message = 'Retained value is invalid';
      end if;
      if field_value ->> 'type' in ('link', 'link_to_one_of_several') then
        select item.value into strict relationship_value
        from pg_catalog.jsonb_array_elements(subject #> '{recordType,relationships}') as item(value)
        where item.value ->> 'fromFieldId' = field_value ->> 'fieldId';
        begin
          edge_changes := edge_changes || pg_catalog.jsonb_build_array(
            vortex_record.prepare_relationship_value_internal(
              (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
              (relationship_value ->> 'relationshipId')::uuid, retained_value, false
            )
          );
        exception when no_data_found then
          raise exception using errcode = '23514', message = 'Retained relationship is unavailable';
        end;
      end if;
    end loop;
  end loop;
  return edge_changes;
end
$function$;
alter function vortex_record.prepare_record_restore_edges_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_restore_edges_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_restore_edges_internal(jsonb) is
  'Private restore edge preparation over the restored storage set: validates retained fields and targets, returning links for the command-wide edge write.';

create or replace function vortex_record.validate_record_restore_set_internal(p_subjects jsonb)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  subjects jsonb := p_subjects;
  subject jsonb;
  field_value jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
begin
  -- Re-evaluate the actual proposed records, including recovered optional
  -- links, before exposing preparation to the runtime rule evaluator.
  for subject in select item.value from pg_catalog.jsonb_array_elements(subjects) as item(value)
  loop
    loaded := (vortex_record.load_record_access_facts_internal(case when (subject ->> 'deleted')::boolean then 'restore' else 'update' end, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', (subject ->> 'recordTypeId')::uuid, 'recordId', (subject ->> 'recordId')::uuid))) -> 0);
    if loaded ->> 'outcome' is distinct from 'loaded'
      or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object' then
      raise exception using errcode = '42501', message = 'Restored record is unavailable';
    end if;
    decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', loaded -> 'declaration', 'recordId', (subject ->> 'recordId')::uuid, 'facts', loaded -> 'facts'))) -> 0);
    if decision ->> 'outcome' is distinct from 'allowed' then
      raise exception using errcode = '42501', message = 'Restored record is unavailable';
    end if;
    bounds := vortex_record.decide_record_field_bounds_internal(decision);
    for field_value in
      select item.value from pg_catalog.jsonb_array_elements(subject #> '{recordType,fields}') as item(value)
      where (subject #> '{storageChange,values}') ? (subject -> 'columns' -> (item.value ->> 'fieldId') ->> 'token')
    loop
      if not (bounds -> 'changeableFieldIds') ? (field_value ->> 'fieldId') then
        raise exception using errcode = '42501', message = 'Restored relationship is unavailable';
      end if;
    end loop;
  end loop;
end
$function$;

alter function vortex_record.validate_record_restore_set_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.validate_record_restore_set_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.validate_record_restore_set_internal(jsonb) is
  'Private restore finalization: checks current authority and changed-field bounds against the complete restored storage and relationship graph.';

-- Private Record-adapter routine; migrations install the complete canonical body
-- under its owner with schema CREATE granted only for that migration transaction.
create or replace function vortex_record.write_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_increment_source_revision boolean
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  prepared jsonb;
  context_value jsonb;
  changed_rows integer;
begin
  prepared := vortex_record.prepare_relationship_value_internal(
    p_source_record_type_id, p_source_record_id, p_relationship_id,
    p_target_value, p_increment_source_revision
  );
  context_value := vortex_access.validated_human_request_context();
  perform vortex_record.apply_relationship_edges_internal(pg_catalog.jsonb_build_array(prepared));
  execute pg_catalog.format(
    'update record_data.%I as stored set %I = $3::jsonb%s
     where stored.organisation_id = $1 and stored.record_id = $2',
    prepared ->> 'table', prepared ->> 'column',
    case when p_increment_source_revision then
      ', concurrency_number = concurrency_number + 1, updated_at = pg_catalog.statement_timestamp(), updated_by = $4'
    else '' end
  ) using (context_value ->> 'organizationId')::uuid, p_source_record_id, p_target_value,
    (context_value ->> 'organizationAccountId')::uuid;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Relationship source record changed';
  end if;
end
$function$;

alter function vortex_record.write_relationship_value_internal(uuid,uuid,uuid,jsonb,boolean) owner to vortex_record_adapter;

revoke all on function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.write_relationship_value_internal(uuid, uuid, uuid, jsonb, boolean) is
  'Private relationship writer: validates the declared relationship and target eligibility, checks current application access for flagged Person links, share-locks the record or protected projection target, then takes the source data version and the shared edge identities before replacing the source link edge and typed value atomically. Owner-only.';
drop function vortex_record.change_record_by_named_action_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid);

create or replace function vortex_record.prepare_named_action_record_change_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_final_values jsonb,
  p_submitted_field_ids uuid[],
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  context_value jsonb;
  columns_value jsonb;
  decision jsonb;
  bounds jsonb;
  changeable text[];
  proposed_values jsonb;
  proposed_facts jsonb;
  proposed_records jsonb;
  entry_key text;
  entry_value jsonb;
  column_entry jsonb;
  field_type text;
  storage_type text;
  submitted_id uuid;
  physical_values jsonb := '{}'::jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  -- The next number must still fit the column's own range, so the highest
  -- accepted expected number is one below its maximum.
  if p_record_type_id is null or p_record_id is null
    or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_final_values is null
    or pg_catalog.jsonb_typeof(p_final_values) <> 'object'
    or p_submitted_field_ids is null
    or pg_catalog.array_position(p_submitted_field_ids, null::uuid) is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  context_value := loaded -> 'context';
  columns_value := loaded -> 'columns';

  -- The old row's own update decision, and the changeable set it carries.
  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', loaded -> 'declaration',
      'recordId', p_record_id,
      'facts', loaded -> 'facts'
    )
  )) -> 0);
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
  select coalesce(pg_catalog.array_agg(item.value #>> '{}'), array[]::text[])
  into changeable
  from pg_catalog.jsonb_array_elements(bounds -> 'changeableFieldIds') as item(value);

  -- Every submitted field must be a field of the exact installed definition and
  -- inside that changeable set. The first one outside it refuses the whole
  -- change, before any value is cast and before any statement writes.
  foreach submitted_id in array p_submitted_field_ids loop
    if not (columns_value ? pg_catalog.lower(submitted_id::text)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    if not (pg_catalog.lower(submitted_id::text) = any (changeable)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'field_not_changeable'
      );
    end if;
  end loop;

  -- Every final value must name a field of that same definition: an unknown
  -- identifier and a system column are the same refusal, because neither is a
  -- field of this record type.
  proposed_values := loaded -> 'fieldValues';
  for entry_key, entry_value in
    select pg_catalog.lower(entry.key), entry.value
    from pg_catalog.jsonb_each(p_final_values) as entry(key, value)
  loop
    column_entry := columns_value -> entry_key;
    if column_entry is null then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'unknown_field'
      );
    end if;
    field_type := column_entry ->> 'type';
    storage_type := column_entry ->> 'databaseValueType';

    -- Link fields carry relationship edges, and edge writes are S2's. Refusing
    -- with a fixed code keeps a link change from being silently dropped.
    if field_type in ('link', 'link_to_one_of_several') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'link_change_unsupported'
      );
    end if;

    if not vortex_record.canonical_record_value_matches(
      entry_value, field_type, storage_type
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'value_invalid'
      );
    end if;

    proposed_values := proposed_values || pg_catalog.jsonb_build_object(entry_key, entry_value);
    physical_values := physical_values || pg_catalog.jsonb_build_object(
      column_entry ->> 'token', entry_value
    );
  end loop;

  -- The proposed row's own update decision. Values that move the record out of
  -- every route the caller holds are refused here, after the old row admitted
  -- them and before anything is written.
  proposed_records := coalesce((
    select pg_catalog.jsonb_agg(
      case
        when pg_catalog.lower(stored.value -> 'recordScope' ->> 'recordId')
          = pg_catalog.lower(p_record_id::text)
          then stored.value || pg_catalog.jsonb_build_object('fieldValues', proposed_values)
        else stored.value
      end
      order by stored.ordinality
    )
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records')
      with ordinality as stored(value, ordinality)
  ), '[]'::jsonb);
  proposed_facts := (loaded -> 'facts')
    || pg_catalog.jsonb_build_object('records', proposed_records);

  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', loaded -> 'declaration',
      'recordId', p_record_id,
      'facts', proposed_facts
    )
  )) -> 0);
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'proposed_record_refused'
    );
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);

  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') as item(value)
  loop
    if columns_value ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, proposed_values -> field_id
      );
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'allowed',
    'recordId', p_record_id,
    'concurrencyNumber', p_expected_concurrency_number + 1,
    'values', values_value,
    'storageChange', pg_catalog.jsonb_build_object(
      'storageContractId', loaded #> '{actionContext,storageContractId}',
      'recordId', p_record_id, 'expectedConcurrencyNumber', p_expected_concurrency_number,
      'values', physical_values || pg_catalog.jsonb_build_object(
        'definition_revision', loaded -> 'moduleReleaseRevision'
      )
    )
  );
end
$function$;

alter function vortex_record.prepare_named_action_record_change_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_named_action_record_change_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_named_action_record_change_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) to vortex_record_adapter;
comment on function vortex_record.prepare_named_action_record_change_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) is
  'Private named-action update preparation: checks current and proposed action authority and field bounds, and returns the typed storage mutation without writing the record.';

create or replace function vortex_record.prepare_record_change_set_internal(
  p_command_id uuid,
  p_subjects jsonb,
  p_named_roles jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  subject jsonb;
  ordinal integer;
  meta jsonb;
  meta_cache jsonb := '{}'::jsonb;
  cache_key text;
  prepared jsonb;
  receipt vortex_record.command_receipts%rowtype;
  plans jsonb[] := array[]::jsonb[];
  storage_changes jsonb := '[]'::jsonb;
  edge_changes jsonb := '[]'::jsonb;
  effects jsonb := '[]'::jsonb;
  restore_subject jsonb;
  submitted_fields uuid[];
  normalized_edges jsonb;
  named_role jsonb;
  named_action jsonb;
  preview_installation jsonb;
  update_targets jsonb := '[]'::jsonb;
  update_ordinals integer[] := array[]::integer[];
  update_loaded jsonb[] := array[]::jsonb[];
  update_memo jsonb[] := array[]::jsonb[];
  loaded_set jsonb;
  decision_inputs jsonb[] := array[]::jsonb[];
  decision_owners integer[] := array[]::integer[];
  decisions jsonb;
  target_position integer;
  decision_position integer;
  update_meta jsonb;
  decision_pass integer;
  decision_batch jsonb[];
  batch_position integer;
begin
  if p_command_id is null or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or not vortex_record.record_change_set_is_valid_internal(p_subjects) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  perform vortex_access.validated_human_request_context();
  receipt := vortex_record.lock_command_receipt_internal('record_changes', p_command_id);
  if receipt.command_id is null or receipt.result is not null then
    raise exception using errcode = '42501', message = 'Record set receipt is unavailable';
  end if;

  -- The plain updates of the set load their current facts together (in the same stable lock
  -- order) and decide their current authority together; each update reuses these results.
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation is null then
    for subject, ordinal in
      select item.value, (item.ordinality - 1)::integer
      from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
      order by (item.value ->> 'recordTypeId')::uuid,
        (item.value ->> 'recordId')::uuid nulls last, item.ordinality
    loop
      if subject ->> 'operation' <> 'update'
        or p_named_roles #> array['roles', ordinal::text] is not null then
        continue;
      end if;
      cache_key := (subject ->> 'recordTypeId') || ':update';
      if not meta_cache ? cache_key then
        meta_cache := meta_cache || pg_catalog.jsonb_build_object(cache_key,
          vortex_record.resolve_record_action_context_internal((subject ->> 'recordTypeId')::uuid, 'update'));
      end if;
      update_meta := meta_cache -> cache_key;
      if pg_catalog.jsonb_typeof(update_meta -> 'recordType') is distinct from 'object'
        or update_meta -> 'recordType' ? 'systemProjection'
        or not coalesce((update_meta #> '{recordType,standardActions}') ? 'update', false) then
        continue;
      end if;
      update_targets := update_targets || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', (subject ->> 'recordTypeId')::uuid, 'recordId', (subject ->> 'recordId')::uuid,
        'expectedConcurrencyNumber', (subject ->> 'expectedConcurrencyNumber')::bigint
      ));
      update_ordinals := pg_catalog.array_append(update_ordinals, ordinal);
    end loop;
    if pg_catalog.cardinality(update_ordinals) > 0 then
      loaded_set := vortex_record.load_record_access_facts_internal('update', update_targets);
      for target_position in 1 .. pg_catalog.cardinality(update_ordinals) loop
        update_loaded[update_ordinals[target_position] + 1] := loaded_set -> (target_position - 1);
        if loaded_set -> (target_position - 1) ->> 'outcome' = 'loaded'
          and pg_catalog.jsonb_typeof(loaded_set -> (target_position - 1) -> 'declaration') = 'object' then
          update_meta := meta_cache -> ((update_targets -> (target_position - 1) ->> 'recordTypeId') || ':update');
          decision_inputs := pg_catalog.array_append(decision_inputs, pg_catalog.jsonb_build_object(
            'declaration', update_meta -> 'declaration',
            'recordId', (update_targets -> (target_position - 1) ->> 'recordId')::uuid,
            'facts', (loaded_set -> (target_position - 1) -> 'facts')
              || pg_catalog.jsonb_build_object( 'binding', update_meta -> 'declaration' -> 'recordBinding' )));
          decision_owners := pg_catalog.array_append(decision_owners, update_ordinals[target_position]);
          decision_inputs := pg_catalog.array_append(decision_inputs, pg_catalog.jsonb_build_object(
            'declaration', loaded_set -> (target_position - 1) -> 'declaration',
            'recordId', (update_targets -> (target_position - 1) ->> 'recordId')::uuid,
            'facts', loaded_set -> (target_position - 1) -> 'facts'));
          decision_owners := pg_catalog.array_append(decision_owners, update_ordinals[target_position]);
        end if;
      end loop;
      -- Each decision call takes at most 200 inputs: the two decisions a record needs are two
      -- calls of one input per record.
      for decision_pass in 1 .. 2 loop
        decision_batch := array[]::jsonb[];
        for decision_position in 1 .. pg_catalog.cardinality(decision_inputs) loop
          if decision_position % 2 = decision_pass % 2 then
            decision_batch := pg_catalog.array_append(decision_batch, decision_inputs[decision_position]);
          end if;
        end loop;
        if pg_catalog.cardinality(decision_batch) = 0 then continue; end if;
        decisions := vortex_access.evaluate_organization_record_access_internal(
          (select pg_catalog.jsonb_agg(item.value order by item.ordinality)
           from pg_catalog.unnest(decision_batch) with ordinality as item(value, ordinality)));
        batch_position := 0;
        for decision_position in 1 .. pg_catalog.cardinality(decision_inputs) loop
          if decision_position % 2 = decision_pass % 2 then
            update_memo[decision_owners[decision_position] + 1] := coalesce(update_memo[decision_owners[decision_position] + 1], '[]'::jsonb)
              || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
                'input', decision_inputs[decision_position], 'decision', decisions -> batch_position));
            batch_position := batch_position + 1;
          end if;
        end loop;
      end loop;
    end if;
  end if;

  -- Existing row locks are acquired in stable record-type/record identity order.
  -- Creation identities are allocated by the private create preparation itself.
  for subject, ordinal in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
    order by (item.value ->> 'recordTypeId')::uuid,
      (item.value ->> 'recordId')::uuid nulls last, item.ordinality
  loop
    named_role := p_named_roles #> array['roles', ordinal::text];
    named_action := case when named_role ->> 'role' = 'subject'
      then p_named_roles #> array['subjects', named_role ->> 'named', 'action'] end;
    -- A named subject write is prepared under its action; a declared create needs
    -- no standard create, since the installed action declares it.
    if named_action is not null and subject ->> 'operation' = 'update' then
      meta := p_named_roles -> 'actionContext';
    else
      cache_key := (subject ->> 'recordTypeId') || ':' || (subject ->> 'operation');
      if not meta_cache ? cache_key then
        meta_cache := meta_cache || pg_catalog.jsonb_build_object(cache_key,
          vortex_record.resolve_record_action_context_internal(
            (subject ->> 'recordTypeId')::uuid, subject ->> 'operation'
          ));
      end if;
      meta := meta_cache -> cache_key;
    end if;
    if pg_catalog.jsonb_typeof(meta -> 'recordType') is distinct from 'object'
      or (subject ->> 'operation' in ('create', 'update')
        and coalesce(named_role ->> 'role', 'copy') = 'copy'
        and not coalesce((meta #> '{recordType,standardActions}') ? (subject ->> 'operation'), false)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'index', ordinal, 'reasonCode', 'record_unavailable'
      );
    end if;
    if meta -> 'recordType' ? 'systemProjection' then
      if subject ->> 'operation' <> 'update' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'index', ordinal, 'reasonCode', 'record_unavailable');
      end if;
      prepared := vortex_record.prepare_settings_record_change_internal(
        (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint, subject -> 'submittedValues', subject -> 'finalValues'
      );
      if prepared ->> 'outcome' = 'prepared' and prepared -> 'currentConcurrencyNumber'
        is distinct from subject -> 'expectedConcurrencyNumber' then
        return pg_catalog.jsonb_build_object('outcome', 'conflict', 'index', ordinal, 'reasonCode', 'record_revision_conflict');
      end if;
    elsif subject ->> 'operation' = 'create' then
      prepared := vortex_record.classify_record_change_values_internal(
        (subject ->> 'recordTypeId')::uuid, subject -> 'finalValues', meta, subject -> 'submittedValues',
        (meta #>> '{context,organizationId}')::uuid, (meta #>> '{context,applicationRootId}')::uuid,
        'record_changes', p_command_id
      );
      if prepared ->> 'outcome' is distinct from 'classified' then
        return prepared || pg_catalog.jsonb_build_object('index', ordinal);
      end if;
      select coalesce(pg_catalog.array_agg(key::uuid order by key::uuid), array[]::uuid[])
      into submitted_fields from pg_catalog.jsonb_object_keys(subject -> 'submittedValues') as key;
      prepared := vortex_record.prepare_record_create_internal(
        (subject ->> 'recordTypeId')::uuid, subject -> 'finalValues', submitted_fields,
        (subject ->> 'selectedGroupId')::uuid
      );
      if prepared ->> 'outcome' = 'prepared' then
        storage_changes := storage_changes || pg_catalog.jsonb_build_array(prepared -> 'storageChange');
        edge_changes := edge_changes || (prepared -> 'edgeChanges');
      end if;
    elsif subject ->> 'operation' = 'update' then
      prepared := vortex_record.prepare_record_update_internal(
        p_command_id, 'record_changes', (subject ->> 'recordTypeId')::uuid,
        (subject ->> 'recordId')::uuid, (subject ->> 'expectedConcurrencyNumber')::bigint,
        subject -> 'submittedValues', subject -> 'finalValues', (subject ->> 'activityId')::uuid,
        named_action, meta, update_loaded[ordinal + 1], update_memo[ordinal + 1]
      );
      if prepared ->> 'outcome' = 'allowed' then
        storage_changes := storage_changes || pg_catalog.jsonb_build_array(prepared -> 'storageChange');
        edge_changes := edge_changes || (prepared -> 'edgeChanges');
      end if;
    elsif subject ->> 'operation' = 'delete' then
      prepared := vortex_record.prepare_record_delete_closure_internal(
        (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint, array[]::text[]
      );
      storage_changes := storage_changes || (prepared -> 'storageChanges');
      edge_changes := edge_changes || (prepared -> 'edgeChanges');
      effects := effects || (prepared -> 'effects');
      prepared := prepared || pg_catalog.jsonb_build_object('outcome', 'prepared');
    else
      prepared := vortex_record.prepare_record_restore_closure_internal(
        (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint
      );
      if prepared ->> 'outcome' = 'prepared' then
        storage_changes := storage_changes || (prepared -> 'storageChanges');
        for restore_subject in
          select item.value from pg_catalog.jsonb_array_elements(prepared -> 'subjects') as item(value)
        loop
          effects := effects || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'effectKind', case when (restore_subject ->> 'deleted')::boolean then 'restored' else 'links_restored' end,
            'storageContractId', restore_subject -> 'storageContractId',
            'recordTypeId', restore_subject -> 'recordTypeId', 'recordId', restore_subject -> 'recordId',
            'preConcurrencyNumber', restore_subject -> 'expectedConcurrencyNumber',
            'relationshipId', null, 'previousValue', null,
            'restoresCommandId', prepared -> 'deleteCommandId',
            'deleteRoots', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
              'recordTypeId', subject -> 'recordTypeId', 'recordId', subject -> 'recordId'
            ))
          ));
        end loop;
      end if;
    end if;
    if not coalesce(prepared ->> 'outcome' in ('allowed', 'prepared'), false) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'index', ordinal, 'subject', prepared);
    end if;
    plans := pg_catalog.array_append(plans, pg_catalog.jsonb_build_object(
      'index', ordinal, 'subject', subject, 'meta', meta, 'prepared', prepared,
      'action', named_action, 'role', named_role -> 'role'
    ));
  end loop;

  -- Overlapping delete closures can repeat the same field delta. Conflicting
  -- explicit intentions are refused before any physical record is written.
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(storage_changes) as item(value)
    cross join lateral pg_catalog.jsonb_each(item.value -> 'values') as field(key, value)
    group by item.value -> 'storageContractId', item.value -> 'recordId', field.key
    having pg_catalog.count(distinct field.value) > 1
  ) or exists (
    select 1 from pg_catalog.jsonb_array_elements(edge_changes) as item(value)
    group by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
    having pg_catalog.count(distinct pg_catalog.jsonb_build_array(
      item.value -> 'targetStorageContractId', item.value -> 'targetRecordId'
    )) > 1
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_changes_conflict');
  end if;
  select coalesce(pg_catalog.jsonb_agg(candidate.value order by candidate.value ->> 'relationshipId',
    candidate.value ->> 'sourceStorageContractId', candidate.value ->> 'sourceRecordId'), '[]'::jsonb)
  into normalized_edges
  from (
    select distinct on (item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId')
      item.value
    from pg_catalog.jsonb_array_elements(edge_changes) as item(value)
    order by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
  ) as candidate;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'plans', (select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'index')::integer)
      from pg_catalog.unnest(plans) as item(value)),
    'storageChanges', vortex_record.combine_record_storage_changes_internal(storage_changes),
    'edgeChanges', normalized_edges, 'effects', effects
  );
end
$function$;
alter function vortex_record.prepare_record_change_set_internal(uuid,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_change_set_internal(uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_change_set_internal(uuid,jsonb,jsonb) is
  'Private closed preparation of up to 200 record intents under one claimed set receipt; reuses create, update (ordinary or under a named action) and lifecycle authority checks, gathers closure effects, and combines compatible deltas for one physical write per storage table.';

drop function vortex_record.insert_named_action_record_internal(uuid,jsonb,uuid[]);
drop function vortex_record.write_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid);


-- Private Record-adapter routine; migrations install the complete canonical body
-- under its owner with schema CREATE granted only for that migration transaction.
create or replace function vortex_record.prepare_named_action_relationship_value_internal(
  p_source_record_type_id uuid,
  p_source_record_id uuid,
  p_relationship_id uuid,
  p_target_value jsonb,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_subject_record_type_id uuid,
  p_subject_record_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  source_meta jsonb;
  source_context jsonb;
  source_type jsonb;
  relationship_value jsonb;
  field_value jsonb;
  field_column jsonb;
  target_type_id uuid;
  target_record_id uuid;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  target_record jsonb;
  target_scope jsonb;
  source_application_root_id uuid;
  target_application_root_id uuid;
  mapping_row vortex_record.relationship_storage_mappings%rowtype;
  application_root_required boolean;
begin
  if p_source_record_type_id is null or p_source_record_id is null
    or p_relationship_id is null
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_subject_record_type_id is null or p_subject_record_id is null then
    raise exception using errcode = '22023', message = 'Relationship change is invalid';
  end if;
  source_meta := vortex_record.resolve_record_action_context_internal(
    p_source_record_type_id, 'read'
  );
  source_context := source_meta -> 'context';
  source_type := source_meta -> 'recordType';
  select item.value into relationship_value
  from pg_catalog.jsonb_array_elements(source_type -> 'relationships') as item(value)
  where (item.value ->> 'relationshipId')::uuid = p_relationship_id;
  if not found then
    raise exception using errcode = '23514',
      message = 'Relationship is not declared by the active record type';
  end if;
  select item.value into field_value
  from pg_catalog.jsonb_array_elements(source_type -> 'fields') as item(value)
  where (item.value ->> 'fieldId')::uuid = (relationship_value ->> 'fromFieldId')::uuid;
  if not found or field_value ->> 'type' not in ('link', 'link_to_one_of_several') then
    raise exception using errcode = '55000',
      message = 'Relationship field definition is unavailable';
  end if;
  field_column := source_meta -> 'columns' -> pg_catalog.lower(field_value ->> 'fieldId');

  select mapping.* into mapping_row
  from vortex_record.relationship_storage_mappings as mapping
  where mapping.relationship_id = p_relationship_id
    and mapping.source_storage_contract_id = (source_meta ->> 'storageContractId')::uuid
    and mapping.source_field_id = (field_value ->> 'fieldId')::uuid
    and mapping.release_revision <= (source_meta ->> 'moduleReleaseRevision')::bigint;
  if not found
    or mapping_row.cardinality is distinct from (relationship_value ->> 'cardinality')
    or mapping_row.on_parent_delete is distinct from (relationship_value ->> 'onParentDelete') then
    raise exception using errcode = '55000',
      message = 'Relationship storage disagrees with the active definition';
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) = 'null' then
    if (field_value ->> 'required')::boolean then
      raise exception using errcode = '23514', message = 'Required relationship cannot be empty';
    end if;
    perform vortex_record.acquire_relationship_edge_locks_internal(
      vortex_record.relationship_edge_lock_identities_internal(
        p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
        p_source_record_id, null, null
      )
    );
    return pg_catalog.jsonb_build_object(
      'relationshipId', p_relationship_id, 'sourceRecordId', p_source_record_id,
      'sourceStorageContractId', source_meta -> 'storageContractId',
      'sourceApplicationRootId', case when source_meta ->> 'storageScope' = 'application_contained'
        then source_context -> 'applicationRootId' else null end,
      'table', source_meta -> 'table', 'column', field_column -> 'token',
      'value', p_target_value, 'cardinality', mapping_row.cardinality
    );
  end if;

  if pg_catalog.jsonb_typeof(p_target_value) <> 'object'
    or not (p_target_value ?& array['recordTypeId', 'recordId'])
    or p_target_value - array['recordTypeId', 'recordId'] <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end if;
  begin
    target_type_id := (p_target_value ->> 'recordTypeId')::uuid;
    target_record_id := (p_target_value ->> 'recordId')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'Relationship target is invalid';
  end;
  if target_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or target_type_id <> all (mapping_row.target_record_type_ids) then
    raise exception using errcode = '23514', message = 'Relationship target is unavailable';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(target_type_id, 'read');
  source_application_root_id := case when source_meta ->> 'storageScope' = 'application_contained'
    then (source_context ->> 'applicationRootId')::uuid else null end;
  application_root_required := coalesce(
    (field_value #>> '{settings,applicationRootIdRequired}')::boolean, false
  );
  if application_root_required
    and (target_meta #>> '{recordType,systemProjection,protectedView}')
      is distinct from 'organization_accounts' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  perform vortex_record.lock_relationship_target_row_internal(
    target_type_id, target_record_id,
    (source_context ->> 'organizationId')::uuid
  );

  -- The one substitution. Executing a permitted named action must not require
  -- ordinary read authority on its own subject, so when the
  -- selected target is exactly this command's subject the decision is taken on
  -- the installed named declaration instead. The loader re-resolves the active
  -- installation, the owner kind/id/release revision, the action id and the
  -- action's declared subject record type, and the Access evaluation binds the
  -- organization, application, record type, record and the actor's current
  -- authority. Every other target keeps the ordinary read check unchanged.
  if target_type_id = p_subject_record_type_id and target_record_id = p_subject_record_id then
    target_loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, target_type_id, target_record_id, null
    );
  else
    target_loaded := (vortex_record.load_record_access_facts_internal(
      'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', target_type_id,
        'recordId', target_record_id
      ))
    ) -> 0);
  end if;
  if target_loaded ->> 'outcome' <> 'loaded'
    or pg_catalog.jsonb_typeof(target_loaded -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  target_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object(
      'declaration', target_loaded -> 'declaration',
      'recordId', target_record_id,
      'facts', target_loaded -> 'facts'
    )
  )) -> 0);
  if target_decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  select item.value into target_record
  from pg_catalog.jsonb_array_elements(target_loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = target_record_id;
  target_scope := target_record -> 'recordScope';
  target_application_root_id := case when target_meta ->> 'storageScope' = 'application_contained'
    then (target_scope ->> 'applicationRootId')::uuid else null end;
  if target_record is null or target_record ->> 'lifecycleState' <> 'active'
    or (target_scope ->> 'organizationId')::uuid <>
      (source_context ->> 'organizationId')::uuid
    or (source_application_root_id is not null and target_application_root_id is not null
      and source_application_root_id <> target_application_root_id) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;
  if application_root_required
    and not vortex_access.organization_account_has_current_application_access_internal(
      (source_context ->> 'organizationId')::uuid,
      target_record_id,
      (source_context ->> 'applicationRootId')::uuid
    ) then
    raise exception using errcode = 'P0002', message = 'Relationship target is unavailable';
  end if;

  -- The target row is share-locked (the command preflight already holds every
  -- link target) and eligible; the shared edge identities are taken last,
  -- exactly as `write_relationship_value_internal` takes them.
  perform vortex_record.acquire_relationship_edge_locks_internal(
    vortex_record.relationship_edge_lock_identities_internal(
      p_relationship_id, (source_meta ->> 'storageContractId')::uuid,
      p_source_record_id, (target_meta ->> 'storageContractId')::uuid,
      target_record_id
    )
  );
  -- Parent proposals serialize before storage and edge writes, but cardinality
  -- and cycles are checked by the edge writer on the complete resulting graph.
  -- Checking the old graph here would reject valid swaps within one set.
  if mapping_row.cardinality = 'many_to_one' and target_type_id = p_source_record_type_id then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'parent:' || (source_context ->> 'organizationId') || ':' || p_relationship_id::text, 0
    ));
  end if;

  return pg_catalog.jsonb_build_object(
    'relationshipId', p_relationship_id,
    'sourceRecordId', p_source_record_id,
    'sourceStorageContractId', source_meta -> 'storageContractId',
    'sourceApplicationRootId', source_application_root_id,
    'targetStorageContractId', target_meta -> 'storageContractId',
    'targetRecordId', target_record_id,
    'targetApplicationRootId', target_application_root_id,
    'table', source_meta -> 'table', 'column', field_column -> 'token',
    'value', p_target_value, 'cardinality', mapping_row.cardinality
  );
end
$function$;

alter function vortex_record.prepare_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) owner to vortex_record_adapter;

revoke all on function
  vortex_record.prepare_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

grant execute on function
  vortex_record.prepare_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) to vortex_record_adapter;

comment on function vortex_record.prepare_named_action_relationship_value_internal(uuid,uuid,uuid,jsonb,text,uuid,bigint,uuid,uuid,uuid) is
  'Private named-action edge preparation: checks current application access for flagged Person links, uses the ordinary or protected projection target lock and edge flow, and authorises the command subject by re-evaluating the exact installed named action rather than ordinary read.';

create or replace function vortex_record.apply_prepared_record_set_internal(p_preparation jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  storage_changes jsonb;
  edge_changes jsonb := p_preparation -> 'edgeChanges';
  written jsonb;
  plan jsonb;
  subject jsonb;
  restored_subject jsonb;
  restored_subjects jsonb := '[]'::jsonb;
  prepared jsonb;
  meta jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  preview_installation jsonb;
  relationship_value jsonb;
  results jsonb := '[]'::jsonb;
  result_value jsonb;
  create_results jsonb := '[]'::jsonb;
  create_indexes integer[] := array[]::integer[];
  update_targets jsonb := '[]'::jsonb;
  update_indexes integer[] := array[]::integer[];
  update_loaded jsonb[] := array[]::jsonb[];
  update_decisions jsonb[] := array[]::jsonb[];
  loaded_set jsonb;
  decision_set jsonb;
  set_position integer;
  target_position integer;
begin
  if p_preparation ->> 'outcome' is distinct from 'prepared'
    or pg_catalog.jsonb_typeof(p_preparation -> 'plans') is distinct from 'array'
    or pg_catalog.jsonb_typeof(edge_changes) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Prepared record set is invalid';
  end if;
  preview_installation := vortex_record.read_current_preview_installation_internal();
  storage_changes := vortex_record.combine_record_storage_changes_internal(p_preparation -> 'storageChanges');
  written := vortex_record.apply_record_storage_changes_internal(storage_changes);

  -- Restores can overlap, and generated totals can change the same row. Reload
  -- the combined persisted values rather than validate a root's partial copy.
  for plan in select item.value from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
    where item.value #>> '{subject,operation}' = 'restore'
  loop
    for restored_subject in
      select item.value from pg_catalog.jsonb_array_elements(plan #> '{prepared,subjects}') as item(value)
    loop
      loaded := (vortex_record.load_record_access_facts_internal('update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', (restored_subject ->> 'recordTypeId')::uuid, 'recordId', (restored_subject ->> 'recordId')::uuid))) -> 0);
      if loaded ->> 'outcome' is distinct from 'loaded' then
        raise exception using errcode = '42501', message = 'Restored record is unavailable';
      end if;
      restored_subjects := restored_subjects || pg_catalog.jsonb_build_array(
        restored_subject || pg_catalog.jsonb_build_object(
          'values', loaded -> 'fieldValues'
        )
      );
    end loop;
  end loop;
  edge_changes := edge_changes || vortex_record.prepare_record_restore_edges_internal(restored_subjects);
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(edge_changes) as item(value)
    group by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
    having pg_catalog.count(distinct pg_catalog.jsonb_build_array(
      item.value -> 'targetStorageContractId', item.value -> 'targetRecordId'
    )) > 1
  ) then
    raise exception using errcode = '23514', message = 'Record relationship changes conflict';
  end if;
  select coalesce(pg_catalog.jsonb_agg(candidate.value order by candidate.value ->> 'relationshipId',
    candidate.value ->> 'sourceStorageContractId', candidate.value ->> 'sourceRecordId'), '[]'::jsonb)
  into edge_changes
  from (
    select distinct on (item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId')
      item.value
    from pg_catalog.jsonb_array_elements(edge_changes) as item(value)
    order by item.value -> 'relationshipId', item.value -> 'sourceStorageContractId', item.value -> 'sourceRecordId'
  ) as candidate;
  perform vortex_record.apply_relationship_edges_internal(edge_changes);

  -- Every decision below sees the complete storage and relationship graph. A
  -- refusal raises, so callers cannot commit a partially authorized set.
  perform vortex_record.validate_record_restore_set_internal(restored_subjects);
  -- Created records finish together, and the access of every plainly changed record is decided
  -- with one facts load and one decision for the whole set.
  select coalesce(pg_catalog.array_agg((item.value ->> 'index')::integer order by (item.value ->> 'index')::integer), array[]::integer[])
  into create_indexes
  from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
  where item.value #>> '{subject,operation}' = 'create' and not (item.value #> '{meta,recordType}' ? 'systemProjection');
  if pg_catalog.cardinality(create_indexes) > 0 then
    create_results := vortex_record.complete_record_creates_internal((
      select pg_catalog.jsonb_agg(item.value -> 'prepared' order by (item.value ->> 'index')::integer)
      from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
      where item.value #>> '{subject,operation}' = 'create' and not (item.value #> '{meta,recordType}' ? 'systemProjection')
    ));
  end if;
  select coalesce(pg_catalog.array_agg((item.value ->> 'index')::integer order by (item.value ->> 'index')::integer), array[]::integer[]),
    coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'recordTypeId', item.value #> '{subject,recordTypeId}', 'recordId', item.value #> '{subject,recordId}'
    ) order by (item.value ->> 'index')::integer), '[]'::jsonb)
  into update_indexes, update_targets
  from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
  where item.value #>> '{subject,operation}' = 'update' and not (item.value #> '{meta,recordType}' ? 'systemProjection')
    and (item.value -> 'action' is null or item.value -> 'action' = 'null'::jsonb);
  if pg_catalog.cardinality(update_indexes) > 0 then
    loaded_set := vortex_record.load_record_access_facts_internal('update', update_targets);
    if preview_installation is null then
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'declaration', plan_item.value #> '{meta,declaration}',
          'recordId', update_targets -> (loaded.ordinality - 1)::integer -> 'recordId',
          'facts', (loaded.value -> 'facts') || pg_catalog.jsonb_build_object('binding', plan_item.value #> '{meta,declaration,recordBinding}')
        ) order by loaded.ordinality)
      into decision_set
      from pg_catalog.jsonb_array_elements(loaded_set) with ordinality as loaded(value, ordinality)
      join (
        select item.value, row_number() over (order by (item.value ->> 'index')::integer) as plan_position
        from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
        where item.value #>> '{subject,operation}' = 'update' and not (item.value #> '{meta,recordType}' ? 'systemProjection')
          and (item.value -> 'action' is null or item.value -> 'action' = 'null'::jsonb)
      ) as plan_item on plan_item.plan_position = loaded.ordinality
      where loaded.value ->> 'outcome' = 'loaded';
      if decision_set is not null then
        decision_set := vortex_access.evaluate_organization_record_access_internal(decision_set);
      end if;
    end if;
    set_position := 0;
    for target_position in 1 .. pg_catalog.jsonb_array_length(loaded_set) loop
      update_loaded[update_indexes[target_position] + 1] := loaded_set -> (target_position - 1);
      if loaded_set -> (target_position - 1) ->> 'outcome' = 'loaded' and preview_installation is null then
        update_decisions[update_indexes[target_position] + 1] := decision_set -> set_position;
        set_position := set_position + 1;
      end if;
    end loop;
  end if;
  for plan in select item.value from pg_catalog.jsonb_array_elements(p_preparation -> 'plans') as item(value)
    order by (item.value ->> 'index')::integer
  loop
    subject := plan -> 'subject';
    prepared := plan -> 'prepared';
    meta := plan -> 'meta';
    if meta -> 'recordType' ? 'systemProjection' then
      result_value := vortex_access.change_organization_settings_record_internal(
        (subject ->> 'recordId')::uuid, (subject ->> 'expectedConcurrencyNumber')::bigint,
        prepared -> 'coreValues', prepared -> 'extensionValues'
      );
      if result_value ->> 'outcome' is distinct from 'saved' then
        raise exception using errcode = '40001', message = 'Prepared settings record change was refused';
      end if;
      results := results || pg_catalog.jsonb_build_array(result_value || pg_catalog.jsonb_build_object(
        'recordId', subject -> 'recordId'
      ));
      continue;
    end if;
    if subject ->> 'operation' in ('create', 'update') then
      -- A different intent may have deleted or changed a link target since its
      -- preparation. Recheck target eligibility against the completed graph.
      for relationship_value in
        select item.value from pg_catalog.jsonb_array_elements(meta #> '{recordType,relationships}') as item(value)
        where (subject -> 'finalValues') ? (item.value ->> 'fromFieldId')
      loop
        if plan -> 'action' is not null and plan -> 'action' <> 'null'::jsonb then
          perform vortex_record.prepare_named_action_relationship_value_internal(
            (subject ->> 'recordTypeId')::uuid, (prepared ->> 'recordId')::uuid,
            (relationship_value ->> 'relationshipId')::uuid,
            subject -> 'finalValues' -> (relationship_value ->> 'fromFieldId'),
            plan #>> '{action,ownerKind}', (plan #>> '{action,ownerId}')::uuid,
            (plan #>> '{action,releaseRevision}')::bigint, (plan #>> '{action,actionId}')::uuid,
            (subject ->> 'recordTypeId')::uuid, (prepared ->> 'recordId')::uuid
          );
        else
          perform vortex_record.prepare_relationship_value_internal(
            (subject ->> 'recordTypeId')::uuid, (prepared ->> 'recordId')::uuid,
            (relationship_value ->> 'relationshipId')::uuid,
            subject -> 'finalValues' -> (relationship_value ->> 'fromFieldId'), false
          );
        end if;
      end loop;
    end if;
    if subject ->> 'operation' = 'create' then
      result_value := create_results -> (pg_catalog.array_position(create_indexes, (plan ->> 'index')::integer) - 1);
    elsif subject ->> 'operation' = 'update' then
      if plan -> 'action' is not null and plan -> 'action' <> 'null'::jsonb then
        loaded := vortex_record.load_named_action_facts_internal(
          plan #>> '{action,ownerKind}', (plan #>> '{action,ownerId}')::uuid,
          (plan #>> '{action,releaseRevision}')::bigint, (plan #>> '{action,actionId}')::uuid,
          (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid, null
        );
      else
        loaded := update_loaded[(plan ->> 'index')::integer + 1];
      end if;
      if loaded ->> 'outcome' is distinct from 'loaded' then
        raise exception using errcode = '42501', message = 'Changed record is unavailable';
      end if;
      if preview_installation is null then
        decision := case when plan -> 'action' is not null and plan -> 'action' <> 'null'::jsonb
          then (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', meta -> 'declaration', 'recordId', (subject ->> 'recordId')::uuid, 'facts', (loaded -> 'facts') || pg_catalog.jsonb_build_object('binding', meta #> '{declaration,recordBinding}')))) -> 0)
          else update_decisions[(plan ->> 'index')::integer + 1] end;
        if decision ->> 'outcome' is distinct from 'allowed' then
          raise exception using errcode = '42501', message = 'Changed record is unavailable';
        end if;
        bounds := vortex_access.resolve_record_field_bounds_internal(decision);
      else
        bounds := vortex_record.preview_record_field_bounds_internal(
          (subject ->> 'recordTypeId')::uuid, (meta ->> 'storageContractId')::uuid, meta -> 'recordType'
        );
        if bounds is null then
          raise exception using errcode = '42501', message = 'Changed record is unavailable';
        end if;
      end if;
      if exists (
        select 1 from pg_catalog.jsonb_object_keys(subject -> 'submittedValues') as field(key)
        where not (bounds -> 'changeableFieldIds') ? field.key
      ) then
        raise exception using errcode = '42501', message = 'Changed field is unavailable';
      end if;
      result_value := prepared - array['storageChange', 'edgeChanges']::text[];
    else
      result_value := pg_catalog.jsonb_build_object(
        'outcome', case subject ->> 'operation' when 'delete' then 'deleted' else 'restored' end,
        'recordId', subject -> 'recordId',
        'concurrencyNumber', (subject ->> 'expectedConcurrencyNumber')::bigint + 1
      );
    end if;
    results := results || pg_catalog.jsonb_build_array(result_value);
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'results', results, 'written', written);
end
$function$;
alter function vortex_record.apply_prepared_record_set_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.apply_prepared_record_set_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.apply_prepared_record_set_internal(jsonb) is
  'Private prepared-set persistence: one physical write per storage table and one edge write, followed by current authority and relationship checks over the complete graph; any refusal aborts the set.';

create or replace function vortex_record.prepare_record_calculation_graph_internal(
  p_catalogue jsonb,
  p_records jsonb,
  p_proposals jsonb,
  p_visible_record_keys text[]
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  organization_id_value uuid := (context_value ->> 'organizationId')::uuid;
  application_id_value uuid := (context_value ->> 'applicationRootId')::uuid;
  prepared_record jsonb;
  prepared_records jsonb[] := array[]::jsonb[];
  parent_read jsonb;
  module_id uuid;
  release_revision bigint;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  source_snapshot jsonb;
  source_key text;
  edge_value vortex_record.relationship_edges%rowtype;
  proposal jsonb;
begin
  if pg_catalog.jsonb_typeof(p_records) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_proposals) is distinct from 'array'
    or p_visible_record_keys is null then
    raise exception using errcode = '22023', message = 'Record calculation graph is invalid';
  end if;
  for prepared_record in
    select item.value from pg_catalog.jsonb_array_elements(p_records) as item(value)
    order by item.value ->> 'recordKey'
  loop
    select storage.module_root_id into strict module_id
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
      and storage.record_type_id = (prepared_record ->> 'recordTypeId')::uuid
      and storage.state = 'active';
    select (item.value ->> 'moduleReleaseRevision')::bigint into strict release_revision
    from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
    where item.value -> 'recordTypeId' = prepared_record -> 'recordTypeId';
    parent_read := null;
    if not ((prepared_record ->> 'recordKey') = any(p_visible_record_keys))
      and prepared_record ? 'recordId' then
      select row_read.projection into parent_read
      from vortex_record.read_record_projection_internal(
        (prepared_record ->> 'recordTypeId')::uuid, (prepared_record ->> 'recordId')::uuid
      ) as row_read;
    end if;
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb,
      'canRead', (prepared_record ->> 'recordKey') = any(p_visible_record_keys)
        or coalesce(parent_read ->> 'outcome' = 'allowed', false),
      'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
        module_id, release_revision, (prepared_record ->> 'recordTypeId')::uuid
      )
    );
    for total_field in
      select field.value from pg_catalog.jsonb_array_elements(prepared_record #> '{recordType,fields}') as field(value)
      where field.value ->> 'type' = 'total' order by field.value ->> 'fieldId'
    loop
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(p_catalogue -> 'relationships') as item(value)
      where item.value ->> 'relationshipId' = total_field #>> '{settings,relationshipId}'
        and vortex_record.relationship_declares_target_internal(
          item.value, (prepared_record ->> 'recordTypeId')::uuid
        );
      if relationship_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_refused');
      end if;
      if exists (
        select 1 from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') as source(value)
        where source.value -> 'relationshipId' = relationship_value -> 'relationshipId'
      ) then continue; end if;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
      where item.value -> 'recordTypeId' = relationship_value -> 'fromRecordTypeId';
      if source_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_refused');
      end if;
      source_records := '[]'::jsonb;
      -- Unchanged members come from the protected storage graph. Every supplied
      -- proposal replaces its old membership below, including removals and links
      -- moved between two parents by different intentions in the same command.
      for edge_value in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
          and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
          and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
          and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
          and edge.from_organisation_id = organization_id_value
          and edge.to_organisation_id = organization_id_value
          and edge.from_application_root_id is not distinct from case
            when source_type ->> 'storageScope' = 'application_contained' then application_id_value else null end
          and edge.to_application_root_id is not distinct from case
            when prepared_record #>> '{recordType,storageScope}' = 'application_contained' then application_id_value else null end
          and not exists (
            select 1 from pg_catalog.jsonb_array_elements(p_proposals) as changed(value)
            where changed.value -> 'recordTypeId' = source_type -> 'recordTypeId'
              and (changed.value ->> 'recordId')::uuid = edge.from_record_id
          )
        order by edge.from_storage_contract_id, edge.from_record_id
      loop
        source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
          p_catalogue, (source_type ->> 'recordTypeId')::uuid, edge_value.from_record_id, false
        );
        if source_snapshot is null and vortex_record.relationship_total_source_is_retained_internal(
          p_catalogue, (source_type ->> 'recordTypeId')::uuid, edge_value.from_record_id,
          organization_id_value, application_id_value
        ) then continue; end if;
        if source_snapshot is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
        select item.value ->> 'recordKey' into source_key
        from pg_catalog.jsonb_array_elements(p_records) as item(value)
        where item.value -> 'recordTypeId' = source_type -> 'recordTypeId'
          and (item.value ->> 'recordId')::uuid = edge_value.from_record_id;
        source_records := source_records || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('fieldValues', source_snapshot -> 'existingValues')
          || case when source_key is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('recordKey', source_key) end
        );
      end loop;
      for proposal in
        select item.value from pg_catalog.jsonb_array_elements(p_proposals) as item(value)
        where item.value -> 'recordTypeId' = source_type -> 'recordTypeId'
          and item.value ->> 'lifecycleState' = 'active'
          and item.value -> 'values' -> (relationship_value ->> 'fromFieldId') -> 'recordTypeId'
            = prepared_record -> 'recordTypeId'
          and item.value -> 'values' -> (relationship_value ->> 'fromFieldId') -> 'recordId'
            = prepared_record -> 'recordId'
        order by item.value ->> 'recordKey'
      loop
        source_records := source_records || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object('fieldValues', proposal -> 'values')
          || case when proposal ->> 'recordKey' is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('recordKey', proposal -> 'recordKey') end
        );
      end loop;
      prepared_record := pg_catalog.jsonb_set(prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision', 'records', source_records
          )
        )
      );
    end loop;
    prepared_records := pg_catalog.array_append(prepared_records, prepared_record);
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'prepared', 'records', coalesce(
    (select pg_catalog.jsonb_agg(item.value order by item.ordinality)
     from pg_catalog.unnest(prepared_records) with ordinality as item(value, ordinality)), '[]'::jsonb));
end
$function$;
alter function vortex_record.prepare_record_calculation_graph_internal(jsonb,jsonb,jsonb,text[]) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_calculation_graph_internal(jsonb,jsonb,jsonb,text[])
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_calculation_graph_internal(jsonb,jsonb,jsonb,text[]) is
  'Private calculation input preparation for a locked record set: delivers current rule definitions and total memberships after replacing every changed source with its proposed state, without mutating records.';







create or replace function vortex_record.record_change_total_closure_internal(
  p_catalogue jsonb,
  p_roots jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  root_value jsonb;
  closure_value jsonb;
  record_value jsonb;
  signature_value jsonb;
  identity_keys jsonb := '{}'::jsonb;
  record_keys text[] := array[]::text[];
  record_values jsonb[] := array[]::jsonb[];
  record_positions jsonb := '{}'::jsonb;
  record_entry jsonb;
  signatures jsonb := '[]'::jsonb;
  root_key text;
  record_key text;
  source_key text;
  target_key text;
  group_key text;
  group_records jsonb := '{}'::jsonb;
  group_record_map jsonb;
begin
  if pg_catalog.jsonb_typeof(p_roots) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Record calculation roots are invalid';
  end if;
  -- Explicit roots keep their caller-assigned keys even when another root's
  -- closure reaches them first. Concrete parents otherwise use their identity.
  for root_value in select item.value from pg_catalog.jsonb_array_elements(p_roots) as item(value)
  loop
    root_key := root_value ->> 'recordKey';
    if root_key is null or root_key = '' or root_value ->> 'operation' is null
      or root_value ->> 'operation' not in ('create', 'update')
      or pg_catalog.jsonb_typeof(root_value -> 'values') is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Record calculation root is invalid';
    end if;
    if root_value ->> 'operation' = 'update' then
      record_key := (root_value ->> 'recordTypeId')::uuid::text || ':' ||
        (root_value ->> 'recordId')::uuid::text;
      if identity_keys ? record_key then
        raise exception using errcode = '22023', message = 'Record calculation root is repeated';
      end if;
      identity_keys := identity_keys || pg_catalog.jsonb_build_object(record_key, root_key);
    end if;
  end loop;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_roots) as item(value)
    group by item.value ->> 'recordKey' having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Record calculation key is repeated';
  end if;
  for root_value in
    select item.value from pg_catalog.jsonb_array_elements(p_roots) as item(value)
    order by item.value ->> 'recordKey'
  loop
    root_key := root_value ->> 'recordKey';
    -- Each traversal retains the existing 256-record per-root bound. Do not
    -- skip a root already reached elsewhere: its proposed links can differ.
    closure_value := vortex_record.discover_relationship_total_closure_internal(
      p_catalogue, root_value ->> 'operation', (root_value ->> 'recordTypeId')::uuid,
      (root_value ->> 'recordId')::uuid, root_value -> 'values'
    );
    if closure_value is null then return null; end if;
    for record_value in
      select item.value from pg_catalog.jsonb_array_elements(closure_value -> 'records') as item(value)
    loop
      record_key := case when record_value ->> 'recordKey' = 'root' then root_key
        else coalesce(identity_keys ->> (record_value ->> 'recordKey'), record_value ->> 'recordKey') end;
      record_entry := record_value || pg_catalog.jsonb_build_object('recordKey', record_key);
      if record_positions ? record_key then
        record_values[(record_positions ->> record_key)::integer] := record_entry;
      else
        record_keys := pg_catalog.array_append(record_keys, record_key);
        record_values := pg_catalog.array_append(record_values, record_entry);
        record_positions := record_positions || pg_catalog.jsonb_build_object(
          record_key, pg_catalog.cardinality(record_keys));
      end if;
      -- A lifecycle root can seed several changed descendants. Its bound is
      -- over their combined transitive closure, not separately per descendant.
      for group_key in select item.value from pg_catalog.jsonb_array_elements_text(
        coalesce(root_value -> 'groupKeys', pg_catalog.jsonb_build_array(root_key))
      ) as item(value)
      loop
        group_record_map := coalesce(group_records -> group_key, '{}'::jsonb)
          || pg_catalog.jsonb_build_object(record_key, true);
        if (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(group_record_map)) > 256 then
          return pg_catalog.jsonb_build_object(
            'outcome', 'refused', 'reasonCode', 'record_change_too_large',
            'message', 'This change affects too many related records. Save fewer rows.', 'closureLimit', 256
          );
        end if;
        group_records := group_records || pg_catalog.jsonb_build_object(group_key, group_record_map);
      end loop;
    end loop;
    if pg_catalog.cardinality(record_keys) > 1000 then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_change_too_large',
        'message', 'This change affects too many related records. Save fewer rows.', 'closureLimit', 1000
      );
    end if;
    for signature_value in
      select item.value from pg_catalog.jsonb_array_elements(closure_value -> 'signatures') as item(value)
    loop
      source_key := signature_value ->> 'from';
      target_key := signature_value ->> 'to';
      signatures := signatures || pg_catalog.jsonb_build_array(signature_value || pg_catalog.jsonb_build_object(
        'from', case when source_key = 'root' then root_key else coalesce(identity_keys ->> source_key, source_key) end,
        'to', case when target_key = 'root' then root_key else coalesce(identity_keys ->> target_key, target_key) end
      ));
    end loop;
  end loop;
  return pg_catalog.jsonb_build_object(
    'records', coalesce((select pg_catalog.jsonb_agg(record_values[item.position] order by record_keys[item.position])
      from pg_catalog.generate_subscripts(record_keys, 1) as item(position)), '[]'::jsonb),
    'recordCount', pg_catalog.cardinality(record_keys),
    'signatures', coalesce((select pg_catalog.jsonb_agg(distinct item.value order by item.value)
      from pg_catalog.jsonb_array_elements(signatures) as item(value)), '[]'::jsonb)
  );
exception
  when statement_too_complex then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_change_too_large',
      'message', 'This change affects too many related records. Save fewer rows.', 'closureLimit', 256
    );
end
$function$;
alter function vortex_record.record_change_total_closure_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.record_change_total_closure_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.record_change_total_closure_internal(jsonb,jsonb) is
  'Private dependency discovery for a complete record command, preserving explicit root keys, deduplicating shared parents, and refusing beyond 256 records per root or 1000 records in the union.';



create or replace function vortex_record.record_change_set_is_valid_internal(p_subjects jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
begin
  if pg_catalog.jsonb_typeof(p_subjects) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_subjects) > 200 then return false; end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or not (item.value ?& array[
        'operation', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber',
        'submittedValues', 'finalValues', 'selectedGroupId', 'activityId', 'occurrenceId'
      ])
      or item.value - array[
        'operation', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber',
        'submittedValues', 'finalValues', 'selectedGroupId', 'activityId', 'occurrenceId'
      ]::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(item.value -> 'operation') is distinct from 'string'
      or item.value ->> 'operation' not in ('create', 'update', 'delete', 'restore')
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordTypeId')
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'activityId')
      or not vortex_platform.is_non_nil_uuid(item.value ->> 'occurrenceId')
      or pg_catalog.jsonb_typeof(item.value -> 'submittedValues') is distinct from 'object'
      or pg_catalog.jsonb_typeof(item.value -> 'finalValues') is distinct from 'object'
      or (item.value ->> 'operation' = 'create' and (
        item.value -> 'recordId' <> 'null'::jsonb
        or item.value -> 'expectedConcurrencyNumber' <> 'null'::jsonb
        or (item.value -> 'selectedGroupId' <> 'null'::jsonb
          and not vortex_platform.is_non_nil_uuid(item.value ->> 'selectedGroupId'))
      ))
      or (item.value ->> 'operation' <> 'create' and (
        not vortex_platform.is_non_nil_uuid(item.value ->> 'recordId')
        or pg_catalog.jsonb_typeof(item.value -> 'expectedConcurrencyNumber') is distinct from 'number'
        or not pg_catalog.pg_input_is_valid(item.value ->> 'expectedConcurrencyNumber', 'bigint')
        or item.value -> 'selectedGroupId' <> 'null'::jsonb
      ))
      or (item.value ->> 'operation' in ('delete', 'restore') and (
        item.value -> 'submittedValues' <> '{}'::jsonb or item.value -> 'finalValues' <> '{}'::jsonb
      ))
  ) or exists (
    select 1 from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
    where item.value ->> 'operation' <> 'create'
    group by pg_catalog.lower(item.value ->> 'recordTypeId'), pg_catalog.lower(item.value ->> 'recordId')
    having pg_catalog.count(*) > 1
  ) then
    return false;
  end if;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
    where item.value ->> 'operation' <> 'create'
      and (item.value ->> 'expectedConcurrencyNumber')::bigint not between 1 and 9007199254740990
  ) then
    return false;
  end if;
  return true;
end
$function$;
alter function vortex_record.record_change_set_is_valid_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.record_change_set_is_valid_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.record_change_set_is_valid_internal(jsonb) is
  'Validates the one closed internal record-intent storage shape, at most 200 unique subjects (empty only for a named command that writes no record), before calculation or persistence.';

create or replace function vortex_record.prepare_record_lifecycle_set_internal(p_subjects jsonb)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  subject jsonb;
  subject_index integer;
  prepared jsonb;
  storage_change jsonb;
  storage_changes jsonb := '[]'::jsonb;
  root_groups jsonb := '{}'::jsonb;
  group_keys jsonb;
  identity_key text;
  record_key text;
  record_type_id_value uuid;
  explicit_subject jsonb;
  explicit_index integer;
  operation_value text;
  meta jsonb;
  loaded jsonb;
  projection jsonb;
  changed_values jsonb;
  proposed_values jsonb;
  snapshot jsonb;
  snapshots jsonb := '[]'::jsonb;
  roots jsonb := '[]'::jsonb;
  proposals jsonb := '[]'::jsonb;
  changes jsonb := '[]'::jsonb;
  subjects jsonb := '[]'::jsonb;
  lifecycle_states jsonb := '{}'::jsonb;
begin
  if not vortex_record.record_change_set_is_valid_internal(p_subjects) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_subjects) as item(value)
    where item.value ->> 'operation' in ('delete', 'restore'))
    and vortex_record.read_current_preview_installation_internal() is not null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'preview_effect_refused');
  end if;

  -- These existing preparations own current lifecycle authority, closure locks,
  -- retained revisions and recoverable edge snapshots. They write no records.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
    where item.value ->> 'operation' in ('delete', 'restore')
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    if subject ->> 'operation' = 'delete' then
      prepared := vortex_record.prepare_record_delete_closure_internal(
        (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint, array[]::text[]
      );
    else
      prepared := vortex_record.prepare_record_restore_closure_internal(
        (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint
      );
      if prepared ->> 'outcome' is distinct from 'prepared' then
        return prepared || pg_catalog.jsonb_build_object('index', subject_index);
      end if;
    end if;
    storage_changes := storage_changes || coalesce(prepared -> 'storageChanges', '[]'::jsonb);
    for storage_change in
      select item.value from pg_catalog.jsonb_array_elements(prepared -> 'storageChanges') as item(value)
    loop
      identity_key := (storage_change ->> 'storageContractId') || ':' || (storage_change ->> 'recordId');
      group_keys := coalesce(root_groups -> identity_key, '[]'::jsonb);
      root_groups := root_groups || pg_catalog.jsonb_build_object(identity_key,
        group_keys || pg_catalog.jsonb_build_array('intent:' || subject_index::text));
      if storage_change #>> '{values,lifecycle_state}' is not null then
        if lifecycle_states ? identity_key and lifecycle_states ->> identity_key
          <> storage_change #>> '{values,lifecycle_state}' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_changes_conflict');
        end if;
        lifecycle_states := lifecycle_states || pg_catalog.jsonb_build_object(
          identity_key, storage_change #> '{values,lifecycle_state}'
        );
      end if;
    end loop;
  end loop;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(storage_changes) as item(value)
    cross join lateral pg_catalog.jsonb_each(item.value -> 'values') as field(key, value)
    group by item.value -> 'storageContractId', item.value -> 'recordId', field.key
    having pg_catalog.count(distinct field.value) > 1
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_changes_conflict');
  end if;

  for storage_change in
    select item.value from pg_catalog.jsonb_array_elements(
      vortex_record.combine_record_storage_changes_internal(storage_changes)
    ) as item(value)
    order by item.value ->> 'storageContractId', item.value ->> 'recordId'
  loop
    select storage.record_type_id into strict record_type_id_value
    from vortex_record.storage_catalogue as storage
    where storage.storage_contract_id = (storage_change ->> 'storageContractId')::uuid
      and storage.state = 'active';
    select item.value, (item.ordinality - 1)::integer into explicit_subject, explicit_index
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
    where (item.value ->> 'recordTypeId')::uuid = record_type_id_value
      and item.value -> 'recordId' = storage_change -> 'recordId';
    if explicit_subject ->> 'operation' in ('create', 'update') then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_changes_conflict');
    end if;
    record_key := case when explicit_subject is not null then 'intent:' || explicit_index::text
      else record_type_id_value::text || ':' || (storage_change ->> 'recordId') end;
    operation_value := case storage_change #>> '{values,lifecycle_state}'
      when 'soft_deleted' then 'delete' when 'active' then 'restore' else 'update' end;
    meta := vortex_record.resolve_record_action_context_internal(record_type_id_value, operation_value);
    loaded := (vortex_record.load_record_access_facts_internal(operation_value, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', record_type_id_value, 'recordId', (storage_change ->> 'recordId')::uuid))) -> 0);
    if loaded ->> 'outcome' is distinct from 'loaded' then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
    end if;
    select coalesce(pg_catalog.jsonb_object_agg(field.key, storage_change -> 'values' -> (field.value ->> 'token')),
      '{}'::jsonb) into changed_values
    from pg_catalog.jsonb_each(meta -> 'columns') as field(key, value)
    where (storage_change -> 'values') ? (field.value ->> 'token');
    proposed_values := (loaded -> 'fieldValues') || changed_values;
    snapshot := pg_catalog.jsonb_build_object(
      'recordKey', record_key, 'recordTypeId', record_type_id_value, 'recordType', meta -> 'recordType',
      'storageContractId', storage_change -> 'storageContractId', 'recordId', storage_change -> 'recordId',
      'concurrencyNumber', storage_change -> 'expectedConcurrencyNumber',
      'definitionRevision', meta -> 'moduleReleaseRevision', 'existingValues', loaded -> 'fieldValues',
      -- Discovery must see the old outgoing links even for a row this command removes.
      -- Actual proposed lifecycle state is supplied separately to total membership.
      'lifecycleState', 'active'
    );
    snapshots := snapshots || pg_catalog.jsonb_build_array(snapshot);
    identity_key := (storage_change ->> 'storageContractId') || ':' || (storage_change ->> 'recordId');
    roots := roots || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordKey', record_key, 'operation', 'update', 'recordTypeId', record_type_id_value,
      'recordId', storage_change -> 'recordId', 'values', changed_values,
      'groupKeys', root_groups -> identity_key
    ));
    proposals := proposals || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordKey', record_key, 'recordTypeId', record_type_id_value, 'recordId', storage_change -> 'recordId',
      'values', proposed_values, 'lifecycleState', case operation_value when 'delete' then 'soft_deleted' else 'active' end
    ));
    changes := changes || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordKey', record_key, 'operation', operation_value, 'storedValues', loaded -> 'fieldValues',
      'submittedValues', changed_values, 'proposedValues', proposed_values
    ));
    if explicit_subject is not null then
      projection := (vortex_record.read_record(record_type_id_value, (storage_change ->> 'recordId')::uuid)) -> 'record';
      subjects := subjects || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordKey', record_key, 'index', explicit_index, 'outcome', 'prepared',
        'recordType', meta -> 'recordType', 'existingValues', loaded -> 'fieldValues',
        'readableFieldIds', case when projection ->> 'outcome' = 'allowed' then
          (select coalesce(pg_catalog.jsonb_agg(field.key order by field.key), '[]'::jsonb)
           from pg_catalog.jsonb_object_keys(projection -> 'values') as field(key)) else '[]'::jsonb end,
        'correlationId', context_value -> 'correlationId'
      ));
    end if;
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'prepared', 'roots', roots, 'snapshots', snapshots,
    'proposals', proposals, 'changes', changes, 'subjects', subjects);
exception
  when serialization_failure then
    return pg_catalog.jsonb_build_object('outcome', 'conflict', 'reasonCode', 'record_revision_conflict');
  when no_data_found or insufficient_privilege or check_violation then
    raise warning 'Record lifecycle preparation refused: [%] %', sqlstate, sqlerrm;
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_lifecycle_refused');
end
$function$;
alter function vortex_record.prepare_record_lifecycle_set_internal(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_lifecycle_set_internal(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_lifecycle_set_internal(jsonb) is
  'Private lifecycle calculation inputs for a complete command: authorizes and locks exact per-root delete or restore closures, combines their compatible deltas, and exposes stored rule values and proposed membership without writing records.';

create or replace function vortex_record.prepare_record_calculation_set_internal(
  p_subjects jsonb,
  p_named_roles jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  catalogue jsonb;
  subject jsonb;
  subject_index integer;
  root_key text;
  roots jsonb := '[]'::jsonb;
  root_keys text[] := array[]::text[];
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  loaded jsonb;
  decision jsonb;
  prepared jsonb;
  subjects jsonb := '[]'::jsonb;
  prepared_subjects jsonb[] := array[]::jsonb[];
  proposals jsonb;
  graph jsonb;
  meta jsonb;
  projection_records jsonb := '[]'::jsonb;
  preview_installation jsonb;
  lifecycle jsonb;
  named_prepared jsonb;
  meta_cache jsonb := '{}'::jsonb;
  cache_key text;
  update_targets jsonb := '[]'::jsonb;
  update_indexes integer[] := array[]::integer[];
  update_loaded jsonb[] := array[]::jsonb[];
  update_decisions jsonb[] := array[]::jsonb[];
  loaded_set jsonb;
  decision_set jsonb;
  set_position integer;
  target_position integer;
begin
  if not vortex_record.record_change_set_is_valid_internal(p_subjects) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'preview_unavailable');
  end if;
  catalogue := case when preview_installation is null
    then vortex_record.relationship_total_catalogue_internal() else '{}'::jsonb end;
  lifecycle := vortex_record.prepare_record_lifecycle_set_internal(p_subjects);
  if lifecycle ->> 'outcome' is distinct from 'prepared' then return lifecycle; end if;
  catalogue := catalogue || pg_catalog.jsonb_build_object('proposedRecords', lifecycle -> 'snapshots');
  roots := lifecycle -> 'roots';
  subjects := lifecycle -> 'subjects';
  select coalesce(pg_catalog.array_agg(item.value ->> 'recordKey'), array[]::text[]) into root_keys
  from pg_catalog.jsonb_array_elements(subjects) as item(value);
  -- Resolve each record type's context once, and decide the access of every plain update
  -- source with one facts load and one decision for the whole set.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
  loop
    if subject ->> 'operation' not in ('create', 'update') then
      continue;
    end if;
    cache_key := (subject ->> 'recordTypeId') || ':' || (subject ->> 'operation');
    if not meta_cache ? cache_key then
      meta_cache := meta_cache || pg_catalog.jsonb_build_object(cache_key,
        vortex_record.resolve_record_action_context_internal(
          (subject ->> 'recordTypeId')::uuid, subject ->> 'operation'
        ));
    end if;
    if subject ->> 'operation' = 'update' and preview_installation is null
      and not (meta_cache -> cache_key -> 'recordType' ? 'systemProjection')
      and vortex_record.named_record_change_values_internal(p_named_roles, subject_index) is null then
      update_targets := update_targets || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', subject -> 'recordTypeId', 'recordId', subject -> 'recordId'
      ));
      update_indexes := pg_catalog.array_append(update_indexes, subject_index);
    end if;
  end loop;
  if pg_catalog.jsonb_array_length(update_targets) > 0 then
    loaded_set := vortex_record.load_record_access_facts_internal('update', update_targets);
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'declaration', loaded.value -> 'declaration',
        'recordId', update_targets -> (loaded.ordinality - 1)::integer -> 'recordId',
        'facts', loaded.value -> 'facts'
      ) order by loaded.ordinality)
    into decision_set
    from pg_catalog.jsonb_array_elements(loaded_set) with ordinality as loaded(value, ordinality)
    where loaded.value ->> 'outcome' = 'loaded'
      and pg_catalog.jsonb_typeof(loaded.value -> 'declaration') = 'object';
    if decision_set is not null then
      decision_set := vortex_access.evaluate_organization_record_access_internal(decision_set);
    end if;
    set_position := 0;
    for target_position in 1 .. pg_catalog.jsonb_array_length(loaded_set) loop
      update_loaded[update_indexes[target_position] + 1] := loaded_set -> (target_position - 1);
      if loaded_set -> (target_position - 1) ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(loaded_set -> (target_position - 1) -> 'declaration') = 'object' then
        update_decisions[update_indexes[target_position] + 1] := decision_set -> set_position;
        set_position := set_position + 1;
      end if;
    end loop;
  end if;
  -- Authorize every explicit source before reading or locking its dependencies.
  -- A null expected revision is the existing loader's non-locking read mode.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
  loop
    if subject ->> 'operation' not in ('create', 'update') then
      continue;
    end if;
    named_prepared := vortex_record.named_record_change_values_internal(p_named_roles, subject_index);
    meta := meta_cache -> ((subject ->> 'recordTypeId') || ':' || (subject ->> 'operation'));
    if preview_installation is not null or meta -> 'recordType' ? 'systemProjection' then
      prepared := coalesce(named_prepared, vortex_record.prepare_record_values_internal(
        subject ->> 'operation', (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint, subject -> 'submittedValues',
        (subject ->> 'selectedGroupId')::uuid, (subject ->> 'activityId')::uuid
      ));
      if prepared ->> 'outcome' is distinct from 'prepared' then
        return prepared || pg_catalog.jsonb_build_object('index', subject_index);
      end if;
      projection_records := projection_records || pg_catalog.jsonb_build_array(
        prepared || pg_catalog.jsonb_build_object(
          'recordKey', 'intent:' || subject_index::text, 'recordTypeId', subject -> 'recordTypeId',
          'canRead', true, 'relationshipSources', '[]'::jsonb
        ) || case when subject ->> 'operation' = 'create' then '{}'::jsonb
          else pg_catalog.jsonb_build_object('recordId', subject -> 'recordId',
            'concurrencyNumber', subject -> 'expectedConcurrencyNumber') end
      );
      continue;
    end if;
    if named_prepared is not null then
      -- The action's own authority and revision were verified with the named scope.
      null;
    elsif subject ->> 'operation' = 'update' then
      loaded := update_loaded[subject_index + 1];
      if loaded ->> 'outcome' is distinct from 'loaded'
        or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'index', subject_index, 'reasonCode', 'record_unavailable'
        );
      end if;
      decision := update_decisions[subject_index + 1];
      if decision ->> 'outcome' is distinct from 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'index', subject_index, 'reasonCode', 'record_unavailable'
        );
      end if;
      if (loaded ->> 'concurrencyNumber')::bigint
        is distinct from (subject ->> 'expectedConcurrencyNumber')::bigint then
        return pg_catalog.jsonb_build_object('outcome', 'conflict', 'index', subject_index);
      end if;
    else
      -- A plain create has no stored record to authorize here; its values are prepared once
      -- below, after the closure is locked.
      null;
    end if;
    root_key := 'intent:' || subject_index::text;
    roots := roots || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordKey', root_key, 'operation', subject -> 'operation',
      'recordTypeId', subject -> 'recordTypeId', 'recordId', subject -> 'recordId',
      'values', subject -> 'submittedValues'
    ));
    root_keys := pg_catalog.array_append(root_keys, root_key);
  end loop;
  before_closure := vortex_record.record_change_total_closure_internal(catalogue, roots);
  if before_closure is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_refused');
  end if;
  if before_closure ->> 'outcome' = 'refused' then return before_closure; end if;
  if (before_closure ->> 'recordCount')::integer + pg_catalog.jsonb_array_length(projection_records) > 1000 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_change_too_large');
  end if;
  for record_value in
    select item.value from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value)
    where item.value ? 'recordId'
    order by (item.value ->> 'storageContractId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    if vortex_record.relationship_total_record_snapshot_internal(
      catalogue, (record_value ->> 'recordTypeId')::uuid, (record_value ->> 'recordId')::uuid, true
    ) is null then return pg_catalog.jsonb_build_object('outcome', 'restart'); end if;
  end loop;
  after_closure := vortex_record.record_change_total_closure_internal(catalogue, roots);
  if after_closure ->> 'outcome' = 'refused' then return after_closure; end if;
  if after_closure is null or before_closure -> 'signatures' is distinct from after_closure -> 'signatures'
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
      from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value))
      is distinct from (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  -- Reuse current access, field policy, metadata and rule preparation after the
  -- complete concrete union is locked. No record or receipt is written here.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
  loop
    if subject ->> 'operation' not in ('create', 'update') then continue; end if;
    prepared := coalesce(
      vortex_record.named_record_change_values_internal(p_named_roles, subject_index),
      vortex_record.prepare_record_values_internal(
        subject ->> 'operation', (subject ->> 'recordTypeId')::uuid, (subject ->> 'recordId')::uuid,
        (subject ->> 'expectedConcurrencyNumber')::bigint, subject -> 'submittedValues',
        (subject ->> 'selectedGroupId')::uuid, (subject ->> 'activityId')::uuid
      )
    );
    if prepared ->> 'outcome' is distinct from 'prepared' then
      return prepared || pg_catalog.jsonb_build_object('index', subject_index);
    end if;
    prepared_subjects := pg_catalog.array_append(prepared_subjects, prepared || pg_catalog.jsonb_build_object(
      'recordKey', 'intent:' || subject_index::text, 'index', subject_index
    ));
  end loop;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'recordKey', record.value -> 'recordKey', 'recordTypeId', root.value -> 'recordTypeId',
    'recordId', root.value -> 'recordId', 'values', (record.value -> 'existingValues') || (root.value -> 'values'),
    'lifecycleState', 'active'
  )), '[]'::jsonb) into proposals
  from pg_catalog.jsonb_array_elements(roots) as root(value)
  join pg_catalog.jsonb_array_elements(after_closure -> 'records') as record(value)
    on root.value -> 'recordKey' = record.value -> 'recordKey'
  where not exists (select 1 from pg_catalog.jsonb_array_elements(lifecycle -> 'proposals') as changed(value)
    where changed.value -> 'recordKey' = root.value -> 'recordKey');
  proposals := proposals || (lifecycle -> 'proposals');
  -- Restored records calculate from the recovered values, while their rule
  -- execution retains the stored deleted snapshot supplied in lifecycleChanges.
  select pg_catalog.jsonb_agg(case when changed.value ->> 'operation' = 'restore'
      then item.value || pg_catalog.jsonb_build_object('existingValues', changed.value -> 'proposedValues')
      else item.value end order by item.value ->> 'recordKey') into prepared
  from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)
  left join pg_catalog.jsonb_array_elements(lifecycle -> 'changes') as changed(value)
    on changed.value -> 'recordKey' = item.value -> 'recordKey';
  graph := vortex_record.prepare_record_calculation_graph_internal(
    catalogue, coalesce(prepared, '[]'::jsonb), proposals, root_keys
  );
  if graph ->> 'outcome' is distinct from 'prepared' then return graph; end if;
  return graph || pg_catalog.jsonb_build_object(
    'records', (graph -> 'records') || projection_records,
    'subjects', (select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'index')::integer)
      from (select existing.value from pg_catalog.jsonb_array_elements(subjects) as existing(value)
        union all select added.value from pg_catalog.unnest(prepared_subjects) as added(value)) as item(value)),
    'lifecycleChanges', lifecycle -> 'changes', 'lifecycleProposals', lifecycle -> 'proposals',
    'correlationId', context_value -> 'correlationId',
    'preview', preview_installation is not null,
    'readableFieldIds', '[]'::jsonb,
    'recordCount', (after_closure ->> 'recordCount')::integer + pg_catalog.jsonb_array_length(projection_records)
  );
end
$function$;
alter function vortex_record.prepare_record_calculation_set_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_calculation_set_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_record_calculation_set_internal(jsonb,jsonb) is
  'Private record-set calculation preflight: authorizes roots (a named command''s subject and declared creates by its action) and lifecycle closures, locks their complete dependency union, repeats current authority and revisions, and returns one rule and total graph for all four intents.';

create or replace function vortex_record.prepare_record_changes(
  p_command_id uuid,
  p_subjects jsonb,
  p_named jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt jsonb;
  preparation jsonb;
  effective_command_id uuid;
  named_roles jsonb;
begin
  if p_command_id is null or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or not vortex_record.record_change_set_is_valid_internal(p_subjects)
    or (p_named is null and pg_catalog.jsonb_array_length(p_subjects) = 0) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'preview_unavailable');
  end if;
  receipt := vortex_record.claim_command_receipt_internal('record_changes', effective_command_id, true);
  if receipt ->> 'status' = 'completed' then
    return vortex_record.replay_record_changes_internal(effective_command_id, receipt -> 'result');
  elsif receipt ->> 'status' <> 'none' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  -- With a named action, its authority replaces ordinary authority for the
  -- subject and its declared creates, and every intent must be one of its effects.
  if p_named is not null then
    named_roles := vortex_record.prepare_named_record_change_roles_internal(p_subjects, p_named);
    if named_roles ->> 'outcome' is distinct from 'prepared' then
      return named_roles || pg_catalog.jsonb_build_object('correlationId', context_value -> 'correlationId');
    end if;
  end if;
  -- An action that only announces writes no record and has nothing to calculate.
  if pg_catalog.jsonb_array_length(p_subjects) = 0 then
    return vortex_record.retain_record_change_preparation_internal(effective_command_id, p_subjects, p_named,
      pg_catalog.jsonb_build_object(
      'outcome', 'prepared', 'records', '[]'::jsonb, 'subjects', '[]'::jsonb,
      'lifecycleChanges', '[]'::jsonb, 'lifecycleProposals', '[]'::jsonb, 'recordCount', 0,
      'preview', vortex_record.read_current_preview_installation_internal() is not null,
      'correlationId', context_value -> 'correlationId', 'namedRoles', named_roles
    ));
  end if;
  preparation := vortex_record.prepare_record_calculation_set_internal(p_subjects, named_roles)
    || pg_catalog.jsonb_build_object('correlationId', context_value -> 'correlationId', 'namedRoles', named_roles);
  -- The writer takes this locked preparation later in the same transaction instead of preparing again.
  if preparation ->> 'outcome' = 'prepared' then
    perform vortex_record.retain_record_change_preparation_internal(effective_command_id, p_subjects, p_named, preparation);
  end if;
  return preparation;
end
$function$;
alter function vortex_record.prepare_record_changes(uuid,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_changes(uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_record_changes(uuid,jsonb,jsonb) to vortex_request;
comment on function vortex_record.prepare_record_changes(uuid,jsonb,jsonb) is
  'Protected record-set calculation preflight and current-authority replay projection; one command identity, optionally one named action over its subjects, one locked dependency graph, no record writes.';






-- The validator needs owner EXECUTE while replacing this function; its canonical grants revoke it again.
grant execute on function vortex_record.transfer_offboarding_active_owned_record(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,bigint) to vortex_record_adapter;

create or replace function vortex_record.transfer_offboarding_active_owned_record(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_target_kind text,
  p_target_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_expected_access_version bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
begin
  select authorized.* into strict scope
  from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;
  if p_expected_access_version is null
    or scope.access_version is distinct from p_expected_access_version then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'access_changed');
  end if;

  begin
    return vortex_record.apply_record_mutations_internal(
      p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind', 'transfer_ownership',
        'targetKind', p_target_kind,
        'targetId', p_target_id
      )),
      p_activity_id, p_occurrence_id
    );
  exception
    when serialization_failure or lock_not_available then
      -- Identical per-record boundary to the retained entry: a contested final
      -- update rolls back its own pending receipt and is reported as a
      -- conflict, so one contested record never fails the whole batch.
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end;
end
$function$;

alter function vortex_record.transfer_offboarding_active_owned_record(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,bigint) owner to vortex_record_adapter;

revoke all on function vortex_record.transfer_offboarding_active_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_record.transfer_offboarding_active_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, bigint
) to vortex_request;
comment on function vortex_record.transfer_offboarding_active_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, bigint
) is
  'Protected request entry for one disclosed account-offboarding transfer of an ordinary active record; it rechecks accounts.manage scope and delegates all target, owner, lifecycle, authority and revision checks to the one record-change operation''s terminal ownership transfer.';

-- The validator needs owner EXECUTE while replacing this function; its canonical grants revoke it again.
grant execute on function vortex_record.transfer_offboarding_owned_record(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,uuid,bigint) to vortex_record_adapter;

CREATE OR REPLACE FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  -- The one record-change operation checks the accounts.manage scope and its access version,
  -- reloads the record facts, locks the target and requires the caller's expected concurrency
  -- number before it mutates anything.
  begin
    return vortex_record.apply_record_mutations_internal(
      p_command_id, p_record_type_id, p_record_id,
      p_expected_concurrency_number,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind', 'offboarding_transfer',
        'targetKind', p_target_kind,
        'targetId', p_target_id,
        'sourceOrganizationAccountId', p_source_organization_account_id,
        'expectedAccessVersion', p_expected_access_version
      )),
      p_activity_id, p_occurrence_id
    );
  exception
    when serialization_failure or lock_not_available then
      -- A contested final update is an expected per-record result. The nested
      -- exception block rolls back its pending receipt before returning it.
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end;
end
$$;
alter function vortex_record.transfer_offboarding_owned_record(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,uuid,bigint) owner to vortex_record_adapter;


COMMENT ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) IS 'The one protected request entry for a disclosed account-offboarding transfer of a retained or disabled-installation record; the record-change operation checks the accounts.manage scope, access version, target, owner, lifecycle and revision.';

REVOKE ALL ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) FROM vortex_record_adapter;
GRANT ALL ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) TO vortex_request;

drop function vortex_record.apply_record_changes(uuid,text,uuid,uuid,bigint,jsonb,uuid,jsonb,uuid,uuid,jsonb);

drop function vortex_record.save_base_record_set(uuid,jsonb);

drop function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb);
drop function vortex_record.save_base_record(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid);
drop function vortex_record.prepare_base_record_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid);
drop function vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid);
drop function vortex_record.apply_settings_record_changes(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid);
drop function vortex_record.apply_settings_record_changes_internal(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid);

create or replace function vortex_record.prepare_record_restore_target(p_record_type_id uuid, p_record_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  loaded jsonb;
  prepared jsonb;
begin
  perform vortex_access.validated_human_request_context();
  if vortex_record.read_current_preview_installation_internal() is not null then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;
  loaded := (vortex_record.load_record_access_facts_internal('restore', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', p_record_type_id, 'recordId', p_record_id))) -> 0);
  if loaded ->> 'outcome' is distinct from 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;
  -- A retained record has no ordinary page projection. Reveal only its current
  -- revision, and only after the existing exact closure authority check passes.
  prepared := vortex_record.prepare_record_restore_closure_internal(
    p_record_type_id, p_record_id, (loaded ->> 'concurrencyNumber')::bigint
  );
  if prepared ->> 'outcome' is distinct from 'prepared' then
    return pg_catalog.jsonb_build_object('outcome', 'unavailable');
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'allowed', 'concurrencyNumber', loaded -> 'concurrencyNumber');
exception when no_data_found or insufficient_privilege or check_violation then
  raise warning 'Restore target unavailable: [%] %', sqlstate, sqlerrm;
  return pg_catalog.jsonb_build_object('outcome', 'unavailable');
end
$function$;
alter function vortex_record.prepare_record_restore_target(uuid,uuid) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_record_restore_target(uuid,uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_record_restore_target(uuid,uuid) to vortex_request;
comment on function vortex_record.prepare_record_restore_target(uuid,uuid) is
  'Protected retained-record revision lookup for a restore step: current exact closure authority is required, no stored field values are exposed and no records are written.';


create or replace function vortex_record.read_record_change_targets(
  p_targets jsonb,
  p_lock boolean
)
returns table (ordinal integer, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target record;
  read_row record;
  reads jsonb := '[]'::jsonb;
  loaded jsonb;
begin
  perform vortex_access.validated_human_request_context();
  if p_lock is null or pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) > 400
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_targets) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'recordTypeId', 'uuid'), false)
        or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'recordId', 'uuid'), false)
    ) then
    raise exception using errcode = '22023', message = 'Record change targets are invalid';
  end if;

  -- Authorize every projection before taking locks; no field beyond that read decision leaves.
  for target in select item.value, item.ordinality::integer as ordinal
    from pg_catalog.jsonb_array_elements(p_targets) with ordinality as item(value, ordinality)
  loop
    select row_read.* into read_row
    from vortex_record.read_record_projection_internal(
      (target.value ->> 'recordTypeId')::uuid, (target.value ->> 'recordId')::uuid
    ) as row_read;
    reads := reads || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'target', target.value, 'ordinal', target.ordinal,
      'projection', read_row.projection, 'facts', read_row.read_facts, 'bounds', read_row.read_bounds
    ));
  end loop;

  -- Copy sources are not themselves updated, so retain their observed revision until commit.
  -- The shared loader also handles preview storage; never introduce another access decision.
  for target in select item.value from pg_catalog.jsonb_array_elements(reads) as item(value)
    order by item.value #>> '{facts,recordTypeMeta,storageContractId}',
      item.value #>> '{target,recordId}'
  loop
    ordinal := (target.value ->> 'ordinal')::integer;
    if p_lock and target.value #>> '{projection,outcome}' = 'allowed' then
      if (target.value #>> '{facts,isSystemProjection}')::boolean then
        result := pg_catalog.jsonb_build_object('record', pg_catalog.jsonb_build_object('outcome', 'refused'), 'capabilities', null);
        return next;
        continue;
      end if;
      loaded := (vortex_record.load_record_access_facts_internal('read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', (target.value #>> '{target,recordTypeId}')::uuid, 'recordId', (target.value #>> '{target,recordId}')::uuid, 'expectedConcurrencyNumber', (target.value #>> '{projection,concurrencyNumber}')::bigint))) -> 0);
      if loaded ->> 'outcome' is distinct from 'loaded' then
        raise exception using errcode = '40001', message = 'Record copy source changed';
      end if;
      result := vortex_record.read_record(
        (target.value #>> '{target,recordTypeId}')::uuid,
        (target.value #>> '{target,recordId}')::uuid
      );
    else
      result := pg_catalog.jsonb_build_object(
        'record', target.value -> 'projection',
        'capabilities', case when target.value #>> '{projection,outcome}' = 'allowed'
          then vortex_record.read_record_capabilities_internal(
            (target.value #>> '{target,recordTypeId}')::uuid,
            (target.value #>> '{target,recordId}')::uuid,
            target.value -> 'facts', target.value -> 'bounds', null
          ) end
      );
    end if;
    return next;
  end loop;
end
$function$;

alter function vortex_record.read_record_change_targets(jsonb,boolean) owner to vortex_record_adapter;
revoke all on function vortex_record.read_record_change_targets(jsonb,boolean)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_change_targets(jsonb,boolean) to vortex_request, vortex_owner;
comment on function vortex_record.read_record_change_targets(jsonb,boolean) is
  'Bounded current record projections and capabilities for a composed change; relationship copies lock ordinary source and destination revisions through the shared access loader.';


create or replace function vortex_record.prepare_named_record_change_intents_internal(
  p_named_action jsonb,
  p_subjects jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_reference jsonb;
  action_context jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  copy_plan jsonb;
  creation_plan jsonb;
  subject jsonb;
  subject_index integer;
  expected_fields jsonb;
  supplied_fields jsonb;
  root_fields jsonb;
  root_delete boolean;
  root_seen boolean := false;
  creation_tasks jsonb;
  creation_index integer := 0;
  creation_task jsonb;
  creations jsonb := '[]'::jsonb;
  copy_values jsonb;
  copied_targets uuid[] := array[]::uuid[];
  roles jsonb := '{}'::jsonb;
begin
  if pg_catalog.jsonb_typeof(p_named_action) is distinct from 'object'
    or not (p_named_action ?& array['action', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'inputs'])
    or p_named_action - array['action', 'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'inputs']::text[] <> '{}'::jsonb
    or not vortex_platform.is_non_nil_uuid(p_named_action ->> 'recordTypeId')
    or not vortex_platform.is_non_nil_uuid(p_named_action ->> 'recordId')
    or not coalesce(pg_catalog.pg_input_is_valid(p_named_action ->> 'expectedConcurrencyNumber', 'bigint'), false)
    or (p_named_action ->> 'expectedConcurrencyNumber')::bigint not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_named_action -> 'inputs') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_subjects) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_subjects) > 200 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  action_reference := p_named_action -> 'action';
  if pg_catalog.jsonb_typeof(action_reference) is distinct from 'object'
    or not (action_reference ?& array['ownerKind', 'ownerId', 'releaseRevision', 'actionId'])
    or action_reference - array['ownerKind', 'ownerId', 'releaseRevision', 'actionId']::text[] <> '{}'::jsonb
    or action_reference ->> 'ownerKind' not in ('application', 'module')
    or not vortex_platform.is_non_nil_uuid(action_reference ->> 'ownerId')
    or not vortex_platform.is_non_nil_uuid(action_reference ->> 'actionId')
    or not coalesce(pg_catalog.pg_input_is_valid(action_reference ->> 'releaseRevision', 'bigint'), false)
    or (action_reference ->> 'releaseRevision')::bigint not between 1 and 9007199254740991 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  action_context := vortex_record.resolve_named_action_context_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid
  );
  loaded := vortex_record.load_named_action_facts_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid, (p_named_action ->> 'recordId')::uuid,
    (p_named_action ->> 'expectedConcurrencyNumber')::bigint
  );
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object('outcome', 'conflict', 'reasonCode', 'stale_revision');
  end if;
  if loaded ->> 'outcome' is distinct from 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', loaded -> 'declaration', 'recordId', (p_named_action ->> 'recordId')::uuid, 'facts', loaded -> 'facts'))) -> 0);
  if decision ->> 'outcome' is distinct from 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
  if not vortex_record.validate_named_action_reference_inputs_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid, p_named_action -> 'inputs'
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_inputs_invalid');
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(action_context #> '{action,tasks}') as task(value)
    where task.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_effects_invalid');
  end if;
  select coalesce(pg_catalog.jsonb_agg(distinct field.key order by field.key), '[]'::jsonb)
  into root_fields
  from pg_catalog.jsonb_array_elements(action_context #> '{action,tasks}') as task(value)
  cross join lateral pg_catalog.jsonb_object_keys(task.value #> '{properties,values}') as field(key)
  where task.value ->> 'type' = 'record.set_fields';
  root_delete := exists (select 1 from pg_catalog.jsonb_array_elements(action_context #> '{action,tasks}') as task(value)
    where task.value ->> 'type' = 'record.delete');
  if root_delete and pg_catalog.jsonb_array_length(root_fields) > 0 then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_effects_invalid');
  end if;
  select coalesce(pg_catalog.jsonb_agg(task.value || pg_catalog.jsonb_build_object('ordinal', task.ordinality - 1)
    order by task.ordinality), '[]'::jsonb) into creation_tasks
  from pg_catalog.jsonb_array_elements(action_context #> '{action,tasks}') with ordinality as task(value, ordinality)
  where task.value ->> 'type' = 'record.create';
  copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid, (p_named_action ->> 'recordId')::uuid,
    p_named_action -> 'inputs', action_context
  );
  if copy_plan ->> 'outcome' = 'refused' then return copy_plan; end if;

  -- The four-intent shape stays unchanged. The exact installed action bounds which
  -- subject, creation and copy each intent represents; derived parents come from the graph.
  for subject, subject_index in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)
  loop
    select coalesce(pg_catalog.jsonb_agg(field.key order by field.key), '[]'::jsonb)
    into supplied_fields from pg_catalog.jsonb_object_keys(subject -> 'submittedValues') as field(key);
    if subject ->> 'operation' = 'create' then
      creation_task := creation_tasks -> creation_index;
      if creation_task is null or subject -> 'recordTypeId' is distinct from creation_task #> '{properties,recordType,recordTypeId}'
        or subject -> 'selectedGroupId' is distinct from 'null'::jsonb then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'creation_plan_mismatch');
      end if;
      select coalesce(pg_catalog.jsonb_agg(field.key order by field.key), '[]'::jsonb)
      into expected_fields from pg_catalog.jsonb_object_keys(creation_task #> '{properties,values}') as field(key);
      if supplied_fields is distinct from expected_fields then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'creation_plan_mismatch');
      end if;
      creations := creations || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'ordinal', creation_task -> 'ordinal', 'recordTypeId', subject -> 'recordTypeId',
        'values', subject -> 'submittedValues', 'finalValues', subject -> 'finalValues'
      ));
      roles := roles || pg_catalog.jsonb_build_object(subject_index::text, 'creation');
      creation_index := creation_index + 1;
    elsif subject -> 'recordTypeId' = p_named_action -> 'recordTypeId'
      and subject -> 'recordId' = p_named_action -> 'recordId' then
      if root_seen or subject -> 'expectedConcurrencyNumber' is distinct from p_named_action -> 'expectedConcurrencyNumber'
        or (root_delete and subject ->> 'operation' <> 'delete')
        or (not root_delete and (subject ->> 'operation' <> 'update' or pg_catalog.jsonb_array_length(root_fields) = 0))
        or supplied_fields is distinct from root_fields then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_subject_mismatch');
      end if;
      root_seen := true;
      roles := roles || pg_catalog.jsonb_build_object(subject_index::text, 'subject');
    else
      select pg_catalog.jsonb_object_agg(copy.value ->> 'fromFieldId', copy.value -> 'value')
      into copy_values from pg_catalog.jsonb_array_elements(coalesce(copy_plan -> 'copies', '[]'::jsonb)) as copy(value)
      where copy.value -> 'targetRecordId' = subject -> 'recordId';
      if subject ->> 'operation' <> 'update' or subject -> 'recordTypeId' is distinct from p_named_action -> 'recordTypeId'
        or copy_values is null or subject -> 'submittedValues' is distinct from copy_values
        or (subject ->> 'recordId')::uuid = any(copied_targets) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'relationship_copy_plan_mismatch');
      end if;
      copied_targets := pg_catalog.array_append(copied_targets, (subject ->> 'recordId')::uuid);
      roles := roles || pg_catalog.jsonb_build_object(subject_index::text, 'copy');
    end if;
  end loop;
  if root_seen is distinct from (root_delete or pg_catalog.jsonb_array_length(root_fields) > 0)
    or creation_index <> pg_catalog.jsonb_array_length(creation_tasks)
    or exists (select 1 from pg_catalog.jsonb_array_elements(coalesce(copy_plan -> 'copies', '[]'::jsonb)) as copy(value)
      where not ((copy.value ->> 'targetRecordId')::uuid = any(copied_targets))) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_effects_missing');
  end if;
  creation_plan := vortex_record.named_action_creation_plan_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named_action ->> 'recordTypeId')::uuid, creations, action_context
  );
  if creation_plan ->> 'outcome' is distinct from 'planned' then return creation_plan; end if;
  return pg_catalog.jsonb_build_object('outcome', 'prepared', 'actionContext', action_context,
    'loaded', loaded, 'bounds', bounds, 'intentRoles', roles, 'createTargets', creation_plan -> 'createTargets');
end
$function$;

alter function vortex_record.prepare_named_record_change_intents_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_named_record_change_intents_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_named_record_change_intents_internal(jsonb,jsonb) is
  'Private named-command authority and intent scope: verifies the exact installed action, current subject permission and revision, declared creates, exact relationship copies and optional subject delete before the common record writer prepares its graph.';


create or replace function vortex_record.prepare_named_action_subject_internal(
  p_preview boolean,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_inputs jsonb,
  p_read_loaded jsonb,
  p_action_context jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  action_context jsonb;
  creation_plan jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  copy_plan jsonb;
  copy_targets jsonb := '[]'::jsonb;
  copy_target record;
  target_meta jsonb;
  target_loaded jsonb;
  target_decision jsonb;
  record_type_meta jsonb;
  reused_read_facts boolean := false;
begin
  if p_preview is null or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  -- The context depends only on the action and the record type: a page that previews
  -- one action for many records resolves it once and passes it here; null resolves it now.
  action_context := coalesce(p_action_context, vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  ));
  if pg_catalog.jsonb_typeof(action_context -> 'action' -> 'tasks') is distinct from 'array'
    or pg_catalog.jsonb_array_length(action_context -> 'action' -> 'tasks') not between 1 and 10
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(
        action_context -> 'action' -> 'tasks'
      ) item(value)
      where item.value ->> 'type' not in ('record.set_fields', 'record.create', 'record.changes', 'record.delete', 'event.announce')
    ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  creation_plan := vortex_record.named_action_creation_plan_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, null, action_context
  );
  if creation_plan ->> 'outcome' <> 'planned' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'reasonCode', creation_plan -> 'reasonCode',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  -- A preview of a record its caller has just read in this invocation reuses
  -- that read's facts when they are exactly the facts the named loader would
  -- build: the record alone, with no inherited owner, no edge and no
  -- relationship route on any of the action's permissions. Only the fixed
  -- record adapter can pass them; the action's own decision is still made below.
  record_type_meta := p_read_loaded -> 'recordTypeMeta';
  if p_preview and p_read_loaded ->> 'outcome' = 'loaded'
    and not (p_read_loaded ? 'previewInstallationId')
    and (p_read_loaded ->> 'isSystemProjection')::boolean is false
    and p_read_loaded -> 'context' = context_value
    and pg_catalog.jsonb_typeof(record_type_meta) = 'object'
    and pg_catalog.lower(record_type_meta ->> 'recordTypeId') = pg_catalog.lower(p_record_type_id::text)
    and coalesce(record_type_meta ->> 'ownershipMode', '') <> 'inherited'
    and p_read_loaded #> '{facts,binding}' = action_context #> '{declaration,recordBinding}'
    and pg_catalog.jsonb_array_length(p_read_loaded #> '{facts,records}') = 1
    and p_read_loaded #>> '{facts,records,0,recordScope,recordId}' = pg_catalog.lower(p_record_id::text)
    and p_read_loaded #> '{facts,edges}' = '[]'::jsonb
    and pg_catalog.jsonb_typeof(action_context #> '{declaration,requiredPermissions}') = 'array'
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(action_context #> '{declaration,requiredPermissions}') as required(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_read_loaded -> 'accessPermissions'
            -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes') = 'array'
          then p_read_loaded -> 'accessPermissions'
            -> pg_catalog.lower(required.value ->> 'permissionId') -> 'recordScope' -> 'routes'
          else '[{"kind": "relationship"}]'::jsonb end
      ) as route(value)
      where route.value ->> 'kind' = 'relationship'
    ) then
    loaded := pg_catalog.jsonb_build_object(
      'outcome', 'loaded',
      'declaration', action_context -> 'declaration',
      'facts', p_read_loaded -> 'facts',
      'concurrencyNumber', p_read_loaded -> 'concurrencyNumber',
      'fieldValues', p_read_loaded -> 'fieldValues'
    );
    reused_read_facts := true;
  else
    loaded := vortex_record.load_named_action_facts_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id,
      case when p_preview then null else p_expected_concurrency_number end
    );
  end if;
  if loaded ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  if p_preview and (loaded ->> 'concurrencyNumber')::bigint <>
      p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  -- Read facts reused above keep the record types their read decision
  -- validated in this invocation; the named loader's own facts are validated in full.
  decision := vortex_access.evaluate_record_access_with_validated_types_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts', null,
    case when reused_read_facts then loaded #> '{facts,recordTypes}' end
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'subject_permission_refused', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  bounds := vortex_record.decide_record_field_bounds_internal(decision);
  -- Use the same locked copy plan the writer re-derives. Only rows with an
  -- actual new edge are evaluated; a no-op copy does not save its target.
  copy_plan := vortex_record.prepare_named_action_relationship_copies_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_inputs, action_context
  );
  if copy_plan ->> 'outcome' = 'refused' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', copy_plan -> 'reasonCode',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  for copy_target in
    select (item.value ->> 'targetRecordId')::uuid as record_id,
      pg_catalog.jsonb_object_agg(
        item.value ->> 'fromFieldId', item.value -> 'value'
      ) as submitted_values
    from pg_catalog.jsonb_array_elements(
      coalesce(copy_plan -> 'copies', '[]'::jsonb)
    ) item(value)
    group by 1
    order by 1
  loop
    target_meta := vortex_record.resolve_record_action_context_internal(
      p_record_type_id, 'update'
    );
    target_loaded := (vortex_record.load_record_access_facts_internal(
      'update', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', p_record_type_id,
        'recordId', copy_target.record_id
      ))
    ) -> 0);
    if target_loaded ->> 'outcome' is distinct from 'loaded' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'relationship_copy_target_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    target_decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'declaration', target_meta -> 'declaration',
        'recordId', copy_target.record_id,
        'facts', (target_loaded -> 'facts') || pg_catalog.jsonb_build_object( 'binding', target_meta -> 'declaration' -> 'recordBinding' )
      )
    )) -> 0);
    if target_decision ->> 'outcome' is distinct from 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_object_keys(copy_target.submitted_values) field_id
      where not exists (
        select 1 from pg_catalog.jsonb_array_elements_text(
          vortex_record.decide_record_field_bounds_internal(target_decision)
            -> 'changeableFieldIds'
        ) allowed(value)
        where pg_catalog.lower(allowed.value) = pg_catalog.lower(field_id)
      )
    ) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    copy_targets := copy_targets || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'recordId', copy_target.record_id,
        'concurrencyNumber', target_loaded -> 'concurrencyNumber',
        'existingValues', target_loaded -> 'fieldValues',
        'submittedValues', copy_target.submitted_values
      )
    );
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', case when p_preview then 'previewed' else 'prepared' end,
    'action', action_context -> 'action',
    'validationContractVersion', action_context -> 'validationContractVersion',
    'recordType', action_context -> 'recordType',
    -- The owning Module release's rules for the subject, evaluated by Record.
    'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
      (action_context ->> 'moduleRootId')::uuid,
      (action_context ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),
    'createTargets', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'ordinal', item.value -> 'ordinal',
          'recordTypeId', item.value -> 'recordTypeId',
          'recordType', item.value -> 'recordType',
          'beforeSaveFlows', item.value -> 'beforeSaveFlows'
        ) order by (item.value ->> 'ordinal')::integer
      )
      from pg_catalog.jsonb_array_elements(creation_plan -> 'createTargets') item(value)
    ), '[]'::jsonb),
    'copyTargets', copy_targets,
    'recordId', p_record_id,
    'existingValues', loaded -> 'fieldValues',
    -- A singleton required permission was decided by the named-action access
    -- check above. The Record port may use it for a choice gated by that exact
    -- permission; a multi-permission declaration grants no such shortcut.
    'singleRequiredPermissionId', case
      when pg_catalog.jsonb_array_length(
        loaded #> '{declaration,requiredPermissions}'
      ) = 1 then loaded #> '{declaration,requiredPermissions,0,permissionId}'
      else 'null'::jsonb
    end,
    'readableFieldIds', bounds -> 'readableFieldIds',
    'changeableFieldIds', bounds -> 'changeableFieldIds',
    'eventDescriptors', action_context -> 'eventDescriptors',
    'actorOrganizationAccountId', context_value -> 'organizationAccountId',
    'correlationId', context_value -> 'correlationId'
  );
end
$function$;
alter function vortex_record.prepare_named_action_subject_internal(boolean,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_named_action_subject_internal(boolean,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_named_action_subject_internal(boolean,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb) is
  'Private named-action subject preparation shared by preview and command execution: resolves current action authority, locked facts, creation metadata and relationship copies without reading or writing a command receipt or Activity.';

-- Named actions write through apply_record_changes: the per-action writer, its
-- previews and every private step only it used are retired.
drop function vortex_record.apply_action_record_changes(uuid,jsonb,jsonb);
drop function vortex_record.prepare_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid);
drop function vortex_record.preview_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid);
drop function vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid,jsonb,jsonb);
drop function vortex_record.prepare_named_action_command_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,text,uuid,bigint,uuid);
drop function vortex_record.complete_named_action_changes_internal(text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,boolean,jsonb,jsonb,integer,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,jsonb,jsonb,boolean,boolean,uuid,uuid,bigint,uuid,uuid,boolean);
drop function vortex_record.named_action_deleted_subject_replay_internal(uuid,text,uuid,bigint,uuid,uuid);
drop function vortex_record.apply_named_action_relationship_copies_internal(jsonb);
drop function vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb);
drop function vortex_record.authorize_created_records_for_command_internal(jsonb,jsonb,jsonb);
drop function vortex_record.change_record_relationship_internal(uuid,uuid,bigint,uuid,jsonb);
drop function vortex_record.create_record_internal(uuid,jsonb,uuid[],uuid);
drop function vortex_record.named_action_command_closure_internal(jsonb,uuid,uuid,jsonb,jsonb);
drop function vortex_record.named_action_command_link_targets_internal(jsonb,uuid,jsonb,jsonb);
drop function vortex_record.reserve_named_action_creation_locks_internal(uuid,jsonb);
drop function vortex_record.share_lock_named_action_target_internal(jsonb,uuid,uuid);
drop function vortex_record.record_lifecycle_current_revision_internal(uuid,uuid);
drop function vortex_record.record_lifecycle_total_closure_internal(jsonb,text,uuid,uuid,uuid);
drop function vortex_record.validate_named_action_reference_inputs(text,uuid,bigint,uuid,uuid,jsonb);

create or replace function vortex_record.prepare_named_record_change_roles_internal(
  p_subjects jsonb,
  p_named jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_reference jsonb;
  named_subject jsonb;
  named_position integer;
  slice jsonb;
  prepared jsonb;
  action_context jsonb;
  roles jsonb := '{}'::jsonb;
  subjects jsonb := '[]'::jsonb;
  intent_index integer;
  slice_position integer;
  creation_position integer;
  role text;
  covered integer[] := array[]::integer[];
begin
  if pg_catalog.jsonb_typeof(p_named) is distinct from 'object'
    or not (p_named ?& array['action', 'recordTypeId', 'subjects'])
    or p_named - array['action', 'recordTypeId', 'subjects']::text[] <> '{}'::jsonb
    or not vortex_platform.is_non_nil_uuid(p_named ->> 'recordTypeId')
    or pg_catalog.jsonb_typeof(p_named -> 'subjects') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_named -> 'subjects') not between 1 and 200
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_named -> 'subjects') as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not (item.value ?& array['recordId', 'expectedConcurrencyNumber', 'inputs',
          'intentIndexes', 'activityId', 'declaredOccurrenceIds'])
        or item.value - array['recordId', 'expectedConcurrencyNumber', 'inputs',
          'intentIndexes', 'activityId', 'declaredOccurrenceIds']::text[] <> '{}'::jsonb
        or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordId')
        or not vortex_platform.is_non_nil_uuid(item.value ->> 'activityId')
        or pg_catalog.jsonb_typeof(item.value -> 'intentIndexes') is distinct from 'array'
        or pg_catalog.jsonb_typeof(item.value -> 'declaredOccurrenceIds') is distinct from 'array'
        or exists (select 1 from pg_catalog.jsonb_array_elements(item.value -> 'intentIndexes') as entry(value)
          where pg_catalog.jsonb_typeof(entry.value) is distinct from 'number'
            or not coalesce(pg_catalog.pg_input_is_valid(entry.value #>> '{}', 'integer'), false)
            or (entry.value #>> '{}')::integer not between 0 and pg_catalog.jsonb_array_length(p_subjects) - 1)
        or exists (select 1 from pg_catalog.jsonb_array_elements(item.value -> 'declaredOccurrenceIds') as entry(value)
          where not vortex_platform.is_non_nil_uuid(entry.value #>> '{}'))
    )
    or (select pg_catalog.count(distinct pg_catalog.lower(item.value ->> 'recordId'))
      from pg_catalog.jsonb_array_elements(p_named -> 'subjects') as item(value))
      <> pg_catalog.jsonb_array_length(p_named -> 'subjects') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  action_reference := p_named -> 'action';
  -- Subjects are validated in record identity order so overlapping commands lock alike.
  for named_subject, named_position in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_named -> 'subjects') with ordinality as item(value, ordinality)
    order by (item.value ->> 'recordId')::uuid
  loop
    select coalesce(pg_catalog.jsonb_agg(p_subjects -> (entry.value #>> '{}')::integer order by entry.ordinality), '[]'::jsonb)
    into slice
    from pg_catalog.jsonb_array_elements(named_subject -> 'intentIndexes') with ordinality as entry(value, ordinality);
    prepared := vortex_record.prepare_named_record_change_intents_internal(
      pg_catalog.jsonb_build_object(
        'action', action_reference, 'recordTypeId', p_named -> 'recordTypeId',
        'recordId', named_subject -> 'recordId',
        'expectedConcurrencyNumber', named_subject -> 'expectedConcurrencyNumber',
        'inputs', named_subject -> 'inputs'
      ),
      slice
    );
    if prepared ->> 'outcome' is distinct from 'prepared' then
      return prepared || pg_catalog.jsonb_build_object('namedIndex', named_position);
    end if;
    action_context := prepared -> 'actionContext';
    if pg_catalog.jsonb_array_length(named_subject -> 'declaredOccurrenceIds')
      <> pg_catalog.jsonb_array_length(coalesce(action_context -> 'eventDescriptors', '[]'::jsonb)) then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid',
        'namedIndex', named_position);
    end if;
    creation_position := 0;
    for intent_index, slice_position in
      select (entry.value #>> '{}')::integer, (entry.ordinality - 1)::integer
      from pg_catalog.jsonb_array_elements(named_subject -> 'intentIndexes') with ordinality as entry(value, ordinality)
    loop
      if intent_index = any(covered) then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
      end if;
      covered := pg_catalog.array_append(covered, intent_index);
      role := prepared #>> array['intentRoles', slice_position::text];
      roles := roles || pg_catalog.jsonb_build_object(intent_index::text, pg_catalog.jsonb_build_object(
        'role', role, 'named', named_position,
        'creation', case when role = 'creation' then pg_catalog.to_jsonb(creation_position) end
      ));
      if role = 'creation' then creation_position := creation_position + 1; end if;
    end loop;
    subjects := subjects || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'position', named_position, 'recordId', named_subject -> 'recordId',
      'expectedConcurrencyNumber', named_subject -> 'expectedConcurrencyNumber',
      'activityId', named_subject -> 'activityId',
      'declaredOccurrenceIds', named_subject -> 'declaredOccurrenceIds',
      'deletes', exists (select 1 from pg_catalog.jsonb_array_elements(slice) as item(value)
        where item.value ->> 'operation' = 'delete'),
      'writesSubject', exists (select 1 from pg_catalog.jsonb_array_elements(slice) as item(value)
        where item.value ->> 'operation' = 'update'
          and item.value -> 'recordId' = named_subject -> 'recordId'),
      'action', action_reference || pg_catalog.jsonb_build_object('inputs', named_subject -> 'inputs'),
      'existingValues', prepared #> '{loaded,fieldValues}',
      'readableFieldIds', prepared #> '{bounds,readableFieldIds}',
      'createTargets', prepared -> 'createTargets'
    ));
  end loop;
  -- A named command carries only the effects its action declares: no other intent.
  if pg_catalog.cardinality(covered) <> pg_catalog.jsonb_array_length(p_subjects) then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'action_effects_invalid');
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'roles', roles, 'actionContext', action_context,
    'recordTypeId', p_named -> 'recordTypeId',
    'beforeSaveFlows', vortex_record.before_save_flows_for_record_type_internal(
      (action_context ->> 'moduleRootId')::uuid,
      (action_context ->> 'moduleReleaseRevision')::bigint,
      (p_named ->> 'recordTypeId')::uuid
    ),
    'subjects', (select pg_catalog.jsonb_agg(item.value order by (item.value ->> 'position')::integer)
      from pg_catalog.jsonb_array_elements(subjects) as item(value))
  );
end
$function$;
alter function vortex_record.prepare_named_record_change_roles_internal(jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_named_record_change_roles_internal(jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.prepare_named_record_change_roles_internal(jsonb,jsonb) is
  'Private named-command scope: for one installed action over up to 200 subjects, verifies each subject''s current action authority and revision and that every intent is one of that subject''s declared effects (subject write or delete, declared create, exact relationship copy), returning each intent''s role.';

create or replace function vortex_record.named_record_change_values_internal(
  p_named_roles jsonb,
  p_index integer
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  role_value jsonb := p_named_roles #> array['roles', p_index::text];
  named_subject jsonb;
  target jsonb;
begin
  if role_value is null or role_value ->> 'role' not in ('subject', 'creation') then
    return null;
  end if;
  named_subject := p_named_roles -> 'subjects' -> (role_value ->> 'named')::integer;
  if role_value ->> 'role' = 'subject' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'prepared', 'recordType', p_named_roles #> '{actionContext,recordType}',
      'beforeSaveFlows', p_named_roles -> 'beforeSaveFlows',
      'correlationId', vortex_access.validated_human_request_context() -> 'correlationId',
      'readableFieldIds', named_subject -> 'readableFieldIds',
      'existingValues', named_subject -> 'existingValues'
    );
  end if;
  select item.value into target
  from pg_catalog.jsonb_array_elements(named_subject -> 'createTargets') with ordinality as item(value, ordinality)
  where item.ordinality - 1 = (role_value ->> 'creation')::integer;
  if target is null then
    raise exception using errcode = '55000', message = 'Named action creation target is unavailable';
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared', 'recordType', target -> 'recordType',
    'beforeSaveFlows', target -> 'beforeSaveFlows',
    'correlationId', vortex_access.validated_human_request_context() -> 'correlationId',
    'readableFieldIds', '[]'::jsonb, 'existingValues', '{}'::jsonb
  );
end
$function$;
alter function vortex_record.named_record_change_values_internal(jsonb,integer) owner to vortex_record_adapter;
revoke all on function vortex_record.named_record_change_values_internal(jsonb,integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.named_record_change_values_internal(jsonb,integer) is
  'Private: the calculation inputs of a named command''s subject or declared create (record type, BeforeSave flows, current values and readable fields under the action), or null for an intent ordinary authority prepares.';

create or replace function vortex_record.replay_record_changes_internal(
  p_effective_command_id uuid,
  p_result jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  preview_installation jsonb := vortex_record.read_current_preview_installation_internal();
  stored_result jsonb;
  projection jsonb;
  results jsonb := '[]'::jsonb;
  named_results jsonb := '[]'::jsonb;
  loaded jsonb;
  decision jsonb;
begin
  if pg_catalog.jsonb_typeof(p_result -> 'results') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_result -> 'results') > 200
    or (pg_catalog.jsonb_array_length(p_result -> 'results') = 0 and not p_result ? 'named') then
    raise exception using errcode = '55000', message = 'Stored record change result is invalid';
  end if;
  -- A replay uses the identities retained by the command and today's protected
  -- projections. Neither changed retry input nor previously readable values
  -- can widen current authority or disclose a stale receipt payload.
  for stored_result in
    select item.value from pg_catalog.jsonb_array_elements(p_result -> 'results') as item(value)
  loop
    if stored_result ->> 'operation' in ('delete', 'restore') then
      loaded := (vortex_record.load_record_access_facts_internal(stored_result ->> 'operation', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('recordTypeId', (stored_result ->> 'recordTypeId')::uuid, 'recordId', (stored_result ->> 'recordId')::uuid))) -> 0);
      if loaded ->> 'outcome' = 'loaded' and pg_catalog.jsonb_typeof(loaded -> 'declaration') = 'object' then
        -- Recheck the original delete authority against today's retained
        -- ownership and scopes. Only rows journaled by this exact command
        -- may stand in their pre-delete lifecycle state for that decision.
        if stored_result ->> 'operation' = 'delete' then
          loaded := pg_catalog.jsonb_set(loaded, '{facts,records}', (
            select pg_catalog.jsonb_agg(case when item.value ->> 'lifecycleState' = 'soft_deleted'
              and exists (select 1 from vortex_record.record_lifecycle_command_effects as effect
                where effect.command_id = p_effective_command_id and effect.effect_kind = 'soft_deleted'
                  and effect.organization_id = (context_value ->> 'organizationId')::uuid
                  and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
                  and effect.record_id = (item.value #>> '{recordScope,recordId}')::uuid
                  and effect.storage_contract_id = (item.value #>> '{recordScope,storageContractId}')::uuid)
              then item.value || pg_catalog.jsonb_build_object('lifecycleState', 'active') else item.value end
              order by item.ordinality)
            from pg_catalog.jsonb_array_elements(loaded #> '{facts,records}') with ordinality as item(value, ordinality)
          ));
        end if;
        decision := (vortex_access.evaluate_organization_record_access_internal(pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('declaration', loaded -> 'declaration', 'recordId', (stored_result ->> 'recordId')::uuid, 'facts', loaded -> 'facts'))) -> 0);
      else
        decision := null;
      end if;
      if decision ->> 'outcome' is distinct from 'allowed' then
        return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId');
      end if;
      results := results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'outcome', case stored_result ->> 'operation' when 'delete' then 'deleted' else 'restored' end,
        'recordId', stored_result -> 'recordId', 'concurrencyNumber', stored_result -> 'concurrencyNumber',
        'unrestoredLinkCount', stored_result -> 'unrestoredLinkCount',
        'correlationId', context_value -> 'correlationId', 'replayed', true
      ));
      continue;
    end if;
    projection := (vortex_record.read_record(
      (stored_result ->> 'recordTypeId')::uuid, (stored_result ->> 'recordId')::uuid
    )) -> 'record';
    if projection ->> 'outcome' is distinct from 'allowed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    results := results || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'outcome', 'saved', 'recordTypeId', stored_result -> 'recordTypeId',
      'recordId', projection -> 'recordId', 'concurrencyNumber', projection -> 'concurrencyNumber',
      'values', projection -> 'values', 'correlationId', context_value -> 'correlationId',
      'backgroundDelivery', case when preview_installation is null then 'pending' else 'none' end,
      'replayed', true
    ));
  end loop;
  -- A named command replays each subject through the action's own current
  -- projection; a subject the action deleted keeps its stored deleted outcome.
  if p_result ? 'named' then
    for stored_result in
      select item.value from pg_catalog.jsonb_array_elements(p_result #> '{named,subjects}') as item(value)
    loop
      if (stored_result ->> 'deleted')::boolean then
        projection := pg_catalog.jsonb_build_object(
          'outcome', 'completed', 'recordId', stored_result -> 'recordId',
          'concurrencyNumber', stored_result -> 'concurrencyNumber', 'values', '{}'::jsonb,
          'correlationId', context_value -> 'correlationId', 'backgroundDelivery', 'pending', 'replayed', true
        );
      else
        projection := vortex_record.project_named_action_record_internal(
          p_result #>> '{named,action,ownerKind}', (p_result #>> '{named,action,ownerId}')::uuid,
          (p_result #>> '{named,action,releaseRevision}')::bigint, (p_result #>> '{named,action,actionId}')::uuid,
          (p_result #>> '{named,recordTypeId}')::uuid, (stored_result ->> 'recordId')::uuid
        );
        if projection ->> 'outcome' is distinct from 'completed' then
          return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable',
            'correlationId', context_value -> 'correlationId');
        end if;
        projection := projection || pg_catalog.jsonb_build_object('correlationId', context_value -> 'correlationId');
      end if;
      named_results := named_results || pg_catalog.jsonb_build_array(projection);
    end loop;
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'completed', 'results', results, 'replayed', true,
    'correlationId', context_value -> 'correlationId')
    || case when p_result ? 'named' then pg_catalog.jsonb_build_object('namedResults', named_results)
      else '{}'::jsonb end;
end
$function$;
alter function vortex_record.replay_record_changes_internal(uuid,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.replay_record_changes_internal(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.replay_record_changes_internal(uuid,jsonb) is
  'Private replay of a completed record command: reprojects each retained identity (and each named subject through its action) under current authority; it never returns stored values.';

create or replace function vortex_record.complete_named_record_subject_internal(
  p_named_roles jsonb,
  p_subject jsonb,
  p_field_values jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  field_values jsonb := p_field_values;
  loaded jsonb;
  event_result jsonb;
begin
  -- A subject write already recorded the action with its changed fields.
  if not (p_subject ->> 'writesSubject')::boolean then
    perform vortex_record.append_record_activity_internal(
      (p_subject ->> 'activityId')::uuid, 'execute_named_action',
      array[(p_subject ->> 'recordId')::uuid], array[]::uuid[], 'completed'
    );
  end if;
  if pg_catalog.jsonb_array_length(p_subject -> 'declaredOccurrenceIds') = 0 then
    return;
  end if;
  if field_values is null then
    loaded := vortex_record.load_named_action_facts_internal(
      p_subject #>> '{action,ownerKind}', (p_subject #>> '{action,ownerId}')::uuid,
      (p_subject #>> '{action,releaseRevision}')::bigint, (p_subject #>> '{action,actionId}')::uuid,
      (p_named_roles ->> 'recordTypeId')::uuid, (p_subject ->> 'recordId')::uuid, null
    );
    if loaded ->> 'outcome' is distinct from 'loaded' then
      raise exception using errcode = '55000', message = 'Named action Event values are unavailable';
    end if;
    field_values := loaded -> 'fieldValues';
  end if;
  event_result := vortex_record.append_declared_named_action_occurrences_internal(
    (p_named_roles #>> '{actionContext,storageContractId}')::uuid, (p_subject ->> 'recordId')::uuid,
    p_named_roles #> '{actionContext,eventDescriptors}', p_subject -> 'declaredOccurrenceIds', field_values
  );
  if pg_catalog.jsonb_typeof(event_result) is distinct from 'array'
    or pg_catalog.jsonb_array_length(event_result)
      is distinct from pg_catalog.jsonb_array_length(p_subject -> 'declaredOccurrenceIds')
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(event_result) with ordinality as appended(value, ordinal)
      join pg_catalog.jsonb_array_elements(p_subject -> 'declaredOccurrenceIds')
        with ordinality as expected(value, ordinal) using (ordinal)
      where (appended.value ->> 'occurrenceId') is distinct from (expected.value #>> '{}')
    ) then
    raise exception using errcode = '55000', message = 'Named action declared Event append failed';
  end if;
end
$function$;
alter function vortex_record.complete_named_record_subject_internal(jsonb,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.complete_named_record_subject_internal(jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.complete_named_record_subject_internal(jsonb,jsonb,jsonb) is
  'Private named-command finalisation for one subject: the action''s Activity entry when no subject write recorded it, and its declared Events against the given (or current) subject values.';

create or replace function vortex_record.prepare_named_record_commands(
  p_command_id uuid,
  p_named jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  effective_command_id uuid;
  receipt jsonb;
  action_reference jsonb;
  action_context jsonb;
  named_subject jsonb;
  named_position integer;
  prepared jsonb;
  subjects jsonb := '[]'::jsonb;
begin
  if p_command_id is null or not vortex_platform.is_non_nil_uuid(p_command_id::text)
    or pg_catalog.jsonb_typeof(p_named) is distinct from 'object'
    or not (p_named ?& array['action', 'recordTypeId', 'subjects'])
    or p_named - array['action', 'recordTypeId', 'subjects']::text[] <> '{}'::jsonb
    or not vortex_platform.is_non_nil_uuid(p_named ->> 'recordTypeId')
    or pg_catalog.jsonb_typeof(p_named -> 'action') is distinct from 'object'
    or not ((p_named -> 'action') ?& array['ownerKind', 'ownerId', 'releaseRevision', 'actionId'])
    or (p_named -> 'action') - array['ownerKind', 'ownerId', 'releaseRevision', 'actionId']::text[] <> '{}'::jsonb
    or p_named #>> '{action,ownerKind}' not in ('application', 'module')
    or not vortex_platform.is_non_nil_uuid(p_named #>> '{action,ownerId}')
    or not vortex_platform.is_non_nil_uuid(p_named #>> '{action,actionId}')
    or not coalesce(pg_catalog.pg_input_is_valid(p_named #>> '{action,releaseRevision}', 'bigint'), false)
    or pg_catalog.jsonb_typeof(p_named -> 'subjects') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_named -> 'subjects') not between 1 and 200
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_named -> 'subjects') as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not (item.value ?& array['recordId', 'expectedConcurrencyNumber', 'inputs', 'activityId'])
        or item.value - array['recordId', 'expectedConcurrencyNumber', 'inputs', 'activityId']::text[] <> '{}'::jsonb
        or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordId')
        or not vortex_platform.is_non_nil_uuid(item.value ->> 'activityId')
        or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'expectedConcurrencyNumber', 'bigint'), false)
        or pg_catalog.jsonb_typeof(item.value -> 'inputs') is distinct from 'object'
    )
    or (select pg_catalog.count(distinct pg_catalog.lower(item.value ->> 'recordId'))
      from pg_catalog.jsonb_array_elements(p_named -> 'subjects') as item(value))
      <> pg_catalog.jsonb_array_length(p_named -> 'subjects') then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  effective_command_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  if effective_command_id is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'preview_unavailable');
  end if;
  receipt := vortex_record.claim_command_receipt_internal('record_changes', effective_command_id, true);
  if receipt ->> 'status' = 'completed' then
    return vortex_record.replay_record_changes_internal(effective_command_id, receipt -> 'result');
  elsif receipt ->> 'status' <> 'none' then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_identity_conflict',
      'correlationId', context_value -> 'correlationId');
  end if;
  action_reference := p_named -> 'action';
  action_context := vortex_record.resolve_named_action_context_internal(
    action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
    (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
    (p_named ->> 'recordTypeId')::uuid
  );
  -- Subjects are locked in record identity order; the results keep the order given.
  for named_subject, named_position in
    select item.value, (item.ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(p_named -> 'subjects') with ordinality as item(value, ordinality)
    order by (item.value ->> 'recordId')::uuid
  loop
    prepared := vortex_record.prepare_named_action_subject_internal(
      false, action_reference ->> 'ownerKind', (action_reference ->> 'ownerId')::uuid,
      (action_reference ->> 'releaseRevision')::bigint, (action_reference ->> 'actionId')::uuid,
      (p_named ->> 'recordTypeId')::uuid, (named_subject ->> 'recordId')::uuid,
      (named_subject ->> 'expectedConcurrencyNumber')::bigint, named_subject -> 'inputs', null, action_context
    );
    if prepared ->> 'outcome' = 'subject_permission_refused' then
      perform vortex_record.append_record_activity_internal((named_subject ->> 'activityId')::uuid,
        'execute_named_action', array[(named_subject ->> 'recordId')::uuid], array[]::uuid[], 'refused');
      return pg_catalog.jsonb_build_object('outcome', 'refused_recorded', 'namedIndex', named_position,
        'correlationId', context_value -> 'correlationId');
    end if;
    if prepared ->> 'outcome' is distinct from 'prepared' then
      return prepared || pg_catalog.jsonb_build_object('namedIndex', named_position,
        'correlationId', context_value -> 'correlationId');
    end if;
    subjects := subjects || pg_catalog.jsonb_build_array(prepared || pg_catalog.jsonb_build_object(
      'position', named_position, 'concurrencyNumber', named_subject -> 'expectedConcurrencyNumber'));
  end loop;
  return pg_catalog.jsonb_build_object('outcome', 'prepared', 'correlationId', context_value -> 'correlationId',
    'subjects', (select pg_catalog.jsonb_agg(item.value - 'position' order by (item.value ->> 'position')::integer)
      from pg_catalog.jsonb_array_elements(subjects) as item(value)));
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'record_unavailable');
end
$function$;
alter function vortex_record.prepare_named_record_commands(uuid,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.prepare_named_record_commands(uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.prepare_named_record_commands(uuid,jsonb) to vortex_request;
comment on function vortex_record.prepare_named_record_commands(uuid,jsonb) is
  'Protected named-command preflight for one installed action over up to 200 subjects: replays a completed command, or locks each subject at its expected revision and returns what its action flow composes from (facts, declared creates and relationship copies), writing only the refused Activity of a subject the action may not act on.';

create or replace function vortex_record.preview_named_action_internal(
  p_command_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_inputs jsonb,
  p_read_loaded jsonb,
  p_action_context jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt_claim jsonb;
  projection jsonb;
  prepared jsonb;
begin
  if p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  context_value := vortex_access.validated_human_request_context();
  if vortex_record.preview_scoped_command_id_internal(p_command_id) is null then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_changes', vortex_record.preview_scoped_command_id_internal(p_command_id), true
  );
  if receipt_claim ->> 'status' is distinct from 'none' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    -- A completed command answers with its own replay of this subject.
    select item.value into projection
    from pg_catalog.jsonb_array_elements(coalesce(vortex_record.replay_record_changes_internal(
      vortex_record.preview_scoped_command_id_internal(p_command_id), receipt_claim -> 'result'
    ) -> 'namedResults', '[]'::jsonb)) as item(value)
    where (item.value ->> 'recordId')::uuid = p_record_id;
    if projection ->> 'outcome' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    return projection;
  end if;

  prepared := vortex_record.prepare_named_action_subject_internal(
    true, p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
    p_inputs, p_read_loaded, p_action_context
  );
  if prepared ->> 'outcome' = 'subject_permission_refused' then
    return prepared || pg_catalog.jsonb_build_object('outcome', 'permission_refused');
  end if;
  return prepared;
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

alter function vortex_record.preview_named_action_internal(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.preview_named_action_internal(
  uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.preview_named_action_internal(
  uuid, text, uuid, bigint, uuid, uuid, uuid, bigint, jsonb, jsonb, jsonb
) is
  'Private named-action availability preview: a completed command answers with its own replay of the subject; otherwise the facts, permission decision and bounds of the exact installed action, writing nothing. It may reuse the read facts its fixed adapter caller loaded for the same record in this invocation when they are exactly the facts the named loader would build.';

create or replace function vortex_record.read_record_with_action_previews(
  p_record_type_id uuid,
  p_record_id uuid,
  p_actions jsonb,
  p_requested_field_ids jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  read_row record;
  action_item jsonb;
  previews jsonb := '[]'::jsonb;
begin
  if pg_catalog.jsonb_typeof(p_actions) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_actions) > 20
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_actions) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not pg_catalog.pg_input_is_valid(item.value ->> 'commandId', 'uuid')
        or not pg_catalog.pg_input_is_valid(item.value ->> 'ownerId', 'uuid')
        or not pg_catalog.pg_input_is_valid(item.value ->> 'actionId', 'uuid')
        or not pg_catalog.pg_input_is_valid(item.value ->> 'releaseRevision', 'bigint')
    ) then
    raise exception using errcode = '22023', message = 'Named action previews are invalid';
  end if;
  -- One exact read decision for the page subject: the projection and the
  -- capabilities vortex_record.read_record returns, and the
  -- read facts every bound action's preview reuses where they are exactly the
  -- facts its named loader would build. Each action is still decided against
  -- its own declaration; a subject the viewer cannot read previews nothing.
  select row_read.* into read_row
  from vortex_record.read_record_projection_internal(
    p_record_type_id, p_record_id,
    -- A preview validates the complete proposed record, including unchanged required values.
    case when pg_catalog.jsonb_array_length(p_actions) > 0 then null else p_requested_field_ids end
  ) as row_read;
  if read_row.projection ->> 'outcome' = 'allowed' then
    for action_item in
      select item.value from pg_catalog.jsonb_array_elements(p_actions) with ordinality as item(value, ordinality)
      order by item.ordinality
    loop
      previews := previews || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'actionId', action_item -> 'actionId',
        'preview', vortex_record.preview_named_action_internal(
          (action_item ->> 'commandId')::uuid, action_item ->> 'ownerKind',
          (action_item ->> 'ownerId')::uuid, (action_item ->> 'releaseRevision')::bigint,
          (action_item ->> 'actionId')::uuid, p_record_type_id, p_record_id,
          (read_row.projection ->> 'concurrencyNumber')::bigint, '{}'::jsonb,
          read_row.read_facts, null::jsonb
        )
      ));
    end loop;
  end if;
  return pg_catalog.jsonb_build_object(
    'record', read_row.projection,
    'capabilities', case when read_row.projection ->> 'outcome' = 'allowed'
      then vortex_record.read_record_capabilities_internal(
        p_record_type_id, p_record_id, read_row.read_facts, read_row.read_bounds, null::jsonb
      ) end,
    'previews', previews
  );
end
$function$;

alter function vortex_record.read_record_with_action_previews(uuid,uuid,jsonb,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_record_with_action_previews(uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role, vortex_request;
grant execute on function vortex_record.read_record_with_action_previews(uuid, uuid, jsonb, jsonb) to vortex_request;

comment on function vortex_record.read_record_with_action_previews(uuid, uuid, jsonb, jsonb) is
  'Fixed record adapter for a page subject and the named actions its placements are bound to: from one read decision under the caller''s current authority, the readable projection (record) and capabilities vortex_record.read_record returns, and, only when the record is readable, each action''s preview exactly as vortex_record.preview_named_action_internal returns it for the record''s current concurrency number and no inputs (previews, in the order given), writing nothing.';

create or replace function vortex_record.read_records_with_action_previews(
  p_record_type_id uuid,
  p_targets jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  target_ids uuid[];
  requested_id uuid;
  target_position integer;
  action_item jsonb;
  loaded jsonb;
  first_loaded_id uuid;
  first_loaded jsonb;
  page_declaration jsonb;
  page_eligibility jsonb;
  page_shared jsonb;
  page_narrowed boolean;
  candidate_ids uuid[];
  decided_ids uuid[] := array[]::uuid[];
  decided_loaded jsonb[] := array[]::jsonb[];
  decided_decisions jsonb[] := array[]::jsonb[];
  decided_bounds jsonb[] := array[]::jsonb[];
  decided_index integer;
  validated_record_types jsonb;
  row_read record;
  projection jsonb;
  read_facts jsonb;
  preview_meta jsonb;
  preview_installation_id uuid;
  previews jsonb[];
  results jsonb[] := array[]::jsonb[];
  action_contexts jsonb := '{}'::jsonb;
  context_key text;
begin
  if p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) > 200
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_targets) as target(value)
      where pg_catalog.jsonb_typeof(target.value) is distinct from 'object'
        or not coalesce(pg_catalog.pg_input_is_valid(target.value ->> 'recordId', 'uuid'), false)
        or pg_catalog.jsonb_typeof(target.value -> 'actions') is distinct from 'array'
        or pg_catalog.jsonb_array_length(target.value -> 'actions') > 20
        or exists (
          select 1 from pg_catalog.jsonb_array_elements(target.value -> 'actions') as item(value)
          where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
            or item.value ->> 'ownerKind' is null
            or item.value ->> 'ownerKind' not in ('application', 'module')
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'commandId', 'uuid'), false)
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'ownerId', 'uuid'), false)
            or not coalesce(pg_catalog.pg_input_is_valid(item.value ->> 'actionId', 'uuid'), false)
            or not coalesce(case when pg_catalog.pg_input_is_valid(item.value ->> 'releaseRevision', 'bigint')
              then (item.value ->> 'releaseRevision')::bigint between 1 and 9007199254740991 end, false)
        )
    ) then
    raise exception using errcode = '22023', message = 'Named action previews are invalid';
  end if;
  select coalesce(pg_catalog.array_agg((target.value ->> 'recordId')::uuid order by target.ordinality),
    array[]::uuid[])
  into target_ids
  from pg_catalog.jsonb_array_elements(p_targets) with ordinality as target(value, ordinality);

  -- The page read pass the list read uses: the first readable record
  -- is decided exactly and supplies the installation-wide facts; the other
  -- records are decided together from them. A record the pass does not decide
  -- (missing, inaccessible or relationship-routed) keeps the exact
  -- single-record path with the same refusal. The eligibility is local to this
  -- invocation and narrows work only when each record's projection confirms
  -- the same declaration and a live deadline.
  if p_record_type_id <> '00000000-0000-0000-0000-000000000000'::uuid then
    foreach requested_id in array target_ids loop
      if requested_id = '00000000-0000-0000-0000-000000000000'::uuid then
        continue;
      end if;
      loaded := (vortex_record.load_record_access_facts_internal(
        'read', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'recordTypeId', p_record_type_id,
          'recordId', requested_id
        ))
      ) -> 0);
      if loaded ->> 'outcome' = 'loaded'
        and pg_catalog.jsonb_typeof(loaded -> 'declaration') = 'object' then
        page_declaration := loaded -> 'declaration';
        if loaded ? 'previewInstallationId' then
          preview_installation_id := (loaded ->> 'previewInstallationId')::uuid;
          preview_meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'read');
          page_shared := pg_catalog.jsonb_build_object('previewBounds',
            vortex_record.preview_record_field_bounds_internal(
              p_record_type_id, (preview_meta ->> 'storageContractId')::uuid,
              preview_meta -> 'recordType'));
        else
          page_eligibility := vortex_access.evaluate_organization_record_permission_eligibility_internal(
            page_declaration, vortex_access.validated_human_request_context(),
            pg_catalog.clock_timestamp()
          );
        end if;
        first_loaded_id := requested_id;
        first_loaded := loaded;
        exit;
      end if;
    end loop;
  end if;
  if first_loaded is not null then
    select pg_catalog.array_agg(distinct candidate.id)
    into candidate_ids
    from pg_catalog.unnest(target_ids) as candidate(id)
    where candidate.id <> first_loaded_id
      and candidate.id <> '00000000-0000-0000-0000-000000000000'::uuid;
  end if;
  if candidate_ids is not null then
    select coalesce(page_shared, '{}'::jsonb)
      || pg_catalog.jsonb_build_object('envelope', page.envelope) || page.read_time,
      page.narrowed
    into page_shared, page_narrowed
    from vortex_record.read_record_page_envelope_internal(p_record_type_id, first_loaded) as page;
    -- At most 199 candidates (200 targets, the first decided exactly).
    select coalesce(pg_catalog.array_agg(decided.record_id), array[]::uuid[]),
      coalesce(pg_catalog.array_agg(decided.loaded), array[]::jsonb[]),
      coalesce(pg_catalog.array_agg(decided.decision), array[]::jsonb[]),
      coalesce(pg_catalog.array_agg(decided.bounds), array[]::jsonb[])
    into decided_ids, decided_loaded, decided_decisions, decided_bounds
    from vortex_record.read_record_page_decisions_internal(
      p_record_type_id, first_loaded, page_declaration, page_eligibility,
      candidate_ids, page_shared -> 'envelope', page_narrowed
    ) as decided;
  end if;

  for target_position in 1 .. pg_catalog.cardinality(target_ids) loop
    requested_id := target_ids[target_position];
    decided_index := case when requested_id is distinct from first_loaded_id
      then pg_catalog.array_position(decided_ids, requested_id) end;
    select row_projection.* into row_read
    from vortex_record.read_record_projection_with_validated_types_internal(
      p_record_type_id, requested_id, page_declaration, page_eligibility,
      validated_record_types, null::jsonb,
      coalesce(decided_loaded[decided_index],
        case when requested_id = first_loaded_id then first_loaded end),
      decided_decisions[decided_index], decided_bounds[decided_index], page_shared
    ) as row_projection;
    if requested_id = first_loaded_id then
      first_loaded := null;
    end if;
    projection := row_read.projection;
    -- Only the exact evaluator validates record types for reuse.
    if validated_record_types is null and decided_index is null then
      validated_record_types := coalesce(
        row_read.read_facts -> 'validatedRecordTypes',
        case when projection ->> 'outcome' = 'allowed'
          then row_read.read_facts #> '{facts,recordTypes}' end
      );
    end if;
    previews := array[]::jsonb[];
    if projection ->> 'outcome' = 'allowed' then
      -- A decided record carries its compact scope; its complete read facts are
      -- the page envelope with that scope. Each bound action is still decided
      -- against its own declaration, never by the record's read decision.
      read_facts := case when decided_index is not null
        then vortex_record.read_record_page_row_facts_internal(page_shared -> 'envelope', row_read.read_facts)
        else row_read.read_facts end;
      for action_item in
        select item.value
        from pg_catalog.jsonb_array_elements(p_targets -> (target_position - 1) -> 'actions')
          with ordinality as item(value, ordinality)
        order by item.ordinality
      loop
        -- An action's context depends only on the action and the record type, not on the
        -- record: it is resolved once per page. A resolution that fails is not cached as a
        -- context: each record's preview then decides it (and its replay) itself.
        context_key := pg_catalog.lower(action_item ->> 'ownerKind') || ':'
          || pg_catalog.lower(action_item ->> 'ownerId') || ':'
          || ((action_item ->> 'releaseRevision')::bigint)::text || ':'
          || pg_catalog.lower(action_item ->> 'actionId');
        if not action_contexts ? context_key then
          begin
            action_contexts := action_contexts || pg_catalog.jsonb_build_object(context_key,
              vortex_record.resolve_named_action_context_internal(
                action_item ->> 'ownerKind', (action_item ->> 'ownerId')::uuid,
                (action_item ->> 'releaseRevision')::bigint, (action_item ->> 'actionId')::uuid,
                p_record_type_id));
          exception
            when no_data_found or too_many_rows or insufficient_privilege
              or object_not_in_prerequisite_state or check_violation then
              action_contexts := action_contexts || pg_catalog.jsonb_build_object(context_key, false);
          end;
        end if;
        previews := pg_catalog.array_append(previews, pg_catalog.jsonb_build_object(
          'actionId', action_item -> 'actionId',
          -- An unresolvable context passes null, so the preview resolves it itself after its
          -- command-receipt replay check and refuses exactly as the single preview does.
          'preview', vortex_record.preview_named_action_internal(
            (action_item ->> 'commandId')::uuid, action_item ->> 'ownerKind',
            (action_item ->> 'ownerId')::uuid, (action_item ->> 'releaseRevision')::bigint,
            (action_item ->> 'actionId')::uuid, p_record_type_id, requested_id,
            (projection ->> 'concurrencyNumber')::bigint, '{}'::jsonb,
            read_facts,
            nullif(action_contexts -> context_key, 'false'::jsonb)
          )
        ));
      end loop;
    end if;
    results := pg_catalog.array_append(results, pg_catalog.jsonb_build_object(
      'recordId', requested_id,
      'record', case when projection ->> 'outcome' = 'allowed'
        then pg_catalog.jsonb_build_object('outcome', 'allowed', 'recordId', projection -> 'recordId',
          'concurrencyNumber', projection -> 'concurrencyNumber')
        else projection end,
      'previews', pg_catalog.to_jsonb(previews)
    ));
  end loop;
  -- PL/pgSQL materializes the result before returning it. Revalidate after all
  -- reads so invocation-local preview facts cannot extend a builder's expiring
  -- role/group authority and disclose any part of the result.
  if preview_installation_id is not null
    and vortex_record.read_current_preview_installation_internal() ->> 'previewInstallationId'
      is distinct from preview_installation_id::text then
    raise exception using errcode = '42501', message = 'Preview authority is unavailable';
  end if;
  return pg_catalog.to_jsonb(results);
end
$function$;

alter function vortex_record.read_records_with_action_previews(uuid,jsonb) owner to vortex_record_adapter;

revoke all on function vortex_record.read_records_with_action_previews(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_request;
grant execute on function vortex_record.read_records_with_action_previews(uuid, jsonb) to vortex_request;

comment on function vortex_record.read_records_with_action_previews(uuid, jsonb) is
  'Fixed record adapter for a grid page of records and the named actions bound to each: reads every target through the page read pass the list read uses (the first readable record decided exactly, the others together, any record the pass does not decide by the exact single-record path), and, only for a readable record, returns each action''s preview exactly as vortex_record.preview_named_action_internal returns it for the record''s current concurrency number and no inputs (previews, in the order given), under the caller''s current authority and writing nothing; a readable record is reported by its recordId and concurrencyNumber, an unreadable one as refused.';

create or replace function vortex_record.validate_named_action_reference_inputs_internal(
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_inputs jsonb
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  action_context jsonb;
  input_definition jsonb;
  input_candidate jsonb;
  catalogue jsonb;
  reference_record_type_id uuid;
  reference_record_id uuid;
  resolved_target_count integer;
begin
  if pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object' then
    return false;
  end if;
  context_value := vortex_access.validated_human_request_context();
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  for input_definition in
    select item.value
    from pg_catalog.jsonb_array_elements(action_context -> 'action' -> 'inputs') item(value)
    where item.value ->> 'type' in (
      'organization_account_reference', 'record_reference'
    )
  loop
    if not p_inputs ? (input_definition ->> 'key') then
      continue;
    end if;
    input_candidate := p_inputs -> (input_definition ->> 'key');
    if input_definition ->> 'type' = 'organization_account_reference' then
      if pg_catalog.jsonb_typeof(input_candidate) is distinct from 'string'
        or not pg_catalog.pg_input_is_valid(input_candidate #>> '{}', 'uuid')
        or not vortex_identity.is_active_organization_account_reference_internal(
          (context_value ->> 'tenantId')::uuid,
          (context_value ->> 'organizationId')::uuid,
          (input_candidate #>> '{}')::uuid
        ) then
        return false;
      end if;
      continue;
    end if;

    reference_record_type_id := null;
    reference_record_id := null;
    if pg_catalog.jsonb_typeof(input_candidate) = 'object'
      and input_candidate ?& array['recordTypeId', 'recordId']
      and input_candidate - array['recordTypeId', 'recordId'] = '{}'::jsonb
      and pg_catalog.pg_input_is_valid(input_candidate ->> 'recordTypeId', 'uuid')
      and pg_catalog.pg_input_is_valid(input_candidate ->> 'recordId', 'uuid') then
      reference_record_type_id := (input_candidate ->> 'recordTypeId')::uuid;
      reference_record_id := (input_candidate ->> 'recordId')::uuid;
    elsif pg_catalog.jsonb_typeof(input_candidate) = 'string'
      and pg_catalog.pg_input_is_valid(input_candidate #>> '{}', 'uuid') then
      select pg_catalog.count(*),
        (pg_catalog.array_agg(
          (target.value ->> 'recordTypeId')::uuid
          order by (target.value ->> 'recordTypeId')::uuid
        ))[1]
      into resolved_target_count, reference_record_type_id
      from pg_catalog.jsonb_array_elements(input_definition -> 'recordTypes') target(value)
      where target.value ->> 'state' = 'resolved';
      if resolved_target_count = 1 then
        reference_record_id := (input_candidate #>> '{}')::uuid;
      end if;
    end if;
    if reference_record_type_id is null or reference_record_id is null
      or not exists (
        select 1
        from pg_catalog.jsonb_array_elements(input_definition -> 'recordTypes') target(value)
        where target.value ->> 'state' = 'resolved'
          and (target.value ->> 'recordTypeId')::uuid = reference_record_type_id
      ) then
      return false;
    end if;
    catalogue := coalesce(catalogue,
      vortex_record.relationship_total_catalogue_internal());
    if vortex_record.relationship_total_record_snapshot_internal(
      catalogue, reference_record_type_id, reference_record_id, false
    ) is null then
      return false;
    end if;
  end loop;
  return true;
exception
  when no_data_found or too_many_rows or invalid_text_representation
    or insufficient_privilege or object_not_in_prerequisite_state
    or check_violation then
    return false;
end
$function$;
alter function vortex_record.validate_named_action_reference_inputs_internal(text,uuid,bigint,uuid,uuid,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.validate_named_action_reference_inputs_internal(text,uuid,bigint,uuid,uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.validate_named_action_reference_inputs_internal(text,uuid,bigint,uuid,uuid,jsonb) is
  'Private: whether every record reference input of the exact installed action names a record the action may use under current authority.';

create or replace function vortex_record.retain_record_change_preparation_internal(
  p_command_id uuid,
  p_subjects jsonb,
  p_named jsonb,
  p_preparation jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  retained jsonb;
begin
  -- The preparation lives only for this transaction, in a session table only the record adapter
  -- owns; a table of the same name created by any other role is refused.
  create temporary table if not exists record_change_preparations (
    command_id uuid primary key,
    intents jsonb not null,
    named jsonb,
    preparation jsonb not null
  ) on commit delete rows;
  if (select relation.relowner from pg_catalog.pg_class as relation
      where relation.oid = 'pg_temp.record_change_preparations'::pg_catalog.regclass)
    is distinct from 'vortex_record_adapter'::pg_catalog.regrole then
    raise exception using errcode = '42501', message = 'Record change preparation store is unavailable';
  end if;
  if p_preparation is null then
    -- Taking the preparation for the writer: the same command, intents (without the final values
    -- the caller calculated) and named scope, prepared earlier in this transaction.
    delete from pg_temp.record_change_preparations as stored
    where stored.command_id = p_command_id
      and stored.intents = (select coalesce(pg_catalog.jsonb_agg(item.value - 'finalValues' order by item.ordinality), '[]'::jsonb)
        from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality))
      and stored.named is not distinct from p_named
    returning stored.preparation into retained;
    return retained;
  end if;
  insert into pg_temp.record_change_preparations (command_id, intents, named, preparation)
  values (p_command_id,
    (select coalesce(pg_catalog.jsonb_agg(item.value - 'finalValues' order by item.ordinality), '[]'::jsonb)
      from pg_catalog.jsonb_array_elements(p_subjects) with ordinality as item(value, ordinality)),
    p_named, p_preparation)
  on conflict (command_id) do update
    set intents = excluded.intents, named = excluded.named, preparation = excluded.preparation;
  return p_preparation;
end
$function$;
alter function vortex_record.retain_record_change_preparation_internal(uuid,jsonb,jsonb,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.retain_record_change_preparation_internal(uuid,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.retain_record_change_preparation_internal(uuid,jsonb,jsonb,jsonb) is
  'Private: keeps a record command''s locked calculation preparation for the rest of its transaction (with a preparation), or takes it for the writer (without one), so the writer re-checks only revisions instead of preparing again.';

create or replace function vortex_record.read_record_change_revisions(p_targets jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  record_type_id uuid;
  meta jsonb;
  found_rows jsonb;
  revisions jsonb := '[]'::jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(p_targets) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_targets) > 200
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(p_targets) as item(value)
      where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
        or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordTypeId')
        or not vortex_platform.is_non_nil_uuid(item.value ->> 'recordId')
    ) then
    raise exception using errcode = '22023', message = 'Record change targets are invalid';
  end if;
  -- One locking read per record type of the installed application: revisions only. The record
  -- writer decides every target's authority; no value or capability leaves here.
  for record_type_id in
    select distinct (item.value ->> 'recordTypeId')::uuid
    from pg_catalog.jsonb_array_elements(p_targets) as item(value)
    order by 1
  loop
    meta := vortex_record.resolve_record_action_context_internal(record_type_id, 'read');
    if meta -> 'recordType' ? 'systemProjection' then
      continue;
    end if;
    execute pg_catalog.format(
      'select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          ''recordTypeId'', $4, ''recordId'', stored.record_id, ''revision'', stored.concurrency_number)
          order by stored.record_id), ''[]''::jsonb)
       from (select record_id, concurrency_number from record_data.%I
         where organisation_id = $1 and %s and lifecycle_state = ''active''
           and record_id = any ($2) order by record_id for update) as stored',
      meta ->> 'table',
      case when meta ->> 'storageScope' = 'application_contained'
        then 'application_root_id = $3' else 'application_root_id is null' end
    )
    into found_rows
    using (context_value ->> 'organizationId')::uuid,
      (select pg_catalog.array_agg((item.value ->> 'recordId')::uuid)
        from pg_catalog.jsonb_array_elements(p_targets) as item(value)
        where (item.value ->> 'recordTypeId')::uuid = record_type_id),
      (context_value ->> 'applicationRootId')::uuid, record_type_id;
    revisions := revisions || found_rows;
  end loop;
  return revisions;
end
$function$;
alter function vortex_record.read_record_change_revisions(jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.read_record_change_revisions(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.read_record_change_revisions(jsonb) to vortex_request;
comment on function vortex_record.read_record_change_revisions(jsonb) is
  'Locks and returns the current revisions of up to 200 active records of the installed application for one set-based change, one read per record type; the record writer still decides each target''s authority, and no value or capability is returned.';

-- The in-page agent is the one agent channel: webmcp.
create or replace function vortex_record.decide_record_access_internal(
  p_memo jsonb,
  p_declaration jsonb,
  p_record_id uuid,
  p_facts jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  input_value jsonb := pg_catalog.jsonb_build_object(
    'declaration', p_declaration, 'recordId', p_record_id, 'facts', p_facts
  );
  remembered jsonb;
begin
  -- A decision the whole set already made for this exact input is reused; any other input is
  -- decided now, so a memo never answers for a different declaration, record or facts.
  if p_memo is not null then
    select entry.value -> 'decision' into remembered
    from pg_catalog.jsonb_array_elements(p_memo) as entry(value)
    where entry.value -> 'input' = input_value
    limit 1;
    if remembered is not null then return remembered; end if;
  end if;
  return (vortex_access.evaluate_organization_record_access_internal(
    pg_catalog.jsonb_build_array(input_value)
  ) -> 0);
end
$function$;
alter function vortex_record.decide_record_access_internal(jsonb,jsonb,uuid,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.decide_record_access_internal(jsonb,jsonb,uuid,jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.decide_record_access_internal(jsonb,jsonb,uuid,jsonb) is
  'Private record access decision for one input that reuses the decision a set preparation already made for the identical declaration, record and facts, and otherwise evaluates it.';

set role vortex_owner;

create or replace function vortex_platform.validated(candidate jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  caller_kind text;
  authentication_strength text;
  issued_at timestamptz;
  expires_at timestamptz;
  access_token_issued_at timestamptz;
  primary_authenticated_at timestamptz;
  multi_factor_authenticated_at timestamptz;
  allowed_keys text[];
  nested jsonb;
begin
  if candidate is null or pg_catalog.jsonb_typeof(candidate) <> 'object' then
    raise exception using errcode = '22023', message = 'Vortex request context must be an object';
  end if;

  if not candidate ?& array[
    'callerKind', 'tenantId', 'organizationId', 'sessionId', 'issuedAt',
    'expiresAt', 'accessVersion', 'correlationId', 'authenticationStrength'
  ] then
    raise exception using errcode = '22023', message = 'Vortex request context is incomplete';
  end if;

  caller_kind := candidate ->> 'callerKind';
  authentication_strength := candidate ->> 'authenticationStrength';

  case caller_kind
    when 'human' then
      allowed_keys := array[
        'callerKind', 'identityAuthorityId', 'tenantId', 'organizationId',
        'applicationRootId', 'sessionId', 'issuedAt', 'expiresAt',
        'accessVersion', 'correlationId', 'identityId', 'organizationAccountId',
        'authenticationStrength', 'accessTokenIssuedAt', 'primaryAuthenticatedAt',
        'multiFactorAuthenticatedAt', 'delegatedContext', 'supportContext',
        'channel'
      ];
      if not candidate ? 'identityAuthorityId'
        or not vortex_platform.is_non_nil_uuid(candidate ->> 'identityAuthorityId') then
        raise exception using errcode = '22023', message = 'Authenticated request context requires an Identity Authority';
      end if;
      if not candidate ?& array['identityId', 'organizationAccountId']
        or authentication_strength is null
        or authentication_strength not in ('single_factor', 'multi_factor', 'recent_multi_factor') then
        raise exception using errcode = '22023', message = 'Vortex human context has an invalid actor';
      end if;
    when 'federated' then
      allowed_keys := array[
        'callerKind', 'identityAuthorityId', 'tenantId', 'organizationId',
        'applicationRootId', 'sessionId', 'issuedAt', 'expiresAt',
        'accessVersion', 'correlationId', 'identityId', 'organizationAccountId',
        'authenticationStrength', 'channel'
      ];
      if not candidate ? 'identityAuthorityId'
        or not vortex_platform.is_non_nil_uuid(candidate ->> 'identityAuthorityId') then
        raise exception using errcode = '22023', message = 'Authenticated request context requires an Identity Authority';
      end if;
      if not candidate ?& array['identityId', 'organizationAccountId']
        or authentication_strength is null
        or authentication_strength not in ('single_factor', 'multi_factor', 'recent_multi_factor') then
        raise exception using errcode = '22023', message = 'Vortex federated context has an invalid actor';
      end if;
    when 'system' then
      allowed_keys := array[
        'callerKind', 'tenantId', 'organizationId', 'applicationRootId',
        'sessionId', 'issuedAt', 'expiresAt', 'accessVersion', 'correlationId',
        'systemActorId', 'authenticationStrength', 'supportContext', 'channel'
      ];
      if not candidate ? 'systemActorId' or authentication_strength is distinct from 'service' then
        raise exception using errcode = '22023', message = 'Vortex system context has an invalid actor';
      end if;
    when 'public' then
      allowed_keys := array[
        'callerKind', 'tenantId', 'organizationId', 'applicationRootId',
        'sessionId', 'issuedAt', 'expiresAt', 'accessVersion', 'correlationId',
        'authenticationStrength', 'channel'
      ];
      if authentication_strength is distinct from 'anonymous' then
        raise exception using errcode = '22023', message = 'Vortex public context has an invalid actor';
      end if;
    else
      raise exception using errcode = '22023', message = 'Vortex request context has an unsupported caller kind';
  end case;

  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(candidate) as supplied(key)
    where not supplied.key = any (allowed_keys)
  ) then
    raise exception using errcode = '22023', message = 'Vortex request context has an unknown field';
  end if;

  if candidate ? 'channel'
    and (
      pg_catalog.jsonb_typeof(candidate -> 'channel') <> 'string'
      or (candidate ->> 'channel') <> all (array[
        'web', 'webmcp', 'programmatic_interface', 'connection', 'federation',
        'system'
      ])
    ) then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid channel';
  end if;

  if not vortex_platform.is_non_nil_uuid(candidate ->> 'tenantId')
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'organizationId')
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'sessionId')
    or not vortex_platform.is_non_nil_uuid(candidate ->> 'correlationId')
    or (candidate ? 'applicationRootId' and not vortex_platform.is_non_nil_uuid(candidate ->> 'applicationRootId'))
    or (candidate ? 'identityId' and not vortex_platform.is_non_nil_uuid(candidate ->> 'identityId'))
    or (candidate ? 'organizationAccountId' and not vortex_platform.is_non_nil_uuid(candidate ->> 'organizationAccountId'))
    or (candidate ? 'systemActorId' and not vortex_platform.is_non_nil_uuid(candidate ->> 'systemActorId')) then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid identifier';
  end if;

  if pg_catalog.jsonb_typeof(candidate -> 'accessVersion') <> 'number'
    or (candidate ->> 'accessVersion') !~ '^[1-9][0-9]*$'
    or (candidate ->> 'accessVersion')::numeric > 9007199254740991 then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid access version';
  end if;

  if pg_catalog.jsonb_typeof(candidate -> 'issuedAt') <> 'string'
    or pg_catalog.jsonb_typeof(candidate -> 'expiresAt') <> 'string'
    or (candidate ->> 'issuedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
    or (candidate ->> 'expiresAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid time';
  end if;

  begin
    issued_at := (candidate ->> 'issuedAt')::timestamptz;
    expires_at := (candidate ->> 'expiresAt')::timestamptz;
  exception when others then
    raise exception using errcode = '22023', message = 'Vortex request context has an invalid time';
  end;

  if not pg_catalog.isfinite(issued_at)
    or not pg_catalog.isfinite(expires_at)
    or expires_at <= issued_at
    or expires_at <= pg_catalog.statement_timestamp() then
    raise exception using errcode = '22023', message = 'Vortex request context is expired or inconsistent';
  end if;

  if caller_kind = 'human' then
    if (candidate ? 'accessTokenIssuedAt')
      <> (candidate ? 'primaryAuthenticatedAt' or candidate ? 'multiFactorAuthenticatedAt') then
      raise exception using errcode = '22023', message = 'Vortex human authentication evidence is incomplete';
    end if;

    if candidate ? 'accessTokenIssuedAt' then
      if pg_catalog.jsonb_typeof(candidate -> 'accessTokenIssuedAt') <> 'string'
        or (candidate ->> 'accessTokenIssuedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end if;
      begin
        access_token_issued_at := (candidate ->> 'accessTokenIssuedAt')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end;
      if not pg_catalog.isfinite(access_token_issued_at)
        or access_token_issued_at >= expires_at
        or access_token_issued_at > issued_at + interval '60 seconds' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence is inconsistent';
      end if;
    end if;

    if candidate ? 'primaryAuthenticatedAt' then
      if pg_catalog.jsonb_typeof(candidate -> 'primaryAuthenticatedAt') <> 'string'
        or (candidate ->> 'primaryAuthenticatedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end if;
      begin
        primary_authenticated_at := (candidate ->> 'primaryAuthenticatedAt')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end;
      if not pg_catalog.isfinite(primary_authenticated_at)
        or primary_authenticated_at > access_token_issued_at
        or primary_authenticated_at > pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence is inconsistent';
      end if;
    end if;

    if candidate ? 'multiFactorAuthenticatedAt' then
      if authentication_strength not in ('multi_factor', 'recent_multi_factor') then
        raise exception using errcode = '22023', message = 'Vortex human multi-factor evidence conflicts with authentication strength';
      end if;
      if pg_catalog.jsonb_typeof(candidate -> 'multiFactorAuthenticatedAt') <> 'string'
        or (candidate ->> 'multiFactorAuthenticatedAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end if;
      begin
        multi_factor_authenticated_at := (candidate ->> 'multiFactorAuthenticatedAt')::timestamptz;
      exception when others then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence has an invalid time';
      end;
      if not pg_catalog.isfinite(multi_factor_authenticated_at)
        or multi_factor_authenticated_at > access_token_issued_at
        or multi_factor_authenticated_at > pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex human authentication evidence is inconsistent';
      end if;
    end if;
  end if;

  if candidate ? 'delegatedContext' then
    nested := candidate -> 'delegatedContext';
    if pg_catalog.jsonb_typeof(nested) <> 'object'
      or not nested ?& array['delegatedByOrganizationAccountId', 'reason', 'expiresAt']
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(nested) as supplied(key)
        where supplied.key <> all (array['delegatedByOrganizationAccountId', 'reason', 'expiresAt'])
      )
      or not vortex_platform.is_non_nil_uuid(nested ->> 'delegatedByOrganizationAccountId')
      or pg_catalog.jsonb_typeof(nested -> 'reason') <> 'string'
      or pg_catalog.length(nested ->> 'reason') not between 1 and 500 then
      raise exception using errcode = '22023', message = 'Vortex delegated context is invalid';
    end if;
    if pg_catalog.jsonb_typeof(nested -> 'expiresAt') <> 'string'
      or (nested ->> 'expiresAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
      raise exception using errcode = '22023', message = 'Vortex delegated context has an invalid time';
    end if;
    begin
      if not pg_catalog.isfinite((nested ->> 'expiresAt')::timestamptz)
        or (nested ->> 'expiresAt')::timestamptz > expires_at
        or (nested ->> 'expiresAt')::timestamptz <= pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex delegated context is expired or inconsistent';
      end if;
    exception when invalid_datetime_format then
      raise exception using errcode = '22023', message = 'Vortex delegated context has an invalid time';
    end;
  end if;

  if candidate ? 'supportContext' then
    nested := candidate -> 'supportContext';
    if pg_catalog.jsonb_typeof(nested) <> 'object'
      or not nested ?& array['supportActorId', 'approvedByOrganizationAccountId', 'reason', 'expiresAt']
      or exists (
        select 1 from pg_catalog.jsonb_object_keys(nested) as supplied(key)
        where supplied.key <> all (array['supportActorId', 'approvedByOrganizationAccountId', 'reason', 'expiresAt'])
      )
      or not vortex_platform.is_non_nil_uuid(nested ->> 'supportActorId')
      or not vortex_platform.is_non_nil_uuid(nested ->> 'approvedByOrganizationAccountId')
      or pg_catalog.jsonb_typeof(nested -> 'reason') <> 'string'
      or pg_catalog.length(nested ->> 'reason') not between 1 and 500 then
      raise exception using errcode = '22023', message = 'Vortex support context is invalid';
    end if;
    if pg_catalog.jsonb_typeof(nested -> 'expiresAt') <> 'string'
      or (nested ->> 'expiresAt') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]+)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then
      raise exception using errcode = '22023', message = 'Vortex support context has an invalid time';
    end if;
    begin
      if not pg_catalog.isfinite((nested ->> 'expiresAt')::timestamptz)
        or (nested ->> 'expiresAt')::timestamptz > expires_at
        or (nested ->> 'expiresAt')::timestamptz <= pg_catalog.statement_timestamp() then
        raise exception using errcode = '22023', message = 'Vortex support context is expired or inconsistent';
      end if;
    exception when invalid_datetime_format then
      raise exception using errcode = '22023', message = 'Vortex support context has an invalid time';
    end;
  end if;

  return candidate;
end
$function$;

revoke execute on function vortex_platform.validated(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function vortex_platform.validated(jsonb)
  to vortex_runtime, vortex_request;

comment on function vortex_platform.validated(jsonb) is
  'Validates one trusted request context, including its optional trusted channel, or fails closed.';

alter function vortex_platform.validated(candidate jsonb) owner to vortex_owner;

grant execute on function vortex_platform.validated(candidate jsonb) to postgres;

create or replace function vortex_access.admit_flow_segment_rate(
  p_kind text
)
returns table (admitted boolean, retry_after_seconds integer)
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  context_value jsonb := vortex_access.validated_human_request_context();
  v_tenant_id uuid := (context_value ->> 'tenantId')::uuid;
  v_organization_id uuid := (context_value ->> 'organizationId')::uuid;
  v_account_id uuid := (context_value ->> 'organizationAccountId')::uuid;
  v_correlation_id uuid := (context_value ->> 'correlationId')::uuid;
  v_evaluated_at timestamptz;
  v_window_start timestamptz;
  v_kind text := case when vortex_platform.channel() = 'webmcp' then 'mcp' else p_kind end;
  v_account_limit integer;
  v_organization_limit integer;
  v_account_count integer;
  v_organization_count integer;
  v_refusal_id uuid;
begin
  if p_kind is null or p_kind not in ('change', 'read') then
    raise exception using errcode = '22023', message = 'Flow segment rate command is invalid';
  end if;
  select defaults.account_limit, defaults.organization_limit
    into strict v_account_limit, v_organization_limit
  from vortex_access.flow_segment_rate_defaults as defaults
  where defaults.kind = v_kind;

  -- Lock in the same order for all callers: organisation bucket, then account bucket.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.concat_ws(E'\x1f', v_organization_id::text, v_kind), 817
  ));
  v_evaluated_at := pg_catalog.clock_timestamp();
  v_window_start := pg_catalog.date_trunc('minute', v_evaluated_at);
  delete from vortex_access.flow_segment_rate_buckets as bucket
  where bucket.organization_id = v_organization_id
    and bucket.kind = v_kind
    and bucket.window_start < v_window_start - interval '2 minutes';
  insert into vortex_access.flow_segment_rate_buckets
    (organization_id, organization_account_id, kind, window_start, used)
  values (v_organization_id, null, v_kind, v_window_start, 0),
    (v_organization_id, v_account_id, v_kind, v_window_start, 0)
  on conflict (organization_id, organization_account_id, kind, window_start) do nothing;

  select bucket.used into strict v_organization_count
  from vortex_access.flow_segment_rate_buckets as bucket
  where bucket.organization_id = v_organization_id and bucket.organization_account_id is null
    and bucket.kind = v_kind and bucket.window_start = v_window_start;
  select bucket.used into strict v_account_count
  from vortex_access.flow_segment_rate_buckets as bucket
  where bucket.organization_id = v_organization_id and bucket.organization_account_id = v_account_id
    and bucket.kind = v_kind and bucket.window_start = v_window_start;
  if v_organization_count >= v_organization_limit or v_account_count >= v_account_limit then
    v_refusal_id := pg_catalog.gen_random_uuid();
    perform vortex_access.record_metering_event(
      v_tenant_id, v_organization_id, 'local', v_refusal_id, 'flow.rate_limit_refused',
      1, 'segment', 'web', pg_catalog.jsonb_build_object('kind', v_kind, 'channel', vortex_platform.channel()), v_evaluated_at,
      null, v_refusal_id, v_correlation_id, null, null
    );
    return query select false,
      greatest(1, pg_catalog.ceil(extract(epoch from
        (v_window_start + interval '1 minute' - v_evaluated_at)))::integer);
    return;
  end if;
  update vortex_access.flow_segment_rate_buckets as bucket
  set used = bucket.used + 1
  where bucket.organization_id = v_organization_id and bucket.kind = v_kind
    and bucket.window_start = v_window_start
    and (bucket.organization_account_id is null or bucket.organization_account_id = v_account_id);
  return query select true, 0;
end
$function$;

comment on function vortex_access.admit_flow_segment_rate(text) is
  'Checks and increments current account and organisation flow-segment minute buckets atomically.';
revoke execute on function vortex_access.admit_flow_segment_rate(text)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_access.admit_flow_segment_rate(text) to vortex_request;
alter function vortex_access.admit_flow_segment_rate(text) owner to vortex_owner;
grant execute on function vortex_access.admit_flow_segment_rate(text) to postgres;

reset role;
