-- #49: one protected, recoverable parent delete composed with #48's concrete
-- relationship totals inside a single request transaction.
--
-- Shape.  There is no second delete engine and no second permission evaluator.
-- `vortex_record.soft_delete_record_recursive_internal` remains the sole
-- incoming-policy traversal; it is replaced in place only to journal the
-- effects it already applies. Its policy, refusals, hidden-child skip rules,
-- cycle refusal, lock order, mutations and recovery semantics remain unchanged
-- from 20260913030000:1039-1248. The surviving affected-record set is derived
-- exclusively from that private journal, never from a caller argument.
--
-- Transaction.  `prepare_protected_parent_delete` is deliberately mutating: it
-- opens a scoped pending receipt, runs the one traversal, journals its effects
-- and prepares the totals closure through the existing preparation engine's
-- adapter-private delete overload.  `finalize_protected_parent_delete` repeats
-- that relationship-total preparation -- and only that, never the traversal,
-- which runs exactly once -- then applies the generated parent values, appends
-- the Activity and the Event, and completes the receipt.  A deferred constraint
-- trigger forbids a pending receipt at commit, so a prepared-but-unfinalized
-- command can never commit.  Every refusal after the traversal is undone by an
-- internal subtransaction before the refusal is returned, so a refusal leaves
-- no row, edge, cleared link, revision, generated value, Activity, Event or
-- journal effect behind.
--
-- Lock order.  Physical locks are taken in exactly two documented stages, in
-- the orders the existing engines already use:
--   1. the lifecycle traversal's incoming-edge order
--      (from_storage_contract_id, from_record_id, relationship_id), which locks
--      the named parent's affected children and then the parent row
--      (20260913030000:1119);
--   2. the totals closure's canonical concrete identity order
--      (storageContractId, recordId) over surviving affected records
--      (20260914013000:435-450).
-- Discovery order inside the delete closure is deterministic
-- (effect_sequence, relationshipId, to_storage_contract_id, to_record_id) but
-- takes no locks; all locking happens in stage 2's canonical order.
--
-- Stale-value honesty.  A surviving affected record whose generated values this
-- command cannot authoritatively recompute is refused with
-- `unsupported_relationship_total_save`, following 20260914013000:818-900,
-- rather than written stale.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
grant create on schema vortex_record to postgres;
reset role;

-- The closed Activity composer is owned by postgres (20260913115000:59-71) and
-- is replaced here as that owner.  This is a strict superset: every existing
-- validation, the Application-context requirement, the private Activity append
-- and its stale-entry refusal are unchanged, and `create or replace` preserves
-- the existing owner and the existing revoke/grant at 20260913115000:126-132.
-- The only additions are the `delete` operation and its `delete_record` action.
create or replace function vortex_record.append_base_save_activity_internal(
  p_activity_id uuid,
  p_operation text,
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
    or p_operation not in ('create', 'update', 'delete')
    or p_subject_id is null
    or p_subject_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_field_ids is null
    or pg_catalog.array_position(p_changed_field_ids, null::uuid) is not null
    or p_changed_field_ids is distinct from (
      select coalesce(pg_catalog.array_agg(value order by value), array[]::uuid[])
      from (select distinct value
        from pg_catalog.unnest(p_changed_field_ids) as item(value)) as canonical
    )
    or p_outcome not in ('completed', 'refused') then
    raise exception using errcode = '22023',
      message = 'Record save Activity input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501',
      message = 'Record save Activity requires an Application context';
  end if;
  append_result := vortex_activity.append_organization_activity_entry(
    (context_value ->> 'organizationId')::uuid,
    p_activity_id, occurred_at_value, 'organization_account',
    (context_value ->> 'organizationAccountId')::uuid,
    case p_operation
      when 'create' then 'create_record'
      when 'delete' then 'delete_record'
      else 'update_record' end,
    array[p_subject_id]::uuid[], p_changed_field_ids, 'web',
    (context_value ->> 'correlationId')::uuid, p_outcome
  );
  if append_result is distinct from 'inserted' then
    raise exception using errcode = '40001',
      message = 'Record save Activity is stale';
  end if;
  return occurred_at_value;
end
$function$;

set local role vortex_record_owner;
revoke create on schema vortex_record from postgres;
reset role;
set local role vortex_record_adapter;

-- Private scoped idempotency receipt for the one protected parent delete. It
-- mirrors vortex_record.save_command_receipts (20260913115000:13-57): the same
-- organization/application/actor/command scope, the same fingerprint shape and
-- the same pending/completed lifecycle.
create table vortex_record.delete_command_receipts (
  organization_id uuid not null,
  application_root_id uuid not null,
  actor_organization_account_id uuid not null,
  command_id uuid not null,
  command_fingerprint text not null,
  record_type_id uuid not null,
  record_id uuid not null,
  expected_concurrency_number bigint not null,
  activity_id uuid not null,
  state text not null,
  completed_concurrency_number bigint,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  completed_at timestamptz,
  constraint delete_command_receipts_pk primary key (
    organization_id, application_root_id,
    actor_organization_account_id, command_id
  ),
  constraint delete_command_receipts_fingerprint_valid check (
    command_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint delete_command_receipts_revision_valid check (
    expected_concurrency_number between 1 and 9007199254740990
  ),
  constraint delete_command_receipts_state_valid check (
    state in ('pending', 'completed')
  ),
  constraint delete_command_receipts_result_complete check (
    (state = 'pending' and completed_concurrency_number is null
      and completed_at is null)
    or
    (state = 'completed'
      and completed_concurrency_number between 1 and 9007199254740991
      and completed_at is not null)
  )
);

-- Private effect journal for one pending delete command. It is written only by
-- the sole lifecycle traversal and is the only trusted source of the affected
-- record set: no caller can supply, extend or observe a deleted identity.
create table vortex_record.delete_command_effects (
  organization_id uuid not null,
  application_root_id uuid not null,
  actor_organization_account_id uuid not null,
  command_id uuid not null,
  effect_sequence integer not null,
  effect_kind text not null,
  storage_contract_id uuid not null,
  record_type_id uuid not null,
  record_id uuid not null,
  pre_concurrency_number bigint not null,
  post_concurrency_number bigint not null,
  relationship_id uuid,
  source_field_id uuid,
  previous_value jsonb,
  field_values jsonb,
  constraint delete_command_effects_pk primary key (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, effect_sequence
  ),
  constraint delete_command_effects_receipt_fk foreign key (
    organization_id, application_root_id, actor_organization_account_id,
    command_id
  ) references vortex_record.delete_command_receipts (
    organization_id, application_root_id, actor_organization_account_id,
    command_id
  ) on delete cascade,
  constraint delete_command_effects_kind_valid check (
    effect_kind in ('soft_deleted', 'optional_cleared')
  ),
  constraint delete_command_effects_revision_valid check (
    pre_concurrency_number between 1 and 9007199254740990
    and post_concurrency_number = pre_concurrency_number + 1
  ),
  constraint delete_command_effects_shape_valid check (
    (effect_kind = 'soft_deleted' and relationship_id is null
      and source_field_id is null and previous_value is null
      and pg_catalog.jsonb_typeof(field_values) = 'object')
    or
    (effect_kind = 'optional_cleared' and relationship_id is not null
      and source_field_id is not null
      and pg_catalog.jsonb_typeof(previous_value) = 'object'
      and field_values is null)
  )
);

alter table vortex_record.delete_command_receipts enable row level security;
alter table vortex_record.delete_command_receipts force row level security;
create policy delete_command_receipts_adapter
  on vortex_record.delete_command_receipts to vortex_record_adapter
  using (true) with check (true);
alter table vortex_record.delete_command_receipts owner to vortex_record_adapter;
alter table vortex_record.delete_command_effects enable row level security;
alter table vortex_record.delete_command_effects force row level security;
create policy delete_command_effects_adapter
  on vortex_record.delete_command_effects to vortex_record_adapter
  using (true) with check (true);
alter table vortex_record.delete_command_effects owner to vortex_record_adapter;
revoke all on table vortex_record.delete_command_receipts,
  vortex_record.delete_command_effects
  from public, anon, authenticated, service_role, vortex_runtime,
    vortex_request, vortex_record_owner, vortex_module_owner;

create function vortex_record.delete_command_fingerprint_internal(
  p_command_id uuid,
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
        'operation', 'delete',
        'recordTypeId', p_record_type_id,
        'recordId', p_record_id,
        'expectedConcurrencyNumber', p_expected_concurrency_number
      )::text, 'UTF8'
    )), 'hex'
  )
