create or replace function vortex_record.is_record_type_lifecycle_policy(p_policy jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select coalesce(
    p_policy is not null
    and pg_catalog.jsonb_typeof(p_policy) = 'object'
    and p_policy ?& array[
      'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
      'policyRevision', 'action', 'maxAgeDays', 'maxCount',
      'allowUnlimitedAge', 'allowUnlimitedCount'
    ]
    and vortex_context.is_non_nil_uuid(p_policy ->> 'policyId')
    and vortex_context.is_non_nil_uuid(p_policy ->> 'organizationId')
    and vortex_context.is_non_nil_uuid(p_policy ->> 'storageContractId')
    and (
      pg_catalog.jsonb_typeof(p_policy -> 'applicationRootId') = 'null'
      or vortex_context.is_non_nil_uuid(p_policy ->> 'applicationRootId')
    )
    and vortex_record.is_lifecycle_revision_value(p_policy -> 'policyRevision')
    and p_policy ->> 'action' in ('delete', 'archive_workflow')
    and pg_catalog.jsonb_typeof(p_policy -> 'allowUnlimitedAge') = 'boolean'
    and pg_catalog.jsonb_typeof(p_policy -> 'allowUnlimitedCount') = 'boolean'
    and vortex_record.is_lifecycle_limit_value(p_policy -> 'maxAgeDays')
    and vortex_record.is_lifecycle_limit_value(p_policy -> 'maxCount')
    -- Closed representation: an explicit ceiling or an explicit unlimited
    -- permission, never both and never a silent missing-limit fallback.
    and (p_policy -> 'allowUnlimitedAge' = 'true'::jsonb)
      = (pg_catalog.jsonb_typeof(p_policy -> 'maxAgeDays') = 'null')
    and (p_policy -> 'allowUnlimitedCount' = 'true'::jsonb)
      = (pg_catalog.jsonb_typeof(p_policy -> 'maxCount') = 'null')
    and case
      when p_policy ->> 'action' = 'delete' then
        p_policy - array[
          'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
          'policyRevision', 'action', 'maxAgeDays', 'maxCount',
          'allowUnlimitedAge', 'allowUnlimitedCount', 'recoveryWindowDays'
        ] = '{}'::jsonb
        and (
          not p_policy ? 'recoveryWindowDays'
          or case
            when pg_catalog.jsonb_typeof(p_policy -> 'recoveryWindowDays') = 'number'
              and (p_policy ->> 'recoveryWindowDays') ~ '^[1-9][0-9]{0,8}$'
            then (p_policy ->> 'recoveryWindowDays')::bigint <= 104249991
            else false end
        )
      else
        p_policy ?& array[
          'archiveWorkflowId', 'expectedWorkflowRevision', 'archiveConnectionInstanceId',
          'archiveDestination', 'expectedConnectionRevision',
          'expectedDestinationFingerprint', 'expectedConnectionHealthOutcome'
        ]
        and p_policy - array[
          'policyId', 'organizationId', 'storageContractId', 'applicationRootId',
          'policyRevision', 'action', 'maxAgeDays', 'maxCount',
          'allowUnlimitedAge', 'allowUnlimitedCount',
          'archiveWorkflowId', 'expectedWorkflowRevision', 'archiveConnectionInstanceId',
          'archiveDestination', 'expectedConnectionRevision',
          'expectedDestinationFingerprint', 'expectedConnectionHealthOutcome'
        ] = '{}'::jsonb
        and vortex_context.is_non_nil_uuid(p_policy ->> 'archiveWorkflowId')
        and vortex_context.is_non_nil_uuid(p_policy ->> 'archiveConnectionInstanceId')
        and vortex_record.is_lifecycle_revision_value(p_policy -> 'expectedWorkflowRevision')
        and vortex_record.is_lifecycle_revision_value(p_policy -> 'expectedConnectionRevision')
        and pg_catalog.jsonb_typeof(p_policy -> 'archiveDestination') = 'string'
        and vortex_record.is_lifecycle_destination(p_policy ->> 'archiveDestination')
        and pg_catalog.jsonb_typeof(p_policy -> 'expectedDestinationFingerprint') = 'string'
        and (p_policy ->> 'expectedDestinationFingerprint') ~ '^[a-f0-9]{64}$'
        and p_policy ->> 'expectedConnectionHealthOutcome' = 'healthy'
    end,
    false
  );
$function$;

revoke all on function vortex_record.is_record_type_lifecycle_policy(jsonb) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_record.is_record_type_lifecycle_policy(jsonb) is
  'Closed shape check for one complete stored record-type lifecycle policy; guards both the protected save and the stored row.';
