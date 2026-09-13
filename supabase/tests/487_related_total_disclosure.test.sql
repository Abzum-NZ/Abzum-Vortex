\ir helpers/definition-release-writer.psql

begin;
select plan(13);
set local search_path = extensions, public, pg_catalog;

-- A real published, provisioned and lifecycle-activated application: no fake
-- loader inputs or direct filter-only projection are used in this proof.
\ir helpers/related-total-installed-fixture.psql

-- pgTAP lives in the private extensions schema. This temporary harness grant
-- lets assertions execute while preserving the actual vortex_request role for
-- each read; the enclosing transaction rolls it back.
grant usage on schema extensions to vortex_request;
grant execute on all functions in schema extensions to vortex_request;

select pg_temp.related_context(:'app'::uuid, :'full_account'::uuid);
set local role vortex_request;
select is(
  (vortex_record.read_record(:'parent_type'::uuid, :'parent_record'::uuid)->'values')::text,
  pg_catalog.jsonb_build_object(:'f_parent_title','Parent',:'f_parent_total','12.50',:'f_parent_display','12.50',:'f_parent_unrelated','Unrelated survives')::text,
  'installed read retains total and dependent calculation when each contributor field is readable'::text
);
select ok(
  vortex_record.read_record(:'child_type'::uuid, :'child_record'::uuid)->'values' ? :'f_child_self_total'
  and not (vortex_record.read_record(:'child_type'::uuid, :'child_record'::uuid)->'values' ? :'f_child_cycle_total')
  and vortex_record.read_record(:'child_type'::uuid, :'child_record'::uuid)->'values' ? :'f_child_amount',
  'ordinary self aggregate stays visible while actual derived cycle suppresses only affected value'
);
reset role;

select pg_temp.related_context(:'app'::uuid, :'no_child_account'::uuid);
set local role vortex_request;
select is(
  (vortex_record.read_record(:'parent_type'::uuid, :'parent_record'::uuid)->'values')::text,
  pg_catalog.jsonb_build_object(:'f_parent_title','Parent',:'f_parent_unrelated','Unrelated survives')::text,
  'unreadable contributor row suppresses related total and dependent calculation'::text
);
reset role;

select pg_temp.related_context(:'app'::uuid, :'no_amount_account'::uuid);
set local role vortex_request;
select ok(
  not (vortex_record.read_record(:'parent_type'::uuid, :'parent_record'::uuid)->'values' ? :'f_parent_total')
  and not (vortex_record.read_record(:'parent_type'::uuid, :'parent_record'::uuid)->'values' ? :'f_parent_display')
  and vortex_record.read_record(:'parent_type'::uuid, :'parent_record'::uuid)->'values'->> :'f_parent_unrelated' = 'Unrelated survives',
  'unreadable aggregate field suppresses only related derived values'
);
reset role;
select pg_temp.related_context(:'app'::uuid, :'no_filter_account'::uuid);
set local role vortex_request;
select ok(
  not (vortex_record.read_record(:'parent_type'::uuid, :'parent_record'::uuid)->'values' ? :'f_parent_total')
  and not (vortex_record.read_record(:'parent_type'::uuid, :'parent_record'::uuid)->'values' ? :'f_parent_display')
  and vortex_record.read_record(:'parent_type'::uuid, :'parent_record'::uuid)->'values'->> :'f_parent_unrelated' = 'Unrelated survives',
  'unreadable filter field suppresses only related derived values'
);
reset role;

select is((select f_f4870000000040008000000000000002::text from record_data.rt_b4870000000040008000000000000001 where record_id=:'parent_record'::uuid),
  '12.50','read projection does not alter stored total'::text);
select is((select f_f4870000000040008000000000000004 from record_data.rt_b4870000000040008000000000000001 where record_id=:'parent_record'::uuid),
  'Unrelated survives','read projection does not alter unrelated stored value'::text);

-- The normal edge constraint correctly prevents an edge whose source and
-- target organisations differ.  Drop it only inside this rolled-back pgTAP
-- transaction to prove that the reader's own target-organisation predicate is
-- meaningful: if it were removed, this foreign source would fail its actual
-- current-context read and suppress the displayed total.
set local role vortex_record_owner;
alter table vortex_record.relationship_edges drop constraint relationship_edges_check;
insert into vortex_record.relationship_edges(relationship_id,from_organisation_id,to_organisation_id,from_application_root_id,to_application_root_id,from_storage_contract_id,from_record_id,to_storage_contract_id,to_record_id)
values(:'child_parent_relationship'::uuid,:'org'::uuid,:'foreign_org'::uuid,:'app'::uuid,:'app'::uuid,:'child_storage'::uuid,:'foreign_org_child_record'::uuid,:'parent_storage'::uuid,:'parent_record'::uuid);
reset role;
select pg_temp.related_context(:'app'::uuid, :'full_account'::uuid);
set local role vortex_request;
select ok(vortex_record.read_record(:'parent_type'::uuid, :'parent_record'::uuid)->'values' ? :'f_parent_total',
  'foreign-organisation edge cannot become a current-installation contributor');
reset role;

-- The edge writer correctly rejects two application-contained endpoints with
-- different applications.  Disable that one writer trigger only long enough
-- to create an adversarial row; the runtime read remains fully real.  If its
-- source-application predicate were removed, the source record would fail the
-- current-application RLS lookup and suppress the displayed total.
set local role vortex_record_owner;
alter table vortex_record.relationship_edges disable trigger relationship_edges_scope;
insert into vortex_record.relationship_edges(relationship_id,from_organisation_id,to_organisation_id,from_application_root_id,to_application_root_id,from_storage_contract_id,from_record_id,to_storage_contract_id,to_record_id)
values(:'child_parent_relationship'::uuid,:'org'::uuid,:'org'::uuid,:'other_app'::uuid,:'app'::uuid,:'child_storage'::uuid,:'other_app_child_record'::uuid,:'parent_storage'::uuid,:'parent_record'::uuid);
alter table vortex_record.relationship_edges enable trigger relationship_edges_scope;
reset role;
select pg_temp.related_context(:'app'::uuid, :'full_account'::uuid);
set local role vortex_request;
select ok(vortex_record.read_record(:'parent_type'::uuid, :'parent_record'::uuid)->'values' ? :'f_parent_total',
  'foreign-application edge cannot become a current-installation contributor');
select ok(not has_function_privilege('vortex_request','vortex_record.total_inputs_readable_internal(jsonb,uuid,uuid,jsonb,jsonb)'::regprocedure,'EXECUTE'),
  'request role cannot invoke private related-total source reader');
select ok(not has_table_privilege('vortex_request','vortex_record.relationship_edges','SELECT'),
  'request role cannot enumerate relationship edges');
reset role;

select ok(exists(select 1 from vortex_module.installation_bindings where organization_id=:'org'::uuid and application_root_id=:'app'::uuid and module_root_id=:'module'::uuid and state='active' and binding_revision=2),
  'fixture activated the provisioned binding that was supplied at revision 1');
select ok(exists(select 1 from vortex_definition.releases where root_id=:'module'::uuid and release_revision=1),
  'fixture used published module release');

select * from finish();
rollback;
