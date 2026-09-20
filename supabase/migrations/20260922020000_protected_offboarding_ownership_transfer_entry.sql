-- #407 S3: a runtime-only offboarding transfer boundary.  The public entry
-- authorizes the organisation administrator before the private
-- transfer engine observes any record facts.
begin;

set local role vortex_record_adapter;

-- A completed receipt is the canonical replay source.  Unlike the ordinary
-- transfer entry, this retained/detached path must not read the record again:
-- the original caller can have lost its record-read route as a consequence of
-- the committed transfer.  The replay is therefore limited to data already
-- recorded by the completed command and exposes no owner metadata.
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
  actor_id_value uuid; fingerprint text; receipt vortex_record.save_command_receipts%rowtype;
  inserted uuid; loaded jsonb; decision jsonb; record_fact jsonb; type_fact jsonb;
  previous_owner uuid; updated_concurrency bigint; changed_rows integer; event_result jsonb;
  evaluation_facts jsonb;
begin
  if p_command_id is null or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_kind <> 'organization_account' or p_target_id is null
    or p_activity_id is null or p_occurrence_id is null
    or p_source_organization_account_id is null
    or p_source_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.validated_human_request_context();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Offboarding ownership transfer requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  fingerprint := vortex_record.ownership_transfer_command_fingerprint_internal(
    p_command_id,p_record_type_id,p_record_id,p_expected_concurrency_number,p_target_kind,p_target_id,
    'offboarding',p_source_organization_account_id);
  insert into vortex_record.save_command_receipts(
    organization_id,application_root_id,actor_organization_account_id,command_id,command_fingerprint,record_type_id,operation,state
  ) values (
    organization_id_value,application_root_id_value,actor_id_value,p_command_id,fingerprint,p_record_type_id,'transfer_ownership','pending'
  ) on conflict do nothing returning command_id into inserted;
  if inserted is null then
    select stored.* into strict receipt from vortex_record.save_command_receipts as stored
    where stored.organization_id=organization_id_value and stored.application_root_id=application_root_id_value
      and stored.actor_organization_account_id=actor_id_value and stored.command_id=p_command_id for update;
    if receipt.command_fingerprint is distinct from fingerprint or receipt.record_type_id is distinct from p_record_type_id
      or receipt.operation <> 'transfer_ownership' then
      return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','command_identity_conflict','correlationId',context_value -> 'correlationId');
    end if;
    if receipt.state <> 'completed' then
      return pg_catalog.jsonb_build_object('outcome','conflict','correlationId',context_value -> 'correlationId');
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome','transferred','recordId',receipt.record_id,
      'concurrencyNumber',receipt.concurrency_number,
      'correlationId',context_value -> 'correlationId','replayed',true
    );
  end if;
  loaded := vortex_record.load_offboarding_ownership_transfer_facts_internal(
    p_record_type_id,p_record_id,p_expected_concurrency_number);
  if loaded ->> 'outcome' = 'conflict' then
    delete from vortex_record.save_command_receipts where organization_id=organization_id_value
      and application_root_id=application_root_id_value and actor_organization_account_id=actor_id_value and command_id=p_command_id;
    return pg_catalog.jsonb_build_object('outcome','conflict','concurrencyNumber',loaded -> 'concurrencyNumber','correlationId',context_value -> 'correlationId');
  end if;
  if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
    delete from vortex_record.save_command_receipts where organization_id=organization_id_value
      and application_root_id=application_root_id_value and actor_organization_account_id=actor_id_value and command_id=p_command_id;
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  select item.value into record_fact from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  select item.value into type_fact from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
  if record_fact is null or type_fact is null
    or record_fact ->> 'lifecycleState' not in ('active','soft_deleted')
    or (loaded ->> 'installationState' = 'active' and record_fact ->> 'lifecycleState' <> 'soft_deleted')
    or type_fact ->> 'ownershipMode' <> 'organization_account'
    or (record_fact ->> 'ownerOrganizationAccountId')::uuid is distinct from p_source_organization_account_id then
    delete from vortex_record.save_command_receipts where organization_id=organization_id_value
      and application_root_id=application_root_id_value and actor_organization_account_id=actor_id_value and command_id=p_command_id;
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','owner_unavailable','correlationId',context_value -> 'correlationId');
  end if;
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
  decision := vortex_access.evaluate_organization_record_access_internal(
    loaded -> 'declaration', p_record_id, evaluation_facts
  );
  if decision ->> 'outcome' = 'refused' then
    perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id,organization_id_value,'refused');
    delete from vortex_record.save_command_receipts where organization_id=organization_id_value
      and application_root_id=application_root_id_value and actor_organization_account_id=actor_id_value and command_id=p_command_id;
    return pg_catalog.jsonb_build_object('outcome','refused_recorded','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  elsif decision ->> 'outcome' <> 'allowed' then
    raise exception using errcode='42501', message='Offboarding ownership transfer authority is unavailable';
  end if;
  if not vortex_access.lock_active_record_ownership_target_internal('organization_account',p_target_id)
    or p_target_id = p_source_organization_account_id then
    delete from vortex_record.save_command_receipts where organization_id=organization_id_value
      and application_root_id=application_root_id_value and actor_organization_account_id=actor_id_value and command_id=p_command_id;
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','owner_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  execute pg_catalog.format(
    'update record_data.%I as stored set owner_organisation_account_id=$3,owner_group_id=null,concurrency_number=concurrency_number+1,updated_at=pg_catalog.statement_timestamp(),updated_by=$4 where stored.organisation_id=$1 and stored.record_id=$2 and stored.concurrency_number=$5 returning stored.concurrency_number',
    loaded ->> 'table') into updated_concurrency using organization_id_value,p_record_id,p_target_id,actor_id_value,p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then raise exception using errcode='40001',message='Offboarding ownership transfer revision changed'; end if;
  perform vortex_record.bump_record_data_version_internal(
    organization_id_value, (type_fact ->> 'storageContractId')::uuid,
    case when record_fact #>> '{recordScope,storageScope}' = 'application_contained'
      then application_root_id_value else null end
  );
  perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id,p_record_id,'completed');
  if loaded ->> 'installationState' = 'detached' then
    event_result := vortex_event.append_detached_offboarding_reassignment_internal(
      (type_fact ->> 'storageContractId')::uuid, p_record_id, p_record_type_id, p_occurrence_id
    );
  else
    event_result := vortex_event.append_record_occurrences(
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
  if pg_catalog.jsonb_array_length(event_result) <> 1 then raise exception using errcode='55000',message='Offboarding ownership transfer Event append failed'; end if;
  update vortex_record.save_command_receipts set state='completed',record_id=p_record_id,concurrency_number=updated_concurrency,completed_at=pg_catalog.statement_timestamp()
  where organization_id=organization_id_value and application_root_id=application_root_id_value
    and actor_organization_account_id=actor_id_value and command_id=p_command_id and state='pending';
  if not found then raise exception using errcode='40001',message='Offboarding ownership transfer receipt is stale'; end if;
  return pg_catalog.jsonb_build_object('outcome','transferred','recordId',p_record_id,
    'concurrencyNumber',updated_concurrency,'correlationId',context_value -> 'correlationId','replayed',false);
end
$function$;

reset role;
set local role postgres;

-- This owner is deliberately the same privileged definer boundary as the
-- existing organisation-account administration entries.  It is the only new
-- caller of their ungranted fixed scope helper; no grant or role membership is
-- widened to make the helper callable by Record code or the runtime role.
create function vortex_record.transfer_record_ownership_for_offboarding(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_target_organization_account_id uuid,
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
begin
  perform vortex_access.organization_accounts_administration_change_scope();
  return vortex_record.transfer_record_ownership_for_offboarding_internal(
    p_command_id,
    p_record_type_id,
    p_record_id,
    p_expected_concurrency_number,
    'organization_account',
    p_target_organization_account_id,
    p_activity_id,
    p_occurrence_id,
    p_source_organization_account_id
  );
end
$function$;

revoke all on function vortex_record.transfer_record_ownership_for_offboarding(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.transfer_record_ownership_for_offboarding(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid, uuid
) to vortex_runtime;
comment on function vortex_record.transfer_record_ownership_for_offboarding(
  uuid, uuid, uuid, bigint, uuid, uuid, uuid, uuid
) is 'Fixed server-only offboarding ownership transfer: accounts.manage authority is established before the source-bound record transfer engine; exact completed command replay reuses only the stored receipt.';

reset role;
commit;
