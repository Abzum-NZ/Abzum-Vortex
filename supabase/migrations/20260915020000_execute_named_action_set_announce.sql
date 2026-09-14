-- #50 slice 1: one fixed human named-action operation for set_field and
-- announce_event. It composes the existing Access, Record, Activity, Event,
-- queue and parent-total owners in one caller transaction.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
grant create on schema vortex_record to postgres;
reset role;
set local role vortex_record_adapter;

create table vortex_record.named_action_command_receipts (
  organization_id uuid not null,
  application_root_id uuid not null,
  actor_organization_account_id uuid not null,
  command_id uuid not null,
  command_fingerprint text not null,
  action_owner_kind text not null,
  action_owner_id uuid not null,
  action_release_revision bigint not null,
  action_id uuid not null,
  record_type_id uuid not null,
  record_id uuid not null,
  concurrency_number bigint,
  state text not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  completed_at timestamptz,
  constraint named_action_command_receipts_pk primary key (
    organization_id, application_root_id, actor_organization_account_id, command_id
  ),
  constraint named_action_command_receipts_fingerprint_valid check (
    command_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint named_action_command_receipts_owner_valid check (
    action_owner_kind in ('application', 'module')
    and action_release_revision between 1 and 9007199254740991
  ),
  constraint named_action_command_receipts_state_valid check (
    state in ('pending', 'completed')
  ),
  constraint named_action_command_receipts_result_complete check (
    (state = 'pending' and concurrency_number is null and completed_at is null)
    or (state = 'completed'
      and concurrency_number between 1 and 9007199254740991
      and completed_at is not null)
  )
);
alter table vortex_record.named_action_command_receipts enable row level security;
alter table vortex_record.named_action_command_receipts force row level security;
create policy named_action_command_receipts_adapter
  on vortex_record.named_action_command_receipts to vortex_record_adapter
  using (true) with check (true);
alter table vortex_record.named_action_command_receipts owner to vortex_record_adapter;
revoke all on table vortex_record.named_action_command_receipts
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;

create function vortex_record.named_action_command_fingerprint_internal(
  p_command_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_inputs jsonb
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'contractVersion', '2.0.0', 'commandId', p_command_id,
      'action', pg_catalog.jsonb_build_object(
        'ownerKind', p_action_owner_kind, 'ownerId', p_action_owner_id,
        'releaseRevision', p_action_release_revision, 'actionId', p_action_id
      ),
      'recordTypeId', p_record_type_id, 'recordId', p_record_id,
      'expectedConcurrencyNumber', p_expected_concurrency_number,
      'inputs', p_inputs
    )::text, 'UTF8')), 'hex')
$function$;

reset role;
revoke all on function vortex_activity.append_organization_activity_entry(
  uuid, uuid, timestamptz, text, uuid, text, uuid[], uuid[], text, uuid, text
) from vortex_record_adapter;

create function vortex_record.append_named_action_activity_internal(
  p_activity_id uuid,
  p_subject_id uuid,
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
    or p_subject_id is null
    or p_subject_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_field_ids is null
    or pg_catalog.array_position(p_changed_field_ids, null::uuid) is not null
    or p_changed_field_ids is distinct from (
      select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[])
      from (select distinct value
        from pg_catalog.unnest(p_changed_field_ids) as item(value)) canonical
    )
    or p_outcome not in ('completed', 'refused') then
    raise exception using errcode = '22023', message = 'Named action Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid, p_activity_id,
    occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    'execute_named_action', array[p_subject_id]::uuid[], p_changed_field_ids,
    'web', (context_value ->> 'correlationId')::uuid, p_outcome
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001', message = 'Named action Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

revoke all on function vortex_record.append_named_action_activity_internal(uuid,uuid,uuid[],text)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_record.append_named_action_activity_internal(uuid,uuid,uuid[],text)
to vortex_record_adapter;
set local role vortex_record_owner;
revoke create on schema vortex_record from postgres;
reset role;
set local role vortex_record_adapter;

