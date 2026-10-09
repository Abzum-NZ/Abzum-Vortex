-- Adapter-only terminal person-field checks for the existing one named-action writer.
create or replace function vortex_record.validate_named_action_person_field_values_internal(
  p_command_id uuid, p_owner_kind text, p_owner_id uuid, p_release_revision bigint,
  p_action_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_revision bigint,
  p_inputs jsonb, p_final_values jsonb, p_phase text, p_observed_revision bigint,
  p_before_proof jsonb
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  ctx jsonb; meta jsonb; loaded jsonb; decision jsonb; bounds jsonb;
  initial_installation jsonb; person_values jsonb := '{}'::jsonb;
  field_value jsonb; value_entry record; source_value jsonb; matches bigint;
  input_value jsonb; input_key text; account_id uuid; deadline timestamptz;
  fingerprint_value text; effective_id uuid; receipt vortex_record.command_receipts%rowtype;
  proof jsonb; current_meta jsonb; current_loaded jsonb;
begin
  if p_phase is null or p_phase not in ('before','after')
    or p_expected_revision is null or p_expected_revision not between 1 and 9007199254740990
    or p_observed_revision is null
    or (p_phase = 'before' and p_observed_revision <> p_expected_revision)
    or (p_phase = 'after' and p_observed_revision <> p_expected_revision + 1)
    or pg_catalog.jsonb_typeof(p_inputs) is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_final_values) is distinct from 'object'
    or p_command_id is null or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
    or (p_phase = 'before' and p_before_proof is not null)
    or (p_phase = 'after' and pg_catalog.jsonb_typeof(p_before_proof) is distinct from 'object') then
    raise exception using errcode = '22023', message = 'Person field command is invalid';
  end if;
  ctx := vortex_access.validated_human_request_context();
  if ctx ->> 'applicationRootId' is null
    or (ctx ->> 'expiresAt')::timestamptz <= pg_catalog.clock_timestamp()
    or vortex_record.read_current_preview_installation_internal() is not null then
    raise exception using errcode = '42501', message = 'Person field command is unavailable';
  end if;
  initial_installation := vortex_module.read_current_active_installation();
  loaded := vortex_record.load_named_action_facts_internal(
    p_owner_kind,p_owner_id,p_release_revision,p_action_id,p_record_type_id,p_record_id,p_observed_revision);
  if loaded ->> 'outcome' is distinct from 'loaded'
    or (loaded ->> 'concurrencyNumber')::bigint is distinct from p_observed_revision then
    raise exception using errcode = '40001', message = 'Person field subject is stale';
  end if;
  meta := loaded -> 'actionContext';
  -- Unchanged inherited values are not newly authorised writes. A non-person action
  -- returns null without adding a new requirement to any existing action.
  for value_entry in select key,value from pg_catalog.jsonb_each(p_final_values) loop
    select value into field_value from pg_catalog.jsonb_array_elements(meta #> '{recordType,fields}')
      where pg_catalog.lower(value ->> 'fieldId') = pg_catalog.lower(value_entry.key);
    if not found or field_value ->> 'type' is distinct from 'link_to_person' then continue; end if;
    select pg_catalog.count(*),pg_catalog.min(entry.value::text)::jsonb into matches,source_value
    from pg_catalog.jsonb_array_elements(meta #> '{action,tasks}') task(value)
    cross join lateral pg_catalog.jsonb_each(case when task.value ->> 'type' = 'record.set_fields'
      then task.value #> '{properties,values}' else '{}'::jsonb end) entry
    where pg_catalog.lower(entry.key) = pg_catalog.lower(value_entry.key);
    if p_phase = 'before' and matches = 0
      and value_entry.value is not distinct from loaded -> 'fieldValues' -> value_entry.key then
      continue;
    end if;
    if p_phase = 'after' and not (p_before_proof -> 'personValues' ? value_entry.key) then continue; end if;
    if matches <> 1 or source_value ->> 'kind' is distinct from 'reference'
      or source_value #>> '{reference,source}' is distinct from 'input'
      or source_value - array['kind','reference']::text[] <> '{}'::jsonb
      or source_value -> 'reference' - array['source','name']::text[] <> '{}'::jsonb
      or field_value #>> '{settings,audience}' is distinct from 'application_accounts'
      or field_value #> '{settings,applicationRootIdRequired}' is distinct from 'true'::jsonb
      or pg_catalog.jsonb_typeof(value_entry.value) is distinct from 'object'
      or value_entry.value - array['organizationAccountId']::text[] <> '{}'::jsonb
      or not vortex_context.is_non_nil_uuid(value_entry.value ->> 'organizationAccountId') then
      raise exception using errcode = '42501', message = 'Person field value is unsupported';
    end if;
    input_key := source_value #>> '{reference,name}';
    select value into strict input_value from pg_catalog.jsonb_array_elements(meta #> '{action,inputs}')
      where value ->> 'key' = input_key;
    if input_value ->> 'type' is distinct from 'organization_account_reference'
      or pg_catalog.jsonb_typeof(p_inputs -> input_key) is distinct from 'string'
      or not vortex_context.is_non_nil_uuid(p_inputs ->> input_key)
      or (p_inputs ->> input_key)::uuid <> (value_entry.value ->> 'organizationAccountId')::uuid then
      raise exception using errcode = '42501', message = 'Person field input is unavailable';
    end if;
    person_values := person_values || pg_catalog.jsonb_build_object(value_entry.key,value_entry.value);
  end loop;
  if p_phase = 'before' and person_values = '{}'::jsonb then return null; end if;
  if coalesce((meta ->> 'rulesUnsupported')::boolean,false) then
    raise exception using errcode = '42501', message = 'Person field command is unsupported';
  end if;
  effective_id := vortex_record.preview_scoped_command_id_internal(p_command_id);
  fingerprint_value := vortex_record.named_action_command_fingerprint_internal(
    p_command_id,p_owner_kind,p_owner_id,p_release_revision,p_action_id,
    p_record_type_id,p_record_id,p_expected_revision,p_inputs);
  select stored.* into receipt from vortex_record.command_receipts as stored
  where stored.organization_id = (ctx ->> 'organizationId')::uuid
    and stored.application_root_id = (ctx ->> 'applicationRootId')::uuid
    and stored.actor_organization_account_id = (ctx ->> 'organizationAccountId')::uuid
    and stored.command_kind = 'named_action' and stored.command_id = effective_id
  for update;
  if not found or receipt.operation is distinct from 'named_action'
    or receipt.record_type_id is distinct from p_record_type_id
    or receipt.record_id is distinct from p_record_id
    or receipt.command_fingerprint is distinct from fingerprint_value
    or receipt.command_identity is distinct from pg_catalog.jsonb_build_object(
      'actionOwnerKind',p_owner_kind,'actionOwnerId',p_owner_id,
      'actionReleaseRevision',p_release_revision,'actionId',p_action_id)
    or (p_phase = 'before' and receipt.state is distinct from 'pending')
    or (p_phase = 'after' and (receipt.state is distinct from 'completed'
      or receipt.concurrency_number is distinct from p_observed_revision)) then
    raise exception using errcode = '42501', message = 'Person field receipt is unavailable';
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration',p_record_id,loaded -> 'facts');
  if decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode = '42501', message = 'Person field command is unavailable';
  end if;
  bounds := vortex_access.resolve_record_field_bounds_internal(decision);
  deadline := least((ctx ->> 'expiresAt')::timestamptz,(decision ->> 'validUntil')::timestamptz);
  if deadline is null or deadline <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501', message = 'Person field command expired';
  end if;
  for value_entry in select key,value from pg_catalog.jsonb_each(person_values) loop
    if not (coalesce(bounds -> 'readableFieldIds','[]'::jsonb) ? pg_catalog.lower(value_entry.key))
      or not (coalesce(bounds -> 'changeableFieldIds','[]'::jsonb) ? pg_catalog.lower(value_entry.key)) then
      raise exception using errcode = '42501', message = 'Person field is unavailable';
    end if;
    if p_phase = 'after' and loaded -> 'fieldValues' -> value_entry.key is distinct from value_entry.value then
      raise exception using errcode = '40001', message = 'Saved person field is stale';
    end if;
  end loop;
  if p_phase = 'after' then
    if p_before_proof - array['context','installation','actionContext','bounds','personValues',
        'fingerprint','commandId','validUntil']::text[] <> '{}'::jsonb
      or not (p_before_proof ?& array['context','installation','actionContext','bounds','personValues',
        'fingerprint','commandId','validUntil'])
      or p_before_proof -> 'context' is distinct from ctx
      or p_before_proof -> 'installation' is distinct from initial_installation
      or p_before_proof -> 'actionContext' is distinct from meta
      or p_before_proof -> 'bounds' is distinct from bounds
      or p_before_proof -> 'personValues' is distinct from person_values
      or p_before_proof ->> 'fingerprint' is distinct from fingerprint_value
      or (p_before_proof ->> 'commandId')::uuid is distinct from p_command_id
      or (p_before_proof ->> 'validUntil')::timestamptz <= pg_catalog.clock_timestamp() then
      raise exception using errcode = '42501', message = 'Person field proof became unavailable';
    end if;
    deadline := least(deadline,(p_before_proof ->> 'validUntil')::timestamptz);
  end if;
  for account_id in select distinct (value ->> 'organizationAccountId')::uuid
    from pg_catalog.jsonb_each(person_values) order by (value ->> 'organizationAccountId')::uuid
  loop
    if not vortex_identity.lock_active_organization_account_reference_internal(
      (ctx ->> 'tenantId')::uuid,(ctx ->> 'organizationId')::uuid,account_id)
      or not vortex_access.organization_account_has_current_application_access_internal(
        (ctx ->> 'organizationId')::uuid,account_id,(ctx ->> 'applicationRootId')::uuid) then
      raise exception using errcode = '42501', message = 'Person field audience is unavailable';
    end if;
  end loop;
  -- Re-evaluate after waits, on the real row in this exact phase. No lifecycle,
  -- owner, values, publication or facts are normalised to fabricate authority.
  current_loaded := vortex_record.load_named_action_facts_internal(
    p_owner_kind,p_owner_id,p_release_revision,p_action_id,p_record_type_id,p_record_id,p_observed_revision);
  current_meta := current_loaded -> 'actionContext';
  if current_loaded ->> 'outcome' is distinct from 'loaded'
    or current_meta is distinct from meta
    or vortex_module.read_current_active_installation() is distinct from initial_installation
    or vortex_access.validated_human_request_context() is distinct from ctx
    or deadline <= pg_catalog.clock_timestamp() then
    raise exception using errcode = '42501', message = 'Person field command became unavailable';
  end if;
  decision := vortex_access.evaluate_organization_record_access_internal(
    current_loaded -> 'declaration',p_record_id,current_loaded -> 'facts');
  if decision ->> 'outcome' is distinct from 'allowed'
    or (decision ->> 'validUntil')::timestamptz <= pg_catalog.clock_timestamp()
    or vortex_access.resolve_record_field_bounds_internal(decision) is distinct from bounds then
    raise exception using errcode = '42501', message = 'Person field command became unavailable';
  end if;
  for account_id in select distinct (value ->> 'organizationAccountId')::uuid
    from pg_catalog.jsonb_each(person_values) order by (value ->> 'organizationAccountId')::uuid
  loop
    if not vortex_access.organization_account_has_current_application_access_internal(
      (ctx ->> 'organizationId')::uuid,account_id,(ctx ->> 'applicationRootId')::uuid) then
      raise exception using errcode = '42501', message = 'Person field audience became unavailable';
    end if;
  end loop;
  if deadline <= pg_catalog.clock_timestamp()
    or vortex_access.validated_human_request_context() is distinct from ctx then
    raise exception using errcode = '42501', message = 'Person field command expired';
  end if;
  proof := pg_catalog.jsonb_build_object('context',ctx,'installation',initial_installation,
    'actionContext',meta,'bounds',bounds,'personValues',person_values,
    'fingerprint',fingerprint_value,'commandId',p_command_id,
    'validUntil',vortex_context.format_timestamp_utc(deadline));
  return case when p_phase = 'before' then proof else p_before_proof end;
end
$function$;
alter function vortex_record.validate_named_action_person_field_values_internal(
  uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,jsonb,text,bigint,jsonb) owner to vortex_record_adapter;
revoke all on function vortex_record.validate_named_action_person_field_values_internal(
  uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,jsonb,text,bigint,jsonb)
  from public,anon,authenticated,service_role,vortex_runtime,vortex_request,vortex_record_owner,vortex_module_owner;
grant execute on function vortex_record.validate_named_action_person_field_values_internal(
  uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,jsonb,text,bigint,jsonb) to vortex_record_adapter;
comment on function vortex_record.validate_named_action_person_field_values_internal(
  uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,jsonb,text,bigint,jsonb)
  is 'Adapter-only exact named-action input-derived application-account person-field validation. Before requires its pending fingerprinted receipt and shown revision; after requires its completed receipt and exact saved next revision, the private before proof, unchanged installed declaration/bounds and current recipient audience. Any late refusal raises for complete transaction rollback; private proof is never persisted or exposed.';