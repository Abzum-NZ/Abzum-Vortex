create or replace function vortex_page.private_form_draft_purge_internal(
  p_organization_id uuid,
  p_limit integer
)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  affected integer;
begin
  with expired as (
    select draft.draft_id
    from vortex_page.form_drafts as draft
    where draft.organization_id = p_organization_id
      and draft.expires_at <= pg_catalog.clock_timestamp()
    order by draft.expires_at
    limit p_limit
    for update skip locked
  )
  delete from vortex_page.form_drafts as draft
  using expired
  where draft.draft_id = expired.draft_id;

  get diagnostics affected = row_count;
  return affected;
end
$function$;

revoke all on function vortex_page.private_form_draft_purge_internal(uuid, integer)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_page.private_form_draft_purge_internal(uuid, integer)
  to vortex_page_owner;
