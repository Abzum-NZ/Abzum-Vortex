-- #560: protected recoverable Record delete and policy-bound restore.
--
-- The private #402 lifecycle primitives (`soft_delete_record_internal`,
-- `restore_record_internal`) stay the only implementations of recursive
-- deletion and restoration. This migration composes them into two protected
-- commands, each split into a database preflight and a terminal writer that
-- run in one request transaction:
--
--   * delete: scoped command receipt, the recursive soft delete (journalled
--     through one hook in the existing traversal), the dependency-total
--     closure of every parent the deleted tree contributed to, generated parent
--     values and their due metadata, due-metadata cancellation for the deleted
--     tree, standard `deleted` / `unlinked` Events, one `delete_record`
--     Activity and the completed receipt;
--   * restore: scoped command receipt, the restore primitive, enforcement of
--     the caller's #567 recovery decision against the stored policy under a
--     share lock, refreshed generated values of the restored record and of
--     every affected parent, their due metadata, the journalled effect, one
--     `restore_record` Activity and the completed receipt.
--
-- The Record runtime recalculates totals between the two phases exactly as
-- the ordinary save does. A pending receipt can never reach commit, so a
-- refusal or restart always rolls the whole transaction back.
--
-- Soft-deleted rows keep their relationship edges so they can be restored.
-- Every relationship-total preflight therefore skips a retained (non-active)
-- source instead of treating it as a concurrent change; without that, the
-- first delete would leave every parent that totals the deleted record
-- unsaveable.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
grant create on schema vortex_record to postgres;
reset role;

-- Closed lifecycle Activity composer, mirroring
-- `append_base_save_activity_internal`: it accepts only the fixed facts,
-- derives context, time and action itself, and invokes the private Activity
-- append as its postgres owner. The shared save composer is left unchanged.
create function vortex_record.append_record_lifecycle_activity_internal(
  p_activity_id uuid,
  p_operation text,
  p_subject_ids uuid[]
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
    or p_operation is null
    or p_operation not in ('delete', 'restore')
    or p_subject_ids is null
    or pg_catalog.cardinality(p_subject_ids) = 0
    or pg_catalog.array_position(p_subject_ids, null::uuid) is not null
    or '00000000-0000-0000-0000-000000000000'::uuid = any (p_subject_ids)
    or p_subject_ids is distinct from (
      select pg_catalog.array_agg(value order by value)
      from (select distinct value
        from pg_catalog.unnest(p_subject_ids) as item(value)) as canonical
    ) then
    raise exception using errcode = '22023',
      message = 'Record lifecycle Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record lifecycle Activity requires an Application context';
  end if;
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id, occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    case p_operation when 'delete' then 'delete_record' else 'restore_record' end,
    p_subject_ids, array[]::uuid[], 'web',
    (context_value ->> 'correlationId')::uuid, 'completed'
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record lifecycle Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

revoke all on function vortex_record.append_record_lifecycle_activity_internal(
  uuid, text, uuid[]
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_record.append_record_lifecycle_activity_internal(
  uuid, text, uuid[]
) to vortex_record_adapter;

set local role vortex_record_owner;
revoke create on schema vortex_record from postgres;

-- The stored #408 policy is owner-only. Restore receives exactly one fact
-- about it: the current revision and action of the exact target policy, read
-- under a share lock so the policy cannot change before the restore commits.
create function vortex_record.lock_record_recovery_policy_internal(
  p_organization_id uuid,
  p_storage_contract_id uuid,
  p_application_root_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  policy_row vortex_record.record_type_lifecycle_policies%rowtype;
begin
  if p_organization_id is null or p_storage_contract_id is null then
    return null;
  end if;
  select stored.* into policy_row
  from vortex_record.record_type_lifecycle_policies as stored
  where stored.organization_id = p_organization_id
    and stored.storage_contract_id = p_storage_contract_id
    and stored.application_root_id is not distinct from p_application_root_id
  for share;
  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'policyRevision', policy_row.policy_revision,
    'action', policy_row.action
  );
end
$function$;

revoke all on function vortex_record.lock_record_recovery_policy_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_module_owner, vortex_record_adapter;
grant execute on function vortex_record.lock_record_recovery_policy_internal(uuid, uuid, uuid)
  to vortex_record_adapter;

reset role;
set local role vortex_record_adapter;

-- One scoped idempotency receipt per human command, shared by both
-- operations so a command identity can never be reused for the other one.
create table vortex_record.record_lifecycle_command_receipts (
  organization_id uuid not null,
  application_root_id uuid not null,
  actor_organization_account_id uuid not null,
  command_id uuid not null,
  operation text not null,
  command_fingerprint text not null,
  record_type_id uuid not null,
  record_id uuid not null,
  expected_concurrency_number bigint not null,
  recovery_policy_revision bigint,
  activity_id uuid not null,
  occurrence_id uuid,
  state text not null,
  completed_concurrency_number bigint,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  completed_at timestamptz,
  constraint record_lifecycle_command_receipts_pk primary key (
    organization_id, application_root_id, actor_organization_account_id, command_id
  ),
  constraint record_lifecycle_command_receipts_operation_valid check (
    operation in ('delete', 'restore')
  ),
  constraint record_lifecycle_command_receipts_fingerprint_valid check (
    command_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint record_lifecycle_command_receipts_revision_valid check (
    expected_concurrency_number between 1 and 9007199254740990
  ),
  constraint record_lifecycle_command_receipts_policy_valid check (
    (operation = 'delete' and recovery_policy_revision is null)
    or (operation = 'restore'
      and recovery_policy_revision between 1 and 9007199254740991)
  ),
  -- Only a delete appends a standard Event; restore has no standard kind.
  constraint record_lifecycle_command_receipts_effects_valid check (
    activity_id <> '00000000-0000-0000-0000-000000000000'::uuid
    and (
      (operation = 'delete' and occurrence_id is not null
        and occurrence_id <> '00000000-0000-0000-0000-000000000000'::uuid)
      or (operation = 'restore' and occurrence_id is null)
    )
  ),
  constraint record_lifecycle_command_receipts_state_valid check (
    state in ('pending', 'completed')
  ),
  constraint record_lifecycle_command_receipts_result_complete check (
    (state = 'pending' and completed_concurrency_number is null
      and completed_at is null)
    or
    (state = 'completed'
      and completed_concurrency_number > expected_concurrency_number
      and completed_concurrency_number <= 9007199254740991
      and completed_at is not null)
  )
);

-- Identity-only journal of what one command's lifecycle traversal changed. It
-- never copies business values, so permanent removal of a record leaves no
-- content behind here. It is the only trusted source of the deleted set.
create table vortex_record.record_lifecycle_command_effects (
  organization_id uuid not null,
  application_root_id uuid not null,
  actor_organization_account_id uuid not null,
  command_id uuid not null,
  effect_sequence integer not null,
  effect_kind text not null,
  storage_contract_id uuid not null,
  record_type_id uuid not null,
  record_id uuid not null,
  relationship_id uuid,
  pre_concurrency_number bigint not null,
  post_concurrency_number bigint not null,
  constraint record_lifecycle_command_effects_pk primary key (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, effect_sequence
  ),
  constraint record_lifecycle_command_effects_receipt_fk foreign key (
    organization_id, application_root_id, actor_organization_account_id, command_id
  ) references vortex_record.record_lifecycle_command_receipts (
    organization_id, application_root_id, actor_organization_account_id, command_id
  ) on delete cascade,
  constraint record_lifecycle_command_effects_sequence_valid check (
    effect_sequence >= 1
  ),
  constraint record_lifecycle_command_effects_kind_valid check (
    effect_kind in ('soft_deleted', 'optional_cleared', 'restored')
  ),
  constraint record_lifecycle_command_effects_shape_valid check (
    (effect_kind = 'optional_cleared') = (relationship_id is not null)
  ),
  constraint record_lifecycle_command_effects_revision_valid check (
    pre_concurrency_number between 1 and 9007199254740990
    and post_concurrency_number = pre_concurrency_number + 1
  )
);

alter table vortex_record.record_lifecycle_command_receipts enable row level security;
alter table vortex_record.record_lifecycle_command_receipts force row level security;
create policy record_lifecycle_command_receipts_adapter
  on vortex_record.record_lifecycle_command_receipts to vortex_record_adapter
  using (true) with check (true);
alter table vortex_record.record_lifecycle_command_effects enable row level security;
alter table vortex_record.record_lifecycle_command_effects force row level security;
create policy record_lifecycle_command_effects_adapter
  on vortex_record.record_lifecycle_command_effects to vortex_record_adapter
  using (true) with check (true);
revoke all on table vortex_record.record_lifecycle_command_receipts,
  vortex_record.record_lifecycle_command_effects
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

create function vortex_record.record_lifecycle_command_fingerprint_internal(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $function$
  select 'sha256:' || pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object(
        'contractVersion', '1.0.0',
        'commandId', p_command_id,
        'operation', p_operation,
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id,
        'expectedConcurrencyNumber', p_expected_concurrency_number
      )::text, 'UTF8'
    )), 'hex'
  )
$function$;

-- A pending receipt reaching commit means a preflight was never finalized.
-- The deferred check re-reads the current row: NEW is the inserted version.
create function vortex_record.assert_record_lifecycle_receipt_completed_internal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1 from vortex_record.record_lifecycle_command_receipts as receipt
    where receipt.organization_id = new.organization_id
      and receipt.application_root_id = new.application_root_id
      and receipt.actor_organization_account_id = new.actor_organization_account_id
      and receipt.command_id = new.command_id
      and receipt.state = 'pending'
  ) then
    raise exception using errcode = '23514',
      message = 'Record lifecycle command was not finalized';
  end if;
  return null;
