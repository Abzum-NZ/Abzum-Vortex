set local role vortex_owner;

create or replace function vortex_definition.read_preview_demand(
  p_preview_installation_id uuid,
  p_demand jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  checked_context jsonb;
  preview_row vortex_definition.preview_installations;
  closure_value jsonb;
begin
  checked_context := vortex_definition.assert_preview_installation_authority_internal();
  if nullif(pg_catalog.current_setting('vortex_record.preview_installation_id', true), '')
      is not null then
    raise exception using errcode = '42501', message = 'Preview installation context is unavailable';
  end if;
  select preview.* into preview_row
  from vortex_definition.preview_installations as preview
  where preview.preview_installation_id = p_preview_installation_id
    and preview.organization_id = (checked_context ->> 'organizationId')::uuid
    and (not preview.seedable or preview.application_root_id = (checked_context ->> 'applicationRootId')::uuid)
    and preview.previewer_organization_account_id =
      (checked_context ->> 'organizationAccountId')::uuid
    and preview.expires_at > pg_catalog.statement_timestamp()
    and preview.runtime_release_set is not null;
  if not found then
    raise exception using errcode = '42501', message = 'Preview installation is unavailable';
  end if;
  -- An uninstalled Application has no live records to copy; its draft storage is ready empty.
  closure_value := case when preview_row.seedable
    then vortex_definition.preview_demand_closure_internal(p_preview_installation_id, p_demand)
    else pg_catalog.jsonb_build_object('closure', '[]'::jsonb) end;
  return pg_catalog.jsonb_build_object(
    'draftRevision', preview_row.draft_revision,
    'closure', closure_value -> 'closure',
    'readyRecordTypeIds', coalesce((
      select pg_catalog.jsonb_agg(seed.record_type_id order by seed.record_type_id)
      from vortex_definition.preview_installation_seeds as seed
      where seed.preview_installation_id = p_preview_installation_id
        and seed.derived_ready_at is not null
    ), '[]'::jsonb)
  );
end
$function$;

alter function vortex_definition.read_preview_demand(uuid, jsonb) owner to vortex_owner;
revoke all on function vortex_definition.read_preview_demand(uuid, jsonb)
  from public, anon, authenticated, service_role, vortex_runtime;
grant execute on function vortex_definition.read_preview_demand(uuid, jsonb) to vortex_request;
comment on function vortex_definition.read_preview_demand(uuid, jsonb) is
  'Reads the current builder preview demand closure and derived-ready types under live builder authority, without creating storage, copying records or backfilling fields.';

reset role;
