-- Process leftovers with no product use (N3): the organisation setup receipt reader, whose only
-- caller was an unused TypeScript reader, and the organisation setup source manifest table, which
-- no function, trigger, constraint or module reads or writes (checked on a migrated lane with
-- pg_depend, pg_constraint and a prosrc search; the table holds no rows). The reader's canonical
-- file is removed with it.
set role vortex_owner;

drop function vortex_identity.read_organization_setup_receipt(uuid, text, uuid);
drop table vortex_definition.organization_setup_source_manifests;

reset role;