end
$function$;

create constraint trigger record_lifecycle_command_receipts_completed_at_commit
after insert or update on vortex_record.record_lifecycle_command_receipts
deferrable initially deferred
for each row
execute function vortex_record.assert_record_lifecycle_receipt_completed_internal();

-- Journals one effect for the command bound to this transaction. With no
-- bound command it does nothing, so the private primitives keep their exact
-- behaviour for any other composition.
create function vortex_record.append_record_lifecycle_effect_internal(
  p_effect_kind text,
  p_storage_contract_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_pre_concurrency_number bigint,
  p_relationship_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  bound_command_id uuid;
  context_value jsonb;
  receipt vortex_record.record_lifecycle_command_receipts%rowtype;
  next_sequence integer;
begin
  bound_command_id := pg_catalog.nullif(
    pg_catalog.current_setting('vortex_record.lifecycle_command_id', true), ''
  )::uuid;
  if bound_command_id is null then
    return;
  end if;
  context_value := vortex_access.validated_human_request_context();
  select stored.* into receipt
  from vortex_record.record_lifecycle_command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = bound_command_id
    and stored.state = 'pending'
  for update;
  if not found
    or (receipt.operation = 'delete'
      and p_effect_kind not in ('soft_deleted', 'optional_cleared'))
    or (receipt.operation = 'restore' and p_effect_kind is distinct from 'restored') then
    raise exception using errcode = '42501',
      message = 'Record lifecycle effect journal is unavailable';
  end if;
  select coalesce(pg_catalog.max(effect.effect_sequence), 0) + 1 into next_sequence
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = receipt.organization_id
    and effect.application_root_id = receipt.application_root_id
    and effect.actor_organization_account_id = receipt.actor_organization_account_id
    and effect.command_id = receipt.command_id;
  insert into vortex_record.record_lifecycle_command_effects (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, effect_sequence, effect_kind, storage_contract_id,
    record_type_id, record_id, relationship_id,
    pre_concurrency_number, post_concurrency_number
  ) values (
    receipt.organization_id, receipt.application_root_id,
    receipt.actor_organization_account_id, receipt.command_id, next_sequence,
    p_effect_kind, p_storage_contract_id, p_record_type_id, p_record_id,
    p_relationship_id, p_pre_concurrency_number, p_pre_concurrency_number + 1
  );
end
$function$;

-- The #402 traversal, unchanged except for its two journal calls: one after
-- each optional child link it clears and one after each record it deletes.
create or replace function vortex_record.soft_delete_record_recursive_internal(
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_visited text[]
)
returns void
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
  changed_rows integer;
  application_scope uuid;
begin
  meta := vortex_record.resolve_record_action_context_internal(p_record_type_id, 'delete');
  context_value := meta -> 'context';
  identity_value := pg_catalog.lower((meta ->> 'storageContractId')) || ':'
    || pg_catalog.lower(p_record_id::text);
  if identity_value = any (p_visited) then
    raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
  end if;
  p_visited := pg_catalog.array_append(p_visited, identity_value);

  loaded := vortex_record.load_record_access_facts_internal(
    p_record_type_id, 'delete', p_record_id, p_expected_concurrency_number
  );
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
  decision := vortex_access.evaluate_organization_record_access_internal(
    meta -> 'declaration', p_record_id, facts
  );
  if decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;

  -- Incoming edges are canonicalised before any child lock.  Every affected
  -- child is then reloaded and locked by #401's fixed loader.
  for incoming in
    select edge.*, mapping.on_parent_delete, mapping.relationship_id,
      mapping.source_field_id
    from vortex_record.relationship_edges as edge
    join vortex_record.relationship_storage_mappings as mapping
      on mapping.relationship_id = edge.relationship_id
    where edge.to_organisation_id = (context_value ->> 'organizationId')::uuid
      and edge.to_storage_contract_id = (meta ->> 'storageContractId')::uuid
      and edge.to_record_id = p_record_id
    order by edge.from_storage_contract_id, edge.from_record_id, edge.relationship_id
  loop
    select catalogue.* into source_catalogue
    from vortex_record.storage_catalogue as catalogue
    where catalogue.storage_contract_id = incoming.from_storage_contract_id;
    source_identity := pg_catalog.lower(incoming.from_storage_contract_id::text) || ':'
      || pg_catalog.lower(incoming.from_record_id::text);
    if source_identity = any (p_visited) then
      raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
    end if;

    -- A child retained by another Application cannot be silently modified
    -- under this Application's request context.  It is therefore a safe
    -- blocking relationship, not an authority bypass.
    source_action_kind := case
      when incoming.on_parent_delete = 'empty_optional' then 'update'
      when incoming.on_parent_delete = 'soft_delete_dependent' then 'delete'
      else 'read'
    end;
    begin
      source_meta := vortex_record.resolve_record_action_context_internal(
        source_catalogue.record_type_id, source_action_kind
      );
    exception when others then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end;

    select field_mapping.physical_column_token into strict source_link_column
    from vortex_record.field_storage_mappings as field_mapping
    where field_mapping.storage_contract_id = incoming.from_storage_contract_id
      and field_mapping.field_id = incoming.source_field_id
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
    if not found then
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
    source_loaded := vortex_record.load_record_access_facts_internal(
      source_catalogue.record_type_id, source_action_kind, incoming.from_record_id,
      source_concurrency
    );
    if source_loaded ->> 'outcome' <> 'loaded' then
      continue;
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(source_loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = incoming.from_record_id;
    if record_fact ->> 'lifecycleState' <> 'active' then
      continue;
    end if;
    if incoming.on_parent_delete = 'refuse' then
      raise exception using errcode = '23514', message = 'Parent deletion is blocked';
    end if;
    if pg_catalog.jsonb_typeof(source_meta -> 'declaration') <> 'object' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;
    source_decision := vortex_access.evaluate_organization_record_access_internal(
      source_meta -> 'declaration', incoming.from_record_id,
      (source_loaded -> 'facts') || pg_catalog.jsonb_build_object(
        'binding', source_meta -> 'declaration' -> 'recordBinding'
      )
    );
    if source_decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Affected record is unavailable';
    end if;

    if incoming.on_parent_delete = 'empty_optional' then
      perform vortex_record.write_relationship_value_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        incoming.relationship_id, 'null'::jsonb, true
      );
      perform vortex_record.append_record_lifecycle_effect_internal(
        'optional_cleared', incoming.from_storage_contract_id,
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, incoming.relationship_id
      );
    elsif incoming.on_parent_delete = 'soft_delete_dependent' then
      source_record_type := source_meta -> 'recordType';
      if source_record_type ->> 'ownershipMode' <> 'inherited'
        or not source_record_type ? 'ownershipRelationshipId'
        or (source_record_type ->> 'ownershipRelationshipId')::uuid <>
          incoming.relationship_id then
        raise exception using errcode = '23514', message = 'Dependent deletion is not declared';
      end if;
      perform vortex_record.soft_delete_record_recursive_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, p_visited
      );
    else
      raise exception using errcode = '23514', message = 'Parent deletion behavior is invalid';
    end if;
  end loop;

  execute pg_catalog.format(
    'update record_data.%I as stored
     set lifecycle_state = ''soft_deleted'',
       concurrency_number = concurrency_number + 1,
       updated_at = pg_catalog.statement_timestamp(), updated_by = $3,
       deleted_at = pg_catalog.statement_timestamp(), deleted_by = $3,
       removal_due_at = null, definition_revision = $4
     where organisation_id = $1 and record_id = $2
       and lifecycle_state = ''active'' and concurrency_number = $5',
    meta ->> 'table'
  ) using (context_value ->> 'organizationId')::uuid, p_record_id,
    (context_value ->> 'organizationAccountId')::uuid,
    (meta ->> 'moduleReleaseRevision')::bigint, p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception using errcode = '40001', message = 'Record delete revision changed';
  end if;
  perform vortex_record.append_record_lifecycle_effect_internal(
    'soft_deleted', (meta ->> 'storageContractId')::uuid,
    p_record_type_id, p_record_id, p_expected_concurrency_number, null
  );
  application_scope := case when meta ->> 'storageScope' = 'application_contained'
    then (context_value ->> 'applicationRootId')::uuid else null end;
  perform vortex_record.bump_record_data_version_internal(
    (context_value ->> 'organizationId')::uuid,
    (meta ->> 'storageContractId')::uuid, application_scope
  );
