-- Functions that nothing calls: no other function body, trigger, constraint, policy, registered
-- reader, TypeScript module or workflow names them (checked on a migrated lane with pg_depend,
-- pg_trigger and a prosrc search). Their canonical files are removed with them.
set role vortex_owner;
drop function vortex_access.check_record_lifecycle_preview_authority();
drop function vortex_access.record_share_grantor_authority_until_internal(jsonb,uuid,jsonb,jsonb);
drop function vortex_definition.private_form_draft_purge_internal(uuid,integer);
drop function vortex_identity.begin_organization_account_closing(uuid,bigint);
drop function vortex_identity.subject_revisions_are_valid(uuid[],bigint[]);
drop function vortex_platform.append_application_grant_activity_internal(jsonb,uuid,uuid,uuid,text,timestamp with time zone);
drop function vortex_platform.read_active_connection_evidence(uuid);
drop function vortex_platform.read_connection_instance_for_administration(uuid,uuid);
drop function vortex_record.authorize_index_status_internal(uuid,uuid);
drop function vortex_record.lock_record_recovery_policy_internal(uuid,uuid,uuid);
drop function vortex_record.read_record_projection_with_eligibility_internal(uuid,uuid,jsonb,jsonb);
reset role;

set role vortex_record_adapter;
drop function vortex_record.read_index_conflict_references_internal(uuid,text,text,text);
drop function vortex_record.read_record_lifecycle_preview_candidates_internal(text,uuid,uuid,uuid,timestamp with time zone,uuid,integer);
drop function vortex_record.restore_record_internal(uuid,uuid,bigint);
reset role;
