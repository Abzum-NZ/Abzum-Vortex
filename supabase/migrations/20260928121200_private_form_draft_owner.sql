-- #1596: Give private form draft definers a least-privilege Page owner.

begin;

grant usage on schema vortex_access, vortex_context, vortex_module
  to vortex_page_owner;
grant execute on function vortex_access.validated_human_request_context()
  to vortex_page_owner;
grant execute on function vortex_context.is_non_nil_uuid(text)
  to vortex_page_owner;
grant execute on function vortex_module.read_current_active_installation()
  to vortex_page_owner;

-- Only the private Page owner receives relation access. Its SECURITY DEFINER
-- entry points derive and constrain every scope from the validated context.
revoke all privileges on table vortex_page.form_drafts from vortex_page_owner;

grant select (
  draft_id,
  organization_id,
  organization_account_id,
  identity_id,
  application_root_id,
  installation_release_revision,
  form_id,
  flow_id,
  node_id,
  subject_record_id,
  revision,
  field_values,
  validation_state,
  created_at,
  updated_at,
  expires_at,
  correlation_id
) on table vortex_page.form_drafts to vortex_page_owner;
grant insert (
  draft_id,
  organization_id,
  organization_account_id,
  identity_id,
  application_root_id,
  installation_release_revision,
  form_id,
  flow_id,
  node_id,
  subject_record_id,
  revision,
  field_values,
  validation_state,
  created_at,
  updated_at,
  expires_at,
  correlation_id
) on table vortex_page.form_drafts to vortex_page_owner;
grant update (field_values, validation_state, revision, updated_at, expires_at)
  on table vortex_page.form_drafts to vortex_page_owner;
grant delete on table vortex_page.form_drafts to vortex_page_owner;

create policy form_drafts_page_owner_select
  on vortex_page.form_drafts
  for select to vortex_page_owner using (true);
create policy form_drafts_page_owner_insert
  on vortex_page.form_drafts
  for insert to vortex_page_owner with check (true);
create policy form_drafts_page_owner_update
  on vortex_page.form_drafts
  for update to vortex_page_owner using (true) with check (true);
create policy form_drafts_page_owner_delete
  on vortex_page.form_drafts
  for delete to vortex_page_owner using (true);

grant execute on function vortex_page.private_form_draft_key_is_valid(text)
  to vortex_page_owner;
grant execute on function vortex_page.private_form_draft_values_are_valid(jsonb)
  to vortex_page_owner;
grant execute on function vortex_page.private_form_draft_validation_is_valid(jsonb)
  to vortex_page_owner;
grant execute on function vortex_page.private_form_draft_to_json_internal(
  vortex_page.form_drafts, text
) to vortex_page_owner;
grant execute on function vortex_page.private_form_draft_expiry_internal(timestamptz)
  to vortex_page_owner;
grant execute on function vortex_page.private_form_draft_purge_internal(uuid, integer)
  to vortex_page_owner;

alter function vortex_page.abandon_private_form_draft(uuid, bigint)
  owner to vortex_page_owner;
alter function vortex_page.create_private_form_draft(
  uuid, uuid, uuid, uuid, jsonb, jsonb
) owner to vortex_page_owner;
alter function vortex_page.expire_private_form_drafts(integer)
  owner to vortex_page_owner;
alter function vortex_page.private_form_draft_context_internal()
  owner to vortex_page_owner;
alter function vortex_page.read_private_form_draft(uuid, uuid, uuid, uuid)
  owner to vortex_page_owner;
alter function vortex_page.update_private_form_draft(
  uuid, bigint, uuid, uuid, uuid, uuid, jsonb, jsonb
) owner to vortex_page_owner;

commit;