$function$;

-- The deferred completion invariant. It runs as its adapter owner because
-- deferred constraint triggers fire at commit under whatever role the request
-- transaction then holds, and that role has no access to the private journal.
create function vortex_record.assert_delete_receipt_completed_internal()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if exists (
    select 1 from vortex_record.delete_command_receipts as receipt
    where receipt.organization_id = new.organization_id
      and receipt.application_root_id = new.application_root_id
      and receipt.actor_organization_account_id =
        new.actor_organization_account_id
      and receipt.command_id = new.command_id
      and receipt.state = 'pending'
  ) then
    raise exception using errcode = '23514',
      message = 'Protected parent delete preparation was not finalized';
  end if;
  return null;
end
$function$;

create constraint trigger delete_command_receipts_completed_at_commit
after insert or update on vortex_record.delete_command_receipts
deferrable initially deferred
for each row
execute function vortex_record.assert_delete_receipt_completed_internal();

-- Journals one effect of the sole lifecycle traversal. It writes nothing when
-- no delete command is bound to this transaction, so the existing private
-- primitive keeps its current behaviour for every other caller. Every value it
-- stores is one the traversal had already loaded under its own row lock; none
-- of it can be supplied, extended or observed by a caller.
create function vortex_record.append_pending_delete_effect_internal(
  p_effect_kind text,
  p_storage_contract_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_pre_concurrency_number bigint,
  p_relationship_id uuid default null,
  p_source_field_id uuid default null,
  p_previous_value jsonb default null,
  p_field_values jsonb default null
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  context_value jsonb;
  bound_command_id uuid;
  next_sequence integer;
begin
  bound_command_id := pg_catalog.nullif(
    pg_catalog.current_setting('vortex_record.pending_delete_command_id', true), ''
  )::uuid;
  if bound_command_id is null then
    return;
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not exists (
    select 1 from vortex_record.delete_command_receipts as receipt
    where receipt.organization_id = (context_value ->> 'organizationId')::uuid
      and receipt.application_root_id =
        (context_value ->> 'applicationRootId')::uuid
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_id = bound_command_id
      and receipt.state = 'pending'
  ) then
    raise exception using errcode = '42501',
      message = 'Delete effect journal is unavailable';
  end if;
  select coalesce(pg_catalog.max(effect.effect_sequence), 0) + 1
  into next_sequence
  from vortex_record.delete_command_effects as effect
  where effect.organization_id = (context_value ->> 'organizationId')::uuid
    and effect.application_root_id =
      (context_value ->> 'applicationRootId')::uuid
    and effect.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and effect.command_id = bound_command_id;
  insert into vortex_record.delete_command_effects (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, effect_sequence, effect_kind, storage_contract_id,
    record_type_id, record_id, pre_concurrency_number, post_concurrency_number,
    relationship_id, source_field_id, previous_value, field_values
  ) values (
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'applicationRootId')::uuid,
    (context_value ->> 'organizationAccountId')::uuid,
    bound_command_id, next_sequence, p_effect_kind, p_storage_contract_id,
    p_record_type_id, p_record_id, p_pre_concurrency_number,
    p_pre_concurrency_number + 1, p_relationship_id, p_source_field_id,
    p_previous_value, p_field_values
  );
end
$function$;

