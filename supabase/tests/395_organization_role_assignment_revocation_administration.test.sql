\ir helpers/private-schema-assertions.psql

begin;
set local search_path = pg_catalog, extensions, public;
select plan(8);

select has_function(
  'vortex_access',
  'revoke_organization_role_assignment_for_administration',
  array['uuid', 'bigint', 'uuid'],
  'Access exposes one exact protected assignment-revocation operation'
);
select is(
  (select owner_role.rolname || '|' || procedure_row.prosecdef::text || '|' ||
      procedure_row.provolatile::text || '|' || procedure_row.proconfig::text
    from pg_catalog.pg_proc as procedure_row
    join pg_catalog.pg_roles as owner_role on owner_role.oid = procedure_row.proowner
    where procedure_row.oid =
      'vortex_access.revoke_organization_role_assignment_for_administration(uuid,bigint,uuid)'::regprocedure),
  'postgres|true|v|{"search_path=\"\""}',
  'the protected composition is owner-held with an empty search path'
);
select ok(pg_catalog.has_function_privilege(
  'vortex_request',
  'vortex_access.revoke_organization_role_assignment_for_administration(uuid,bigint,uuid)',
  'EXECUTE'), 'the restricted request role can execute the protected operation');
select ok(not pg_catalog.has_function_privilege(
  caller.role_name,
  'vortex_access.revoke_organization_role_assignment_for_administration(uuid,bigint,uuid)',
  'EXECUTE'), caller.role_name || ' cannot execute protected assignment revocation')
from (values ('public'), ('anon'), ('authenticated'), ('service_role'), ('vortex_runtime'))
  as caller(role_name)
order by caller.role_name collate "C";

select * from finish();
rollback;