create function vortex_record.project_named_action_record_internal(
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  values_value jsonb := '{}'::jsonb;
  field_id text;
begin
  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, null
  );
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  bounds := bounds || pg_catalog.jsonb_build_object(
    'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
      loaded -> 'facts' -> 'recordTypes', p_record_type_id,
      bounds -> 'readableFieldIds'
    )
  );
  for field_id in
    select item.value #>> '{}'
    from pg_catalog.jsonb_array_elements(bounds -> 'readableFieldIds') item(value)
  loop
    if loaded -> 'columns' ? field_id and loaded -> 'fieldValues' ? field_id then
      values_value := values_value || pg_catalog.jsonb_build_object(
        field_id, loaded -> 'fieldValues' -> field_id
      );
    end if;
  end loop;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed', 'recordId', p_record_id,
    'concurrencyNumber', loaded -> 'concurrencyNumber',
    'values', values_value,
    'correlationId', loaded -> 'context' -> 'correlationId',
    'backgroundDelivery', 'pending', 'replayed', true
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

create function vortex_record.prepare_named_action_set_announce_internal(
  p_preview boolean,
  p_command_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_inputs jsonb,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  fingerprint_value text;
  receipt vortex_record.named_action_command_receipts%rowtype;
  action_context jsonb;
  loaded jsonb;
  decision jsonb;
  bounds jsonb;
  effect_value jsonb;
  projection jsonb;
begin
  if p_preview is null or p_command_id is null
    or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_action_owner_kind not in ('application', 'module')
    or p_action_owner_id is null or p_action_id is null
    or p_action_release_revision not between 1 and 9007199254740991
    or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object'
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  context_value := vortex_access.validated_human_request_context();
  fingerprint_value := vortex_record.named_action_command_fingerprint_internal(
    p_command_id, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_inputs
  );
  select stored.* into receipt
  from vortex_record.named_action_command_receipts stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = p_command_id;
  if found then
    if receipt.command_fingerprint is distinct from fingerprint_value
      or receipt.action_owner_kind is distinct from p_action_owner_kind
      or receipt.action_owner_id is distinct from p_action_owner_id
      or receipt.action_release_revision is distinct from p_action_release_revision
      or receipt.action_id is distinct from p_action_id
      or receipt.record_type_id is distinct from p_record_type_id
      or receipt.record_id is distinct from p_record_id then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if receipt.state <> 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    projection := vortex_record.project_named_action_record_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id
    );
    if projection ->> 'outcome' <> 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    return projection;
  end if;

  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  if coalesce((action_context ->> 'rulesUnsupported')::boolean, false)
    or pg_catalog.jsonb_array_length(action_context -> 'action' -> 'effects') not between 1 and 10
    or exists (
      select 1 from pg_catalog.jsonb_array_elements(
        action_context -> 'action' -> 'effects'
      ) item(value)
      where item.value ->> 'kind' not in ('set_field', 'announce_event')
    ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'unsupported', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id,
    case when p_preview then null else p_expected_concurrency_number end
  );
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
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    if p_preview then
      return pg_catalog.jsonb_build_object(
        'outcome', 'permission_refused', 'correlationId', context_value -> 'correlationId'
      );
    end if;
    perform vortex_record.append_named_action_activity_internal(
      p_activity_id, p_record_id, array[]::uuid[], 'refused'
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused_recorded', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  bounds := bounds || pg_catalog.jsonb_build_object(
    'readableFieldIds', vortex_record.filter_calculated_readable_field_ids(
      loaded -> 'facts' -> 'recordTypes', p_record_type_id,
      bounds -> 'readableFieldIds'
    )
  );
  return pg_catalog.jsonb_build_object(
    'outcome', case when p_preview then 'previewed' else 'prepared' end,
    'action', action_context -> 'action',
    'validationContractVersion', action_context -> 'validationContractVersion',
    'recordType', action_context -> 'recordType',
    'recordId', p_record_id,
    'existingValues', loaded -> 'fieldValues',
    'readableFieldIds', bounds -> 'readableFieldIds',
    'changeableFieldIds', bounds -> 'changeableFieldIds',
    'eventDescriptors', action_context -> 'eventDescriptors',
    'actorOrganizationAccountId', context_value -> 'organizationAccountId',
    'correlationId', context_value -> 'correlationId'
  );