-- The one incoming-policy traversal, replaced in place only to journal the
-- effects it already applies. Its guards, refusals, cycle checks, hidden-child
-- skips, ownership requirements, edge order, row locks, mutations and recovery
-- fields remain unchanged from 20260913030000:1039-1248. The complete delta is:
--   * one new local, `deleted_field_values`, which retains the target's own
--     already-loaded pre-delete field values before `record_fact` is reused for
--     each incoming source. Nothing is read that the traversal did not already
--     read under its own lock;
--   * an optional-clear effect journalled immediately before the existing
--     writer, so the prior link value is retained;
--   * a soft-delete effect journalled after its successful revision-checked
--     update, carrying those retained pre-delete values.
-- No policy, refusal, skip rule, ordering or restore-fidelity field changes.
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
  deleted_field_values jsonb;
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
  deleted_field_values := pg_catalog.jsonb_strip_nulls(
    coalesce(record_fact -> 'fieldValues', '{}'::jsonb)
  );
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
      perform vortex_record.append_pending_delete_effect_internal(
        'optional_cleared', incoming.from_storage_contract_id,
        source_catalogue.record_type_id, incoming.from_record_id,
        source_concurrency, incoming.relationship_id, incoming.source_field_id,
        source_link_value
      );
      perform vortex_record.write_relationship_value_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        incoming.relationship_id, 'null'::jsonb, true
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
  perform vortex_record.append_pending_delete_effect_internal(
    'soft_deleted', (meta ->> 'storageContractId')::uuid,
    p_record_type_id, p_record_id, p_expected_concurrency_number,
    null, null, null, deleted_field_values
  );
  application_scope := case when meta ->> 'storageScope' = 'application_contained'
    then (context_value ->> 'applicationRootId')::uuid else null end;
  perform vortex_record.bump_record_data_version_internal(
    (context_value ->> 'organizationId')::uuid,
    (meta ->> 'storageContractId')::uuid, application_scope
  );
end
$function$;

-- The single derivation of this command's deleted-record set. Every consumer
-- reads it from here, so the set is always the scoped pending journal the one
-- lifecycle traversal wrote and can never originate with a caller.
create function vortex_record.delete_command_deleted_records_internal(
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
  deleted_keys jsonb;
begin
  if p_command_id is null then return null; end if;
  context_value := vortex_access.validated_human_request_context();
  if not exists (
    select 1 from vortex_record.delete_command_receipts as receipt
    where receipt.organization_id = (context_value ->> 'organizationId')::uuid
      and receipt.application_root_id =
        (context_value ->> 'applicationRootId')::uuid
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_id = p_command_id
      and receipt.state = 'pending'
  ) then
    return null;
  end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'recordTypeId', pg_catalog.lower(effect.record_type_id::text),
    'recordId', pg_catalog.lower(effect.record_id::text),
    'storageContractId', pg_catalog.lower(effect.storage_contract_id::text),
    'preConcurrencyNumber', effect.pre_concurrency_number,
    'postConcurrencyNumber', effect.post_concurrency_number
  ) order by effect.effect_sequence), '[]'::jsonb) into deleted_keys
  from vortex_record.delete_command_effects as effect
  where effect.organization_id = (context_value ->> 'organizationId')::uuid
    and effect.application_root_id =
      (context_value ->> 'applicationRootId')::uuid
    and effect.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and effect.command_id = p_command_id
    and effect.effect_kind = 'soft_deleted';
  if pg_catalog.jsonb_array_length(deleted_keys) = 0 then return null; end if;
  return deleted_keys;
end
$function$;

