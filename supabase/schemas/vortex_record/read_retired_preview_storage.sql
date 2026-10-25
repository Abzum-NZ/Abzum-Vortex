create or replace function vortex_record.read_retired_preview_storage(
  p_limit integer
)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  -- A storage binding outlives its preview: deleting a preview leaves the binding as the storage's
  -- retirement identity. Storage whose preview row is gone is reached by no request, and the
  -- background drops it.
  select binding.storage_contract_id
  from vortex_record.preview_storage_bindings as binding
  where not exists (
    select 1 from vortex_definition.preview_installations as preview
    where preview.preview_installation_id = binding.preview_installation_id
  )
  order by binding.storage_contract_id
  limit greatest(1, least(coalesce(p_limit, 1), 100));
$function$;

alter function vortex_record.read_retired_preview_storage(integer) owner to vortex_owner;

revoke all on function vortex_record.read_retired_preview_storage(integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;
grant execute on function vortex_record.read_retired_preview_storage(integer)
  to vortex_runtime;
comment on function vortex_record.read_retired_preview_storage(integer) is
  'Lists a bounded batch of retired preview storage identities (their preview is gone) for the background drop.';
