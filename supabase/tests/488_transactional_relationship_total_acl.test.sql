begin;
select plan(13);
set local search_path = extensions, public, pg_catalog;

select ok(
  has_function_privilege(
    'vortex_runtime',
    'vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid)'::regprocedure,
    'EXECUTE'
  ),
  'runtime may invoke the private transactional-total preflight'
);
select ok(
  has_function_privilege(
    'vortex_runtime',
    'vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb)'::regprocedure,
    'EXECUTE'
  ),
  'runtime may invoke the composed atomic writer'
);
select ok(
  not has_function_privilege(
    'vortex_runtime',
    'vortex_record.save_base_record(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid)'::regprocedure,
    'EXECUTE'
  ),
  'runtime cannot invoke the obsolete unjoined base writer'
);
select ok(
  not has_function_privilege(
    'vortex_request',
    'vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid)'::regprocedure,
    'EXECUTE'
  ),
  'request role cannot invoke the private preflight'
);
select ok(
  not has_function_privilege(
    'vortex_request',
    'vortex_record.save_base_record_with_relationship_totals(uuid,text,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,uuid,jsonb)'::regprocedure,
    'EXECUTE'
  ),
  'request role cannot invoke the composed writer'
);
select ok(
  not has_function_privilege(
    'service_role',
    'vortex_record.prepare_relationship_total_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid)'::regprocedure,
    'EXECUTE'
  ),
  'service role cannot bypass the protected save service'
);
select ok(
  has_function_privilege(
    'vortex_record_adapter',
    'vortex_record.relationship_total_catalogue_internal()'::regprocedure,
    'EXECUTE'
  ),
  'adapter owns the private installed-definition catalogue reader'
);
select ok(
  has_function_privilege(
    'vortex_record_adapter',
    'vortex_record.relationship_total_record_snapshot_internal(jsonb,uuid,uuid,boolean)'::regprocedure,
    'EXECUTE'
  ),
  'adapter owns the private exact record snapshot reader'
);
select ok(
  has_function_privilege(
    'vortex_record_adapter',
    'vortex_record.discover_relationship_total_closure_internal(jsonb,text,uuid,uuid,jsonb)'::regprocedure,
    'EXECUTE'
  ),
  'adapter owns the private concrete closure discovery helper'
);
select ok(
  has_function_privilege(
    'vortex_record_adapter',
    'vortex_record.apply_relationship_total_parent_internal(uuid,uuid,bigint,jsonb)'::regprocedure,
    'EXECUTE'
  ),
  'adapter owns the private generated parent writer'
);
select ok(
  not has_function_privilege(
    'vortex_runtime',
    'vortex_record.relationship_total_record_snapshot_internal(jsonb,uuid,uuid,boolean)'::regprocedure,
    'EXECUTE'
  ),
  'runtime cannot call the general snapshot implementation directly'
);
select ok(
  not has_function_privilege(
    'vortex_request',
    'vortex_record.relationship_total_record_snapshot_internal(jsonb,uuid,uuid,boolean)'::regprocedure,
    'EXECUTE'
  ),
  'request role cannot call the private snapshot reader'
);
select ok(
  not has_table_privilege('vortex_runtime', 'vortex_record.relationship_edges', 'SELECT'),
  'runtime cannot enumerate relationship edges outside the preflight'
);

select * from finish();
rollback;