-- The delete-mode closure. Its roots come only from the private journal that
-- the one lifecycle traversal wrote:
--   * every record this command soft deleted contributes the total-bearing
--     targets of its outbound to-one relationships;
--   * every child whose optional link this command cleared contributes itself,
--     because its own declared generated values may depend on that link. The
--     former target of that link is not a seed: this traversal only clears links
--     that point at the record it is deleting, so that target is always
--     journalled as deleted. The prior link value the traversal recorded under
--     the source row lock is retained as trusted effect evidence.
-- Any record that this command deleted is excluded from the surviving set. Each
-- surviving root is then expanded by the established dependency walk
-- (20260914013000:179-319); this is a closure adapter, never a second cascade.
create function vortex_record.delete_command_closure_internal(
  p_catalogue jsonb,
  p_command_id uuid,
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
  context_value jsonb;
  context_organization_id uuid;
  context_application_id uuid;
  context_actor_id uuid;
  root_type jsonb;
  deleted_keys jsonb;
  seeds jsonb := '[]'::jsonb;
  seed jsonb;
  seed_key text;
  effect_row vortex_record.delete_command_effects%rowtype;
  source_type jsonb;
  relationship jsonb;
  target_type jsonb;
  edge_row vortex_record.relationship_edges%rowtype;
  closure_value jsonb;
  closure_record jsonb;
  records jsonb;
  signatures jsonb := '[]'::jsonb;
  root_field_values jsonb;
begin
  if p_command_id is null or p_record_type_id is null or p_record_id is null
    or pg_catalog.jsonb_typeof(p_catalogue -> 'recordTypes') <> 'array' then
    return null;
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;
  context_actor_id := (context_value ->> 'organizationAccountId')::uuid;
  if not exists (
    select 1 from vortex_record.delete_command_receipts as receipt
    where receipt.organization_id = context_organization_id
      and receipt.application_root_id = context_application_id
      and receipt.actor_organization_account_id = context_actor_id
      and receipt.command_id = p_command_id
      and receipt.state = 'pending'
  ) then
    return null;
  end if;

  select item.value into root_type
  from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') =
    pg_catalog.lower(p_record_type_id::text);
  if root_type is null then return null; end if;

  deleted_keys := vortex_record.delete_command_deleted_records_internal(p_command_id);
  if deleted_keys is null then return null; end if;
  -- The named parent's own journalled effect is what gives the closure root its
  -- trusted pre-delete values, so its absence is a refusal, never a guess.
  select effect.field_values into root_field_values
  from vortex_record.delete_command_effects as effect
  where effect.organization_id = context_organization_id
    and effect.application_root_id = context_application_id
    and effect.actor_organization_account_id = context_actor_id
    and effect.command_id = p_command_id
    and effect.effect_kind = 'soft_deleted'
    and effect.record_type_id = p_record_type_id
    and effect.record_id = p_record_id;
  if pg_catalog.jsonb_typeof(root_field_values) <> 'object' then return null; end if;

  -- Deterministic discovery order: effect sequence, then relationship, then
  -- concrete target identity. No lock is taken here.
  for effect_row in
    select effect.* from vortex_record.delete_command_effects as effect
    where effect.organization_id = context_organization_id
      and effect.application_root_id = context_application_id
      and effect.actor_organization_account_id = context_actor_id
      and effect.command_id = p_command_id
    order by effect.effect_sequence
  loop
    if effect_row.effect_kind = 'optional_cleared' then
      -- The changed child survives and keeps declared generated values that may
      -- depend on the link this command cleared, so it is a closure seed. Its
      -- former target is not: this traversal only clears links that point at the
      -- record it is deleting, so that target is always journalled as deleted
      -- and can never be a surviving total root. The journalled prior link value
      -- is retained as trusted effect evidence, not as a seed.
      seeds := seeds || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'recordTypeId', pg_catalog.lower(effect_row.record_type_id::text),
        'recordId', pg_catalog.lower(effect_row.record_id::text)
      ));
      continue;
    end if;
    select item.value into source_type
    from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
    where pg_catalog.lower(item.value ->> 'recordTypeId') =
      pg_catalog.lower(effect_row.record_type_id::text);
    if source_type is null then return null; end if;
    for relationship in
      select item.value
      from pg_catalog.jsonb_array_elements(source_type -> 'relationships') as item(value)
      where item.value ? 'toRecordType'
        and item.value ->> 'cardinality' in ('one_to_one', 'many_to_one')
      order by item.value ->> 'relationshipId'
    loop
      select item.value into target_type
      from pg_catalog.jsonb_array_elements(p_catalogue -> 'recordTypes') as item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship #>> '{toRecordType,recordTypeId}');
      if target_type is null then continue; end if;
      if not exists (
        select 1
        from pg_catalog.jsonb_array_elements(target_type -> 'fields') as field(value)
        where field.value ->> 'type' = 'total'
          and pg_catalog.lower(field.value #>> '{settings,relationshipId}') =
            pg_catalog.lower(relationship ->> 'relationshipId')
      ) then
        continue;
      end if;
      for edge_row in
        select edge.* from vortex_record.relationship_edges as edge
        where edge.relationship_id = (relationship ->> 'relationshipId')::uuid
          and edge.from_storage_contract_id = effect_row.storage_contract_id
          and edge.from_record_id = effect_row.record_id
          and edge.to_storage_contract_id = (target_type ->> 'storageContractId')::uuid
          and edge.from_organisation_id = context_organization_id
          and edge.to_organisation_id = context_organization_id
          and edge.from_application_root_id is not distinct from case
            when source_type ->> 'storageScope' = 'application_contained'
              then context_application_id else null end
          and edge.to_application_root_id is not distinct from case
            when target_type ->> 'storageScope' = 'application_contained'
              then context_application_id else null end
        order by edge.to_storage_contract_id, edge.to_record_id
      loop
        seeds := seeds || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'recordTypeId', pg_catalog.lower(target_type ->> 'recordTypeId'),
          'recordId', pg_catalog.lower(edge_row.to_record_id::text)
        ));
      end loop;
    end loop;
  end loop;

  -- The deleted named parent is carried as the closure root so the delivered
  -- evaluator keeps its fixed root contract. It has no concrete identity here:
  -- it is never locked, never a total source and never a parent mutation. Its
  -- values are the trusted pre-delete ones the traversal journalled, so the
  -- evaluator sees a complete record and does not reject the command over the
  -- root's own required ordinary fields.
  records := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
    'recordKey', 'root',
    'recordType', root_type - 'moduleReleaseRevision',
    'recordTypeId', p_record_type_id,
    'storageContractId', (root_type ->> 'storageContractId')::uuid,
    'existingValues', root_field_values
  ));

  for seed in
    select item.value
    from pg_catalog.jsonb_array_elements(seeds) with ordinality as item(value, ordinality)
    order by item.ordinality
  loop
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(deleted_keys) as item(value)
      where item.value ->> 'recordTypeId' = seed ->> 'recordTypeId'
        and item.value ->> 'recordId' = seed ->> 'recordId'
    ) then
      continue;
    end if;
    seed_key := pg_catalog.lower(seed ->> 'recordTypeId') || ':' ||
      pg_catalog.lower(seed ->> 'recordId');
    if exists (
      select 1 from pg_catalog.jsonb_array_elements(records) as item(value)
      where item.value ->> 'recordKey' = seed_key
    ) then
      continue;
    end if;
    closure_value := vortex_record.discover_relationship_total_closure_internal(
      p_catalogue, 'update', (seed ->> 'recordTypeId')::uuid,
      (seed ->> 'recordId')::uuid, '{}'::jsonb
    );
    if closure_value is null then return null; end if;
    for closure_record in
      select item.value
      from pg_catalog.jsonb_array_elements(closure_value -> 'records') as item(value)
      order by item.value ->> 'recordKey'
    loop
      if closure_record ->> 'recordKey' = 'root' then
        closure_record := closure_record ||
          pg_catalog.jsonb_build_object('recordKey', seed_key);
      end if;
      if exists (
        select 1 from pg_catalog.jsonb_array_elements(deleted_keys) as item(value)
        where item.value ->> 'recordTypeId' = closure_record ->> 'recordTypeId'
          and item.value ->> 'recordId' = closure_record ->> 'recordId'
      ) or exists (
        select 1 from pg_catalog.jsonb_array_elements(records) as item(value)
        where item.value ->> 'recordKey' = closure_record ->> 'recordKey'
      ) then
        continue;
      end if;
      records := records || pg_catalog.jsonb_build_array(closure_record);
    end loop;
    signatures := signatures || coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'from', case when item.value ->> 'from' = 'root'
          then seed_key else item.value ->> 'from' end,
        'relationshipId', item.value -> 'relationshipId',
        'to', case when item.value ->> 'to' = 'root'
          then seed_key else item.value ->> 'to' end
      ) order by item.value::text collate "C")
      from pg_catalog.jsonb_array_elements(closure_value -> 'signatures') as item(value)
    ), '[]'::jsonb);
  end loop;

  return pg_catalog.jsonb_build_object(
    'records', records,
    'deletedRecordKeys', deleted_keys,
    'signatures', coalesce((
      select pg_catalog.jsonb_agg(distinct item.value order by item.value)
      from pg_catalog.jsonb_array_elements(signatures) as item(value)
    ), '[]'::jsonb)
  );
