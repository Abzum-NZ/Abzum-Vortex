create or replace function vortex_record.lock_relationship_target_row_internal(
  p_target_record_type_id uuid,
  p_target_record_id uuid,
  p_organization_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  target_meta jsonb;
  target_schema text;
  target_protected_read_model_key text;
  target_locked boolean;
begin
  if p_target_record_type_id is null or p_target_record_id is null
    or p_organization_id is null
    or p_target_record_type_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_target_record_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_organization_id = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023',
      message = 'Relationship target is invalid';
  end if;

  target_meta := vortex_record.resolve_record_action_context_internal(
    p_target_record_type_id, 'read'
  );
  select catalogue.physical_schema_token, catalogue.protected_read_model_key
    into target_schema, target_protected_read_model_key
  from vortex_record.storage_catalogue as catalogue
  where catalogue.storage_contract_id = (target_meta ->> 'storageContractId')::uuid
    and catalogue.record_type_id = p_target_record_type_id
    and catalogue.state = 'active';
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Relationship target is unavailable';
  end if;

  if target_schema = 'record_data'
    and pg_catalog.jsonb_typeof(target_meta -> 'table') = 'string' then
    target_locked := false;
    execute pg_catalog.format(
      'select true from record_data.%I as stored
       where stored.organisation_id = $1 and stored.record_id = $2
         and stored.lifecycle_state = ''active'' for share',
      target_meta ->> 'table'
    ) into target_locked using p_organization_id, p_target_record_id;
  elsif target_schema = 'system_projection' then
    target_locked := vortex_access.lock_system_projection_link_target_internal(
      target_protected_read_model_key, p_target_record_id, p_organization_id
    );
  else
    target_locked := false;
  end if;

  if not coalesce(target_locked, false) then
    raise exception using errcode = 'P0002',
      message = 'Relationship target is unavailable';
  end if;
end
$function$;

alter function vortex_record.lock_relationship_target_row_internal(uuid, uuid, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.lock_relationship_target_row_internal(uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_module_owner;

grant execute on function vortex_record.lock_relationship_target_row_internal(uuid, uuid, uuid)
  to vortex_record_adapter, vortex_record_owner;

comment on function vortex_record.lock_relationship_target_row_internal(uuid, uuid, uuid) is
  'One canonical protected target lock for relationship changes: share-locks an active record_data row or delegates registered People and Group projections to Access for an active same-organisation protected-row lock before the link edge is installed.';