end
$function$;


-- True only for an existing source row in the given scope that is retained
-- but not active. A missing row stays a concurrent change for the caller.
create function vortex_record.relationship_total_source_is_retained_internal(
  p_catalogue jsonb,
  p_record_type_id uuid,
  p_record_id uuid,
  p_organization_id uuid,
  p_application_root_id uuid
)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
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
$function$;

reset role;

-- Every existing relationship-total preflight reads each total source through
-- the shared snapshot, which only returns active rows, and treats an absent
-- snapshot as a concurrent change. A soft-deleted source is excluded from
-- totals instead. Each function keeps one implementation: its single source
-- guard is extended in place, as its owner, and any drift in the expected
-- text fails the migration rather than silently skipping a caller.
do $migration$
declare
  target record;
  guard constant text := 'if source_snapshot is null then';
  source_definition text;
  patched_definition text;
  owner_name name;
begin
  for target in
    select candidate.procedure_id, candidate.organization_expression,
      candidate.application_expression
    from (values
      (
        'vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid)'::pg_catalog.regprocedure,
        'context_organization_id', 'context_application_id'
      ),
      (
        'vortex_record.prepare_named_action_command_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,text,uuid,bigint,uuid)'::pg_catalog.regprocedure,
        'context_organization_id', 'context_application_id'
      ),
      (
        'vortex_record.prepare_record_deadline_closure(uuid,uuid,uuid,uuid,uuid,bigint,uuid,uuid,text,timestamptz)'::pg_catalog.regprocedure,
        'p_organization_id', 'p_application_root_id'
      )
    ) as candidate(procedure_id, organization_expression, application_expression)
  loop
    source_definition := pg_catalog.pg_get_functiondef(target.procedure_id);
    if pg_catalog.length(source_definition)
        - pg_catalog.length(pg_catalog.replace(source_definition, guard, ''))
        <> pg_catalog.length(guard)
      or pg_catalog.strpos(source_definition,
        'vortex_record.relationship_total_record_snapshot_internal(
          catalogue, (relationship_value ->> ''fromRecordTypeId'')::uuid,
          edge_value.from_record_id, false') = 0
      and pg_catalog.strpos(source_definition,
        'vortex_record.relationship_total_record_snapshot_internal(
            catalogue, (relationship_value ->> ''fromRecordTypeId'')::uuid,
            edge_value.from_record_id, false') = 0 then
      raise exception using errcode = '55000',
        message = 'Relationship-total source guard is not uniquely patchable';
    end if;
    patched_definition := pg_catalog.replace(
      source_definition, guard,
      pg_catalog.format(
        'if source_snapshot is null
          and vortex_record.relationship_total_source_is_retained_internal(
            catalogue, (relationship_value ->> ''fromRecordTypeId'')::uuid,
            edge_value.from_record_id, %s, %s
          ) then
          continue;
        end if;
        %s',
        target.organization_expression, target.application_expression, guard
      )
    );
    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = target.procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute patched_definition;
    reset role;
  end loop;
end
$migration$;

set local role vortex_record_adapter;

-- The concrete dependency-total closure a lifecycle command changes.
--
-- Restore: the ordinary update closure of the now-active record, rooted at it.
-- Delete: every parent a deleted record of this command contributed a total to
-- and their transitive total parents. The deleted records themselves are not
-- members: they are already locked by the traversal and no longer counted.
create function vortex_record.record_lifecycle_total_closure_internal(
  p_catalogue jsonb,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_command_id uuid
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  context_actor_id uuid;
  seed record;
  seed_key text;
  closure_value jsonb;
  closure_record jsonb;
  record_key text;
  records jsonb := '[]'::jsonb;
  record_keys text[] := array[]::text[];
  signatures jsonb := '[]'::jsonb;
begin
  if p_operation = 'restore' then
    return vortex_record.discover_relationship_total_closure_internal(
      p_catalogue, 'update', p_record_type_id, p_record_id, '{}'::jsonb
    );
  end if;
  if p_operation is distinct from 'delete' or p_command_id is null
    or pg_catalog.jsonb_typeof(p_catalogue -> 'recordTypes') is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_catalogue -> 'relationships') is distinct from 'array' then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  context_actor_id := (context_value ->> 'organizationAccountId')::uuid;

  for seed in
    select distinct
      (target_type.value ->> 'recordTypeId')::uuid as record_type_id,
      edge.to_storage_contract_id as storage_contract_id,
      edge.to_record_id as record_id
    from vortex_record.record_lifecycle_command_effects as effect
    join vortex_record.relationship_edges as edge
      on edge.from_organisation_id = effect.organization_id
     and edge.from_storage_contract_id = effect.storage_contract_id
     and edge.from_record_id = effect.record_id
    cross join lateral (
      select item.value
      from pg_catalog.jsonb_array_elements(p_catalogue -> 'relationships') as item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
          pg_catalog.lower(edge.relationship_id::text)
        and item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
    ) as relationship
    cross join lateral (
      select item.value
      from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
          pg_catalog.lower(relationship.value #>> '{toRecordType,recordTypeId}')
        and (item.value ->> 'storageContractId')::uuid = edge.to_storage_contract_id
    ) as target_type
    where effect.organization_id = context_organization_id
      and effect.application_root_id = context_application_id
      and effect.actor_organization_account_id = context_actor_id
      and effect.command_id = p_command_id
      and effect.effect_kind = 'soft_deleted'
      and edge.to_organisation_id = context_organization_id
      and edge.to_application_root_id is not distinct from case
        when target_type.value ->> 'storageScope' = 'application_contained'
          then context_application_id else null end
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements(target_type.value -> 'fields') as field(value)
        where field.value ->> 'type' = 'total'
          and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
            pg_catalog.lower(relationship.value ->> 'relationshipId')
      )
      and not exists (
        select 1 from vortex_record.record_lifecycle_command_effects as deleted
        where deleted.organization_id = effect.organization_id
          and deleted.application_root_id = effect.application_root_id
          and deleted.actor_organization_account_id = effect.actor_organization_account_id
          and deleted.command_id = effect.command_id
          and deleted.effect_kind = 'soft_deleted'
          and deleted.storage_contract_id = edge.to_storage_contract_id
          and deleted.record_id = edge.to_record_id
      )
    order by 2, 3
  loop
    seed_key := pg_catalog.lower(seed.record_type_id::text) || ':'
      || pg_catalog.lower(seed.record_id::text);
    -- A parent already reached is complete: discovery follows every
    -- transitive total parent of each member it adds.
    if seed_key = any (record_keys) then
      continue;
    end if;
    closure_value := vortex_record.discover_relationship_total_closure_internal(
      p_catalogue, 'update', seed.record_type_id, seed.record_id, '{}'::jsonb
    );
    if closure_value is null then
      return null;
    end if;
    for closure_record in
      select item.value
      from pg_catalog.jsonb_array_elements(closure_value -> 'records') as item(value)
    loop
      record_key := case when closure_record ->> 'recordKey' = 'root'
        then seed_key else closure_record ->> 'recordKey' end;
      if record_key = any (record_keys) then
        continue;
      end if;
      records := records || pg_catalog.jsonb_build_array(
        closure_record || pg_catalog.jsonb_build_object('recordKey', record_key)
      );
      record_keys := pg_catalog.array_append(record_keys, record_key);
    end loop;
    signatures := signatures || coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'from', case when item.value ->> 'from' = 'root'
          then seed_key else item.value ->> 'from' end,
        'relationshipId', item.value -> 'relationshipId',
        'to', case when item.value ->> 'to' = 'root'
          then seed_key else item.value ->> 'to' end
      ))
      from pg_catalog.jsonb_array_elements(closure_value -> 'signatures') as item(value)
    ), '[]'::jsonb);
  end loop;

  return pg_catalog.jsonb_build_object(
    'records', records,
    'signatures', coalesce((
      select pg_catalog.jsonb_agg(distinct item.value order by item.value)
      from pg_catalog.jsonb_array_elements(signatures) as item(value)
    ), '[]'::jsonb)
  );