end
$function$;

-- The delete mode of the existing relationship-total preparation engine, as an
-- adapter-private overload of `prepare_relationship_total_save`. Its body is the
-- bounded clean re-derivation of 20260914013000:321-618: the canonical concrete
-- lock order, the re-read/restart protocol, the root revision check, the
-- physical edge scope filters and the declared-source materialization are
-- preserved text-for-text. The create/update-only branches (receipt deferral,
-- submitted values, the root's proposed membership and the update access
-- re-check that the traversal already performs per affected record) do not
-- apply to a delete and are fenced off by the operation guard.
--
-- The ninth argument carries this command's deleted-record set. It is
-- adapter-private -- this overload is granted to no request role, and the only
-- callers are the two adapter-owned protected functions below, which fill it
-- from `delete_command_deleted_records_internal`, that is, from the scoped
-- pending journal the one lifecycle traversal wrote. It is then re-derived here
-- and compared, so a value that did not come from that journal is refused. No
-- runtime or caller identity can reach it.
create function vortex_record.prepare_relationship_total_save(
  p_command_id uuid,
  p_operation text,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_submitted_values jsonb,
  p_selected_group_id uuid,
  p_activity_id uuid,
  p_deleted_records jsonb
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
  root_type jsonb;
  before_closure jsonb;
  after_closure jsonb;
  record_value jsonb;
  locked_value jsonb;
  prepared_records jsonb := '[]'::jsonb;
  prepared_record jsonb;
  total_field jsonb;
  relationship_value jsonb;
  source_type jsonb;
  source_records jsonb;
  edge_value vortex_record.relationship_edges%rowtype;
  source_snapshot jsonb;
  source_key text;
  journal_records jsonb;
begin
  -- The operation guard admits only `delete` and fences the deleted-record
  -- input to it, so this overload can never serve a create or update.
  if p_operation is distinct from 'delete'
    or p_command_id is null or p_record_type_id is null or p_record_id is null
    or p_selected_group_id is not null
    or p_activity_id is null
    or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_submitted_values is distinct from '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_deleted_records) <> 'array'
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990 then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;
  context_value := vortex_access.validated_human_request_context();
  context_organization_id := (context_value ->> 'organizationId')::uuid;
  context_application_id := (context_value ->> 'applicationRootId')::uuid;

  -- Never accept the supplied set as authority: re-derive it from the scoped
  -- pending journal and refuse anything that differs.
  journal_records := vortex_record.delete_command_deleted_records_internal(p_command_id);
  if journal_records is null or p_deleted_records is distinct from journal_records then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  catalogue := vortex_record.relationship_total_catalogue_internal();
  select item.value into root_type
  from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') as item(value)
  where pg_catalog.lower(item.value ->> 'recordTypeId') =
    pg_catalog.lower(p_record_type_id::text);
  if root_type is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  -- The canonical root revision check, in the only form a delete can take: the
  -- named parent's pre-delete revision is the one the traversal journalled.
  if (select (item.value ->> 'preConcurrencyNumber')::bigint
      from pg_catalog.jsonb_array_elements(journal_records) as item(value)
      where item.value ->> 'recordTypeId' = pg_catalog.lower(p_record_type_id::text)
        and item.value ->> 'recordId' = pg_catalog.lower(p_record_id::text))
    is distinct from p_expected_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
    );
  end if;

  before_closure := vortex_record.delete_command_closure_internal(
    catalogue, p_command_id, p_record_type_id, p_record_id
  );
  if before_closure is null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_unavailable'
    );
  end if;

  -- Dynamic physical rows are locked in one canonical concrete identity order.
  for record_value in
    select item.value
    from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value)
    where item.value ? 'recordId'
    order by (item.value ->> 'storageContractId')::uuid,
      (item.value ->> 'recordId')::uuid
  loop
    locked_value := vortex_record.relationship_total_record_snapshot_internal(
      catalogue,
      (record_value ->> 'recordTypeId')::uuid,
      (record_value ->> 'recordId')::uuid,
      true
    );
    if locked_value is null then
      return pg_catalog.jsonb_build_object('outcome', 'restart');
    end if;
  end loop;

  after_closure := vortex_record.delete_command_closure_internal(
    catalogue, p_command_id, p_record_type_id, p_record_id
  );
  if after_closure is null then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;
  if (before_closure -> 'signatures') is distinct from (after_closure -> 'signatures')
    or (before_closure -> 'deletedRecordKeys')
      is distinct from (after_closure -> 'deletedRecordKeys')
    or (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(before_closure -> 'records') as item(value))
       is distinct from
       (select pg_catalog.jsonb_agg(item.value -> 'recordKey' order by item.value ->> 'recordKey')
        from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)) then
    return pg_catalog.jsonb_build_object('outcome', 'restart');
  end if;

  -- Stale-value honesty. Installed rules are not applied by the delivered
  -- evaluator, so a surviving affected record that declares a generated value
  -- is refused rather than written stale. This follows the established
  -- unsupported refusal at 20260914013000:818-900; unlike the save path there
  -- is no outer writer left to defer to.
  if coalesce((catalogue ->> 'hasInstalledRules')::boolean, false)
    and exists (
      select 1
      from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)
      cross join lateral pg_catalog.jsonb_array_elements(
        item.value -> 'recordType' -> 'fields'
      ) as field(value)
      where item.value ->> 'recordKey' <> 'root'
        and field.value ->> 'type' in ('total', 'calculation')
    ) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'unsupported_relationship_total_save'
    );
  end if;

  -- Materialize only the declared aggregate sources for each locked surviving
  -- affected record.
  for prepared_record in
    select item.value
    from pg_catalog.jsonb_array_elements(after_closure -> 'records') as item(value)
    order by case when item.value ->> 'recordKey' = 'root' then 0 else 1 end,
      item.value ->> 'recordKey'
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
      select item.value into relationship_value
      from pg_catalog.jsonb_array_elements(catalogue -> 'relationships') as item(value)
      where pg_catalog.lower(item.value ->> 'relationshipId') =
        pg_catalog.lower(total_field #>> '{settings,relationshipId}')
        and pg_catalog.lower(item.value #>> '{toRecordType,recordTypeId}') =
          pg_catalog.lower(prepared_record ->> 'recordTypeId');
      if relationship_value is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(prepared_record -> 'relationshipSources') as source(value)
        where source.value ->> 'relationshipId' = relationship_value ->> 'relationshipId'
      ) then
        continue;
      end if;
      select item.value into source_type
      from pg_catalog.jsonb_array_elements(catalogue -> 'recordTypes') as item(value)
      where pg_catalog.lower(item.value ->> 'recordTypeId') =
        pg_catalog.lower(relationship_value ->> 'fromRecordTypeId');
      if source_type is null then
        return pg_catalog.jsonb_build_object('outcome', 'refused');
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
        -- A record this command soft deleted is no longer an active member of
        -- any surviving parent's declared aggregate.
        if exists (
          select 1
          from pg_catalog.jsonb_array_elements(after_closure -> 'deletedRecordKeys') as deleted(value)
          where deleted.value ->> 'storageContractId' =
              edge_value.from_storage_contract_id::text
            and deleted.value ->> 'recordId' = edge_value.from_record_id::text
        ) then
          continue;
        end if;
        source_snapshot := vortex_record.relationship_total_record_snapshot_internal(
          catalogue, (relationship_value ->> 'fromRecordTypeId')::uuid,
          edge_value.from_record_id, false
        );
        if source_snapshot is null then
          return pg_catalog.jsonb_build_object('outcome', 'restart');
        end if;
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
    'records', prepared_records,
    'deletedRecordKeys', after_closure -> 'deletedRecordKeys'
  );
