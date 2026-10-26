-- Record writes and the reads around them run under the request role. These request entries
-- were granted only to vortex_runtime, so request transactions switched back to the runtime role
-- around every save, batch save, delete, named action, settings save, lifecycle policy save and
-- derived-field backfill. They are granted to vortex_request instead; vortex_runtime keeps only
-- the system entries it calls outside a request.
set role vortex_owner;
revoke execute on function vortex_platform.installation_backfill_progress(uuid,uuid,jsonb) from vortex_runtime;
grant execute on function vortex_platform.installation_backfill_progress(uuid,uuid,jsonb) to vortex_request;
revoke execute on function vortex_record.save_record_type_lifecycle_policy_for_administration(uuid,uuid,bigint,bigint,uuid,jsonb) from vortex_runtime;
grant execute on function vortex_record.save_record_type_lifecycle_policy_for_administration(uuid,uuid,bigint,bigint,uuid,jsonb) to vortex_request;
reset role;

set role vortex_record_adapter;
revoke execute on function vortex_record.apply_action_record_changes(uuid,jsonb,jsonb) from vortex_runtime;
grant execute on function vortex_record.apply_action_record_changes(uuid,jsonb,jsonb) to vortex_request;
revoke execute on function vortex_record.apply_derived_field_backfill(uuid,jsonb,boolean) from vortex_runtime;
grant execute on function vortex_record.apply_derived_field_backfill(uuid,jsonb,boolean) to vortex_request;
revoke execute on function vortex_record.apply_lifecycle_record_changes(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) from vortex_runtime;
grant execute on function vortex_record.apply_lifecycle_record_changes(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) to vortex_request;
revoke execute on function vortex_record.apply_settings_record_changes(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid) from vortex_runtime;
grant execute on function vortex_record.apply_settings_record_changes(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid) to vortex_request;
revoke execute on function vortex_record.prepare_base_record_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) from vortex_runtime;
grant execute on function vortex_record.prepare_base_record_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) to vortex_request;
revoke execute on function vortex_record.prepare_named_action_command_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,text,uuid,bigint,uuid) from vortex_runtime;
grant execute on function vortex_record.prepare_named_action_command_totals(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,text,uuid,bigint,uuid) to vortex_request;
revoke execute on function vortex_record.prepare_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid) from vortex_runtime;
grant execute on function vortex_record.prepare_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid) to vortex_request;
revoke execute on function vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) from vortex_runtime;
grant execute on function vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid) to vortex_request;
revoke execute on function vortex_record.preview_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid) from vortex_runtime;
grant execute on function vortex_record.preview_named_action_set_announce(uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid) to vortex_request;
revoke execute on function vortex_record.read_derived_field_backfill(uuid,uuid) from vortex_runtime;
grant execute on function vortex_record.read_derived_field_backfill(uuid,uuid) to vortex_request;
revoke execute on function vortex_record.read_record_with_action_previews(uuid,uuid,jsonb,jsonb) from vortex_runtime;
grant execute on function vortex_record.read_record_with_action_previews(uuid,uuid,jsonb,jsonb) to vortex_request;
revoke execute on function vortex_record.read_records_with_action_previews(uuid,jsonb) from vortex_runtime;
grant execute on function vortex_record.read_records_with_action_previews(uuid,jsonb) to vortex_request;
revoke execute on function vortex_record.record_named_action_precondition_refusal(text,uuid,bigint,uuid,uuid,uuid,bigint,uuid) from vortex_runtime;
grant execute on function vortex_record.record_named_action_precondition_refusal(text,uuid,bigint,uuid,uuid,uuid,bigint,uuid) to vortex_request;
revoke execute on function vortex_record.save_base_record_set(uuid,jsonb) from vortex_runtime;
grant execute on function vortex_record.save_base_record_set(uuid,jsonb) to vortex_request;
revoke execute on function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb) from vortex_runtime;
grant execute on function vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb) to vortex_request;
revoke execute on function vortex_record.validate_named_action_reference_inputs(text,uuid,bigint,uuid,uuid,jsonb) from vortex_runtime;
grant execute on function vortex_record.validate_named_action_reference_inputs(text,uuid,bigint,uuid,uuid,jsonb) to vortex_request;
reset role;
