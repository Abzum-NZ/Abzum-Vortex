begin;

set local search_path = pg_catalog, extensions, public;
select no_plan();

\ir helpers/record-removal-protection-fixture.psql

select has_table(
  'vortex_record', 'record_recovery_policy_states',
  'current recovery-policy evidence has dedicated source-owned storage'
);
select has_table(
  'vortex_record', 'record_recovery_provenance',
  'exact deletion recovery provenance has dedicated storage'
);
select has_table(
  'vortex_record', 'record_legal_holds',
  'versioned legal holds have dedicated storage'
);
select has_table(
  'vortex_record', 'record_removal_guards',
  'exact record removal scopes have a serialization guard'
);

select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_catalog.pg_class
   where oid = 'vortex_record.record_recovery_provenance'::regclass),
  'recovery provenance enforces RLS even for its owner'
);
select ok(
  (select relrowsecurity and relforcerowsecurity
   from pg_catalog.pg_class
   where oid = 'vortex_record.record_legal_holds'::regclass),
  'legal holds enforce RLS even for their owner'
);
select ok(
  not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_record.record_legal_holds', 'SELECT'
  ),
  'a hold grants no request-role visibility into hold state'
);
select ok(
  not pg_catalog.has_table_privilege(
    'vortex_request', 'vortex_record.record_recovery_provenance', 'SELECT'
  ),
  'request callers cannot read provenance directly'
);
select ok(
  pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_record.resolve_record_recovery_eligibility(uuid,uuid,text,uuid,uuid,uuid,timestamptz)',
    'EXECUTE'
  ),
  'the request role has only the content-free #50 recovery resolver'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_runtime',
    'vortex_record.resolve_record_recovery_eligibility(uuid,uuid,text,uuid,uuid,uuid,timestamptz)',
    'EXECUTE'
  ),
  'the ambient runtime role cannot invoke the recovery resolver'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_record.change_record_legal_hold_internal(text,uuid,uuid,uuid,uuid,bigint,text,timestamptz)',
    'EXECUTE'
  ),
  'legal-hold mutation remains owner-only pending its protected Access wrapper'
);
select ok(
  not pg_catalog.has_function_privilege(
    'vortex_request',
    'vortex_record.resolve_permanent_record_removal_internal(uuid,uuid,text,uuid,uuid,uuid,bigint,timestamptz)',
    'EXECUTE'
  ),
  'the final permanent-removal recheck remains owner-only for #117 composition'
);

select is(
  (select removal_due_at
   from vortex_record.record_recovery_provenance
   where organization_id = :'rph_org' and record_id = :'rph_recoverable'),
  (select deleted_at + interval '14 days'
   from vortex_record.record_recovery_provenance
   where organization_id = :'rph_org' and record_id = :'rph_recoverable'),
  'removal due time is derived exactly from persisted deletion time and policy provenance'
);
select is(
  (select removal_due_at
   from record_data.rt_a478000000004000800000000000000b
   where organisation_id = :'rph_org' and record_id = :'rph_recoverable'),
  (select removal_due_at
   from vortex_record.record_recovery_provenance
   where organization_id = :'rph_org' and record_id = :'rph_recoverable'),
  'the source row and recovery provenance persist the same authoritative due time'
);
select pg_temp.rph_context(null, false);
set local role vortex_record_adapter;
select is(
  (vortex_record.record_recovery_provenance_internal(
    :'rph_shared_storage', :'rph_shared_type', :'rph_recoverable', 2
  ) ->> 'replayed'),
  'true',
  'exact recovery provenance replay is idempotent'
);
reset role;

-- Invoke request readers with deletion timestamps captured before role reduction.
select deleted_at as rph_recoverable_deleted_at
from vortex_record.record_recovery_provenance
where organization_id = :'rph_org' and record_id = :'rph_recoverable' \gset
select deleted_at as rph_expired_deleted_at
from vortex_record.record_recovery_provenance
where organization_id = :'rph_org' and record_id = :'rph_expired' \gset
select deleted_at as rph_missing_deleted_at
from record_data.rt_a478000000004000800000000000000b
where organisation_id = :'rph_org' and record_id = :'rph_missing' \gset