exception
  when no_data_found or too_many_rows or insufficient_privilege
    or object_not_in_prerequisite_state or check_violation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

create function vortex_record.preview_named_action_set_announce(
  p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid,
  p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid,
  p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb,
  p_activity_id uuid
)
returns jsonb language sql volatile security definer set search_path = ''
as $function$
  select vortex_record.prepare_named_action_set_announce_internal(
    true, p_command_id, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_inputs, p_activity_id
  )
$function$;

create function vortex_record.prepare_named_action_set_announce(
  p_command_id uuid, p_action_owner_kind text, p_action_owner_id uuid,
  p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid,
  p_record_id uuid, p_expected_concurrency_number bigint, p_inputs jsonb,
  p_activity_id uuid
)
returns jsonb language sql volatile security definer set search_path = ''
as $function$
  select vortex_record.prepare_named_action_set_announce_internal(
    false, p_command_id, p_action_owner_kind, p_action_owner_id,
    p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_inputs, p_activity_id
  )
$function$;

create function vortex_record.record_named_action_precondition_refusal(
  p_action_owner_kind text, p_action_owner_id uuid,
  p_action_release_revision bigint, p_action_id uuid, p_record_type_id uuid,
  p_record_id uuid, p_expected_concurrency_number bigint, p_activity_id uuid
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $function$
declare
  loaded jsonb;
  decision jsonb;
  context_value jsonb;
begin
  context_value := vortex_access.validated_human_request_context();
  loaded := vortex_record.load_named_action_facts_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if loaded ->> 'outcome' <> 'loaded' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, loaded -> 'facts'
  );
  if decision ->> 'outcome' <> 'allowed' then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;
  perform vortex_record.append_named_action_activity_internal(
    p_activity_id, p_record_id, array[]::uuid[], 'refused'
  );
  return pg_catalog.jsonb_build_object(
    'outcome', 'refused_recorded', 'correlationId', context_value -> 'correlationId'
  );
end
$function$;

-- The two storage algorithms below retain the reviewed implementations and
-- replace only the facts/receipt/activity calls with their named-action fixed
-- counterparts. Exact guards make prerequisite drift fail the migration.
do $migration$
declare
  source_definition text;
  named_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'vortex_record.change_record(uuid,uuid,bigint,jsonb,uuid[])'::pg_catalog.regprocedure
  ) into strict source_definition;
  named_definition := pg_catalog.replace(source_definition,
    'CREATE OR REPLACE FUNCTION vortex_record.change_record(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_final_values jsonb, p_submitted_field_ids uuid[])',
    'CREATE OR REPLACE FUNCTION vortex_record.change_record_by_named_action_internal(p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_final_values jsonb, p_submitted_field_ids uuid[], p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid)');
  named_definition := pg_catalog.replace(named_definition,
    E'vortex_record.load_record_access_facts_internal(\n    p_record_type_id, ''update'', p_record_id, p_expected_concurrency_number\n  )',
    E'vortex_record.load_named_action_facts_internal(\n    p_action_owner_kind, p_action_owner_id, p_action_release_revision,\n    p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number\n  )');
  if named_definition = source_definition
    or pg_catalog.strpos(named_definition, 'change_record_by_named_action_internal') = 0
    or pg_catalog.strpos(named_definition, 'load_named_action_facts_internal') = 0 then
    raise exception using errcode = '55000', message = 'Named action writer clone failed';
  end if;
  execute named_definition;
end
$migration$;

