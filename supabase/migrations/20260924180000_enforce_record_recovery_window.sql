-- #844: restoring a deleted record checks its recovery window.
--
-- `prepare_protected_record_restore` trusted a caller-supplied revision of a
-- recovery decision that names no record and no time, and checked only that
-- the policy existed at that revision. One allowed decision could therefore be
-- replayed for any record under the same policy revision, and after the window
-- had closed. Nothing stored a recovery window at all.
--
-- * A recoverable-delete policy may now carry `recoveryWindowDays`, a whole
--   number of days from 1 to floor(MAX_SAFE_INTEGER / 86400000). Only the
--   `delete` action may carry it. It is optional in the stored shape, so every
--   existing policy stays valid, but a policy without it grants no recovery:
--   restore refuses it as `policy_unavailable` and never reads the absence as
--   unlimited recovery (specification 06).
-- * The restore preflight no longer takes a decision or a policy revision from
--   its caller. It reads the record's own `deleted_at` before the restore
--   primitive clears it, share-locks the stored policy and, once the primitive
--   has accepted the restore for this actor, refuses `recovery_window_expired`
--   when the elapsed time since deletion reaches the window. The window and
--   the deletion time are both database facts of exactly this record.
-- * The revision a restore receipt records now comes from the stored policy,
--   so a record type with no stored policy has none. Its pending receipt still
--   guards the commit and the restore is refused as `policy_unavailable`; the
--   receipt check now states that explicitly, and still requires every
--   completed restore to name its governing revision.
--
-- Every function below is patched in place from its current definition (later
-- migrations rewrite Record functions in place, so no CREATE text is reused):
-- each reviewed source fragment must occur exactly once, or the migration
-- aborts rather than silently skipping a change.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;

do $migration$
declare
  policy_shape_old constant text := $q$          'allowUnlimitedAge', 'allowUnlimitedCount'
        ] = '{}'::jsonb
      else$q$;
  policy_shape_new constant text := $q$          'allowUnlimitedAge', 'allowUnlimitedCount', 'recoveryWindowDays'
        ] = '{}'::jsonb
        and (
          not p_policy ? 'recoveryWindowDays'
          or case
            when pg_catalog.jsonb_typeof(p_policy -> 'recoveryWindowDays') = 'number'
              and (p_policy ->> 'recoveryWindowDays') ~ '^[1-9][0-9]{0,8}$'
            then (p_policy ->> 'recoveryWindowDays')::bigint <= 104249991
            else false end
        )
      else$q$;

  lock_old constant text := $q$    'action', policy_row.action
  );$q$;
  lock_new constant text := $q$    'action', policy_row.action,
    'recoveryWindowDays', policy_row.policy_body -> 'recoveryWindowDays'
  );$q$;

  signature_old constant text := $q$p_recovery_policy_revision bigint, p_activity_id uuid)$q$;
  signature_new constant text := $q$p_activity_id uuid)$q$;
  validation_old constant text := $q$    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_recovery_policy_revision is null
    or p_recovery_policy_revision not between 1 and 9007199254740991 then$q$;
  validation_new constant text := $q$    or p_expected_concurrency_number not between 1 and 9007199254740990 then$q$;
  declare_old constant text := $q$  policy_value jsonb;
  refusal_reason text;
begin$q$;
  declare_new constant text := $q$  policy_value jsonb;
  refusal_reason text;
  expected_policy_revision bigint;
  deleted_value timestamptz;