select pg_temp.rph_context(null, false);
set local role vortex_request;
select is(
  (vortex_record.resolve_record_recovery_eligibility(
    :'rph_org', null, 'organization_shared', :'rph_shared_storage',
    :'rph_shared_type', :'rph_recoverable', :'rph_recoverable_deleted_at'
  ) ->> 'outcome'),
  'eligible',
  'a soft-deleted row inside its recorded recovery window is eligible'
);
select is(
  (vortex_record.resolve_record_recovery_eligibility(
    :'rph_org', null, 'organization_shared', :'rph_shared_storage',
    :'rph_shared_type', :'rph_expired', :'rph_expired_deleted_at'
  ) ->> 'reasonCode'),
  'recovery_expired',
  'an expired recovery window returns the closed recovery_expired refusal'
);
select is(
  (vortex_record.resolve_record_recovery_eligibility(
    :'rph_org', null, 'organization_shared', :'rph_shared_storage',
    :'rph_shared_type', :'rph_missing', :'rph_missing_deleted_at'
  ) ->> 'reasonCode'),
  'recovery_unavailable',
  'a retained deleted row without exact provenance fails closed rather than becoming a fresh delete'
);
select is(
  (vortex_record.resolve_record_recovery_eligibility(
    :'rph_org', :'rph_app_one', 'organization_shared', :'rph_shared_storage',
    :'rph_shared_type', :'rph_recoverable', :'rph_recoverable_deleted_at'
  ) ->> 'reasonCode'),
  'recovery_unavailable',
  'contradictory application/shared scope fails closed'
);
reset role;

-- Current policy tightening is observed under the policy-row lock and can only
-- shorten the persisted deletion window.
select pg_temp.rph_context(null, false);
set local role vortex_record_adapter;
select vortex_record.record_current_recovery_policy_internal(
  :'rph_shared_storage', :'rph_shared_type', :'rph_policy_shared', 2, 0
);
reset role;
set local role vortex_request;
select is(
  (vortex_record.resolve_record_recovery_eligibility(
    :'rph_org', null, 'organization_shared', :'rph_shared_storage',
    :'rph_shared_type', :'rph_recoverable', :'rph_recoverable_deleted_at'
  ) ->> 'reasonCode'),
  'recovery_expired',
  'a newer tighter current policy closes an originally recoverable window'
);
reset role;

select pg_temp.rph_context(null, true);
set local role vortex_request;
select throws_ok(
  $$select * from vortex_record.read_lifecycle_removal_protection_facts(
    'a4780000-0000-4000-8000-00000000000b'::uuid
  )$$,
  '42501',
  null,
  'hold/protection facts do not create a human Record visibility path'
);
reset role;

select pg_temp.rph_context(null, false);
set local role vortex_request;
select is(
  (select pg_catalog.count(*)::integer
   from vortex_record.read_lifecycle_removal_protection_facts(:'rph_shared_storage')),
  7,
  'protection reader returns every retained lifecycle fixture without content'
);
select is(
  (select is_recovery_protected
   from vortex_record.read_lifecycle_removal_protection_facts(:'rph_shared_storage')
   where record_id = :'rph_active'),
  false,
  'an active row is not fabricated as a recovery-protected deletion'
);
select is(
  (select is_recovery_protected
   from vortex_record.read_lifecycle_removal_protection_facts(:'rph_shared_storage')
   where record_id = :'rph_missing'),
  true,
  'null due time or missing provenance protects a retained deleted row fail closed'
);
select is(
  (select lifecycle_state
   from vortex_record.read_lifecycle_removal_protection_facts(:'rph_shared_storage')
   where record_id = :'rph_pending'),
  'removal_pending',
  'removal-pending state is preserved as an authoritative lifecycle fact'
);
select is(
  (select is_held
   from vortex_record.read_lifecycle_removal_protection_facts(:'rph_shared_storage')
   where record_id = :'rph_held'),
  true,
  'an active exact-scope legal hold blocks removal'
);
select is(
  (select is_held
   from vortex_record.read_lifecycle_removal_protection_facts(:'rph_shared_storage')
   where record_id = :'rph_released'),
  false,
  'a versioned released hold no longer blocks removal'
);
reset role;