exception
  when no_data_found or too_many_rows or check_violation or invalid_text_representation then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
end
$function$;

-- The protected preparation. It is deliberately mutating: it opens the scoped
-- pending receipt, runs the one lifecycle traversal under the journal binding,
-- and prepares the surviving affected closure. Every refusal that follows the
-- traversal is undone by the internal subtransaction before it is returned, so
-- a refusal leaves nothing behind, and the deferred receipt invariant makes a
-- prepared-but-unfinalized command impossible to commit.
create function vortex_record.prepare_protected_parent_delete(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
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
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  fingerprint_value text;
  receipt vortex_record.delete_command_receipts%rowtype;
  inserted_command_id uuid;
  deletion_result jsonb;
  preparation jsonb;
  refusal_value jsonb;
begin
  if p_command_id is null or p_command_id = nil_uuid
    or p_record_type_id is null or p_record_type_id = nil_uuid
    or p_record_id is null or p_record_id = nil_uuid
    or p_activity_id is null or p_activity_id = nil_uuid
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
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  fingerprint_value := vortex_record.delete_command_fingerprint_internal(
    p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number
  );

  insert into vortex_record.delete_command_receipts (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, command_fingerprint, record_type_id, record_id,
    expected_concurrency_number, activity_id, state
  ) values (
    organization_id_value, application_root_id_value, actor_id_value,
    p_command_id, fingerprint_value, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_activity_id, 'pending'
  )
  on conflict do nothing
  returning command_id into inserted_command_id;

  if inserted_command_id is null then
    select stored.* into receipt
    from vortex_record.delete_command_receipts as stored
    where stored.organization_id = organization_id_value
      and stored.application_root_id = application_root_id_value
      and stored.actor_organization_account_id = actor_id_value
      and stored.command_id = p_command_id
    for update;
    if not found
      or receipt.command_fingerprint is distinct from fingerprint_value
      or receipt.record_type_id is distinct from p_record_type_id
      or receipt.record_id is distinct from p_record_id then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
        'correlationId', correlation_id_value
      );
    end if;
    if receipt.state is distinct from 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_id_value
      );
    end if;
    -- A completed recoverable delete is by construction no longer readable, so
    -- the base save's projection replay (20260913115000:269-284) cannot apply.
    -- The replay is bounded instead by this receipt's own organization,
    -- Application and actor scope, by the exact command fingerprint, and by the
    -- delete action still resolving against the current installation. It
    -- returns only this caller's own prior command outcome and no Record
    -- content.
    begin
      perform vortex_record.resolve_record_action_context_internal(
        p_record_type_id, 'delete'
      );
    exception when others then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', correlation_id_value
      );
    end;
    return pg_catalog.jsonb_build_object(
      'outcome', 'completed',
      'recordId', receipt.record_id,
      'concurrencyNumber', receipt.completed_concurrency_number,
      'correlationId', correlation_id_value,
      'replayed', true
    );
  end if;

  refusal_value := null;
  begin
    perform pg_catalog.set_config(
      'vortex_record.pending_delete_command_id', p_command_id::text, true
    );
    deletion_result := vortex_record.soft_delete_record_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number
    );
    perform pg_catalog.set_config(
      'vortex_record.pending_delete_command_id', '', true
    );
    if deletion_result ->> 'outcome' is distinct from 'completed' then
      refusal_value := deletion_result || pg_catalog.jsonb_build_object(
        'correlationId', correlation_id_value
      );
      raise exception using errcode = 'VX490',
        message = 'Protected parent delete is refused';
    end if;
    -- The deleted-record input is read from the scoped pending journal here and
    -- re-derived inside the preparation, so it is never a caller identity.
    preparation := vortex_record.prepare_relationship_total_save(
      p_command_id, 'delete', p_record_type_id, p_record_id,
      p_expected_concurrency_number, '{}'::jsonb, null, p_activity_id,
      vortex_record.delete_command_deleted_records_internal(p_command_id)
    );
    if preparation ->> 'outcome' = 'restart'
      or preparation ->> 'outcome' = 'conflict' then
      refusal_value := pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'correlationId', correlation_id_value
      );
      raise exception using errcode = 'VX490',
        message = 'Protected parent delete must restart';
    end if;
    if preparation ->> 'outcome' is distinct from 'prepared' then
      refusal_value := pg_catalog.jsonb_build_object(
        'outcome', 'refused',
        'reasonCode', coalesce(
          preparation ->> 'reasonCode', 'unsupported_relationship_total_save'
        ),
        'correlationId', correlation_id_value
      );
      raise exception using errcode = 'VX490',
        message = 'Protected parent delete totals are unsupported';
    end if;
  exception when sqlstate 'VX490' then
    -- Every row, edge, cleared link, revision, generated value and journal
    -- effect written above is rolled back with this subtransaction. Only the
    -- pending receipt inserted before it survives, and it is removed next.
    null;
  end;
  if refusal_value is not null then
    delete from vortex_record.delete_command_receipts
    where organization_id = organization_id_value
      and application_root_id = application_root_id_value
      and actor_organization_account_id = actor_id_value
      and command_id = p_command_id;
    return refusal_value;
  end if;
  return preparation;