end
$function$;

-- Locks one lifecycle command's closure in canonical concrete order, proves it
-- unchanged, and returns the same declared evaluator inputs as the ordinary
-- relationship-total preflight. A delete adds its deleted root, captured
-- before deletion, only so the evaluator has the root it requires; the root is
-- never written and no longer counts toward any total.
create function vortex_record.prepare_record_lifecycle_totals_internal(
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_command_id uuid,
  p_root_snapshot jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  catalogue jsonb;
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
begin
  if p_operation is null or p_operation not in ('delete', 'restore')
    or (p_operation = 'restore' and p_root_snapshot is not null) then
    raise exception using errcode = '22023',
      message = 'Record lifecycle total preparation is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  catalogue := vortex_record.relationship_total_catalogue_internal();

  before_closure := vortex_record.record_lifecycle_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_command_id
  );
  if before_closure is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'relationship_refused',
      'correlationId', context_value -> 'correlationId'
    );
  end if;

  for record_value in
    select item.value
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value)
    where item.value ? 'recordId'
    order by (item.value ->> 'storageContractId')::uuid,
      (item.value ->> 'recordId')::uuid
  loop
    if vortex_record.relationship_total_record_snapshot_internal(
      catalogue,
      (record_value ->> 'recordTypeId')::uuid,
      (record_value ->> 'recordId')::uuid,
      true
    ) is null then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
  end loop;

  after_closure := vortex_record.record_lifecycle_total_closure_internal(
    catalogue, p_operation, p_record_type_id, p_record_id, p_command_id
  );
  if after_closure is null
    or (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value))
      is distinct from
      (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;

  -- Mirrors the ordinary save: installed rules are not evaluated against
  -- generated parent values, so no parent total may change under them.
  if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false) and exists (
    select 1
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)
    where item.value ->> 'recordKey' <> 'root'
  ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'unsupported_relationship_totals',
      'correlationId', context_value -> 'correlationId'
    );
  end if;

  for prepared_record in
    select ordered.value
    from (
      select p_root_snapshot || pg_catalog.jsonb_build_object('recordKey', 'root') as value,
        0 as position, '' as record_key
      where p_root_snapshot is not null
      union all
      select item.value,
        case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
        item.value ->> 'recordKey'
      from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)
    ) as ordered
    order by ordered.position, ordered.record_key collate "C"
  loop
    prepared_record := prepared_record || pg_catalog.jsonb_build_object(
      'relationshipSources', '[]'::jsonb
    );
    for total_field in
      select field.value
      from pg_catalog.jsonb_array_elements(prepared_record -> 'recordType' -> 'fields') as field(value)
      where field.value ->> 'type' = 'total'
      order by field.value ->> 'fieldId'
    loop
      relationship_value := null;
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') as item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
          pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and pg_catalog.lower(item.value #>> '{toRecordType,recordTypeId}') =
          pg_catalog.lower(prepared_record ->> 'recordTypeId');
      if relationship_value is null then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_refused',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') as source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      source_type := null;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') as item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'relationship_refused',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      source_records := '[]'::jsonb;
      for edge_value in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (relationship_value ->> 'relationshipId')::uuid
          and edge.from_storage_contract_id = (source_type ->> 'storageContractId')::uuid
          and edge.to_storage_contract_id = (prepared_record ->> 'storageContractId')::uuid
          and edge.to_record_id = (prepared_record ->> 'recordId')::uuid
          and edge.from_organisation_id = context_organization_id
          and edge.to_organisation_id = context_organization_id
          and edge.from_application_root_id is not distinct from case
            when source_type ->> 'storageScope' = 'application_contained'
              then context_application_id else null end
          and edge.to_application_root_id is not distinct from case
            when prepared_record #>> '{recordType,storageScope}' = 'application_contained'
              then context_application_id else null end
        order by edge.from_storage_contract_id, edge.from_record_id
      loop
        source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
          catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
          edge_value.from_record_id, false
        );
        if source_snapshot is null
          and vortex_record.relationship_total_source_is_retained_internal(
            catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
            edge_value.from_record_id, context_organization_id, context_application_id
          ) then
          continue;
        end if;
        if source_snapshot is null then
          return pg_catalog.jsonb_build_object('outcome', 'restart');
        end if;
        source_key := null;
        select item.value ->> 'recordKey' into source_key
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)
        where item.value ->> 'recordTypeId' = source_snapshot ->> 'recordTypeId'
          and item.value ->> 'recordId' = source_snapshot ->> 'recordId';
        source_records := source_records || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'fieldValues', source_snapshot -> 'existingValues'
          ) || case when source_key is null then '{}'::jsonb
            else pg_catalog.jsonb_build_object('recordKey', source_key) end
        );
      end loop;
      prepared_record := pg_catalog.jsonb_set(
        prepared_record, '{relationshipSources}',
        (prepared_record -> 'relationshipSources') || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'relationshipId', relationship_value -> 'relationshipId',
            'sourceRecordType', source_type - 'moduleReleaseRevision',
            'records', source_records
          )
        )
      );
    end loop;
    prepared_records := prepared_records || pg_catalog.jsonb_build_array(prepared_record);
  end loop;

  return pg_catalog.jsonb_build_object(
    'outcome', 'prepared',
    'correlationId', context_value -> 'correlationId',
    'readableFieldIds', '[]'::jsonb,
    'records', prepared_records
  );
