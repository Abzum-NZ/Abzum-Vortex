create or replace function vortex_file.record_file_download_grant(
  p_one_time_id uuid,
  p_file_id uuid,
  p_owner_record_type_id uuid,
  p_owner_record_id uuid,
  p_owner_field_id uuid,
  p_actor jsonb,
  p_purpose text,
  p_correlation_id uuid,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  evaluated_at timestamptz := pg_catalog.statement_timestamp();
  established jsonb := vortex_context.validated_service_context();
  request_actor jsonb := vortex_file.upload_request_actor(established);
  request_organization_id uuid := (established ->> 'organizationId')::uuid;
  stored vortex_file.file_records%rowtype;
begin
  if request_actor is null
    or p_actor is distinct from request_actor then
    raise exception using errcode = '42501', message = 'File read scope is unavailable';
  end if;

  if p_one_time_id is null
    or p_file_id is null
    or p_owner_record_type_id is null
    or p_owner_record_id is null
    or p_owner_field_id is null
    or p_correlation_id is null
    or p_purpose is null or p_purpose not in ('download', 'preview')
    or p_expires_at is null
    or p_expires_at <= evaluated_at
    or p_expires_at > evaluated_at + interval '65 seconds' then
    raise exception using errcode = '22023', message = 'File read grant is invalid';
  end if;

  select candidate.* into stored
  from vortex_file.file_records as candidate
  where candidate.file_id = p_file_id
    and candidate.organization_id = request_organization_id;
  if not found
    or stored.lifecycle_state <> 'active'
    or stored.scanner_result <> 'clean'
    or stored.owner_record_type_id is distinct from p_owner_record_type_id
    or stored.owner_record_id is distinct from p_owner_record_id
    or stored.owner_field_id is distinct from p_owner_field_id then
    return pg_catalog.jsonb_build_object('outcome', 'refused');
  end if;

  delete from vortex_file.download_grants as expired
  where expired.ctid in (
    select candidate.ctid
    from vortex_file.download_grants as candidate
    where candidate.organization_id = request_organization_id
      and candidate.expires_at < evaluated_at - interval '1 hour'
    order by candidate.expires_at
    limit 100
  );

  insert into vortex_file.download_grants (
    one_time_id, file_id, organization_id,
    owner_record_type_id, owner_record_id, owner_field_id,
    actor, purpose, correlation_id, expires_at, created_at
  ) values (
    p_one_time_id, p_file_id, request_organization_id,
    p_owner_record_type_id, p_owner_record_id, p_owner_field_id,
    request_actor, p_purpose, p_correlation_id, p_expires_at, evaluated_at
  );

  return pg_catalog.jsonb_build_object('outcome', 'recorded');
end
$function$;

revoke execute on function vortex_file.record_file_download_grant(
  uuid, uuid, uuid, uuid, uuid, jsonb, text, uuid, timestamptz
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_file.record_file_download_grant(
  uuid, uuid, uuid, uuid, uuid, jsonb, text, uuid, timestamptz
) to vortex_request;

comment on function vortex_file.record_file_download_grant(
  uuid, uuid, uuid, uuid, uuid, jsonb, text, uuid, timestamptz
) is
  'Records one unclaimed short-lived read grant for the request actor on an active clean attached file.';
