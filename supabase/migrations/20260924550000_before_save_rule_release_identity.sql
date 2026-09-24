-- #578: protected saves hand the exact release's before-save rule graphs to Record.
--
-- Record evaluates compiled before-save graphs (`evaluateBeforeSaveRuleGraphs`)
-- inside the save transaction, but the preparations never returned the graphs or
-- the release they came from. The only existing guards compared a rule's
-- `recordTypeId`, while a compiled graph carries `subjectRecordTypeId`, so they
-- never matched: a rule was silently skipped rather than run or refused.
--
-- The two preparations that Record now completes with rules — the ordinary base
-- save (`prepare_base_record_save`) and the named-action set/announce preparation
-- (`prepare_named_action_set_announce_internal`) — additionally return
-- `beforeSaveRules`: the exact Module release identity the save already resolved
-- (`moduleRootId`, `releaseRevision`) and that release's canonical rule graphs whose
-- subject is the saved record type. They are read here, under the preparation's own
-- owner, from the same immutable release row the save resolved: no second or looser
-- definition read, and never from caller input. The general definition consumer
-- read is a system-context, request-role reader and is not callable from the
-- runtime role, so the private helper below reads the same stored canonical content.
--
-- Nothing else changes. Relationship-total preparation keeps deferring whenever
-- any rule is installed and its writers keep refusing a defer that would move a
-- total, so a rule-bearing save can never skip a total. The paths that still refuse
-- when rules exist (named-action record creation, deadline transition closure,
-- protected delete and recovery) are untouched and stay fail-closed.
--
-- Both functions are patched in place from their live definitions: each reviewed
-- fragment must occur exactly once or the migration aborts.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

create function vortex_record.before_save_rules_for_record_type_internal(
  p_module_root_id uuid,
  p_module_release_revision bigint,
  p_record_type_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  release_content jsonb;
begin
  if p_module_root_id is null or p_module_release_revision is null
    or p_record_type_id is null then
    raise exception using errcode = '22023', message = 'Before-save rule selector is invalid';
  end if;
  select release.compilation_output #> '{canonical,content}'
  into strict release_content
  from vortex_definition.releases as release
  where release.root_id = p_module_root_id
    and release.release_revision = p_module_release_revision;
  return pg_catalog.jsonb_build_object(
    'moduleRootId', p_module_root_id,
    'releaseRevision', p_module_release_revision,
    'rules', coalesce((
      select pg_catalog.jsonb_agg(item.value order by item.value ->> 'ruleId')
      from pg_catalog.jsonb_array_elements(
        coalesce(release_content -> 'rules', '[]'::jsonb)
      ) as item(value)
      where pg_catalog.lower(item.value ->> 'subjectRecordTypeId') =
        pg_catalog.lower(p_record_type_id::text)
    ), '[]'::jsonb)
  );
end
$function$;

do $migration$
declare
  base_old constant text := $q$    'outcome', 'prepared',
    'recordType', meta -> 'recordType',$q$;
  base_new constant text := $q$    'outcome', 'prepared',
    'recordType', meta -> 'recordType',
    'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
      (meta ->> 'moduleRootId')::uuid,
      (meta ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),$q$;
  action_old constant text := $q$    'validationContractVersion', action_context -> 'validationContractVersion',
    'recordType', action_context -> 'recordType',$q$;
  action_new constant text := $q$    'validationContractVersion', action_context -> 'validationContractVersion',
    'recordType', action_context -> 'recordType',
    'beforeSaveRules', vortex_record.before_save_rules_for_record_type_internal(
      (action_context ->> 'moduleRootId')::uuid,
      (action_context ->> 'moduleReleaseRevision')::bigint,
      p_record_type_id
    ),$q$;
  target record;
  definition text;
  occurrences integer;
  owner_name name;
begin
  for target in
    select candidate.procedure_id, candidate.old_text, candidate.new_text
    from (values
      ('vortex_record.prepare_base_record_save(uuid,text,uuid,uuid,bigint,jsonb,uuid,uuid)'::pg_catalog.regprocedure,
        base_old, base_new),
      ('vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid)'::pg_catalog.regprocedure,
        action_old, action_new)
    ) as candidate(procedure_id, old_text, new_text)
  loop
    definition := pg_catalog.pg_get_functiondef(target.procedure_id);
    if definition is null then
      raise exception using errcode = '55000',
        message = 'Before-save rule preparation is missing', detail = target.procedure_id::text;
    end if;
    definition := pg_catalog.replace(definition, E'\r\n', E'\n');
    if pg_catalog.strpos(definition, 'before_save_rules_for_record_type_internal') <> 0 then
      raise exception using errcode = '55000',
        message = 'Before-save rule preparation is already patched', detail = target.procedure_id::text;
    end if;
    occurrences := (
      pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, target.old_text, ''))
    ) / pg_catalog.length(target.old_text);
    if occurrences <> 1 then
      raise exception using errcode = '55000',
        message = 'Before-save rule patch does not match exactly once',
        detail = target.procedure_id::text;
    end if;
    definition := pg_catalog.replace(definition, target.old_text, target.new_text);
    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = target.procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    set local role vortex_record_adapter;
  end loop;
end
$migration$;

alter function vortex_record.before_save_rules_for_record_type_internal(uuid, bigint, uuid)
  owner to vortex_record_adapter;

revoke all on function vortex_record.before_save_rules_for_record_type_internal(uuid, bigint, uuid)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.before_save_rules_for_record_type_internal(uuid, bigint, uuid)
  to vortex_record_adapter;

comment on function vortex_record.before_save_rules_for_record_type_internal(uuid, bigint, uuid) is
  'Private save step: returns the exact Module release identity and that release''s canonical before-save rule graphs whose subject is the given record type, read from the immutable release row the save already resolved.';

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
