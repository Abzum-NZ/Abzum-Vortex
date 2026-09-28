begin;

-- The schema owner remains outside other schemas' tables. The converted
-- routines that call vortex_context use only its stateless UUID validator.
grant usage on schema vortex_context to vortex_workflow_owner;
grant execute on function vortex_context.is_non_nil_uuid(text)
  to vortex_workflow_owner;

-- Grant only the columns the protected functions read or write. No sequence is
-- used by these relations.
grant select (
  run_id, task_path, iteration, organization_id, identity_id, state, outcome, outputs
) on table vortex_workflow.flow_effect_ledger to vortex_workflow_owner;
grant insert (
  run_id, task_path, iteration, organization_id, identity_id, state, started_at
) on table vortex_workflow.flow_effect_ledger to vortex_workflow_owner;
grant update (state, outcome, outputs, completed_at)
  on table vortex_workflow.flow_effect_ledger to vortex_workflow_owner;

grant select (
  token_hash, run_id, organization_id, identity_id, flow_id, release_key, state,
  elapsed_milliseconds, expires_at, consumed_at, ctid
) on table vortex_workflow.flow_continuations to vortex_workflow_owner;
grant insert (
  token_hash, run_id, organization_id, identity_id, flow_id, release_key, state,
  elapsed_milliseconds, created_at, expires_at
) on table vortex_workflow.flow_continuations to vortex_workflow_owner;
grant update (consumed_at)
  on table vortex_workflow.flow_continuations to vortex_workflow_owner;
grant delete on table vortex_workflow.flow_continuations to vortex_workflow_owner;

-- The role is non-login and is assumed only as the owner of these private
-- SECURITY DEFINER functions. Their existing predicates continue to bind each
-- operation to its run, organisation, identity, token and flow release.
create policy flow_effect_ledger_vortex_workflow_owner_select
  on vortex_workflow.flow_effect_ledger
  for select to vortex_workflow_owner using (true);
create policy flow_effect_ledger_vortex_workflow_owner_insert
  on vortex_workflow.flow_effect_ledger
  for insert to vortex_workflow_owner with check (true);
create policy flow_effect_ledger_vortex_workflow_owner_update
  on vortex_workflow.flow_effect_ledger
  for update to vortex_workflow_owner using (true) with check (true);

create policy flow_continuations_vortex_workflow_owner_select
  on vortex_workflow.flow_continuations
  for select to vortex_workflow_owner using (true);
create policy flow_continuations_vortex_workflow_owner_insert
  on vortex_workflow.flow_continuations
  for insert to vortex_workflow_owner with check (true);
create policy flow_continuations_vortex_workflow_owner_update
  on vortex_workflow.flow_continuations
  for update to vortex_workflow_owner using (true) with check (true);
create policy flow_continuations_vortex_workflow_owner_delete
  on vortex_workflow.flow_continuations
  for delete to vortex_workflow_owner using (true);

alter function vortex_workflow.begin_flow_effect(uuid,uuid,uuid,text,text)
  owner to vortex_workflow_owner;
alter function vortex_workflow.complete_flow_effect(uuid,uuid,uuid,text,text,text,jsonb)
  owner to vortex_workflow_owner;
alter function vortex_workflow.consume_flow_continuation(text,uuid,uuid,uuid,text)
  owner to vortex_workflow_owner;
alter function vortex_workflow.issue_flow_continuation(text,uuid,uuid,uuid,uuid,text,jsonb,integer,integer)
  owner to vortex_workflow_owner;

commit;
