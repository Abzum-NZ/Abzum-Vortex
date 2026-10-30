create or replace function vortex_record.apply_record_mutations_internal(
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
  preview_installation jsonb;
  offboarding_scope record;
  offboarding_transfer jsonb;
begin
  preview_installation :=
    vortex_record.read_current_preview_installation_internal();
  if preview_installation is not null then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused',
      'reasonCode', case when preview_installation ->> 'outcome' = 'refused'
        then 'record_unavailable' else 'preview_effect_refused' end
    );
  end if;

  -- An account offboarding transfer of a retained row or of a detached installation's record has
  -- its own facts and the accounts.manage authority of the offboarding inventory, rechecked here
  -- for every record against the access version the inventory was disclosed at.
  if pg_catalog.jsonb_typeof(p_mutations) = 'array'
    and pg_catalog.jsonb_array_length(p_mutations) = 1
    and p_mutations -> 0 ->> 'kind' = 'offboarding_transfer' then
    offboarding_transfer := p_mutations -> 0;
    if pg_catalog.jsonb_typeof(offboarding_transfer -> 'expectedAccessVersion') is distinct from 'number'
      or pg_catalog.jsonb_typeof(offboarding_transfer -> 'sourceOrganizationAccountId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(offboarding_transfer -> 'targetId') is distinct from 'string' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'refused', 'reasonCode', 'command_invalid'
      );
    end if;
    select authorized.* into strict offboarding_scope
    from vortex_access.organization_accounts_offboarding_inventory_scope_internal() as authorized;
    if offboarding_scope.access_version
      is distinct from (offboarding_transfer ->> 'expectedAccessVersion')::bigint then
      return pg_catalog.jsonb_build_object('outcome', 'refused', 'reasonCode', 'access_changed');
    end if;
    return vortex_record.transfer_record_ownership_for_offboarding_internal(
      p_command_id, p_record_type_id, p_record_id, p_expected_concurrency_number,
      offboarding_transfer ->> 'targetKind', (offboarding_transfer ->> 'targetId')::uuid,
      p_activity_id, p_occurrence_id,
      (offboarding_transfer ->> 'sourceOrganizationAccountId')::uuid
    );
  end if;

  -- Access ownership transfer retains its exact protected authority and receipt.
  return vortex_record.apply_lifecycle_record_changes_internal(
    'transfer_ownership', p_command_id, p_record_type_id, p_record_id,
    p_expected_concurrency_number, p_mutations, p_activity_id, p_occurrence_id
  );
end
$function$;

alter function vortex_record.apply_record_mutations_internal(uuid,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_record_mutations_internal(
  uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_record_mutations_internal(
  uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_record_adapter;

comment on function vortex_record.apply_record_mutations_internal(
  uuid, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'The private ownership-transfer core shared by the Access ownership and offboarding entries: an offboarding transfer rechecks the accounts.manage inventory scope and its access version; an ownership transfer applies through the protected lifecycle preparation. Record commands use apply_record_changes; previews refuse transfers.';
