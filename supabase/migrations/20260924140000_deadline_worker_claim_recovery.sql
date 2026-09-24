-- #857: keep the deadline worker moving and use local dates for date totals.
--
-- Two related defects in the deadline refresh path:
--
-- 1. A single stale due row can block every later claim. The unscoped batch
--    claim selected rows for a binding that is not active, so an inactive
--    binding's row was offered and then refused. And `claim_record_deadline_refresh`
--    returned a bare conflict when the stored `record_concurrency_number` no
--    longer matched the record: the worker stops on a conflict and the row is
--    never corrected, so the same row is chosen on every later call.
-- 2. Ownership transfer and its offboarding bridge bumped the record revision
--    without updating its due row, manufacturing exactly that stale mismatch.
--
-- The batch claim now selects only rows whose System context can be
-- established (an active binding with its current, unrevoked actor, in an
-- active organisation and tenant), reselects a due row whose stored
-- revision is behind the locked record (so the worker recomputes and moves on),
-- and retires a due row whose storage or record can no longer serve it. Both
-- transfer paths keep their record's due row at the revision they actually
-- wrote.
--
-- The functions below are defined by earlier migrations and
-- `claim_record_deadline_refresh` was patched in place by
-- `20260924070000_wide_record_field_values.sql`, so they are patched in place
-- from their current definitions exactly as
-- `20260924070000_wide_record_field_values.sql` and
-- `20260924010000_query_system_values_and_deadline_refresh.sql` do: each
-- reviewed source fragment must occur exactly once, or the migration aborts
-- rather than silently skipping a caller. Each is re-created under its own
-- current owner, so its OID, grants, comment, security and search_path stay
-- put.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
grant create on schema vortex_record to postgres;
reset role;

