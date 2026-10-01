create or replace function vortex_page.private_form_draft_to_json_internal(
  d vortex_page.form_drafts,
  p_state text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'draftId', d.draft_id,
    'organizationId', d.organization_id,
    'organizationAccountId', d.organization_account_id,
    'identityId', d.identity_id,
    'applicationRootId', d.application_root_id,
    'installationReleaseRevision', d.installation_release_revision,
    'formId', d.form_id,
    'revision', d.revision,
    'values', d.field_values,
    'validation', d.validation_state,
    'state', p_state,
    'createdAt', pg_catalog.to_char(d.created_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'updatedAt', pg_catalog.to_char(d.updated_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'expiresAt', pg_catalog.to_char(d.expires_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )
  || case when d.flow_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('flowId', d.flow_id) end
  || case when d.node_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('nodeId', d.node_id) end
  || case when d.subject_record_id is null then '{}'::jsonb
    else pg_catalog.jsonb_build_object('subjectRecordId', d.subject_record_id) end
$function$;

revoke all on function vortex_page.private_form_draft_to_json_internal(
  vortex_page.form_drafts, text
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_record_adapter, vortex_module_owner;

comment on function vortex_page.private_form_draft_to_json_internal(
  vortex_page.form_drafts, text
) is 'Converts one private form draft row to its canonical JSON result.';

grant execute on function vortex_page.private_form_draft_to_json_internal(vortex_page.form_drafts, text)
  to vortex_page_owner;
