-- Private Record-adapter routine; migrations install the complete canonical body
-- under its owner with schema CREATE granted only for that migration transaction.
create or replace function vortex_record.assert_relationship_acyclic_internal(
  p_relationship_id uuid,
  p_organisation_id uuid,
  p_storage_contract_id uuid,
  p_field_id uuid,
  p_source_record_id uuid,
  p_target_record_id uuid
)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  makes_cycle boolean;
begin
  if p_relationship_id is null or p_organisation_id is null or p_storage_contract_id is null
    or p_field_id is null or p_source_record_id is null or p_target_record_id is null then
    raise exception using errcode = '22023', message = 'Relationship cycle check is invalid';
  end if;
  -- Serialize parent changes for this relationship and organisation. Participant locks alone
  -- cannot prevent two disjoint edges from closing the same cycle concurrently. Refuse rather
  -- than wait while holding participant locks; the caller can retry the atomic command.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended(
    'parent:' || p_organisation_id::text || ':' || p_relationship_id::text, 0
  )) then
    raise exception using errcode = '40001', message = 'Concurrent parent change; retry the command';
  end if;
  -- A record linking to its own record type with one record per link is a parent link. Linking a
  -- record to itself, or to any record that already sits below it, would make it its own ancestor.
  -- The constraint name carries the field so the save can name it; the walk follows the chain
  -- upward from the new parent and stops at the record being linked.
  if p_source_record_id = p_target_record_id then
    makes_cycle := true;
  else
    with recursive ancestors(record_id) as (
      select p_target_record_id
      union
      select edge.to_record_id
      from ancestors as ancestor
      join vortex_record.relationship_edges as edge
        on edge.relationship_id = p_relationship_id
       and edge.from_organisation_id = p_organisation_id
       and edge.from_storage_contract_id = p_storage_contract_id
       and edge.from_record_id = ancestor.record_id
       and edge.to_storage_contract_id = p_storage_contract_id
      where ancestor.record_id <> p_source_record_id
    )
    select exists (
      select 1 from ancestors as ancestor where ancestor.record_id = p_source_record_id
    ) into makes_cycle;
  end if;
  if makes_cycle then
    raise exception using errcode = '23514',
      message = 'Relationship would make a record its own ancestor',
      constraint = 'vx_parent_' || pg_catalog.replace(p_field_id::text, '-', '');
  end if;
end
$function$;

alter function vortex_record.assert_relationship_acyclic_internal(uuid,uuid,uuid,uuid,uuid,uuid) owner to vortex_record_adapter;

revoke all on function vortex_record.assert_relationship_acyclic_internal(uuid, uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_record.assert_relationship_acyclic_internal(uuid, uuid, uuid, uuid, uuid, uuid) is
  'Refuses a one-record link from a record type to itself that would make a record its own ancestor: it walks the relationship edges upward from the new parent and raises a check violation naming the link field when the walk reaches the record being linked. Owner-only.';