end
$function$;

-- The authorized current revision a conflicting delete may report. Nothing is
-- reported unless the actor may still delete the record.
create function vortex_record.record_lifecycle_current_revision_internal(
  p_record_type_id uuid,
  p_record_id uuid
)
returns bigint
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  loaded jsonb;
  decision jsonb;
begin
  begin
    loaded := vortex_record.load_record_access_facts_internal(
      p_record_type_id, 'delete', p_record_id, null
    );
    if loaded ->> 'outcome' is distinct from 'loaded'
      or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object' then
      return null;
    end if;
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' is distinct from 'allowed' then
      return null;
    end if;
    return (loaded ->> 'concurrencyNumber')::bigint;
  exception
    when others then
      return null;
  end;
end
$function$;

-- The stored outcome of an already-received command identity.
create function vortex_record.record_lifecycle_receipt_outcome_internal(
  p_command_id uuid,
  p_operation text,
  p_fingerprint text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.record_lifecycle_command_receipts%rowtype;
begin
  context_value := vortex_access.validated_human_request_context();
  select stored.* into receipt
  from vortex_record.record_lifecycle_command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = p_command_id
  for share;
  if not found
    or receipt.operation is distinct from p_operation
    or receipt.command_fingerprint is distinct from p_fingerprint then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
      'correlationId', context_value -> 'correlationId'
    );
  end if;
  if receipt.state is distinct from 'completed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', case receipt.operation when 'delete' then 'deleted' else 'restored' end,
    'recordId', receipt.record_id,
    'concurrencyNumber', receipt.completed_concurrency_number,
    'correlationId', context_value -> 'correlationId',
    'replayed', true
  );
end
$function$;