end
$function$;

-- The terminal delete writer. It repeats the relationship-total preparation
-- itself -- not the lifecycle traversal, which runs exactly once, in the
-- preparation above -- so the closure identity, the revisions and the complete
-- generated-field set never depend on caller-supplied or replayable transaction
-- state (20260914013000:797-799). The repeated preparation re-derives its
-- deleted-record input from the same scoped journal and re-reads rows this
-- transaction already holds locked, so it observes no new fact and applies no
-- second cascade. It raises rather than returns on every invalid path, because
-- returning normally after a mutating preparation would attempt to commit a
-- pending journal.
create function vortex_record.finalize_protected_parent_delete(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_parent_mutations jsonb
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
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  correlation_id_value uuid;
  receipt vortex_record.delete_command_receipts%rowtype;
  preparation jsonb;
  expected_parents jsonb;
  supplied_parents jsonb;
  parent_value jsonb;
  prepared_parent jsonb;
  reduced_final_values jsonb;
  root_storage_contract_id uuid;
  event_result jsonb;
begin
  if p_occurrence_id is null or p_occurrence_id = nil_uuid
    or pg_catalog.jsonb_typeof(p_parent_mutations) <> 'array' then
    raise exception using errcode = '22023',
      message = 'Protected parent delete finalizer input is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;

  select stored.* into receipt
  from vortex_record.delete_command_receipts as stored
  where stored.organization_id = organization_id_value
    and stored.application_root_id = application_root_id_value
    and stored.actor_organization_account_id = actor_id_value
    and stored.command_id = p_command_id
  for update;
  if not found
    or receipt.state is distinct from 'pending'
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.record_id is distinct from p_record_id
    or receipt.expected_concurrency_number is distinct from p_expected_concurrency_number
    or receipt.activity_id is distinct from p_activity_id then
    raise exception using errcode = '42501',
      message = 'Protected parent delete finalizer is unavailable';
  end if;

  preparation := vortex_record.prepare_relationship_total_save(
    p_command_id, 'delete', p_record_type_id, p_record_id,
    p_expected_concurrency_number, '{}'::jsonb, null, p_activity_id,
    vortex_record.delete_command_deleted_records_internal(p_command_id)
  );
  if preparation ->> 'outcome' is distinct from 'prepared' then
    raise exception using errcode = '40001',
      message = 'Protected parent delete preparation is no longer current';
  end if;

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
  ), '[]'::jsonb) into expected_parents
  from pg_catalog.jsonb_array_elements(preparation -> 'records') as item(value)
  where item.value ->> 'recordKey' <> 'root';
  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'recordTypeId', item.value -> 'recordTypeId',
      'recordId', item.value -> 'recordId',
      'expectedConcurrencyNumber', item.value -> 'expectedConcurrencyNumber',
      'finalFieldIds', coalesce((
        select pg_catalog.jsonb_agg(field_id order by field_id collate "C")
        from pg_catalog.jsonb_object_keys(item.value -> 'finalValues') as field(field_id)
      ), '[]'::jsonb)
    ) order by item.value ->> 'recordTypeId', item.value ->> 'recordId'
  ), '[]'::jsonb) into supplied_parents
  from pg_catalog.jsonb_array_elements(p_parent_mutations) as item(value)
  where pg_catalog.jsonb_typeof(item.value) = 'object'
    and item.value ?& array[
      'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
    ]
    -- Exactly those four keys: an entry carrying anything else is not the
    -- prepared shape, so it drops out here and fails the count check below.
    and item.value - array[
      'recordTypeId', 'recordId', 'expectedConcurrencyNumber', 'finalValues'
    ] = '{}'::jsonb
    and pg_catalog.jsonb_typeof(item.value -> 'finalValues') = 'object';
  if supplied_parents is distinct from expected_parents
    or pg_catalog.jsonb_array_length(supplied_parents) <>
      pg_catalog.jsonb_array_length(p_parent_mutations) then
    raise exception using errcode = '42501',
      message = 'Protected parent delete parent mutation is invalid';
  end if;

  for parent_value in
    select item.value
    from pg_catalog.jsonb_array_elements(p_parent_mutations) as item(value)
    order by (item.value ->> 'recordTypeId')::uuid, (item.value ->> 'recordId')::uuid
  loop
    select item.value into strict prepared_parent
    from pg_catalog.jsonb_array_elements(preparation -> 'records') as item(value)
    where item.value ->> 'recordTypeId' = parent_value ->> 'recordTypeId'
      and item.value ->> 'recordId' = parent_value ->> 'recordId';
    select coalesce(
      pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb
    ) into reduced_final_values
    from pg_catalog.jsonb_each(parent_value -> 'finalValues') as entry(key, value)
    where entry.value is distinct from coalesce(
      prepared_parent -> 'existingValues' -> entry.key, 'null'::jsonb
    );
    perform vortex_record.apply_relationship_total_parent_internal(
      (parent_value ->> 'recordTypeId')::uuid,
      (parent_value ->> 'recordId')::uuid,
      (parent_value ->> 'expectedConcurrencyNumber')::bigint,
      reduced_final_values
    );
  end loop;

  perform vortex_record.append_base_save_activity_internal(
    p_activity_id, 'delete', p_record_id, array[]::uuid[], 'completed'
  );

  -- The record type is part of the key: a cascaded record could otherwise share
  -- a record identifier value with the named parent and select the wrong
  -- storage contract for the Event.
  select effect.storage_contract_id into strict root_storage_contract_id
  from vortex_record.delete_command_effects as effect
  where effect.organization_id = organization_id_value
    and effect.application_root_id = application_root_id_value
    and effect.actor_organization_account_id = actor_id_value
    and effect.command_id = p_command_id
    and effect.effect_kind = 'soft_deleted'
    and effect.record_type_id = p_record_type_id
    and effect.record_id = p_record_id;
  event_result := vortex_event.append_record_occurrences(
    root_storage_contract_id, p_record_id,
    pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'occurrenceId', p_occurrence_id,
      'descriptor', pg_catalog.jsonb_build_object(
        'kind', 'standard', 'eventKind', 'deleted',
        'recordTypeId', p_record_type_id
      ),
      'payload', pg_catalog.jsonb_build_object('kind', 'deleted')
    ))
  );
  if pg_catalog.jsonb_array_length(event_result) <> 1 then
    raise exception using errcode = '55000',
      message = 'Protected parent delete Event append failed';
  end if;

  update vortex_record.delete_command_receipts as stored
  set state = 'completed',
    completed_concurrency_number = p_expected_concurrency_number + 1,
    completed_at = pg_catalog.statement_timestamp()
  where stored.organization_id = organization_id_value
    and stored.application_root_id = application_root_id_value
    and stored.actor_organization_account_id = actor_id_value
    and stored.command_id = p_command_id
    and stored.state = 'pending';
  if not found then
    raise exception using errcode = '40001',
      message = 'Protected parent delete receipt is stale';
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'recordId', p_record_id,
    'concurrencyNumber', p_expected_concurrency_number + 1,
    'correlationId', correlation_id_value,
    'replayed', false
  );
