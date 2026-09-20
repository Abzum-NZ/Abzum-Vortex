-- #49: one protected recoverable parent delete composed with relationship totals.
--
-- Lock order is the existing lifecycle incoming-edge order
-- (source storage contract, source record, relationship), followed by the
-- existing totals concrete identity order (storage contract, record). The
-- journal is private transaction state: its deferred invariant forbids a
-- pending receipt at commit, so a mutating prepare can never commit alone.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
grant create on schema vortex_record to postgres;
reset role;
set local role vortex_record_adapter;

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
    organization_id, application_root_id, actor_organization_account_id, command_id
  ),
  constraint delete_command_receipts_fingerprint_valid check (
    command_fingerprint ~ '^sha256:[a-f0-9]{64}$'
  ),
  constraint delete_command_receipts_revision_valid check (
    expected_concurrency_number between 1 and 9007199254740990
  ),
  constraint delete_command_receipts_state_valid check (state in ('pending', 'completed')),
  constraint delete_command_receipts_completion_valid check (
    (state = 'pending' and completed_concurrency_number is null and completed_at is null)
    or (state = 'completed' and completed_concurrency_number between 1 and 9007199254740991
      and completed_at is not null)
  )
);

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
  constraint delete_command_effects_pk primary key (
    organization_id, application_root_id, actor_organization_account_id,
    command_id, effect_sequence
  ),
  constraint delete_command_effects_receipt_fk foreign key (
    organization_id, application_root_id, actor_organization_account_id, command_id
  ) references vortex_record.delete_command_receipts (
    organization_id, application_root_id, actor_organization_account_id, command_id
  ) on delete cascade,
  constraint delete_command_effects_kind_valid check (effect_kind in ('soft_deleted', 'optional_cleared')),
  constraint delete_command_effects_revision_valid check (
    pre_concurrency_number between 1 and 9007199254740990
    and post_concurrency_number = pre_concurrency_number + 1
  ),
  constraint delete_command_effects_shape_valid check (
    (effect_kind = 'soft_deleted' and relationship_id is null and source_field_id is null
      and previous_value is null)
    or (effect_kind = 'optional_cleared' and relationship_id is not null
      and source_field_id is not null and previous_value is not null)
  )
);

alter table vortex_record.delete_command_receipts enable row level security;
alter table vortex_record.delete_command_receipts force row level security;
create policy delete_command_receipts_adapter on vortex_record.delete_command_receipts
  to vortex_record_adapter using (true) with check (true);
alter table vortex_record.delete_command_receipts owner to vortex_record_adapter;
alter table vortex_record.delete_command_effects enable row level security;
alter table vortex_record.delete_command_effects force row level security;
create policy delete_command_effects_adapter on vortex_record.delete_command_effects
  to vortex_record_adapter using (true) with check (true);
alter table vortex_record.delete_command_effects owner to vortex_record_adapter;
revoke all on table vortex_record.delete_command_receipts, vortex_record.delete_command_effects
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

create function vortex_record.assert_delete_receipt_completed_internal()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if exists (
    select 1 from vortex_record.delete_command_receipts receipt
    where receipt.organization_id = new.organization_id
      and receipt.application_root_id = new.application_root_id
      and receipt.actor_organization_account_id = new.actor_organization_account_id
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
for each row execute function vortex_record.assert_delete_receipt_completed_internal();

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
      )::text,
      'UTF8'
    )),
    'hex'
  )
$function$;

