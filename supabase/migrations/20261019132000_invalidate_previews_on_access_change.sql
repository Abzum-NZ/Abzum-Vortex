-- Invalidate copied previews with every access change and ownership transfer.
set local role vortex_owner;

create or replace function vortex_access.invalidate_preview_installations_internal(
  p_organization_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  if p_organization_id is null
    or not vortex_platform.is_non_nil_uuid(p_organization_id::text)
    or pg_catalog.current_setting('vortex_access.exclusive_organization_id', true)
      is distinct from p_organization_id::text then
    raise exception using errcode = '55000',
      message = 'Preview invalidation requires an exclusive access-change scope';
  end if;

  delete from vortex_definition.preview_installations as preview
  where preview.organization_id = p_organization_id;
end
$function$;

alter function vortex_access.invalidate_preview_installations_internal(uuid) owner to vortex_owner;

revoke all on function vortex_access.invalidate_preview_installations_internal(uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.invalidate_preview_installations_internal(uuid)
  to vortex_record_adapter, postgres;

CREATE OR REPLACE FUNCTION vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) RETURNS TABLE(organization_id uuid, current_version bigint, changed_at timestamp with time zone, changed_by uuid, change_correlation_id uuid, change_reason text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
begin
  if p_organization_id is null
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_changed_by is null
    or p_changed_by = '00000000-0000-0000-0000-000000000000'::uuid
    or p_correlation_id is null
    or p_correlation_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_change_reason not in (
      'organization_account_activated',
      'organization_account_reactivated',
      'organization_account_suspended',
      'organization_account_closed',
      'role_assignment_changed',
      'role_activation_changed',
      'delegation_changed',
      'stewardship_changed',
      'invitation_access_accepted',
      'role_catalogue_changed',
      'group_membership_changed',
      'application_access_changed',
      'direct_share_changed',
      'record_ownership_changed',
      'access_grant_changed',
      'public_policy_changed',
      'federation_mirror_changed',
      'mcp_authorization_changed'
    ) then
    raise exception using errcode = '22023', message = 'Access-version increment input is invalid';
  end if;

  -- This marker detects a wrong request runner before UPDATE attempts a lock upgrade.
  -- It is not authority: callers still validate the current context and permission.
  if pg_catalog.current_setting('vortex_access.exclusive_organization_id', true)
    is distinct from p_organization_id::text then
    raise exception using errcode = '55000',
      message = 'Access-version increment requires an exclusive access-change scope';
  end if;

  return query
  update vortex_access.organization_access_versions as version
  set current_version = version.current_version + 1,
      changed_at = greatest(version.changed_at, pg_catalog.clock_timestamp()),
      changed_by = p_changed_by,
      change_correlation_id = p_correlation_id,
      change_reason = p_change_reason
  where version.organization_id = p_organization_id
    and version.current_version < 9007199254740991
  returning version.organization_id, version.current_version, version.changed_at,
    version.changed_by, version.change_correlation_id, version.change_reason;

  if not found then
    if exists (
      select 1 from vortex_access.organization_access_versions as version
      where version.organization_id = p_organization_id
        and version.current_version = 9007199254740991
    ) then
      raise exception using errcode = '22003', message = 'Access version is exhausted';
    end if;
    raise exception using errcode = '40001', message = 'Access version is unavailable';
  end if;

  -- A preview's copied live rows and fields were admitted under the previous access.
  -- Invalidate every builder's snapshot atomically with the version advance, while the
  -- access-change scope excludes preview requests. The next open seeds a new preview
  -- using current live access; retired physical storage is dropped in the background.
  perform vortex_access.invalidate_preview_installations_internal(p_organization_id);
end
$$;

alter function vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) owner to vortex_owner;

REVOKE ALL ON FUNCTION vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) FROM PUBLIC;

grant execute on function vortex_access.increment_organization_access_version(p_organization_id uuid, p_changed_by uuid, p_correlation_id uuid, p_change_reason text) to postgres;

create or replace function vortex_access.lock_human_request_access_version_internal()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  initial_context jsonb;
  rechecked_context jsonb;
  locked_access_version bigint;
begin
  initial_context := vortex_access.validated_human_request_context();
  if pg_catalog.jsonb_typeof(initial_context) is distinct from 'object'
    or not (initial_context ?& array[
      'callerKind', 'tenantId', 'organizationId', 'organizationAccountId',
      'applicationRootId', 'accessVersion', 'correlationId'
    ])
    or initial_context ->> 'callerKind' is distinct from 'human'
    or not vortex_platform.is_non_nil_uuid(initial_context ->> 'tenantId')
    or not vortex_platform.is_non_nil_uuid(initial_context ->> 'organizationId')
    or not vortex_platform.is_non_nil_uuid(initial_context ->> 'organizationAccountId')
    or not vortex_platform.is_non_nil_uuid(initial_context ->> 'applicationRootId')
    or not vortex_platform.is_non_nil_uuid(initial_context ->> 'correlationId')
    or not pg_catalog.pg_input_is_valid(initial_context ->> 'accessVersion', 'bigint')
    or (initial_context ->> 'accessVersion')::bigint not between 1 and 9007199254740991 then
    raise exception using errcode = '42501',
      message = 'Human ownership transfer access scope is unavailable';
  end if;

  select version.current_version into locked_access_version
  from vortex_access.organization_access_versions as version
  join vortex_identity.organizations as organization
    on organization.organization_id = version.organization_id
  join vortex_identity.tenants as tenant
    on tenant.tenant_id = organization.tenant_id
  where version.organization_id = (initial_context ->> 'organizationId')::uuid
    and organization.tenant_id = (initial_context ->> 'tenantId')::uuid
    and organization.state = 'active'
    and tenant.state = 'active'
  -- This entry is used by ownership transfers. Upgrade the request's shared
  -- scope before taking a record lock. NOWAIT turns competing shared readers
  -- or upgrades into a retry instead of a lock-upgrade deadlock.
  for update of version nowait;

  if not found then
    raise exception using errcode = '42501',
      message = 'Human ownership transfer access scope is unavailable';
  end if;
  if locked_access_version is distinct from (initial_context ->> 'accessVersion')::bigint then
    raise exception using errcode = '40001',
      message = 'Human ownership transfer access version changed';
  end if;

  rechecked_context := vortex_access.validated_human_request_context();
  if rechecked_context is distinct from initial_context then
    raise exception using errcode = '40001',
      message = 'Human ownership transfer context changed while acquiring access lock';
  end if;

  perform pg_catalog.set_config(
    'vortex_access.exclusive_organization_id',
    initial_context ->> 'organizationId', true
  );

  return initial_context;