-- The claim has a postgres-owned row-selection helper and adapter-owned
-- callers, so the patch loop runs as the migrator and re-creates each function
-- under its own current owner, exactly as
-- `20260923180000_protected_record_delete_and_recovery.sql` does.
do $migration$
declare
  -- The batch claim considers only a row whose System context can actually be
  -- established: an active binding with its current, unrevoked actor, in an
  -- active organisation and tenant with runtime settings, exactly as
  -- `resolve_configured_deadline_actor_internal` and
  -- `establish_deadline_system_context_internal` require. Any other row would
  -- be refused on every call and starve every later due row of every tenant;
  -- it stays in place and is offered again once its configuration recovers.
  claim_due_row_active_binding_old constant text := $patch$    join vortex_record.deadline_actor_bindings as binding
      on binding.organization_id = metadata.organization_id
      and binding.application_root_id is not distinct from metadata.application_root_id
      and binding.operation = 'refresh_record_deadline'
      and binding.execution_session_role_oid = pg_catalog.to_regrole(session_user)::oid
    where metadata.transition_at <= pg_catalog.coalesce($patch$;
  claim_due_row_active_binding_new constant text := $patch$    join vortex_record.deadline_actor_bindings as binding
      on binding.organization_id = metadata.organization_id
      and binding.application_root_id is not distinct from metadata.application_root_id
      and binding.operation = 'refresh_record_deadline'
      and binding.state = 'active'
      and binding.execution_session_role_oid = pg_catalog.to_regrole(session_user)::oid
      and exists (
        select 1
        from vortex_record.deadline_actors as actor
        where actor.actor_id = binding.current_actor_id
          and actor.binding_id = binding.binding_id
          and actor.organization_id = binding.organization_id
          and actor.application_root_id is not distinct from binding.application_root_id
          and actor.operation = 'refresh_record_deadline'
          and actor.generation = binding.generation
          and actor.revoked_at is null
      )
      and exists (
        select 1
        from vortex_identity.organizations as org
        join vortex_identity.tenants as tenant on tenant.tenant_id = org.tenant_id
        join vortex_access.organization_access_versions as version
          on version.organization_id = org.organization_id
        join vortex_identity.organization_runtime_settings as settings
          on settings.organization_id = org.organization_id
        where org.organization_id = metadata.organization_id
          and org.state = 'active'
          and tenant.state = 'active'
          and version.current_version is not null
          and settings.time_zone is not null
      )
    where metadata.transition_at <= pg_catalog.coalesce($patch$;

  -- A due row whose storage contract can no longer serve it is retired rather
  -- than left to block every later claim of the earliest due row.
  claim_storage_unavailable_old constant text := $patch$    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'storage_contract_unavailable'
    );
  end if;$patch$;
  claim_storage_unavailable_new constant text := $patch$    delete from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = due_row.organization_id
      and metadata.storage_contract_id = due_row.storage_contract_id
      and metadata.record_id = due_row.record_id
      and metadata.application_root_id is not distinct from due_row.application_root_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'storage_contract_unavailable'
    );
  end if;$patch$;

  -- A record that is missing or no longer active retires its due row.
  claim_record_unavailable_old constant text := $patch$  if not found or record_row.lifecycle_state <> 'active' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'record_unavailable'
    );
  end if;$patch$;
  claim_record_unavailable_new constant text := $patch$  if not found or record_row.lifecycle_state <> 'active' then
    delete from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = due_row.organization_id
      and metadata.storage_contract_id = due_row.storage_contract_id
      and metadata.record_id = due_row.record_id
      and metadata.application_root_id is not distinct from due_row.application_root_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'record_unavailable'
    );
  end if;$patch$;

  -- A record whose stored definition is outside the contract's compatible range
  -- retires its due row; a later compatible installation reselects it.
  claim_storage_incompatible_old constant text := $patch$    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_storage_incompatible'
    );
  end if;$patch$;
  claim_storage_incompatible_new constant text := $patch$    delete from vortex_record.record_deadline_due_metadata as metadata
    where metadata.organization_id = due_row.organization_id
      and metadata.storage_contract_id = due_row.storage_contract_id
      and metadata.record_id = due_row.record_id
      and metadata.application_root_id is not distinct from due_row.application_root_id;
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'record_storage_incompatible'
    );
  end if;$patch$;

  -- A revision mismatch is corrected in place. The row keeps its schedule but
  -- carries the record's actual revision, so the claim returns `claimed` and the
  -- closure recomputes the next transition instead of the worker getting stuck
  -- on a conflict it can never clear.
  claim_concurrency_mismatch_old constant text := $patch$  if record_row.concurrency_number <> due_row.record_concurrency_number then
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'reasonCode', 'concurrency_mismatch'
    );
  end if;$patch$;
  claim_concurrency_mismatch_new constant text := $patch$  if record_row.concurrency_number <> due_row.record_concurrency_number then
    update vortex_record.record_deadline_due_metadata as metadata
    set record_concurrency_number = record_row.concurrency_number,
      changed_at = pg_catalog.statement_timestamp()
    where metadata.organization_id = due_row.organization_id
      and metadata.storage_contract_id = due_row.storage_contract_id
      and metadata.record_id = due_row.record_id
      and metadata.application_root_id is not distinct from due_row.application_root_id;
    due_row.record_concurrency_number := record_row.concurrency_number;
  end if;$patch$;

  -- The ordinary ownership transfer advanced the record revision; keep its due
  -- row at the revision the transfer actually wrote. Ownership does not change
  -- deadline inputs, so the schedule is unchanged.
  transfer_record_ownership_old constant text := $patch$  perform vortex_record.bump_record_data_version_internal(
    organization_id_value, (record_type_fact ->> 'storageContractId')::uuid,
    case when record_fact #>> '{recordScope,storageScope}' = 'application_contained'
      then application_root_id_value else null end
  );
  perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id, p_record_id, 'completed');$patch$;
  transfer_record_ownership_new constant text := $patch$  perform vortex_record.bump_record_data_version_internal(
    organization_id_value, (record_type_fact ->> 'storageContractId')::uuid,
    case when record_fact #>> '{recordScope,storageScope}' = 'application_contained'
      then application_root_id_value else null end
  );
  update vortex_record.record_deadline_due_metadata as metadata
  set record_concurrency_number = updated_concurrency_number,
    changed_at = pg_catalog.statement_timestamp()
  where metadata.organization_id = organization_id_value
    and metadata.storage_contract_id = (record_type_fact ->> 'storageContractId')::uuid
    and metadata.record_id = p_record_id
    and metadata.application_root_id is not distinct from case
      when record_fact #>> '{recordScope,storageScope}' = 'application_contained'
        then application_root_id_value else null end;
  perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id, p_record_id, 'completed');$patch$;

  -- The offboarding transfer's fixed sibling advanced the revision too.
  offboarding_transfer_old constant text := $patch$  perform vortex_record.bump_record_data_version_internal(
    organization_id_value, (type_fact ->> 'storageContractId')::uuid,
    case when record_fact #>> '{recordScope,storageScope}' = 'application_contained'
      then application_root_id_value else null end
  );
  perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id,p_record_id,'completed');$patch$;
  offboarding_transfer_new constant text := $patch$  perform vortex_record.bump_record_data_version_internal(
    organization_id_value, (type_fact ->> 'storageContractId')::uuid,
    case when record_fact #>> '{recordScope,storageScope}' = 'application_contained'
      then application_root_id_value else null end
  );
  update vortex_record.record_deadline_due_metadata as metadata
  set record_concurrency_number = updated_concurrency,
    changed_at = pg_catalog.statement_timestamp()
  where metadata.organization_id = organization_id_value
    and metadata.storage_contract_id = (type_fact ->> 'storageContractId')::uuid
    and metadata.record_id = p_record_id
    and metadata.application_root_id is not distinct from case
      when record_fact #>> '{recordScope,storageScope}' = 'application_contained'
        then application_root_id_value else null end;
  perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id,p_record_id,'completed');$patch$;

  targets constant jsonb := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_array(
      'vortex_record.claim_configured_deadline_due_row_internal(uuid,uuid,uuid,timestamptz)',
      claim_due_row_active_binding_old, claim_due_row_active_binding_new
    ),
    pg_catalog.jsonb_build_array(
      'vortex_record.claim_record_deadline_refresh(uuid,uuid,uuid,timestamptz)',
      claim_storage_unavailable_old, claim_storage_unavailable_new,
      claim_record_unavailable_old, claim_record_unavailable_new,
      claim_storage_incompatible_old, claim_storage_incompatible_new,
      claim_concurrency_mismatch_old, claim_concurrency_mismatch_new
    ),
    pg_catalog.jsonb_build_array(
      'vortex_record.transfer_record_ownership(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid)',
      transfer_record_ownership_old, transfer_record_ownership_new
    ),
    pg_catalog.jsonb_build_array(
      'vortex_record.transfer_record_ownership_for_offboarding_internal(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,uuid)',
      offboarding_transfer_old, offboarding_transfer_new
    )
  );

  target jsonb;
  procedure_id pg_catalog.regprocedure;
  patch_index integer;
  old_text text;
  new_text text;
  occurrences integer;
  definition text;
  owner_name name;
