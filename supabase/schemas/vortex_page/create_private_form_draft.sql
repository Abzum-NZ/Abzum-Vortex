create or replace function vortex_page.create_private_form_draft(
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
  created_at timestamptz;
  new_draft_id uuid;
  stored vortex_page.form_drafts%rowtype;
begin
  if p_form_id is null or not vortex_context.is_non_nil_uuid(p_form_id::text)
    or (p_flow_id is not null and not vortex_context.is_non_nil_uuid(p_flow_id::text))
    or (p_node_id is not null and not vortex_context.is_non_nil_uuid(p_node_id::text))
    or (p_subject_record_id is not null
      and not vortex_context.is_non_nil_uuid(p_subject_record_id::text))
    or not vortex_page.private_form_draft_values_are_valid(p_field_values)
    or not vortex_page.private_form_draft_validation_is_valid(p_validation_state) then
    raise exception using errcode = '22023',
      message = 'Private form draft create command is invalid';
  end if;

  select context.* into strict scope
  from vortex_page.private_form_draft_context_internal() as context;

  -- An untouched draft that has reached its expiry no longer holds the scope.
  delete from vortex_page.form_drafts as draft
  where draft.organization_id = scope.organization_id
    and draft.organization_account_id = scope.organization_account_id
    and draft.application_root_id = scope.application_root_id
    and draft.form_id = p_form_id
    and draft.flow_id is not distinct from p_flow_id
    and draft.node_id is not distinct from p_node_id
    and draft.subject_record_id is not distinct from p_subject_record_id
    and draft.expires_at <= pg_catalog.clock_timestamp();

  perform vortex_page.private_form_draft_purge_internal(scope.organization_id, 100);

  perform 1
  from vortex_page.form_drafts as draft
  where draft.organization_id = scope.organization_id
    and draft.organization_account_id = scope.organization_account_id
    and draft.application_root_id = scope.application_root_id
    and draft.installation_release_revision = scope.release_revision
    and draft.form_id = p_form_id
    and draft.flow_id is not distinct from p_flow_id
    and draft.node_id is not distinct from p_node_id
    and draft.subject_record_id is not distinct from p_subject_record_id
  for update;
  if found then
    return query select 'exists'::text, null::jsonb;
    return;
  end if;

  created_at := pg_catalog.clock_timestamp();
  new_draft_id := pg_catalog.gen_random_uuid();
  begin
    insert into vortex_page.form_drafts (
      draft_id, organization_id, organization_account_id, identity_id,
      application_root_id, installation_release_revision,
      form_id, flow_id, node_id, subject_record_id,
      revision, field_values, validation_state,
      created_at, updated_at, expires_at, correlation_id
    ) values (
      new_draft_id, scope.organization_id, scope.organization_account_id, scope.identity_id,
      scope.application_root_id, scope.release_revision,
      p_form_id, p_flow_id, p_node_id, p_subject_record_id,
      1, p_field_values, p_validation_state,
      created_at, created_at,
      vortex_page.private_form_draft_expiry_internal(created_at), scope.correlation_id
    )
    returning * into stored;
  exception
    when unique_violation then
      return query select 'exists'::text, null::jsonb;
      return;
  end;

  return query select 'created'::text,
    vortex_page.private_form_draft_to_json_internal(stored, 'active');
end
$function$;

revoke all on function vortex_page.create_private_form_draft(
  uuid, uuid, uuid, uuid, jsonb, jsonb
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

grant execute on function vortex_page.create_private_form_draft(
  uuid, uuid, uuid, uuid, jsonb, jsonb
) to vortex_request;

comment on function vortex_page.create_private_form_draft(uuid, uuid, uuid, uuid, jsonb, jsonb) is
  'Creates revision 1 of a private form draft for the current person and exact active installation, or reports the scope is already held.';

alter function vortex_page.create_private_form_draft(uuid, uuid, uuid, uuid, jsonb, jsonb)
  owner to vortex_page_owner;
