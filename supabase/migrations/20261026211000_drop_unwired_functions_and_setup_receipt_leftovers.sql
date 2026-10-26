-- Database objects with no product use, removed with the code that alone called them:
-- - the organisation setup receipt reader, whose only caller was an unused TypeScript reader, and
--   the organisation setup source manifest table, which no function, trigger, constraint or module
--   reads or writes (checked on a migrated lane with pg_depend, pg_constraint and a prosrc search;
--   the table holds no rows) (N3);
-- - the event delivery claim recovery and the terminally failed claim listing, and the system actor
--   grants that only authorised that recovery;
-- - the protected workflow run writer: nothing writes protected runs.
-- Their canonical files are removed with them. The grants table belongs to the migration role, so
-- its stale rows are deleted before the owner role drops the functions.
delete from vortex_access.system_actor_grants
where operation_key = 'recover_consumer_occurrence_claim';

set role vortex_owner;

drop function vortex_identity.read_organization_setup_receipt(uuid, text, uuid);
drop table vortex_definition.organization_setup_source_manifests;

drop function vortex_platform.recover_consumer_occurrence_claim(text, uuid, integer, uuid);
drop function vortex_platform.list_terminally_failed_consumer_occurrences(text, integer);

drop function vortex_platform.write_protected_workflow_run(uuid, uuid, uuid, jsonb);

reset role;