begin
  for target in
    select item.value
    from pg_catalog.jsonb_array_elements(targets) as item(value)
  loop
    procedure_id := (target ->> 0)::pg_catalog.regprocedure;
    definition := pg_catalog.pg_get_functiondef(procedure_id);
    if definition is null then
      raise exception using errcode = '55000',
        message = 'Deadline worker patch target is unavailable',
        detail = procedure_id::text;
    end if;
    definition := pg_catalog.replace(definition, E'\r\n', E'\n');
    patch_index := 1;
    while patch_index < pg_catalog.jsonb_array_length(target) loop
      old_text := target ->> patch_index;
      new_text := target ->> (patch_index + 1);
      occurrences := (
        pg_catalog.length(definition)
        - pg_catalog.length(pg_catalog.replace(definition, old_text, ''))
      ) / pg_catalog.length(old_text);
      if occurrences <> 1 then
        raise exception using errcode = '55000',
          message = 'Deadline worker patch does not match exactly once',
          detail = procedure_id::text;
      end if;
      definition := pg_catalog.replace(definition, old_text, new_text);
      patch_index := patch_index + 2;
    end loop;

    -- Re-created under the function's own current owner so its grants,
    -- comment and OID stay put.
    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    reset role;
  end loop;
end
$migration$;

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
revoke create on schema vortex_record from postgres;
reset role;

set local role vortex_record_adapter;
comment on function vortex_record.claim_record_deadline_refresh(uuid, uuid, uuid, timestamptz) is
  'Private atomic due-row claim returning locked root, attribution, effect identity and calculation inputs; patches in #857 offer only rows whose configured actor and organisation can establish context, reselect a stale revision in place and retire a due row whose storage or record can no longer serve it.';
reset role;

commit;
