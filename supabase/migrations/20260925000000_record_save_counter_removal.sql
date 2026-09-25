-- #1068: stop saves waiting on one shared counter per record type.
--
-- Every Record writer incremented one vortex_record.record_data_versions row per
-- storage scope inside its own transaction, so two concurrent saves of different
-- records of one type serialised on that row. The version existed only to key a
-- query-result cache that is not wired and to order live invalidation notices
-- that are not wired. This migration removes the counter and, in its place,
-- publishes the existing content-free post-commit invalidation from a
-- non-blocking monotonic sequence. The query cache keeps its bounded lifetime,
-- so a result is never reused beyond its declared bound even if a notice is lost.
--
-- Both changed functions are installed here as complete bodies.

begin;

reset role;
set local role vortex_record_owner;

-- One non-blocking monotonic source for invalidation notices. nextval takes no
-- row lock, so concurrent saves never wait on a version.
create sequence vortex_record.record_invalidation_sequence as bigint
  minvalue 1
  maxvalue 9007199254740991
  start with 1
  no cycle;

alter sequence vortex_record.record_invalidation_sequence owner to vortex_record_owner;
revoke all on sequence vortex_record.record_invalidation_sequence
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant usage, select on sequence vortex_record.record_invalidation_sequence
  to vortex_record_adapter;

reset role;

-- The private Record adapter publishes only through the one protected
-- content-free invalidation helper, which re-validates the scope itself.
grant usage on schema vortex_invalidation to vortex_record_adapter;
grant execute on function vortex_invalidation.publish_change_notice(
  uuid, uuid, uuid, uuid, bigint, text, bigint, bigint, uuid
) to vortex_record_adapter;

set local role vortex_record_adapter;

create or replace function vortex_record.bump_record_data_version_internal(
  p_organization_id uuid,
  p_storage_contract_id uuid,
  p_application_root_id uuid
)
returns bigint
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  record_type_id uuid;
  version_value bigint;
begin
  version_value := pg_catalog.nextval(
    'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
  );
  -- The shared per-record-type counter is gone. A save now tells open pages to
  -- re-read through the existing content-free post-commit private channel. That
  -- channel is application scoped, so an organisation-shared scope (no
  -- application root) has no topic; the bounded query-cache lifetime still
  -- bounds how long any result may be reused.
  if p_organization_id is null
    or p_storage_contract_id is null
    or p_application_root_id is null then
    return version_value;
  end if;
  select catalogue.record_type_id into record_type_id
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = p_storage_contract_id
    and catalogue.state = 'active';
  if record_type_id is null then
    return version_value;
  end if;
  begin
    perform vortex_invalidation.publish_change_notice(
      p_organization_id,
      p_application_root_id,
      record_type_id,
      null,
      null,
      'changed',
      version_value,
      version_value,
      pg_catalog.gen_random_uuid()
    );
  exception
    when others then
      -- Invalidation is an advisory refresh signal, never a save condition; the
      -- query-cache policy bounds reuse, so a lost notice only delays a refresh.
      null;
  end;
  return version_value;
end
$function$;

revoke all on function vortex_record.bump_record_data_version_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.bump_record_data_version_internal(uuid, uuid, uuid)
  to vortex_record_adapter;
comment on function vortex_record.bump_record_data_version_internal(uuid, uuid, uuid) is
  'Private Record change signal: takes one non-blocking monotonic version and, for an application-contained scope, publishes the existing content-free post-commit invalidation notice for the record type. Never takes a shared row lock.';

