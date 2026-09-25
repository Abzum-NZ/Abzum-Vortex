create or replace function vortex_record.read_exact_module_storage_provision(
  p_module_root_id uuid,
  p_module_release_revision bigint
)
returns table (
  module_root_id uuid,
  release_revision bigint,
  storage_contract_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_module_root_id is null
    or p_module_root_id = '00000000-0000-0000-0000-000000000000'::uuid
    or p_module_release_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Exact Module storage provision input is invalid';
  end if;

  return query
  select provision.module_root_id, provision.release_revision,
    provision.storage_contract_ids
  from vortex_record.release_provisions as provision
  where provision.module_root_id = p_module_root_id
    and provision.release_revision = p_module_release_revision;
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Exact Module storage provision evidence is unavailable';
  end if;
end
$function$;

revoke all on function vortex_record.read_exact_module_storage_provision(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_adapter, vortex_module_owner;
grant execute on function vortex_record.read_exact_module_storage_provision(uuid, bigint)
  to vortex_module_owner;
comment on function vortex_record.read_exact_module_storage_provision(uuid, bigint) is
  'Record-owned read of one exact immutable Module release provision for installation activation.';
