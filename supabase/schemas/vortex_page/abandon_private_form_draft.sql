create or replace function vortex_page.abandon_private_form_draft(
  p_draft_id uuid,
  p_expected_revision bigint
)
returns table (outcome text, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  stored vortex_page.form_drafts%rowtype;
begin
  if p_draft_id is null or not vortex_context.is_non_nil_uuid(p_draft_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991 then
    raise exception using errcode = '22023',
      message = 'Private form draft abandon command is invalid';
  end if;

  select context.* into strict scope
  from vortex_page.private_form_draft_context_internal() as context;

  select draft.* into stored
  from vortex_page.form_drafts as draft
  where draft.draft_id = p_draft_id
    and draft.organization_id = scope.organization_id
    and draft.organization_account_id = scope.organization_account_id
    and draft.identity_id = scope.identity_id
    and draft.application_root_id = scope.application_root_id
  for update;
  if not found or stored.expires_at <= pg_catalog.clock_timestamp() then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  if stored.revision <> p_expected_revision then
    return query select 'stale_revision'::text, null::jsonb;
    return;
  end if;

  delete from vortex_page.form_drafts as draft
  where draft.draft_id = p_draft_id;

  stored.revision := stored.revision + 1;
  stored.updated_at := pg_catalog.clock_timestamp();
  stored.field_values := '{}'::jsonb;
  stored.validation_state := '{}'::jsonb;

  return query select 'abandoned'::text,
    vortex_page.private_form_draft_to_json_internal(stored, 'abandoned');
end
$function$;

revoke all on function vortex_page.abandon_private_form_draft(uuid, bigint)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
    vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_page.abandon_private_form_draft(uuid, bigint)
  to vortex_request;

comment on function vortex_page.abandon_private_form_draft(uuid, bigint) is
  'Abandons and deletes one exact owned live private form draft at its expected revision.';

alter function vortex_page.abandon_private_form_draft(uuid, bigint)
  owner to vortex_page_owner;