select pg_temp.rph_context(null, false);
set local role vortex_record_adapter;
select is(
  (vortex_record.resolve_permanent_record_removal_internal(
    :'rph_org', null, 'organization_shared', :'rph_shared_storage',
    :'rph_shared_type', :'rph_held', 2,
    (select deleted_at from vortex_record.record_recovery_provenance
      where organization_id = :'rph_org' and record_id = :'rph_held')
  ) ->> 'reasonCode'),
  'legal_hold',
  'a matching active hold refuses final permanent removal'
);
select is(
  (vortex_record.resolve_permanent_record_removal_internal(
    :'rph_org', null, 'organization_shared', :'rph_shared_storage',
    :'rph_shared_type', :'rph_released', 2,
    (select deleted_at from vortex_record.record_recovery_provenance
      where organization_id = :'rph_org' and record_id = :'rph_released')
  ) ->> 'outcome'),
  'eligible',
  'an expired removal-pending row becomes eligible after its hold is released'
);
reset role;

-- The same permanent Record ID in two contained applications remains two exact
-- provenance rows and resolves against each application's own policy evidence.
select is(
  (select pg_catalog.count(*)::integer
   from vortex_record.record_recovery_provenance
   where organization_id = :'rph_org'
     and storage_contract_id = :'rph_contained_storage'
     and record_id = :'rph_same_record'),
  2,
  'the same record ID across two applications has two isolated provenance tuples'
);
select deleted_at as rph_app_one_deleted_at
from vortex_record.record_recovery_provenance
where organization_id = :'rph_org' and application_root_id = :'rph_app_one'
  and storage_contract_id = :'rph_contained_storage'
  and record_id = :'rph_same_record' \gset
select deleted_at as rph_app_two_deleted_at
from vortex_record.record_recovery_provenance
where organization_id = :'rph_org' and application_root_id = :'rph_app_two'
  and storage_contract_id = :'rph_contained_storage'
  and record_id = :'rph_same_record' \gset

select pg_temp.rph_context(:'rph_app_one', false);
set local role vortex_request;
select is(
  (vortex_record.resolve_record_recovery_eligibility(
    :'rph_org', :'rph_app_one', 'application_contained', :'rph_contained_storage',
    :'rph_contained_type', :'rph_same_record', :'rph_app_one_deleted_at'
  ) ->> 'reasonCode'),
  'recovery_expired',
  'application one resolves only its zero-day current policy'
);
reset role;
select pg_temp.rph_context(:'rph_app_two', false);
set local role vortex_request;
select is(
  (vortex_record.resolve_record_recovery_eligibility(
    :'rph_org', :'rph_app_two', 'application_contained', :'rph_contained_storage',
    :'rph_contained_type', :'rph_same_record', :'rph_app_two_deleted_at'
  ) ->> 'outcome'),
  'eligible',
  'application two resolves only its independent fourteen-day current policy'
);
select is(
  (select pg_catalog.count(*)::integer
   from vortex_record.read_lifecycle_removal_protection_facts(:'rph_contained_storage')),
  1,
  'application two protection facts cannot see the same ID stored for application one'
);
reset role;

select ok(
  pg_catalog.position(
    'vortex_activity' in pg_catalog.pg_get_functiondef(
      'vortex_record.resolve_record_recovery_eligibility(uuid,uuid,text,uuid,uuid,uuid,timestamptz)'::regprocedure
    )
  ) = 0
  and pg_catalog.position(
    'vortex_event' in pg_catalog.pg_get_functiondef(
      'vortex_record.resolve_record_recovery_eligibility(uuid,uuid,text,uuid,uuid,uuid,timestamptz)'::regprocedure
    )
  ) = 0
  and pg_catalog.position(
    'receipt' in pg_catalog.pg_get_functiondef(
      'vortex_record.resolve_record_recovery_eligibility(uuid,uuid,text,uuid,uuid,uuid,timestamptz)'::regprocedure
    )
  ) = 0,
  'the #50 recovery resolver has no Activity, Event, or receipt side effect'
);

select * from finish();
rollback;
