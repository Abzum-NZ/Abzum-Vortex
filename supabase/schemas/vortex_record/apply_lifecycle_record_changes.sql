create or replace function vortex_record.apply_lifecycle_record_changes(
  p_command_id uuid,
  p_operation text,
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
  result_value jsonb;
  correlation_id_value uuid;
begin
  -- Ownership transfer is an Access command with its own exact authority.
  -- Record deletion and restore enter only through the common record writer.
  if p_operation is distinct from 'transfer_ownership'
    or pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
    or coalesce(pg_catalog.jsonb_path_exists(
      p_mutations, '$[*] ? (@.kind == "offboarding_transfer")'
    ), false) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  result_value := vortex_record.apply_record_mutations_internal(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, '{}'::jsonb, null,
    p_mutations, p_activity_id, p_occurrence_id
  );
  if result_value ->> 'outcome' = 'saved' then
    return result_value - array['values', 'backgroundDelivery']::text[]
      || pg_catalog.jsonb_build_object('outcome', 'transferred');
  end if;
  if result_value ->> 'outcome' in ('conflict', 'refused') then
    correlation_id_value :=
      (vortex_access.validated_human_request_context() ->> 'correlationId')::uuid;
    return result_value || pg_catalog.jsonb_build_object('correlationId', correlation_id_value);
  end if;
  return result_value;
end
$function$;

alter function vortex_record.apply_lifecycle_record_changes(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.apply_lifecycle_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request;
grant execute on function vortex_record.apply_lifecycle_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) to vortex_request;
comment on function vortex_record.apply_lifecycle_record_changes(
  uuid, text, uuid, uuid, bigint, jsonb, uuid, uuid
) is
  'Protected ownership-transfer entry: refuses record commands and account offboarding transfers, and delegates to the shared mutation core under the transfer authority.';