create or replace function vortex_record.reserve_named_action_creation_locks_internal(
  p_record_type_id uuid,
  p_creations jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  context_value jsonb;
  organization_id_value uuid;
  application_root_id_value uuid;
  counters jsonb := '[]'::jsonb;
  creation jsonb;
  record_meta jsonb;
  record_type_value jsonb;
  storage_contract_id_value uuid;
  storage_scope_value text;
  field_item jsonb;
  field_settings jsonb;
  counter_row record;
begin
  if p_record_type_id is null
    or pg_catalog.jsonb_typeof(p_creations) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Named action creation is invalid';
  end if;
  context_value := vortex_access.validated_human_request_context();
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;

  for creation in
    select item.value
    from pg_catalog.jsonb_array_elements(p_creations) with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    record_meta := vortex_record.resolve_record_action_context_internal(
      (creation ->> 'recordTypeId')::uuid, 'create'
    );
    if pg_catalog.jsonb_typeof(record_meta -> 'recordType') is distinct from 'object' then
      raise exception using errcode = '55000',
        message = 'Named action creation target is unavailable';
    end if;
    record_type_value := record_meta -> 'recordType';
    storage_contract_id_value := (record_meta ->> 'storageContractId')::uuid;
    storage_scope_value := record_meta ->> 'storageScope';
    for field_item in
      select item.value
      from pg_catalog.jsonb_array_elements(record_type_value -> 'fields') as item(value)
      order by item.value ->> 'fieldId'
    loop
      if field_item ->> 'type' <> 'reference_number' then continue; end if;
      field_settings := coalesce(field_item -> 'settings', '{}'::jsonb);
      -- A malformed setting is left for `allocate_reference_number_internal` to
      -- reject; this pass only reserves a valid counter.
      if pg_catalog.jsonb_typeof(field_settings -> 'digits') <> 'number'
        or (field_settings ->> 'digits')::integer not between 1 and 20
        or (field_settings ? 'startingNumber' and (
          pg_catalog.jsonb_typeof(field_settings -> 'startingNumber') <> 'number'
          or (field_settings ->> 'startingNumber')::numeric < 1
          or pg_catalog.trunc((field_settings ->> 'startingNumber')::numeric)
            <> (field_settings ->> 'startingNumber')::numeric
        )) then
        continue;
      end if;
      counters := counters || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'storageContractId', storage_contract_id_value,
        'fieldId', (field_item ->> 'fieldId')::uuid,
        'applicationRootId', case when storage_scope_value = 'application_contained'
          then application_root_id_value else null end,
        'startNumber', coalesce((field_settings ->> 'startingNumber')::numeric, 1)
      ));
    end loop;
  end loop;

  -- L4: every created record's reference-number counter, in one canonical
  -- order, before the subject writer writes the subject's relationship edges
  -- (L6), matching ordinary create's counter-then-edge order. A row is created
  -- at `startingNumber` or left unchanged, and `allocate_reference_number_internal`
  -- then increments the held row, so an abandoned reservation consumes no number.
  for counter_row in
    select distinct
      (item.value ->> 'storageContractId')::uuid as storage_contract_id,
      (item.value ->> 'fieldId')::uuid as field_id,
      (item.value ->> 'applicationRootId')::uuid as application_root_id,
      (item.value ->> 'startNumber')::numeric as start_number
    from pg_catalog.jsonb_array_elements(counters) as item(value)
    order by 1, 2, 3
  loop
    insert into vortex_record.record_reference_counters (
      organization_id, storage_contract_id, field_id, application_root_id, next_number
    ) values (
      organization_id_value, counter_row.storage_contract_id, counter_row.field_id,
      counter_row.application_root_id, counter_row.start_number
    )
    on conflict (organization_id, storage_contract_id, field_id, application_root_id)
      do update set next_number = vortex_record.record_reference_counters.next_number;
  end loop;
end
$function$;

revoke all on function vortex_record.reserve_named_action_creation_locks_internal(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.reserve_named_action_creation_locks_internal(uuid, jsonb)
  to vortex_record_adapter;
comment on function vortex_record.reserve_named_action_creation_locks_internal(uuid, jsonb) is
  'Private named-action step: takes every created record''s reference-number counter (L4) before the subject writer writes any relationship edge (L6), so a combined create and subject-link command keeps edge identities as the last lock class, as ordinary create does. Changes no counter value except the creation reservation itself.';

reset role;

-- Record and operation paths no longer read or write the shared per-record-type
-- counter, so the table is removed.
set local role vortex_record_owner;
drop table vortex_record.record_data_versions;
reset role;

commit;
