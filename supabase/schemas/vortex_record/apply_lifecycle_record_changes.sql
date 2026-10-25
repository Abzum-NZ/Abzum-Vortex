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
  -- Closed lifecycle entry to apply_record_changes. Delete alone accepts null
  -- mutations to begin its traversal; the second call supplies calculated parent
  -- mutations and finalises the same command in the same request transaction.
  if p_operation is null
    or p_operation not in ('delete', 'restore', 'transfer_ownership')
    or (pg_catalog.jsonb_typeof(p_mutations) is distinct from 'array'
      and not (p_operation = 'delete' and p_mutations is null)) then
    return pg_catalog.jsonb_build_object(
      'outcome', 'refused', 'reasonCode', 'command_invalid'
    );
  end if;

  result_value := vortex_record.apply_record_changes(
    p_command_id, p_operation, p_record_type_id, p_record_id,
    p_expected_concurrency_number, '{}'::jsonb, null,
    p_mutations, p_activity_id, p_occurrence_id
  );
  if p_operation <> 'transfer_ownership' then
    return result_value;
  end if;

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
  'The request role''s closed entry to delete preparation and finalisation, restore and ownership-transfer record-change writes: it refuses any other operation and delegates once to the one protected apply_record_changes operation.';