end
$function$;

alter function vortex_record.delete_command_fingerprint_internal(uuid,uuid,uuid,bigint)
  owner to vortex_record_adapter;
alter function vortex_record.assert_delete_receipt_completed_internal()
  owner to vortex_record_adapter;
alter function vortex_record.append_pending_delete_effect_internal(
  text,uuid,uuid,uuid,bigint,uuid,uuid,jsonb,jsonb
) owner to vortex_record_adapter;
alter function vortex_record.delete_command_deleted_records_internal(uuid)
  owner to vortex_record_adapter;
alter function vortex_record.delete_command_closure_internal(jsonb,uuid,uuid,uuid)
  owner to vortex_record_adapter;
alter function vortex_record.prepare_relationship_total_save(
  uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb
) owner to vortex_record_adapter;
alter function vortex_record.prepare_protected_parent_delete(uuid,uuid,uuid,bigint,uuid)
  owner to vortex_record_adapter;
alter function vortex_record.finalize_protected_parent_delete(
  uuid,uuid,uuid,bigint,uuid,uuid,jsonb
) owner to vortex_record_adapter;

-- Everything private stays owner-only; only the two protected entry points are
-- reachable by the request runtime, exactly as the save path grants
-- prepare/save and withholds every internal (20260914013000:1003-1020). The
-- nine-argument delete overload is listed here explicitly: overloads carry
-- their own privileges, so the existing eight-argument create/update grant to
-- vortex_runtime does not reach it, and it stays adapter-private.
revoke all on function vortex_record.delete_command_fingerprint_internal(uuid,uuid,uuid,bigint),
  vortex_record.assert_delete_receipt_completed_internal(),
  vortex_record.append_pending_delete_effect_internal(text,uuid,uuid,uuid,bigint,uuid,uuid,jsonb,jsonb),
  vortex_record.delete_command_deleted_records_internal(uuid),
  vortex_record.delete_command_closure_internal(jsonb,uuid,uuid,uuid),
  vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb),
  vortex_record.prepare_protected_parent_delete(uuid,uuid,uuid,bigint,uuid),
  vortex_record.finalize_protected_parent_delete(uuid,uuid,uuid,bigint,uuid,uuid,jsonb)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.delete_command_fingerprint_internal(uuid,uuid,uuid,bigint),
  vortex_record.assert_delete_receipt_completed_internal(),
  vortex_record.append_pending_delete_effect_internal(text,uuid,uuid,uuid,bigint,uuid,uuid,jsonb,jsonb),
  vortex_record.delete_command_deleted_records_internal(uuid),
  vortex_record.delete_command_closure_internal(jsonb,uuid,uuid,uuid),
  vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb)
to vortex_record_adapter;
grant execute on function vortex_record.prepare_protected_parent_delete(uuid,uuid,uuid,bigint,uuid),
  vortex_record.finalize_protected_parent_delete(uuid,uuid,uuid,bigint,uuid,uuid,jsonb)
to vortex_runtime;

comment on table vortex_record.delete_command_receipts is
  'Private scoped idempotency receipts for the one protected parent delete; a pending receipt cannot reach commit.';
comment on table vortex_record.delete_command_effects is
  'Private per-command journal of the effects the one lifecycle traversal applied; it is the only trusted source of the affected record set.';
comment on function vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid,jsonb) is
  'Adapter-private delete mode of the Stage 2B preflight: derives the surviving affected closure from this command''s scoped journal alone, locks it canonically, re-reads it, and returns only declared evaluator inputs.';
comment on function vortex_record.prepare_protected_parent_delete(uuid,uuid,uuid,bigint,uuid) is
  'Protected mutating preparation for one recoverable parent delete: opens the scoped receipt, runs the one lifecycle traversal under its journal, and prepares the surviving affected relationship-total closure.';
comment on function vortex_record.finalize_protected_parent_delete(uuid,uuid,uuid,bigint,uuid,uuid,jsonb) is
  'Terminal writer for one recoverable parent delete: repeats the relationship-total preparation only, applies revision-checked surviving parent totals, and writes the Activity, Event and completed receipt.';

reset role;
set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;
commit;