-- Applies the runtime-calculated generated values of every closure record the
-- command changes, after proving the supplied set is exactly the locked
-- closure at its locked revisions, and keeps each changed record's due
-- metadata at its new revision. Returns each record's resulting revision.
create function vortex_record.apply_record_lifecycle_generated_values_internal(
  p_preparation jsonb,
  p_include_root boolean,
  p_mutations jsonb,
  p_due_transitions jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  expected_mutations jsonb;
  supplied_mutations jsonb;
  expected_due jsonb;
  supplied_due jsonb;
  mutation_value jsonb;
  prepared_record jsonb;
  due_value jsonb;
  reduced_final_values jsonb;
  final_revision bigint;
  revisions jsonb := '[]'::jsonb;
begin
  if pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
    or pg_catalog.jsonb_typeof(p_due_transitions) is distinct from 'array'
    or p_include_root is null then
    raise exception using errcode = '22023',
      message = 'Record lifecycle generated values are invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'recordTypeId', item.value -> 'recordTypeId',
      'recordId', item.value -> 'recordId',
      'expectedConcurrencyNumber', item.value -> 'concurrencyNumber',
      'finalFieldIds', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.lower(field.value ->> 'fieldId')
          order by pg_catalog.lower(field.value ->> 'fieldId') collate "C"
        )
        from pg_catalog.jsonb_array_elements(item.value -> 'recordType' -> 'fields') as field(value)
        where field.value ->> 'type' in ('total', 'calculation')
      ), '[]'::jsonb)
    ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
  ), '[]'::jsonb) into expected_mutations
  from pg_catalog.jsonb_array_elements(p_preparation -> 'records') as item(value)
  where p_include_root or item.value ->> 'recordKey' <> 'root';

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'recordTypeId', item.value -> 'recordTypeId',
      'recordId', item.value -> 'recordId',
      'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
      'finalFieldIds', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.lower(field_id) order by pg_catalog.lower(field_id) collate "C")
        from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') as field(field_id)
      ), '[]'::jsonb)
    ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
  ), '[]'::jsonb) into supplied_mutations
  from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and item.value ?& array['recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues']
    and item.value - array['recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues']
      = '{}'::jsonb
    and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'recordTypeId', item.value -> 'recordTypeId',
      'recordId', item.value -> 'recordId'
    ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
  ), '[]'::jsonb) into expected_due
  from pg_catalog.jsonb_array_elements(expected_mutations) as item(value);

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'recordTypeId', item.value -> 'recordTypeId',
      'recordId', item.value -> 'recordId'
    ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
  ), '[]'::jsonb) into supplied_due
  from pg_catalog.jsonb_array_elements(p_due_transitions) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and item.value ?& array['recordTypeId', 'recordId', 'dueTransition']
    and item.value - array['recordTypeId', 'recordId', 'dueTransition'] = '{}'::jsonb
    and vortex_record.deadline_due_transition_is_valid_internal(item.value -> 'dueTransition');

  if supplied_mutations is distinct from expected_mutations
    or pg_catalog.jsonb_array_length(supplied_mutations)
      <> pg_catalog.jsonb_array_length(p_mutations)
    or supplied_due is distinct from expected_due
    or pg_catalog.jsonb_array_length(supplied_due)
      <> pg_catalog.jsonb_array_length(p_due_transitions) then
    raise exception using errcode = '22023',
      message = 'Record lifecycle generated values do not match the locked closure';
  end if;

  for mutation_value in
    select item.value
    from pg_catalog.jsonb_array_elements(p_mutations) as item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    select item.value into strict prepared_record
    from pg_catalog.jsonb_array_elements(p_preparation -> 'records') as item(value)
    where item.value ->> 'recordTypeId' = mutation_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = mutation_value ->> 'recordId'
      and (p_include_root or item.value ->> 'recordKey' <> 'root');
    select item.value -> 'dueTransition' into strict due_value
    from pg_catalog.jsonb_array_elements(p_due_transitions) as item(value)
    where item.value ->> 'recordTypeId' = mutation_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = mutation_value ->> 'recordId';
    select coalesce(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
      into reduced_final_values
    from pg_catalog.jsonb_each(mutation_value -> 'finalValues') as entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_record -> 'existingValues' -> pg_catalog.lower(entry.key), 'null'::jsonb
    );
    perform vortex_record.apply_relationship_total_parent_internal(
      (mutation_value ->> 'recordTypeId')::uuid,
      (mutation_value ->> 'recordId')::uuid,
      (mutation_value ->> 'expectedConcurrencyNumber')::bigint,
      reduced_final_values
    );
    final_revision := (mutation_value ->> 'expectedConcurrencyNumber')::bigint
      + case when reduced_final_values = '{}'::jsonb then 0 else 1 end;
    -- An unchanged parent keeps its revision and therefore its current due
    -- row. The restored root always reached a new revision.
    if reduced_final_values <> '{}'::jsonb or prepared_record ->> 'recordKey' = 'root' then
      perform vortex_record.write_deadline_closure_due_metadata_internal(
        (context_value ->> 'organizationId')::uuid,
        (context_value ->> 'applicationRootId')::uuid,
        prepared_record, final_revision, due_value
      );
    end if;
    revisions := revisions || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'recordKey', prepared_record ->> 'recordKey',
      'concurrencyNumber', final_revision
    ));
  end loop;
  return revisions;
end
$function$;

-- Protected delete preflight. On `prepared` the soft-deleted tree is held in
-- this transaction behind a pending receipt; only the finalizer completes it.
create function vortex_record.prepare_protected_record_delete(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
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
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  correlation_value jsonb;
  fingerprint_value text;
  inserted_command_id uuid;
  root_snapshot jsonb;
  deletion_result jsonb;
  current_revision bigint;
begin
  if p_command_id is null or p_command_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_activity_id is null or p_activity_id = nil_uuid
    or p_occurrence_id is null or p_occurrence_id = nil_uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record delete requires an Application context';
  end if;
  correlation_value := context_value -> 'correlationId';
  fingerprint_value := vortex_record.record_lifecycle_command_fingerprint_internal(
    p_command_id, 'delete', p_record_type_id, p_record_id, p_expected_concurrency_number
  );

  insert into vortex_record.record_lifecycle_command_receipts (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, operation, command_fingerprint, record_type_id, record_id,
    expected_concurrency_number, recovery_policy_revision, activity_id,
    occurrence_id, state
  ) values (
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'applicationRootId')::uuid,
    (context_value ->> 'organizationAccountId')::uuid,
    p_command_id, 'delete', fingerprint_value, p_record_type_id, p_record_id,
    p_expected_concurrency_number, null, p_activity_id, p_occurrence_id, 'pending'
  )
  on conflict do nothing
  returning command_id into inserted_command_id;
  if inserted_command_id is null then
    return vortex_record.record_lifecycle_receipt_outcome_internal(
      p_command_id, 'delete', fingerprint_value
    );
  end if;

  -- The evaluator needs the root's last active values. They are captured
  -- before the traversal and only used if that traversal deletes exactly the
  -- revision they were read at.
  root_snapshot := vortex_record.relationship_total_record_snapshot_internal(
    vortex_record.relationship_total_catalogue_internal(),
    p_record_type_id, p_record_id, false
  );

  perform pg_catalog.set_config(
    'vortex_record.lifecycle_command_id', p_command_id::text, true
  );
  deletion_result := vortex_record.soft_delete_record_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  perform pg_catalog.set_config('vortex_record.lifecycle_command_id', '', true);

  if deletion_result ->> 'outcome' = 'conflict' then
    current_revision := vortex_record.record_lifecycle_current_revision_internal(
      p_record_type_id, p_record_id
    );
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', correlation_value
    ) || case when current_revision is null then '{}'::jsonb
      else pg_catalog.jsonb_build_object('concurrencyNumber', current_revision) end;
  end if;
  if deletion_result ->> 'outcome' is distinct from 'completed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', coalesce(deletion_result ->> 'reasonCode', 'record_unavailable'),
      'correlationId', correlation_value
    );
  end if;
  if root_snapshot is null then
    raise exception using errcode = '55000',
      message = 'Protected record delete root is not installed';
  end if;
  if (root_snapshot ->> 'concurrencyNumber')::bigint
      is distinct from p_expected_concurrency_number then
    raise exception using errcode = '40001',
      message = 'Protected record delete root changed before deletion';
  end if;

  return vortex_record.prepare_record_lifecycle_totals_internal(
    'delete', p_record_type_id, p_record_id, p_command_id, root_snapshot
  );
end
$function$;

