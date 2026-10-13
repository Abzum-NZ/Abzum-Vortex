create or replace function vortex_definition.read_private_form_draft(
  p_form_id uuid,
  p_flow_id uuid,
  p_node_id uuid,
  p_subject_record_id uuid
)
returns table (outcome text, result jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  scope record;
  stored vortex_definition.form_drafts%rowtype;
begin
  if p_form_id is null or not vortex_platform.is_non_nil_uuid(p_form_id::text)
    or (p_flow_id is not null and not vortex_platform.is_non_nil_uuid(p_flow_id::text))
    or (p_node_id is not null and not vortex_platform.is_non_nil_uuid(p_node_id::text))
    or (p_subject_record_id is not null
      and not vortex_platform.is_non_nil_uuid(p_subject_record_id::text)) then
    raise exception using errcode = '22023',
      message = 'Private form draft read command is invalid';
  end if;

  select context.* into strict scope
  from vortex_definition.private_form_draft_context_internal() as context;

  -- Only the draft bound to the exact current installed release is resumable.
  select draft.* into stored
  from vortex_definition.form_drafts as draft
  where draft.organization_id = scope.organization_id
    and draft.organization_account_id = scope.organization_account_id
    and draft.identity_id = scope.identity_id
    and draft.application_root_id = scope.application_root_id
    and draft.installation_release_revision = scope.release_revision
    and draft.form_id = p_form_id
    and draft.flow_id is not distinct from p_flow_id
    and draft.node_id is not distinct from p_node_id
    and draft.subject_record_id is not distinct from p_subject_record_id
    and draft.expires_at > pg_catalog.clock_timestamp();
  if found then
    return query select 'available'::text,
      vortex_definition.private_form_draft_to_json_internal(stored, 'active');
    return;
  end if;

  -- A live draft for this scope bound to a replaced installation is stale, not
  -- silently combined with the changed form.
  perform 1
  from vortex_definition.form_drafts as draft
  where draft.organization_id = scope.organization_id
    and draft.organization_account_id = scope.organization_account_id
    and draft.identity_id = scope.identity_id
    and draft.application_root_id = scope.application_root_id
    and draft.installation_release_revision <> scope.release_revision
    and draft.form_id = p_form_id
    and draft.flow_id is not distinct from p_flow_id
    and draft.node_id is not distinct from p_node_id
    and draft.subject_record_id is not distinct from p_subject_record_id
    and draft.expires_at > pg_catalog.clock_timestamp();
  if found then
    return query select 'stale_installation'::text, null::jsonb;
    return;
  end if;

  return query select 'unavailable'::text, null::jsonb;
end
$function$;
alter function vortex_definition.read_private_form_draft(uuid,uuid,uuid,uuid) owner to vortex_owner;


revoke all on function vortex_definition.read_private_form_draft(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request, vortex_record_adapter;

grant execute on function vortex_definition.read_private_form_draft(uuid, uuid, uuid, uuid)
  to vortex_request;

comment on function vortex_definition.read_private_form_draft(uuid, uuid, uuid, uuid) is
  'Reads one exact live private form draft of the current person, rechecking the exact active installation before returning any value.';

alter function vortex_definition.read_private_form_draft(uuid, uuid, uuid, uuid)
  owner to vortex_owner;
