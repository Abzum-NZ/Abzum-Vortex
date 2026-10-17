create or replace function vortex_record.read_retired_preview_storage_internal(
  p_limit integer
)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  -- Storage whose preview row is gone: no request reaches it, and the background drops it.
  select binding.storage_contract_id
  from vortex_record.preview_storage_bindings as binding
  where not exists (
    select 1 from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = binding.preview_installation_id
  )
  order by binding.storage_contract_id
  limit greatest(1, least(coalesce(p_limit, 1), 100));
$function$;

alter function vortex_record.read_retired_preview_storage_internal(integer) owner to vortex_owner;

revoke all on function vortex_record.read_retired_preview_storage_internal(integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.read_retired_preview_storage_internal(integer)
  to vortex_runtime;
comment on function vortex_record.read_retired_preview_storage_internal(integer) is
  'Lists a bounded batch of retired preview storage identities (their preview is gone) for the background drop.';