-- Protected delete terminal writer, in the preflight's transaction.
create function vortex_record.finalize_protected_record_delete(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_parent_mutations jsonb,
  p_due_transitions jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.record_lifecycle_command_receipts%rowtype;
  preparation jsonb;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  event_kind text;
  event_result jsonb;
  subject_ids uuid[];
begin
  context_value := vortex_access.validated_human_request_context();
  select stored.* into receipt
  from vortex_record.record_lifecycle_command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = p_command_id
  for update;
  if not found
    or receipt.state is distinct from 'pending'
    or receipt.operation is distinct from 'delete'
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.record_id is distinct from p_record_id
    or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
    raise exception using errcode = '55000',
      message = 'Protected record delete is not prepared';
  end if;

  -- Closure identity and revisions are re-derived under the held locks rather
  -- than taken from the caller.
  preparation := vortex_record.prepare_record_lifecycle_totals_internal(
    'delete', p_record_type_id, p_record_id, p_command_id, null
  );
  if preparation ->> 'outcome' is distinct from 'prepared' then
    raise exception using errcode = '40001',
      message = 'Protected record delete closure changed';
  end if;
  perform vortex_record.apply_record_lifecycle_generated_values_internal(
    preparation, false, p_parent_mutations, p_due_transitions
  );

  for effect_row in
    select effect.*
    from vortex_record.record_lifecycle_command_effects as effect
    where effect.organization_id = receipt.organization_id
      and effect.application_root_id = receipt.application_root_id
      and effect.actor_organization_account_id = receipt.actor_organization_account_id
      and effect.command_id = receipt.command_id
    order by effect.effect_sequence
  loop
    if effect_row.effect_kind = 'soft_deleted' then
      -- A deleted record has no pending deadline.
      delete from vortex_record.record_deadline_due_metadata as metadata
      where metadata.organization_id = effect_row.organization_id
        and metadata.storage_contract_id = effect_row.storage_contract_id
        and metadata.record_id = effect_row.record_id;
      event_kind := 'deleted';
    else
      -- Clearing an optional link changes no deadline input; the due row
      -- follows the child to its new revision.
      update vortex_record.record_deadline_due_metadata as metadata
      set record_concurrency_number = effect_row.post_concurrency_number,
        changed_at = pg_catalog.statement_timestamp()
      where metadata.organization_id = effect_row.organization_id
        and metadata.storage_contract_id = effect_row.storage_contract_id
        and metadata.record_id = effect_row.record_id
        and metadata.record_concurrency_number = effect_row.pre_concurrency_number;
      event_kind := 'unlinked';
    end if;
    event_result := vortex_event.append_record_occurrences(
      effect_row.storage_contract_id, effect_row.record_id,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', case
          when event_kind = 'deleted' and effect_row.record_id = p_record_id
            and effect_row.record_type_id = p_record_type_id
            then receipt.occurrence_id
          else pg_catalog.gen_random_uuid() end,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', event_kind,
          'recordTypeId', effect_row.record_type_id
        ),
        'payload', pg_catalog.jsonb_build_object('kind', event_kind)
      ))
    );
    if pg_catalog.jsonb_array_length(event_result) <> 1 then
      raise exception using errcode = '55000',
        message = 'Protected record delete Event append failed';
    end if;
  end loop;

  select pg_catalog.array_agg(distinct effect.record_id order by effect.record_id)
    into subject_ids
  from vortex_record.record_lifecycle_command_effects as effect
  where effect.organization_id = receipt.organization_id
    and effect.application_root_id = receipt.application_root_id
    and effect.actor_organization_account_id = receipt.actor_organization_account_id
    and effect.command_id = receipt.command_id;
  if subject_ids is null or not (p_record_id = any (subject_ids)) then
    raise exception using errcode = '55000',
      message = 'Protected record delete effects are unavailable';
  end if;
  perform vortex_record.append_record_lifecycle_activity_internal(
    receipt.activity_id, 'delete', subject_ids
  );

  update vortex_record.record_lifecycle_command_receipts as stored
  set state = 'completed',
    completed_concurrency_number = p_expected_concurrency_number + 1,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = receipt.organization_id
    and stored.application_root_id = receipt.application_root_id
    and stored.actor_organization_account_id = receipt.actor_organization_account_id
    and stored.command_id = receipt.command_id
    and stored.state = 'pending';
  if not found then
    raise exception using errcode = '40001',
      message = 'Protected record delete receipt is stale';
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'deleted',
    'recordId', p_record_id,
    'concurrencyNumber', p_expected_concurrency_number + 1,
    'correlationId', context_value -> 'correlationId',
    'replayed', false
  );
end
$function$;

-- Protected restore preflight. The caller supplies the governing revision of
-- the #567 recovery decision it made; the restore proceeds only while that is
-- still the exact stored, recoverable-delete policy of the record's target,
-- and that policy stays share-locked until commit.
create function vortex_record.prepare_protected_record_restore(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_recovery_policy_revision bigint,
  p_activity_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  nil_uuid constant uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  context_value jsonb;
  correlation_value jsonb;
  fingerprint_value text;
  inserted_command_id uuid;
  restore_result jsonb;
  storage_row vortex_record.storage_catalogue%rowtype;
  policy_value jsonb;
  refusal_reason text;
begin
  if p_command_id is null or p_command_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_activity_id is null or p_activity_id = nil_uuid
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_recovery_policy_revision is null
    or p_recovery_policy_revision not between 1 and 9007199254740991 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record restore requires an Application context';
  end if;
  correlation_value := context_value -> 'correlationId';
  fingerprint_value := vortex_record.record_lifecycle_command_fingerprint_internal(
    p_command_id, 'restore', p_record_type_id, p_record_id, p_expected_concurrency_number
  );

  insert into vortex_record.record_lifecycle_command_receipts (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, operation, command_fingerprint, record_type_id, record_id,
    expected_concurrency_number, recovery_policy_revision, activity_id,
    occurrence_id, state
  ) values (
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'applicationRootId')::uuid,
    (context_value ->> 'organizationAccountId')::uuid,
    p_command_id, 'restore', fingerprint_value, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_recovery_policy_revision, p_activity_id,
    null, 'pending'
  )
  on conflict do nothing
  returning command_id into inserted_command_id;
  if inserted_command_id is null then
    return vortex_record.record_lifecycle_receipt_outcome_internal(
      p_command_id, 'restore', fingerprint_value
    );
  end if;

  restore_result := vortex_record.restore_record_internal(
    p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  if restore_result ->> 'outcome' = 'conflict' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', correlation_value
    ) || case when pg_catalog.jsonb_typeof(restore_result -> 'concurrencyNumber') = 'number'
      then pg_catalog.jsonb_build_object(
        'concurrencyNumber', restore_result -> 'concurrencyNumber'
      ) else '{}'::jsonb end;
  end if;
  if restore_result ->> 'outcome' is distinct from 'completed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', coalesce(restore_result ->> 'reasonCode', 'record_unavailable'),
      'correlationId', correlation_value
    );
  end if;

  select catalogue.* into strict storage_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.record_type_id = p_record_type_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
  perform pg_catalog.set_config(
    'vortex_record.lifecycle_command_id', p_command_id::text, true
  );
  perform vortex_record.append_record_lifecycle_effect_internal(
    'restored', storage_row.storage_contract_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, null
  );
  perform pg_catalog.set_config('vortex_record.lifecycle_command_id', '', true);

  policy_value := vortex_record.lock_record_recovery_policy_internal(
    (context_value ->> 'organizationId')::uuid,
    storage_row.storage_contract_id,
    case when storage_row.storage_scope = 'application_contained'
      then (context_value ->> 'applicationRootId')::uuid else null end
  );
  refusal_reason := case
    when policy_value is null then 'policy_unavailable'
    when policy_value ->> 'action' is distinct from 'delete' then 'recovery_action_ineligible'
    when (policy_value ->> 'policyRevision')::bigint
      is distinct from p_recovery_policy_revision then 'policy_revision_stale'
    else null end;
  if refusal_reason is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'recovery_ineligible',
      'recoveryReason', refusal_reason,
      'governingPolicyRevision', policy_value -> 'policyRevision',
      'correlationId', correlation_value
    );
  end if;

  return vortex_record.prepare_record_lifecycle_totals_internal(
    'restore', p_record_type_id, p_record_id, p_command_id, null
  );