begin$q$;
  preamble_old constant text := $q$  correlation_value := context_value -> 'correlationId';
  fingerprint_value := vortex_record.record_lifecycle_command_fingerprint_internal($q$;
  preamble_new constant text := $q$  correlation_value := context_value -> 'correlationId';

  -- The recovery window is decided from this record's own deletion time, read
  -- before the restore primitive clears it, and from the stored policy of its
  -- exact target, share-locked until commit. The row is read unlocked: the
  -- primitive locks it and accepts only the expected revision, and a revision
  -- only ever advances, so a matching read is the same deleted row. Nothing
  -- from this read is returned unless the primitive has accepted the actor.
  select catalogue.* into storage_row
  from vortex_record.storage_catalogue as catalogue
  where catalogue.record_type_id = p_record_type_id
    and catalogue.physical_schema_token = 'record_data'
    and catalogue.state = 'active';
  if found then
    policy_value := vortex_record.lock_record_recovery_policy_internal(
      (context_value ->> 'organizationId')::uuid,
      storage_row.storage_contract_id,
      case when storage_row.storage_scope = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end
    );
    expected_policy_revision := (policy_value ->> 'policyRevision')::bigint;
    execute pg_catalog.format(
      'select stored.deleted_at from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.application_root_id is not distinct from $3
         and stored.lifecycle_state = ''soft_deleted''
         and stored.concurrency_number = $4',
      storage_row.physical_table_token
    ) into deleted_value using
      (context_value ->> 'organizationId')::uuid, p_record_id,
      case when storage_row.storage_scope = 'application_contained'
        then (context_value ->> 'applicationRootId')::uuid else null end,
      p_expected_concurrency_number;
  end if;
  fingerprint_value := vortex_record.record_lifecycle_command_fingerprint_internal($q$;
  receipt_old constant text := $q$    p_expected_concurrency_number, p_recovery_policy_revision, p_activity_id,$q$;
  receipt_new constant text := $q$    p_expected_concurrency_number, expected_policy_revision, p_activity_id,$q$;
  refusal_old constant text := $q$    when (policy_value ->> 'policyRevision')::bigint
      is distinct from p_recovery_policy_revision then 'policy_revision_stale'
    else null end;$q$;
  refusal_new constant text := $q$    when (policy_value ->> 'policyRevision')::bigint
      is distinct from expected_policy_revision then 'policy_revision_stale'
    when pg_catalog.jsonb_typeof(policy_value -> 'recoveryWindowDays')
      is distinct from 'number' then 'policy_unavailable'
    when deleted_value is null then 'malformed_input'
    when pg_catalog.date_part(
      'epoch', pg_catalog.statement_timestamp() - deleted_value
    ) >= (policy_value ->> 'recoveryWindowDays')::numeric * 86400
      then 'recovery_window_expired'
    else null end;$q$;

  target record;
  patch jsonb;
  definition text;
  occurrences integer;
  owner_name text;
begin
  for target in
    select candidate.procedure_id, candidate.patches
    from (values
      ('vortex_record.is_record_type_lifecycle_policy(jsonb)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(policy_shape_old, policy_shape_new))),
      ('vortex_record.lock_record_recovery_policy_internal(uuid,uuid,uuid)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(lock_old, lock_new))),
      ('vortex_record.prepare_protected_record_restore(uuid,uuid,uuid,bigint,bigint,uuid)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(signature_old, signature_new),
          pg_catalog.jsonb_build_array(validation_old, validation_new),
          pg_catalog.jsonb_build_array(declare_old, declare_new),
          pg_catalog.jsonb_build_array(preamble_old, preamble_new),
          pg_catalog.jsonb_build_array(receipt_old, receipt_new),
          pg_catalog.jsonb_build_array(refusal_old, refusal_new)
        ))
    ) as candidate(procedure_id, patches)
  loop
    definition := pg_catalog.pg_get_functiondef(target.procedure_id);
    for patch in select item.value from pg_catalog.jsonb_array_elements(target.patches) as item(value)
    loop
      occurrences := (
        pg_catalog.length(definition)
        - pg_catalog.length(pg_catalog.replace(definition, patch ->> 0, ''))
      ) / pg_catalog.length(patch ->> 0);
      if occurrences <> 1 then
        raise exception using errcode = '55000',
          message = 'Recovery window patch does not match exactly once',
          detail = target.procedure_id::text;
      end if;
      definition := pg_catalog.replace(definition, patch ->> 0, patch ->> 1);
    end loop;
    -- Re-created under the function's own current owner so its grants,
    -- comment and OID stay put. The restore preflight's changed signature
    -- makes it a new function instead; it is handled after this block.
    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = target.procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    reset role;
  end loop;
end
$migration$;

-- The restore preflight has a new signature: replace the old one and give the
-- replacement exactly the privileges and comment of the function it replaces.
set local role vortex_record_adapter;
drop function vortex_record.prepare_protected_record_restore(uuid, uuid, uuid, bigint, bigint, uuid);
revoke all on function vortex_record.prepare_protected_record_restore(uuid, uuid, uuid, bigint, uuid)
from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.prepare_protected_record_restore(uuid, uuid, uuid, bigint, uuid)
to vortex_runtime;
comment on function vortex_record.prepare_protected_record_restore(uuid, uuid, uuid, bigint, uuid) is
  'Protected restore preflight: receipt, restore primitive, share-locked recovery-policy check, the recovery window from the record''s own deletion time and the locked dependency-total closure.';

-- A restore preflight for a target with no stored policy records a pending
-- receipt without a revision and is then refused. Only a pending restore may
-- lack one; a completed restore always names the revision that governed it.
alter table vortex_record.record_lifecycle_command_receipts
  drop constraint record_lifecycle_command_receipts_policy_valid,
  add constraint record_lifecycle_command_receipts_policy_valid check (
    (operation = 'delete' and recovery_policy_revision is null)
    or (operation = 'restore'
      and recovery_policy_revision is not null
      and recovery_policy_revision between 1 and 9007199254740991)
    or (operation = 'restore'
      and recovery_policy_revision is null
      and state = 'pending')
  );
reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
