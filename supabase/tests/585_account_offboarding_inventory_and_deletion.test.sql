begin;

set local search_path = pg_catalog, extensions, public;

select plan(13);

select has_function(
  'vortex_record', 'list_offboarding_owned_records',
  array['uuid', 'text', 'uuid', 'text', 'uuid', 'uuid', 'integer'],
  'the protected account-offboarding inventory entry is installed'
);
select has_function(
  'vortex_record', 'list_offboarding_owned_records_internal',
  array['uuid', 'text', 'uuid', 'uuid', 'uuid', 'integer'],
  'the application-only inventory reader is installed'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_record.list_offboarding_owned_records(uuid,text,uuid,text,uuid,uuid,integer)'::regprocedure,
    'EXECUTE'
  ),
  'the request boundary may invoke the protected inventory entry'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_record.list_offboarding_owned_records(uuid,text,uuid,text,uuid,uuid,integer)'::regprocedure,
    'EXECUTE'
  ),
  'the runtime role cannot bypass the protected inventory entry'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_record.list_offboarding_owned_records_internal(uuid,text,uuid,uuid,uuid,integer)'::regprocedure,
    'EXECUTE'
  ),
  'the runtime role cannot invoke the adapter inventory reader'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_record.list_offboarding_owned_records_internal(uuid,text,uuid,uuid,uuid,integer)'::regprocedure,
    'EXECUTE'
  ),
  'the request role cannot bypass the accounts-manage entry'
);
select ok(
  not pg_catalog.has_schema_privilege(
    'vortex_record_adapter', 'vortex_record', 'CREATE'
  ),
  'the record adapter retains no schema CREATE capability after inventory installation'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_record_adapter',
    'vortex_access.organization_accounts_administration_change_scope()'::regprocedure,
    'EXECUTE'
  ),
  'the generic account-lifecycle scope remains unavailable to the record adapter'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_record_adapter',
    'vortex_access.organization_accounts_offboarding_inventory_scope_internal()'::regprocedure,
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_access.organization_accounts_offboarding_inventory_scope_internal()'::regprocedure,
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_access.organization_accounts_offboarding_inventory_scope_internal()'::regprocedure,
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'vortex_record_owner',
    'vortex_access.organization_accounts_offboarding_inventory_scope_internal()'::regprocedure,
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'vortex_module_owner',
    'vortex_access.organization_accounts_offboarding_inventory_scope_internal()'::regprocedure,
    'EXECUTE'
  ),
  'the narrow inventory scope bridge is available only to the record adapter'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_record.list_offboarding_owned_records(uuid,text,uuid,text,uuid,uuid,integer)'::regprocedure,
    'EXECUTE'
  ) and not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_record.list_offboarding_owned_records(uuid,text,uuid,text,uuid,uuid,integer)'::regprocedure,
    'EXECUTE'
  ) and not exists (
    select 1
    from pg_catalog.pg_proc as procedure
    cross join lateral pg_catalog.aclexplode(procedure.proacl) as privilege
    where procedure.oid =
      'vortex_record.list_offboarding_owned_records(uuid,text,uuid,text,uuid,uuid,integer)'::regprocedure
      and privilege.privilege_type = 'EXECUTE'
      and privilege.grantee <> 'vortex_request'::regrole
  ),
  'the request role is the sole explicitly granted public inventory invoker'
);
select isnt(
  pg_catalog.pg_get_functiondef('vortex_record.list_offboarding_owned_records_internal(uuid,text,uuid,uuid,uuid,integer)'::regprocedure)
    like '%organization_shared%',
  true,
  'the application-contained reader does not scan organisation-shared storage'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('vortex_record.list_offboarding_owned_records(uuid,text,uuid,text,uuid,uuid,integer)'::regprocedure),
    'shared_transfer_authority_undecided'
  ) > 0,
  'the protected entry reports the shared transfer-authority product gate explicitly'
);
select ok(
  pg_catalog.strpos(
    pg_catalog.pg_get_functiondef('vortex_record.list_offboarding_owned_records_internal(uuid,text,uuid,uuid,uuid,integer)'::regprocedure),
    'load_record_access_facts_for_transfer_installation_internal('
  ) > 0,
  'the preview reuses the existing exact transfer facts loader'
);

select * from finish();
rollback;