end
$function$;

alter function vortex_access.lock_human_request_access_version_internal() owner to vortex_owner;

revoke all on function vortex_access.lock_human_request_access_version_internal()
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_access.lock_human_request_access_version_internal()
  to vortex_record_adapter;
comment on function vortex_access.lock_human_request_access_version_internal() is
  'Locks the exact active Human organization access version exclusively before an ownership transfer takes record locks, and revalidates the full original request context.';

grant execute on function vortex_access.lock_human_request_access_version_internal() to postgres;

set local role vortex_record_adapter;

create or replace function vortex_record.apply_lifecycle_record_changes_internal(
  p_operation text,
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_mutations jsonb,
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
  context_value jsonb;
  receipt vortex_record.command_receipts%rowtype;
  preparation jsonb;
  effect_row vortex_record.record_lifecycle_command_effects%rowtype;
  event_kind text;
  event_result jsonb;
  subject_ids uuid[];
  revisions jsonb;
  restored_revision bigint;
  target_kind text;
  target_id uuid;
  organization_id_value uuid;
  application_root_id_value uuid;
  actor_id_value uuid;
  receipt_claim jsonb;
  installation jsonb;
  loaded jsonb;
  decision jsonb;
  record_fact jsonb;
  record_type_fact jsonb;
  ownership_mode text;
  previous_owner_id uuid;
  updated_record_id uuid;
  updated_concurrency_number bigint;
  changed_rows integer;
  notice_sequence bigint;
  context_after jsonb;
  shared_consumers_initial jsonb;
  shared_consumers_final jsonb;
  target_item jsonb;
  module_item jsonb;
  target_application_root_id uuid;
  previous_target_application_root_id uuid;
  target_module_root_id uuid;
  previous_target_module_root_id uuid;
  target_module_binding_count integer;
  origin_application_is_consumer boolean;
begin
  -- The terminal delete, restore and ownership-transfer writes now run inside the
  -- one protected apply_record_changes operation. Each branch is the exact body
  -- its own writer used to carry, so its receipt, Activity and
  -- Events are unchanged; only the entry point moved. The delete and restore
  -- branches complete the record_lifecycle receipt the protected preflight
  -- already claimed and, for a delete, already soft-deleted behind; the transfer
  -- branch owns and claims its own record_save receipt as before.
  if p_operation = 'delete' then
    context_value := vortex_access.validated_human_request_context();
    receipt := vortex_record.lock_command_receipt_internal('record_delete', p_command_id);
    if receipt.command_id is null
      or receipt.result is not null then
      raise exception using errcode = '55000',
        message = 'Protected record delete is not prepared';
    end if;
    if p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Protected record delete identities are invalid';
    end if;

    -- The journaled effects prove the preflight that ran was this delete.
    if exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id and effect.effect_kind = 'restored'
    ) or not exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id
        and effect.effect_kind = 'soft_deleted'
        and effect.record_type_id = p_record_type_id
        and effect.record_id = p_record_id
    ) then
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
      preparation, false, p_mutations
    );

    for effect_row in
      select effect.*
      from vortex_record.record_lifecycle_command_effects as effect
      where effect.organization_id = (context_value ->> 'organizationId')::uuid
        and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
        and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
        and effect.command_id = receipt.command_id
      order by effect.effect_sequence
    loop
      if effect_row.effect_kind = 'soft_deleted' then
        event_kind := 'deleted';
      else
        event_kind := 'unlinked';
      end if;
      event_result := vortex_platform.append_record_occurrences(
        effect_row.storage_contract_id, effect_row.record_id,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'occurrenceId', case
            when event_kind = 'deleted' and effect_row.record_id = p_record_id
              and effect_row.record_type_id = p_record_type_id
              then p_occurrence_id
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
    where effect.organization_id = (context_value ->> 'organizationId')::uuid
      and effect.application_root_id = (context_value ->> 'applicationRootId')::uuid
      and effect.actor_organization_account_id = (context_value ->> 'organizationAccountId')::uuid
      and effect.command_id = receipt.command_id;
    if subject_ids is null or not (p_record_id = any (subject_ids)) then
      raise exception using errcode = '55000',
        message = 'Protected record delete effects are unavailable';
    end if;
    perform vortex_record.append_record_lifecycle_activity_internal(
      p_activity_id, 'delete', subject_ids
    );

    perform vortex_record.complete_command_receipt_internal(
      'record_delete', p_command_id, p_record_id, p_expected_concurrency_number + 1,
      'Protected record delete receipt is stale'
    );

    return pg_catalog.jsonb_build_object(
      'outcome', 'deleted',
      'recordId', p_record_id,
      'concurrencyNumber', p_expected_concurrency_number + 1,
      'correlationId', context_value -> 'correlationId',
      'replayed', false
    );
  elsif p_operation = 'restore' then
    context_value := vortex_access.validated_human_request_context();
    receipt := vortex_record.lock_command_receipt_internal('record_restore', p_command_id);
    if receipt.command_id is null
      or receipt.result is not null then
      raise exception using errcode = '55000',
        message = 'Protected record restore is not prepared';
    end if;
    if p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid then
      raise exception using errcode = '22023',
        message = 'Protected record restore identities are invalid';
    end if;

    -- The journaled effects prove the preflight that ran was this restore.
    if exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id and effect.effect_kind <> 'restored'
    ) or not exists (
      select 1 from vortex_record.record_lifecycle_command_effects as effect
      where effect.command_id = receipt.command_id
        and effect.effect_kind = 'restored'
        and effect.record_type_id = p_record_type_id
        and effect.record_id = p_record_id
    ) then
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
      preparation, true, p_mutations
    );
    select (item.value ->> 'concurrencyNumber')::bigint into strict restored_revision
    from pg_catalog.jsonb_array_elements(revisions) as item(value)
    where item.value ->> 'recordKey' = 'root';

    perform vortex_record.append_record_lifecycle_activity_internal(
      p_activity_id, 'restore', array[p_record_id]::uuid[]
    );

    perform vortex_record.complete_command_receipt_internal(
      'record_restore', p_command_id, p_record_id, restored_revision,
      'Protected record restore receipt is stale'
    );

    return pg_catalog.jsonb_build_object(
      'outcome', 'restored',
      'recordId', p_record_id,
      'concurrencyNumber', restored_revision,
      'correlationId', context_value -> 'correlationId',
      'replayed', false
    );
  elsif p_operation = 'transfer_ownership' then
    -- The transfer's target is the command's ordered mutation list; it carries
    -- one transfer_ownership mutation with the exact installed target kind and
    -- identifier, never an authority.
    if pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      or pg_catalog.jsonb_array_length(p_mutations) <> 1
      or pg_catalog.jsonb_typeof(p_mutations -> 0) is distinct from 'object'
      or not ((p_mutations -> 0) ?& array['kind', 'targetKind', 'targetId'])
      or (p_mutations -> 0) - array['kind', 'targetKind', 'targetId']::text[] <> '{}'::jsonb
      or (p_mutations -> 0 ->> 'kind') is distinct from 'transfer_ownership'
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetKind') is distinct from 'string'
      or (p_mutations -> 0 ->> 'targetKind') not in ('organization_account', 'group')
      or pg_catalog.jsonb_typeof(p_mutations -> 0 -> 'targetId') is distinct from 'string'
      or not pg_catalog.pg_input_is_valid(p_mutations -> 0 ->> 'targetId', 'uuid') then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    target_kind := p_mutations -> 0 ->> 'targetKind';
    target_id := (p_mutations -> 0 ->> 'targetId')::uuid;
    if p_command_id is null or p_command_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_type_id is null or p_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_record_id is null or p_record_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_expected_concurrency_number is null
      or p_expected_concurrency_number not between 1 and 9007199254740990
      or target_kind is null
      or target_kind not in ('organization_account', 'group')
      or target_id is null or target_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_activity_id is null or p_activity_id = '00000000-0000-0000-0000-000000000000'::uuid
      or p_occurrence_id is null or p_occurrence_id = '00000000-0000-0000-0000-000000000000'::uuid then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
    end if;

    context_value := vortex_access.lock_human_request_access_version_internal();
    if not context_value ? 'applicationRootId' then
      raise exception using errcode = '42501', message = 'Record ownership transfer requires an Application context';
    end if;
    organization_id_value := (context_value ->> 'organizationId')::uuid;
    application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
    actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
    receipt_claim := vortex_record.claim_command_receipt_internal(
      'record_save', p_command_id, false
    );
    if receipt_claim ->> 'status' is distinct from 'claimed' then
      if receipt_claim ->> 'status' = 'identity_conflict' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'command_identity_conflict',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      if receipt_claim ->> 'status' is distinct from 'completed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'conflict', 'correlationId', context_value -> 'correlationId'
        );
      end if;
      -- A replay reprojects from current access and intentionally never returns
      -- owner metadata (including the prior target).
      loaded := vortex_record.read_record(
        p_record_type_id, (receipt_claim ->> 'recordId')::uuid
      );
      if loaded ->> 'outcome' <> 'allowed' then
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'transferred', 'recordId', loaded -> 'recordId',
        'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', context_value -> 'correlationId', 'replayed', true
      );
    end if;
    -- The closed transfer authority is its own exact record permission decision;
    -- it is evaluated under the record lock, while owner columns remain
    -- unavailable to the ordinary update writer.
    -- Public transfer is active-installation-only.  It deliberately never calls
    -- the retained/detached reader, so a detached record cannot leak its current
    -- revision through the ordinary conflict response.
    begin
      installation := vortex_definition.read_current_active_installation();
    exception
      when no_data_found then
        perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
        return pg_catalog.jsonb_build_object(
          'outcome', 'refused', 'reasonCode', 'record_unavailable',
          'correlationId', context_value -> 'correlationId'
        );
    end;
    loaded := vortex_record.load_record_access_facts_for_transfer_installation_internal(
      p_record_type_id, p_record_id, p_expected_concurrency_number, installation
    );
    if loaded ->> 'outcome' = 'conflict' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'concurrencyNumber', loaded -> 'concurrencyNumber',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if loaded ->> 'outcome' <> 'loaded' or pg_catalog.jsonb_typeof(loaded -> 'declaration') <> 'object' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    select item.value into record_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
    where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
    select item.value into record_type_fact
    from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
    where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
    if record_fact is null or record_type_fact is null
      or record_fact ->> 'lifecycleState' <> 'active' then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    ownership_mode := record_type_fact ->> 'ownershipMode';
    decision := vortex_access.evaluate_organization_record_access_internal(
      loaded -> 'declaration', p_record_id, loaded -> 'facts'
    );
    if decision ->> 'outcome' = 'refused' then
      perform vortex_record.append_ownership_transfer_activity_internal(
        p_activity_id, organization_id_value, 'refused'
      );
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused_recorded', 'reasonCode', 'record_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    elsif decision ->> 'outcome' <> 'allowed' then
      raise exception using errcode = '42501', message = 'Record ownership transfer authority is unavailable';
    end if;
    if ownership_mode = 'organization_account' then
      previous_owner_id := (record_fact ->> 'ownerOrganizationAccountId')::uuid;
    elsif ownership_mode = 'group' then
      previous_owner_id := (record_fact ->> 'ownerGroupId')::uuid;
    else
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'ownership_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    if (ownership_mode = 'organization_account' and target_kind <> 'organization_account')
      or (ownership_mode = 'group' and target_kind <> 'group')
      or previous_owner_id is null or previous_owner_id = target_id
      or not vortex_access.lock_active_record_ownership_target_internal(target_kind, target_id) then
      perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'owner_unavailable',
        'correlationId', context_value -> 'correlationId'
      );
    end if;
    execute pg_catalog.format(
      'update record_data.%I as stored set owner_organisation_account_id = $3,
         owner_group_id = $4, concurrency_number = concurrency_number + 1,
         updated_at = pg_catalog.statement_timestamp(), updated_by = $5
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.concurrency_number = $6 returning stored.record_id, stored.concurrency_number',
      loaded ->> 'table'
    ) into updated_record_id, updated_concurrency_number using organization_id_value, p_record_id,
      case when target_kind = 'organization_account' then target_id else null end,
      case when target_kind = 'group' then target_id else null end,
      actor_id_value, p_expected_concurrency_number;
    get diagnostics changed_rows = row_count;
    if changed_rows <> 1 then
      raise exception using errcode = '40001', message = 'Record ownership transfer revision changed';
    end if;
    if updated_record_id is distinct from p_record_id
      or updated_concurrency_number is null
      or updated_concurrency_number not between 1 and 9007199254740991 then
      raise exception using errcode = '55000', message = 'Record ownership transfer saved identity is unavailable';
    end if;
    perform vortex_access.invalidate_preview_installations_internal(organization_id_value);
    perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id, p_record_id, 'completed');
    event_result := vortex_platform.append_record_occurrences(
      (record_type_fact ->> 'storageContractId')::uuid,
      p_record_id, pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'occurrenceId', p_occurrence_id,
        'descriptor', pg_catalog.jsonb_build_object(
          'kind', 'standard', 'eventKind', 'reassigned', 'recordTypeId', p_record_type_id
        ), 'payload', pg_catalog.jsonb_build_object('kind', 'reassigned')
      ))
    );
    if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    if pg_catalog.jsonb_array_length(event_result) is distinct from 1 then
      raise exception using errcode = '55000', message = 'Record ownership transfer Event append failed';
    end if;
    perform vortex_record.complete_command_receipt_internal(
      'record_save', p_command_id, p_record_id, updated_concurrency_number,
      'Record ownership transfer receipt is stale'
    );
    if record_fact #>> '{recordScope,storageScope}' = 'application_contained' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        perform vortex_platform.publish_change_notice(
          organization_id_value, application_root_id_value, p_record_type_id,
          updated_record_id, updated_concurrency_number, 'changed',
          notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
        );
      exception when others then
        -- Invalidation is advisory after the protected transfer is complete.
        null;
      end;
    elsif record_fact #>> '{recordScope,storageScope}' = 'organization_shared' then
      begin
        notice_sequence := pg_catalog.nextval('vortex_record.record_invalidation_sequence'::regclass);
        if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
          raise exception using errcode = '22003',
            message = 'Shared ownership transfer notice sequence is unavailable';
        end if;

        if record_fact -> 'recordScope' ->> 'moduleRootId'
            is distinct from record_type_fact ->> 'moduleRootId'
          or record_fact -> 'recordScope' ->> 'storageContractId'
            is distinct from record_type_fact ->> 'storageContractId'
          or not vortex_platform.is_non_nil_uuid(record_fact -> 'recordScope' ->> 'moduleRootId')
          or not vortex_platform.is_non_nil_uuid(record_type_fact ->> 'storageContractId') then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer record lineage is unavailable';
        end if;

        shared_consumers_initial := vortex_definition.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if pg_catalog.jsonb_typeof(shared_consumers_initial) is distinct from 'object'
          or not (shared_consumers_initial ?& array['organizationId', 'accessVersion', 'targets'])
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(shared_consumers_initial)) <> 3
          or shared_consumers_initial ->> 'organizationId' is distinct from organization_id_value::text
          or not pg_catalog.pg_input_is_valid(shared_consumers_initial ->> 'accessVersion', 'bigint')
          or (shared_consumers_initial ->> 'accessVersion')::bigint
            is distinct from (context_value ->> 'accessVersion')::bigint
          or pg_catalog.jsonb_typeof(shared_consumers_initial -> 'targets') is distinct from 'array'
          or pg_catalog.jsonb_array_length(shared_consumers_initial -> 'targets') = 0 then
          raise exception using errcode = '55000',
            message = 'Shared ownership transfer consumer selection is malformed';
        end if;

        previous_target_application_root_id := null;
        origin_application_is_consumer := false;
        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          if pg_catalog.jsonb_typeof(target_item) is distinct from 'object'
            or not (target_item ?& array[
              'applicationRootId', 'applicationReleaseRevision', 'moduleRootId',
              'moduleReleaseRevision', 'bindingRevision', 'recordTypeId',
              'storageContractId', 'registrationRevision', 'definitionKey',
              'releaseVersion', 'validationContractVersion', 'contentFingerprint',
              'resolutionFingerprint', 'catalogueFingerprint', 'moduleBindings'
            ])
            or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(target_item)) <> 15
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'applicationRootId')
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'moduleRootId')
            or not vortex_platform.is_non_nil_uuid(target_item ->> 'storageContractId')
            or not pg_catalog.pg_input_is_valid(target_item ->> 'applicationReleaseRevision', 'bigint')
            or (target_item ->> 'applicationReleaseRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'moduleRootId' is distinct from record_fact -> 'recordScope' ->> 'moduleRootId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'moduleReleaseRevision', 'bigint')
            or (target_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
            or not pg_catalog.pg_input_is_valid(target_item ->> 'bindingRevision', 'bigint')
            or (target_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'recordTypeId' is distinct from p_record_type_id::text
            or target_item ->> 'storageContractId'
              is distinct from record_type_fact ->> 'storageContractId'
            or not pg_catalog.pg_input_is_valid(target_item ->> 'registrationRevision', 'bigint')
            or (target_item ->> 'registrationRevision')::bigint not between 1 and 9007199254740991
            or target_item ->> 'definitionKey' is null or target_item ->> 'definitionKey' = ''
            or target_item ->> 'releaseVersion' is null or target_item ->> 'releaseVersion' = ''
            or target_item ->> 'validationContractVersion' is null
            or target_item ->> 'validationContractVersion' = ''
            or target_item ->> 'contentFingerprint' is null
            or target_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'resolutionFingerprint' is null
            or target_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or target_item ->> 'catalogueFingerprint' is null
            or target_item ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
            or pg_catalog.jsonb_typeof(target_item -> 'moduleBindings') is distinct from 'array'
            or pg_catalog.jsonb_array_length(target_item -> 'moduleBindings') = 0 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer evidence is malformed';
          end if;

          target_application_root_id := (target_item ->> 'applicationRootId')::uuid;
          if previous_target_application_root_id is not null
            and target_application_root_id <= previous_target_application_root_id then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer consumer set is not unique and ordered';
          end if;
          previous_target_application_root_id := target_application_root_id;
          if target_application_root_id = application_root_id_value then
            origin_application_is_consumer := true;
          end if;

          previous_target_module_root_id := null;
          target_module_binding_count := 0;
          for module_item in
            select binding.value
            from pg_catalog.jsonb_array_elements(target_item -> 'moduleBindings') as binding(value)
            order by (binding.value ->> 'moduleRootId')::uuid
          loop
            if pg_catalog.jsonb_typeof(module_item) is distinct from 'object'
              or not (module_item ?& array[
                'moduleRootId', 'bindingRevision', 'applicationReleaseRevision',
                'moduleReleaseRevision', 'state', 'contentFingerprint',
                'resolutionFingerprint', 'generatorContractVersion', 'storageContractIds'
              ])
              or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(module_item)) <> 9
              or not vortex_platform.is_non_nil_uuid(module_item ->> 'moduleRootId')
              or not pg_catalog.pg_input_is_valid(module_item ->> 'bindingRevision', 'bigint')
              or (module_item ->> 'bindingRevision')::bigint not between 1 and 9007199254740991
              or not pg_catalog.pg_input_is_valid(module_item ->> 'applicationReleaseRevision', 'bigint')
              or (module_item ->> 'applicationReleaseRevision')::bigint
                is distinct from (target_item ->> 'applicationReleaseRevision')::bigint
              or not pg_catalog.pg_input_is_valid(module_item ->> 'moduleReleaseRevision', 'bigint')
              or (module_item ->> 'moduleReleaseRevision')::bigint not between 1 and 9007199254740991
              or module_item ->> 'state' is distinct from 'active'
              or module_item ->> 'contentFingerprint' is null
              or module_item ->> 'contentFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'resolutionFingerprint' is null
              or module_item ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
              or module_item ->> 'generatorContractVersion' is distinct from '1.0.0'
              or pg_catalog.jsonb_typeof(module_item -> 'storageContractIds') is distinct from 'array'
              or pg_catalog.jsonb_array_length(module_item -> 'storageContractIds') = 0
              or exists (
                select 1
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                where pg_catalog.jsonb_typeof(contract.value) is distinct from 'string'
                  or not vortex_platform.is_non_nil_uuid(contract.value #>> '{}')
              )
              or exists (
                select contract.value
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                group by contract.value having pg_catalog.count(*) <> 1
              )
              or module_item -> 'storageContractIds' is distinct from (
                select pg_catalog.jsonb_agg(contract.value order by (contract.value #>> '{}')::uuid)
                from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
              ) then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module binding evidence is malformed';
            end if;

            target_module_root_id := (module_item ->> 'moduleRootId')::uuid;
            if previous_target_module_root_id is not null
              and target_module_root_id <= previous_target_module_root_id then
              raise exception using errcode = '55000',
                message = 'Shared ownership transfer Module bindings are not unique and ordered';
            end if;
            previous_target_module_root_id := target_module_root_id;
            if target_module_root_id = (target_item ->> 'moduleRootId')::uuid then
              target_module_binding_count := target_module_binding_count + 1;
              if (module_item ->> 'moduleReleaseRevision')::bigint
                  is distinct from (target_item ->> 'moduleReleaseRevision')::bigint
                or (module_item ->> 'bindingRevision')::bigint
                  is distinct from (target_item ->> 'bindingRevision')::bigint
                or not exists (
                  select 1
                  from pg_catalog.jsonb_array_elements(module_item -> 'storageContractIds') as contract(value)
                  where contract.value #>> '{}' = target_item ->> 'storageContractId'
                ) then
                raise exception using errcode = '55000',
                  message = 'Shared ownership transfer target binding does not match its complete Module lineage';
              end if;
            end if;
          end loop;
          if target_module_binding_count <> 1 then
            raise exception using errcode = '55000',
              message = 'Shared ownership transfer target Module binding is ambiguous';
          end if;
        end loop;

        if not origin_application_is_consumer then
          raise exception using errcode = '42501',
            message = 'Origin Application is not a proved shared record consumer';
        end if;

        shared_consumers_final := vortex_definition.read_active_shared_record_consumers_internal(
          (record_fact -> 'recordScope' ->> 'moduleRootId')::uuid,
          p_record_type_id,
          (record_type_fact ->> 'storageContractId')::uuid
        );
        if shared_consumers_final is distinct from shared_consumers_initial then
          raise exception using errcode = '40001',
            message = 'Shared ownership transfer consumer snapshot changed before publication';
        end if;
        context_after := vortex_access.validated_human_request_context();
        if context_after is distinct from context_value then
          raise exception using errcode = '40001',
            message = 'Human ownership transfer context changed before publication';
        end if;

        for target_item in
          select item.value
          from pg_catalog.jsonb_array_elements(shared_consumers_initial -> 'targets') as item(value)
          order by (item.value ->> 'applicationRootId')::uuid
        loop
          perform vortex_platform.publish_change_notice(
            organization_id_value, (target_item ->> 'applicationRootId')::uuid,
            p_record_type_id, updated_record_id, updated_concurrency_number, 'changed',
            notice_sequence, notice_sequence, (context_value ->> 'correlationId')::uuid
          );
        end loop;
      exception when others then
        -- The completed transfer is structural. All App-scoped notices are one
        -- advisory subtransaction, so a failure rolls back every send together.
        null;
      end;
    else
      raise exception using errcode = '55000',
        message = 'Ownership transfer storage scope is unavailable';
    end if;
    -- This is deliberately an undisclosed result: an authorised transfer may
    -- remove the operator's read path.  A post-write projection would turn that
    -- valid committed mutation into a rollback.  Exact replay still applies
    -- current disclosure separately above.
    return pg_catalog.jsonb_build_object(
      'outcome', 'transferred', 'recordId', updated_record_id,
      'concurrencyNumber', updated_concurrency_number,
      'correlationId', context_value -> 'correlationId', 'replayed', false
    );
  end if;

  return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
end
$function$;

alter function vortex_record.apply_lifecycle_record_changes_internal(text,uuid,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_record_adapter;
comment on function vortex_record.apply_lifecycle_record_changes_internal(
  text, uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'The terminal delete, restore and ownership-transfer record-change writes, applied inside the one protected operation: each keeps its own receipt kind, Activity and Event, and completes the preflight its protected preflight (delete and restore) or itself (ownership transfer) claimed.';

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
  actor_id_value uuid; receipt_claim jsonb;
  loaded jsonb; decision jsonb; record_fact jsonb; type_fact jsonb;
  previous_owner uuid; updated_concurrency bigint; changed_rows integer; event_result jsonb;
  evaluation_facts jsonb;
  updated_record_id uuid; updated_organization_id uuid; updated_application_root_id uuid;
  storage_scope_value text; preview_installation jsonb;
  exact_notice boolean := false; notice_sequence bigint;
  correlation_id_value uuid;
begin
  if p_command_id is null or p_record_type_id is null or p_record_id is null
    or p_expected_concurrency_number is null
    or p_expected_concurrency_number not between 1 and 9007199254740990
    or p_target_kind is distinct from 'organization_account' or p_target_id is null
    or p_activity_id is null or p_occurrence_id is null
    or p_source_organization_account_id is null
    or p_source_organization_account_id = '00000000-0000-0000-0000-000000000000'::uuid then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'command_invalid');
  end if;
  context_value := vortex_access.lock_human_request_access_version_internal();
  if not context_value ? 'applicationRootId' then
    raise exception using errcode = '42501', message = 'Offboarding ownership transfer requires an Application context';
  end if;
  organization_id_value := (context_value ->> 'organizationId')::uuid;
  application_root_id_value := (context_value ->> 'applicationRootId')::uuid;
  actor_id_value := (context_value ->> 'organizationAccountId')::uuid;
  correlation_id_value := (context_value ->> 'correlationId')::uuid;
  if correlation_id_value is null or not vortex_platform.is_non_nil_uuid(correlation_id_value::text) then
    raise exception using errcode='42501',message='Offboarding ownership transfer authority is unavailable';
  end if;
  receipt_claim := vortex_record.claim_command_receipt_internal(
    'record_save', p_command_id, false
  );
  if receipt_claim ->> 'status' is distinct from 'claimed' then
    if receipt_claim ->> 'status' = 'identity_conflict' then
      return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','command_identity_conflict','correlationId',context_value -> 'correlationId');
    end if;
    if receipt_claim ->> 'status' is distinct from 'completed' then
      return pg_catalog.jsonb_build_object('outcome','conflict','correlationId',context_value -> 'correlationId');
    end if;
    return pg_catalog.jsonb_build_object('outcome','transferred','recordId',(receipt_claim ->> 'recordId')::uuid,
      'concurrencyNumber',(receipt_claim ->> 'concurrencyNumber')::bigint,'correlationId',context_value -> 'correlationId','replayed',true);
  end if;
  loaded := vortex_record.load_offboarding_ownership_transfer_facts_internal(
    p_record_type_id,p_record_id,p_expected_concurrency_number);
  if loaded ->> 'outcome' = 'conflict' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','conflict','concurrencyNumber',loaded -> 'concurrencyNumber','correlationId',context_value -> 'correlationId');
  end if;
  if loaded ->> 'outcome' is distinct from 'loaded'
    or pg_catalog.jsonb_typeof(loaded -> 'declaration') is distinct from 'object'
    or loaded ->> 'installationState' is null
    or loaded ->> 'installationState' not in ('active', 'detached')
    or pg_catalog.jsonb_typeof(loaded -> 'facts') is distinct from 'object'
    or pg_catalog.jsonb_typeof(loaded #> '{facts,records}') is distinct from 'array'
    or pg_catalog.jsonb_typeof(loaded #> '{facts,recordTypes}') is distinct from 'array' then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  select item.value into record_fact from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'records') as item(value)
  where (item.value -> 'recordScope' ->> 'recordId')::uuid = p_record_id;
  select item.value into type_fact from pg_catalog.jsonb_array_elements(loaded -> 'facts' -> 'recordTypes') as item(value)
  where (item.value ->> 'recordTypeId')::uuid = p_record_type_id;
  storage_scope_value := record_fact #>> '{recordScope,storageScope}';
  if pg_catalog.jsonb_typeof(record_fact) is distinct from 'object'
    or pg_catalog.jsonb_typeof(type_fact) is distinct from 'object'
    or record_fact ->> 'lifecycleState' is null
    or record_fact ->> 'lifecycleState' not in ('active','soft_deleted')
    or (loaded ->> 'installationState' = 'active' and record_fact ->> 'lifecycleState' is distinct from 'soft_deleted')
    or type_fact ->> 'ownershipMode' is distinct from 'organization_account'
    or storage_scope_value is null
    or storage_scope_value not in ('application_contained', 'organization_shared')
    or (record_fact #>> '{recordScope,organizationId}')::uuid is distinct from organization_id_value
    or (record_fact #>> '{recordScope,recordTypeId}')::uuid is distinct from p_record_type_id
    or (record_fact #>> '{recordScope,storageContractId}')::uuid is distinct from (type_fact ->> 'storageContractId')::uuid
    or type_fact ->> 'storageContractId' is null
    or not vortex_platform.is_non_nil_uuid(type_fact ->> 'storageContractId')
    or (storage_scope_value = 'application_contained'
      and (record_fact #>> '{recordScope,applicationRootId}')::uuid is distinct from application_root_id_value)
    or (record_fact ->> 'ownerOrganizationAccountId')::uuid is distinct from p_source_organization_account_id then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','owner_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  -- Retained rows are never restored.  The unchanged complete Access
  -- evaluator sees only this locked target as active in an in-memory facts
  -- view, preserving every existing transfer route and condition.
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
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused_recorded','reasonCode','record_unavailable','correlationId',context_value -> 'correlationId');
  elsif decision ->> 'outcome' is distinct from 'allowed' then
    raise exception using errcode='42501', message='Offboarding ownership transfer authority is unavailable';
  end if;
  if not vortex_access.lock_active_record_ownership_target_internal('organization_account',p_target_id)
    or p_target_id = p_source_organization_account_id then
    perform vortex_record.release_command_receipt_internal('record_save', p_command_id);
    return pg_catalog.jsonb_build_object('outcome','refused','reasonCode','owner_unavailable','correlationId',context_value -> 'correlationId');
  end if;
  execute pg_catalog.format(
    'update record_data.%I as stored set owner_organisation_account_id=$3,owner_group_id=null,concurrency_number=concurrency_number+1,updated_at=pg_catalog.statement_timestamp(),updated_by=$4 where stored.organisation_id=$1 and stored.record_id=$2 and stored.concurrency_number=$5 returning stored.record_id,stored.concurrency_number,stored.organisation_id,%s',
    loaded ->> 'table',
    case when storage_scope_value = 'application_contained'
      then 'stored.application_root_id' else 'null::uuid' end
  ) into updated_record_id,updated_concurrency,updated_organization_id,updated_application_root_id
    using organization_id_value,p_record_id,p_target_id,actor_id_value,p_expected_concurrency_number;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then raise exception using errcode='40001',message='Offboarding ownership transfer revision changed'; end if;
  if updated_record_id is distinct from p_record_id
    or not vortex_platform.is_non_nil_uuid(updated_record_id::text)
    or updated_organization_id is distinct from organization_id_value
    or updated_concurrency is null
    or updated_concurrency not between 1 and 9007199254740991
    or (storage_scope_value = 'application_contained'
      and updated_application_root_id is distinct from application_root_id_value) then
    raise exception using errcode='40001',message='Offboarding ownership transfer revision changed';
  end if;
  perform vortex_access.invalidate_preview_installations_internal(organization_id_value);
  preview_installation := vortex_record.read_current_preview_installation_internal();
  if preview_installation ->> 'outcome' = 'refused' then
    raise exception using errcode='42501',message='Preview Record context is unavailable';
  end if;
  exact_notice := preview_installation is null
    and loaded ->> 'installationState' = 'active'
    and storage_scope_value = 'application_contained';
  if exact_notice then
    -- Defer the exact notice until the protected transfer is complete.
    null;
  else
    perform vortex_record.bump_record_data_version_internal(
      organization_id_value, (type_fact ->> 'storageContractId')::uuid,
      case when storage_scope_value = 'application_contained'
        then application_root_id_value else null end
    );
  end if;
  perform vortex_record.append_ownership_transfer_activity_internal(p_activity_id,p_record_id,'completed');
  if loaded ->> 'installationState' = 'detached' then
    event_result := vortex_platform.append_detached_offboarding_reassignment_internal(
      (type_fact ->> 'storageContractId')::uuid, p_record_id, p_record_type_id, p_occurrence_id
    );
  else
    event_result := vortex_platform.append_record_occurrences(
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
  if pg_catalog.jsonb_typeof(event_result) is distinct from 'array' then
    raise exception using errcode='55000',message='Offboarding ownership transfer Event append failed';
  end if;
  if pg_catalog.jsonb_array_length(event_result) <> 1 then raise exception using errcode='55000',message='Offboarding ownership transfer Event append failed'; end if;
  perform vortex_record.complete_command_receipt_internal(
    'record_save', p_command_id, updated_record_id, updated_concurrency,
    'Offboarding ownership transfer receipt is stale'
  );
  if exact_notice then
    begin
      notice_sequence := pg_catalog.nextval(
        'vortex_record.record_invalidation_sequence'::pg_catalog.regclass
      );
      if notice_sequence is null or notice_sequence not between 1 and 9007199254740991 then
        raise exception using errcode='22023',message='Invalidation notice command is invalid';
      end if;
      perform vortex_platform.publish_change_notice(
        updated_organization_id, updated_application_root_id, p_record_type_id,
        updated_record_id, updated_concurrency, 'changed',
        notice_sequence, notice_sequence, correlation_id_value
      );
    exception when others then
      -- Notice allocation and publication are advisory after the protected transfer is complete.
      null;
    end;
  end if;
  return pg_catalog.jsonb_build_object('outcome','transferred','recordId',updated_record_id,
    'concurrencyNumber',updated_concurrency,'correlationId',context_value -> 'correlationId','replayed',false);
end
$function$;

alter function vortex_record.transfer_record_ownership_for_offboarding_internal(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.transfer_record_ownership_for_offboarding_internal(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
comment on function vortex_record.transfer_record_ownership_for_offboarding_internal(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, uuid
) is
  'Private offboarding single-record ownership transfer: the public transfer contract, with the command receipt, Activity and Event, for a named source owner.';

create or replace function vortex_record.transfer_offboarding_active_owned_record(
  p_command_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint,
  p_target_kind text,
  p_target_id uuid,
  p_activity_id uuid,
  p_occurrence_id uuid,
  p_expected_access_version bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
begin
  select authorized.* into strict scope
  from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;
  if p_expected_access_version is null
    or scope.access_version is distinct from p_expected_access_version then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'access_changed');
  end if;

  begin
    return vortex_record.apply_lifecycle_record_changes_internal(
      'transfer_ownership',
      p_command_id,
      p_record_type_id,
      p_record_id,
      p_expected_concurrency_number,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'kind', 'transfer_ownership',
        'targetKind', p_target_kind,
        'targetId', p_target_id
      )),
      p_activity_id,
      p_occurrence_id
    );
  exception
    when serialization_failure or lock_not_available then
      -- Identical per-record boundary to the retained entry: a contested final
      -- update rolls back its own pending receipt and is reported as a
      -- conflict, so one contested record never fails the whole batch.
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end;
end
$function$;

alter function vortex_record.transfer_offboarding_active_owned_record(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,bigint) owner to vortex_record_adapter;

revoke all on function vortex_record.transfer_offboarding_active_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_record_adapter;
grant execute on function vortex_record.transfer_offboarding_active_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, bigint
) to vortex_request;
comment on function vortex_record.transfer_offboarding_active_owned_record(
  uuid, uuid, uuid, bigint, text, uuid, uuid, uuid, bigint
) is
  'Protected request entry for one disclosed account-offboarding transfer of an ordinary active record; it rechecks accounts.manage scope and delegates all target, owner, lifecycle, authority and revision checks to the one record-change operation''s terminal ownership transfer.';

CREATE FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  scope record;
begin
  -- Re-admit the current accounts.manage scope for every item. The nested
  -- fixed transfer then reloads record facts, locks the target and requires the
  -- caller's expected concurrency number before it can mutate anything.
  select authorized.* into strict scope
  from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;
  if p_expected_access_version is null
    or scope.access_version is distinct from p_expected_access_version then
    return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'access_changed');
  end if;

  begin
    return vortex_record.transfer_record_ownership_for_offboarding_internal(
      p_command_id,
      p_record_type_id,
      p_record_id,
      p_expected_concurrency_number,
      p_target_kind,
      p_target_id,
      p_activity_id,
      p_occurrence_id,
      p_source_organization_account_id
    );
  exception
    when serialization_failure or lock_not_available then
      -- A contested final update is an expected per-record result. The nested
      -- exception block rolls back its pending receipt before returning it.
      return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end;
end
$$;
alter function vortex_record.transfer_offboarding_owned_record(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,uuid,bigint) owner to vortex_record_adapter;


COMMENT ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) IS 'Protected request entry for one disclosed account-offboarding retained or disabled-installation transfer; it rechecks accounts.manage scope and delegates all target, owner, lifecycle and revision checks to the fixed adapter-only operation.';

REVOKE ALL ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) FROM vortex_record_adapter;
GRANT ALL ON FUNCTION vortex_record.transfer_offboarding_owned_record(p_command_id uuid, p_record_type_id uuid, p_record_id uuid, p_expected_concurrency_number bigint, p_target_kind text, p_target_id uuid, p_activity_id uuid, p_occurrence_id uuid, p_source_organization_account_id uuid, p_expected_access_version bigint) TO vortex_request;

reset role;