do $migration$
declare
  source_definition text;
  named_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid)'::pg_catalog.regprocedure
  ) into strict source_definition;
  named_definition := pg_catalog.replace(source_definition,
    'CREATE OR REPLACE FUNCTION vortex_record.prepare_relationship_total_save(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_selected_group_id uuid, p_activity_id uuid)',
    'CREATE OR REPLACE FUNCTION vortex_record.prepare_named_action_relationship_totals(p_command_id uuid, p_operation text, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_submitted_values jsonb, p_selected_group_id uuid, p_activity_id uuid, p_action_owner_kind text, p_action_owner_id uuid, p_action_release_revision bigint, p_action_id uuid)');
  named_definition := pg_catalog.replace(named_definition,
    'vortex_record.save_command_receipts', 'vortex_record.named_action_command_receipts');
  named_definition := pg_catalog.replace(named_definition,
    E'vortex_record.load_record_access_facts_internal(\n      p_record_type_id, ''update'', p_record_id, null\n    )',
    E'vortex_record.load_named_action_facts_internal(\n      p_action_owner_kind, p_action_owner_id, p_action_release_revision,\n      p_action_id, p_record_type_id, p_record_id, null\n    )');
  named_definition := pg_catalog.replace(named_definition,
    E'vortex_record.load_record_access_facts_internal(\n      p_record_type_id, ''update'', p_record_id, p_expected_concurrency_number\n    )',
    E'vortex_record.load_named_action_facts_internal(\n      p_action_owner_kind, p_action_owner_id, p_action_release_revision,\n      p_action_id, p_record_type_id, p_record_id, p_expected_concurrency_number\n    )');
  named_definition := pg_catalog.replace(named_definition,
    'vortex_record.append_base_save_activity_internal(',
    'vortex_record.append_named_action_activity_internal(');
  named_definition := pg_catalog.replace(named_definition,
    E'p_activity_id, ''update'', context_organization_id,\n        array[]::uuid[], ''refused''',
    E'p_activity_id, p_record_id, array[]::uuid[], ''refused''');
  if named_definition = source_definition
    or pg_catalog.strpos(named_definition, 'prepare_named_action_relationship_totals') = 0
    or pg_catalog.strpos(named_definition, 'load_named_action_facts_internal') = 0
    or pg_catalog.strpos(named_definition, 'named_action_command_receipts') = 0 then
    raise exception using errcode = '55000', message = 'Named total preflight clone failed';
  end if;
  execute named_definition;
end
$migration$;

alter function vortex_record.named_action_command_fingerprint_internal(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb) owner to vortex_record_adapter;
alter function vortex_record.project_named_action_record_internal(text,uuid,bigint,uuid,uuid,uuid) owner to vortex_record_adapter;
alter function vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid) owner to vortex_record_adapter;
alter function vortex_record.preview_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid) owner to vortex_record_adapter;
alter function vortex_record.prepare_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid) owner to vortex_record_adapter;
alter function vortex_record.record_named_action_precondition_refusal(text,uuid,bigint,uuid,uuid,uuid,bigint,uuid) owner to vortex_record_adapter;
alter function vortex_record.change_record_by_named_action_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid) owner to vortex_record_adapter;
alter function vortex_record.prepare_named_action_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid,text,uuid,bigint,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.named_action_command_fingerprint_internal(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb),
  vortex_record.project_named_action_record_internal(text,uuid,bigint,uuid,uuid,uuid),
  vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid),
  vortex_record.preview_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid),
  vortex_record.prepare_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid),
  vortex_record.record_named_action_precondition_refusal(text,uuid,bigint,uuid,uuid,uuid,bigint,uuid),
  vortex_record.change_record_by_named_action_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid),
  vortex_record.prepare_named_action_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid,text,uuid,bigint,uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function
  vortex_record.preview_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid),
  vortex_record.prepare_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid),
  vortex_record.record_named_action_precondition_refusal(text,uuid,bigint,uuid,uuid,uuid,bigint,uuid),
  vortex_record.prepare_named_action_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid,text,uuid,bigint,uuid)
to vortex_runtime;
grant execute on function
  vortex_record.named_action_command_fingerprint_internal(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb),
  vortex_record.project_named_action_record_internal(text,uuid,bigint,uuid,uuid,uuid),
  vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid),
  vortex_record.change_record_by_named_action_internal(uuid,uuid,bigint,jsonb,uuid[],text,uuid,bigint,uuid)
to vortex_record_adapter;

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
commit;
