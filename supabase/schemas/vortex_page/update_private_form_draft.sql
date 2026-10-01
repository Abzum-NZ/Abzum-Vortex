create or replace function vortex_page.update_private_form_draft(
  p_draft_id uuid,
  p_expected_revision bigint,
  p_form_id uuid,
  p_flow_id uuid,
  p_node_id uuid,
  p_subject_record_id uuid,
  p_field_values jsonb,
  p_validation_state jsonb
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
  touched_at timestamptz;
begin
  if p_draft_id is null or not vortex_context.is_non_nil_uuid(p_draft_id::text)
    or p_expected_revision is null
    or p_expected_revision not between 1 and 9007199254740991
    or p_form_id is null or not vortex_context.is_non_nil_uuid(p_form_id::text)
    or (p_flow_id is not null and not vortex_context.is_non_nil_uuid(p_flow_id::text))
    or (p_node_id is not null and not vortex_context.is_non_nil_uuid(p_node_id::text))
    or (p_subject_record_id is not null
      and not vortex_context.is_non_nil_uuid(p_subject_record_id::text))
    or not vortex_page.private_form_draft_values_are_valid(p_field_values)
    or not vortex_page.private_form_draft_validation_is_valid(p_validation_state) then
    raise exception using errcode = '22023',
      message = 'Private form draft update command is invalid';
  end if;

  select context.* into strict scope
  from vortex_page.private_form_draft_context_internal() as context;

  -- Another person's draft is never locked and is indistinguishable from a
  -- missing one.
  select draft.* into stored
  from vortex_page.form_drafts as draft
  where draft.draft_id = p_draft_id
    and draft.organization_id = scope.organization_id
    and draft.organization_account_id = scope.organization_account_id
    and draft.identity_id = scope.identity_id
    and draft.application_root_id = scope.application_root_id
  for update;
  if not found
    or stored.expires_at <= pg_catalog.clock_timestamp()
    or stored.form_id <> p_form_id
    or stored.flow_id is distinct from p_flow_id
    or stored.node_id is distinct from p_node_id
    or stored.subject_record_id is distinct from p_subject_record_id then
    return query select 'unavailable'::text, null::jsonb;
    return;
  end if;

  if stored.installation_release_revision <> scope.release_revision then
    return query select 'stale_installation'::text, null::jsonb;
    return;
  end if;

  if stored.revision <> p_expected_revision then
    return query select 'stale_revision'::text, null::jsonb;
    return;
  end if;

  touched_at := pg_catalog.clock_timestamp();
  update vortex_page.form_drafts as draft
  set field_values = p_field_values,
      validation_state = p_validation_state,
      revision = draft.revision + 1,
      updated_at = touched_at,
      expires_at = vortex_page.private_form_draft_expiry_internal(touched_at)
  where draft.draft_id = p_draft_id
  returning * into stored;

  perform vortex_page.private_form_draft_purge_internal(scope.organization_id, 100);

  return query select 'updated'::text,
    vortex_page.private_form_draft_to_json_internal(stored, 'active');
end
$function$;

revoke all on function vortex_page.update_private_form_draft(
  uuid, bigint, uuid, uuid, uuid, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_page.update_private_form_draft(
  uuid, bigint, uuid, uuid, uuid, uuid, jsonb, jsonb
) to vortex_request;

comment on function vortex_page.update_private_form_draft(uuid, bigint, uuid, uuid, uuid, uuid, jsonb, jsonb) is
  'Compare-and-updates one exact owned live private form draft at its current revision, refusing a stale revision or replaced installation.';

alter function vortex_page.update_private_form_draft(uuid, bigint, uuid, uuid, uuid, uuid, jsonb, jsonb)
  owner to vortex_page_owner;
