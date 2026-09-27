create or replace function vortex_module.expire_preview_installations(
  p_limit integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  preview_row record;
  expired_count integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'Preview expiry batch size is invalid';
  end if;
  checked_context := vortex_module.assert_preview_installation_authority_internal();
  for preview_row in
    select preview.preview_installation_id
    from vortex_module.preview_installations as preview
    where preview.organization_id = (checked_context ->> 'organizationId')::uuid
      and preview.expires_at <= pg_catalog.statement_timestamp()
    order by preview.expires_at, preview.preview_installation_id
    limit p_limit
    for update skip locked
  loop
    perform vortex_record.drop_preview_installation_storage(
      preview_row.preview_installation_id
    );
    delete from vortex_module.preview_installations as preview
    where preview.preview_installation_id = preview_row.preview_installation_id;
    expired_count := expired_count + 1;
  end loop;
  return expired_count;
end
$function$;

alter function vortex_module.expire_preview_installations(integer) owner to vortex_module_owner;

revoke all on function vortex_module.expire_preview_installations(integer)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_module.expire_preview_installations(integer)
  to vortex_request, vortex_module_owner;
comment on function vortex_module.expire_preview_installations(integer) is
  'Purges a bounded batch of expired preview installations in the current human organisation, including their isolated Record storage.';