create function vortex_record.append_pending_delete_effect_internal(
  p_effect_kind text,
  p_storage_contract_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_pre_concurrency_number bigint,
  p_relationship_id uuid default null,
  p_source_field_id uuid default null,
  p_previous_value jsonb default null
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
  bound_command_id := nullif(
    pg_catalog.current_setting('vortex_record.pending_delete_command_id', true), ''
  )::uuid;
  if bound_command_id is null then return; end if;
  context_value := vortex_access.validated_human_request_context();
  if not exists (
    select 1 from vortex_record.delete_command_receipts receipt
    where receipt.organization_id = (context_value ->> 'organizationId')::uuid
      and receipt.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and receipt.actor_organization_account_id =
        (context_value ->> 'organizationAccountId')::uuid
      and receipt.command_id = bound_command_id
      and receipt.state = 'pending'
  ) then
    raise exception using errcode = '42501', message = 'Delete effect journal is unavailable';
  end if;
  select coalesce(pg_catalog.max(effect.effect_sequence), 0) + 1 into next_sequence
  from vortex_record.delete_command_effects effect
  where effect.organization_id = (context_value ->> 'organizationId')::uuid
    and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
    and effect.actor_organization_account_id =
      (context_value ->> 'organizationAccountId')::uuid
    and effect.command_id = bound_command_id;
  insert into vortex_record.delete_command_effects (
    organization_id, application_root_id, actor_organization_account_id, command_id,
    effect_sequence, effect_kind, storage_contract_id, record_type_id, record_id,
    pre_concurrency_number, post_concurrency_number, relationship_id, source_field_id,
    previous_value
  ) values (
    (context_value ->> 'organizationId')::uuid,
    (context_value ->> 'applicationRootId')::uuid,
    (context_value ->> 'organizationAccountId')::uuid,
    bound_command_id, next_sequence, p_effect_kind, p_storage_contract_id,
    p_record_type_id, p_record_id, p_pre_concurrency_number,
    p_pre_concurrency_number + 1, p_relationship_id, p_source_field_id, p_previous_value
  );
end
$function$;

-- This is the sole incoming-policy traversal. Its policy, refusals, child
-- skip rules and recovery semantics are unchanged. A soft-delete effect is
-- journaled after its successful update; an optional-clear effect is journaled
-- immediately before the existing writer so its prior link is retained.
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
  identity_value := pg_catalog.lower((meta ->> 'storageContractId')) || ':' ||
    pg_catalog.lower(p_record_id::text);
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
  if loaded ->> 'outcome' <> 'loaded' or
    pg_catalog.jsonb_typeof(meta -> 'declaration') <> 'object' then
    raise exception using errcode = 'P0002', message = 'Record is unavailable';
  end if;
  select item.value into record_fact
  from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') item(value)
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

  for incoming in
    select edge.*, mapping.on_parent_delete, mapping.relationship_id, mapping.source_field_id
    from vortex_record.relationship_edges edge
    join vortex_record.relationship_storage_mappings mapping
      on mapping.relationship_id = edge.relationship_id
    where edge.to_organisation_id = (context_value ->> 'organizationId')::uuid
      and edge.to_storage_contract_id = (meta ->> 'storageContractId')::uuid
      and edge.to_record_id = p_record_id
    order by edge.from_storage_contract_id, edge.from_record_id, edge.relationship_id
  loop
    select catalogue.* into source_catalogue
    from vortex_record.storage_catalogue catalogue
    where catalogue.storage_contract_id = incoming.from_storage_contract_id;
    source_identity := pg_catalog.lower(incoming.from_storage_contract_id::text) || ':' ||
      pg_catalog.lower(incoming.from_record_id::text);
    if source_identity = any (p_visited) then
      raise exception using errcode = '23514', message = 'Relationship deletion cycle is invalid';
    end if;
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
    from vortex_record.field_storage_mappings field_mapping
    where field_mapping.storage_contract_id = incoming.from_storage_contract_id
      and field_mapping.field_id = incoming.source_field_id
      and field_mapping.state = 'active'
      and field_mapping.introduced_at_release_revision <=
        (source_meta ->> 'moduleReleaseRevision')::bigint;
    execute pg_catalog.format(
      'select concurrency_number, %I from record_data.%I stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active'' for update',
      source_link_column, source_meta ->> 'table'
    ) into source_concurrency, source_link_value using
      (context_value ->> 'organizationId')::uuid, incoming.from_record_id;
    if not found then continue; end if;
    if pg_catalog.jsonb_typeof(source_link_value) <> 'object' or
      source_link_value ->> 'recordId' is distinct from p_record_id::text then
      continue;
    end if;
    source_loaded := vortex_record.load_record_access_facts_internal(
      source_catalogue.record_type_id, source_action_kind, incoming.from_record_id,
      source_concurrency
    );
    if source_loaded ->> 'outcome' <> 'loaded' then continue; end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(source_loaded -> 'facts' -> 'records') item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = incoming.from_record_id;
    if record_fact ->> 'lifecycleState' <> 'active' then continue; end if;
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
        source_catalogue.record_type_id, incoming.from_record_id, source_concurrency,
        incoming.relationship_id, incoming.source_field_id, source_link_value
      );
      perform vortex_record.write_relationship_value_internal(
        source_catalogue.record_type_id, incoming.from_record_id,
        incoming.relationship_id, 'null'::jsonb, true
      );
    elsif incoming.on_parent_delete = 'soft_delete_dependent' then
      source_record_type := source_meta -> 'recordType';
      if source_record_type ->> 'ownershipMode' <> 'inherited'
        or not source_record_type ? 'ownershipRelationshipId'
        or (source_record_type ->> 'ownershipRelationshipId')::uuid <> incoming.relationship_id then
        raise exception using errcode = '23514', message = 'Dependent deletion is not declared';
      end if;
      perform vortex_record.soft_delete_record_recursive_internal(
        source_catalogue.record_type_id, incoming.from_record_id, source_concurrency, p_visited
      );
    else
      raise exception using errcode = '23514', message = 'Parent deletion behavior is invalid';
    end if;
  end loop;
  execute pg_catalog.format(
    'update record_data.%I stored set lifecycle_state = ''soft_deleted'',
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
    p_record_type_id, p_record_id, p_expected_concurrency_number
  );
  application_scope := case when meta ->> 'storageScope' = 'application_contained'
    then (context_value ->> 'applicationRootId')::uuid else null end;
  perform vortex_record.bump_record_data_version_internal(
    (context_value ->> 'organizationId')::uuid,
    (meta ->> 'storageContractId')::uuid, application_scope
  );
end
$function$;