end
$function$;

-- Protected restore terminal writer, in the preflight's transaction.
create function vortex_record.finalize_protected_record_restore(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb,
  p_due_transitions jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  receipt vortex_record.record_lifecycle_command_receipts%rowtype;
  preparation jsonb;
  revisions jsonb;
  restored_revision bigint;
begin
  context_value := vortex_access.validated_human_request_context();
  select stored.* into receipt
  from vortex_record.record_lifecycle_command_receipts as stored
  where stored.organization_id = (context_value ->> 'organizationId')::uuid
    and stored.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and stored.command_id = p_command_id
  for update;
  if not found
    or receipt.state is distinct from 'pending'
    or receipt.operation is distinct from 'restore'
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.record_id is distinct from p_record_id
    or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number then
    raise exception using errcode = '55000',
      message = 'Protected record restore is not prepared';
  end if;

  preparation := vortex_record.prepare_record_lifecycle_totals_internal(
    'restore', p_record_type_id, p_record_id, p_command_id, null
  );
  if preparation ->> 'outcome' is distinct from 'prepared'
    or (
      select (item.value ->> 'concurrencyNumber')::bigint
      from pg_catalog.jsonb_array_elements(preparation -> 'records') as item(value)
      where item.value ->> 'recordKey' = 'root'
    ) is distinct from p_expected_concurrency_number + 1 then
    raise exception using errcode = '40001',
      message = 'Protected record restore closure changed';
  end if;
  revisions := vortex_record.apply_record_lifecycle_generated_values_internal(
    preparation, true, p_mutations, p_due_transitions
  );
  select (item.value ->> 'concurrencyNumber')::bigint into strict restored_revision
  from pg_catalog.jsonb_array_elements(revisions) as item(value)
  where item.value ->> 'recordKey' = 'root';

  perform vortex_record.append_record_lifecycle_activity_internal(
    receipt.activity_id, 'restore', array[p_record_id]::uuid[]
  );

  update vortex_record.record_lifecycle_command_receipts as stored
  set state = 'completed',
    completed_concurrency_number = restored_revision,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = receipt.organization_id
    and stored.application_root_id = receipt.application_root_id
    and stored.actor_organization_account_id = receipt.actor_organization_account_id
    and stored.command_id = receipt.command_id
    and stored.state = 'pending';
  if not found then
    raise exception using errcode = '40001',
      message = 'Protected record restore receipt is stale';
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'restored',
    'recordId', p_record_id,
    'concurrencyNumber', restored_revision,
    'correlationId', context_value -> 'correlationId',
    'replayed', false
  );
end
$function$;

revoke all on function
  vortex_record.record_lifecycle_command_fingerprint_internal(uuid, text, uuid, uuid, bigint),
  vortex_record.assert_record_lifecycle_receipt_completed_internal(),
  vortex_record.append_record_lifecycle_effect_internal(text, uuid, uuid, uuid, bigint, uuid),
  vortex_record.relationship_total_source_is_retained_internal(jsonb, uuid, uuid, uuid, uuid),
  vortex_record.record_lifecycle_total_closure_internal(jsonb, text, uuid, uuid, uuid),
  vortex_record.prepare_record_lifecycle_totals_internal(text, uuid, uuid, uuid, jsonb),
  vortex_record.record_lifecycle_current_revision_internal(uuid, uuid),
  vortex_record.record_lifecycle_receipt_outcome_internal(uuid, text, text),
  vortex_record.apply_record_lifecycle_generated_values_internal(jsonb, boolean, jsonb, jsonb),
  vortex_record.prepare_protected_record_delete(uuid, uuid, uuid, bigint, uuid, uuid),
  vortex_record.finalize_protected_record_delete(uuid, uuid, uuid, bigint, jsonb, jsonb),
  vortex_record.prepare_protected_record_restore(uuid, uuid, uuid, bigint, bigint, uuid),
  vortex_record.finalize_protected_record_restore(uuid, uuid, uuid, bigint, jsonb, jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function
  vortex_record.prepare_protected_record_delete(uuid, uuid, uuid, bigint, uuid, uuid),
  vortex_record.finalize_protected_record_delete(uuid, uuid, uuid, bigint, jsonb, jsonb),
  vortex_record.prepare_protected_record_restore(uuid, uuid, uuid, bigint, bigint, uuid),
  vortex_record.finalize_protected_record_restore(uuid, uuid, uuid, bigint, jsonb, jsonb)
to vortex_runtime;

comment on table vortex_record.record_lifecycle_command_receipts is
  'Private scoped idempotency receipts for protected delete/restore commands; a pending receipt cannot reach commit.';
comment on table vortex_record.record_lifecycle_command_effects is
  'Private identity-only journal of the records one lifecycle command deleted, cleared or restored; it holds no business values.';
comment on function vortex_record.prepare_protected_record_delete(uuid, uuid, uuid, bigint, uuid, uuid) is
  'Protected delete preflight: receipt, recursive soft delete and the locked dependency-total closure of every affected parent.';
comment on function vortex_record.finalize_protected_record_delete(uuid, uuid, uuid, bigint, jsonb, jsonb) is
  'Protected delete writer: generated parent values and due metadata, deleted-tree due cancellation, standard Events, Activity and receipt in the preflight transaction.';
comment on function vortex_record.prepare_protected_record_restore(uuid, uuid, uuid, bigint, bigint, uuid) is
  'Protected restore preflight: receipt, restore primitive, share-locked recovery-policy check and the locked dependency-total closure.';
comment on function vortex_record.finalize_protected_record_restore(uuid, uuid, uuid, bigint, jsonb, jsonb) is
  'Protected restore writer: refreshed generated values and due metadata of the record and its parents, journalled effect, Activity and receipt in the preflight transaction.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
