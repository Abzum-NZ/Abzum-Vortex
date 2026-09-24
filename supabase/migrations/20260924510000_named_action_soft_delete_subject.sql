-- #571: a named action may soft-delete its subject through the shared
-- protected lifecycle delete.
--
-- `soft_delete_subject` is a declared, published effect, but nothing executed
-- it: the preparation and the terminal writer both refused any effect kind
-- other than `set_field`, `create_record`, `copy_relationships` and
-- `announce_event`. This migration lets those two pass a delete-bearing action,
-- and nothing else about the effect model changes.
--
-- There is no second delete path. After the named-action writer has claimed the
-- receipt, recorded the action's Activity and announced its Events, the Record
-- runtime runs the #560 protected delete (`prepare_protected_record_delete`,
-- the runtime's dependency-total recalculation, `finalize_protected_record_delete`)
-- in the same request transaction, with the action's command identity, the
-- revision the action left the subject at and its own Activity and `deleted`
-- Event identities. That delete authorizes the actor's ordinary delete access
-- to the subject, refuses a stale revision, an unavailable or already deleted
-- subject and a `refuse` parent-delete relationship, and recalculates every
-- parent total. Any refusal or failure there raises, so the named-action receipt,
-- Activity, Events and the delete commit or roll back together and a refused
-- delete leaves no partial effect.
--
-- The runtime only composes a deleting action that declares no other subject
-- write, creation or relationship copy, because the delete removes the subject
-- those would write to, link to or copy from. A deleting action may announce
-- Events; they are recorded, with the subject's last values, before the delete.
--
-- A deleted subject cannot be projected, so a replay of a completed deleting
-- action reports the delete's own stored outcome instead: the deleted revision
-- and no values, found through the lifecycle receipt of the same command
-- identity and revision. A record restored later projects normally again.
--
-- Restore is unchanged and stays #560's `restoreRecord`, within its policy.
--
-- The two existing functions are patched in place from their current live
-- definitions, as `20260924360000` does: each reviewed fragment must occur
-- exactly once, or the migration aborts instead of silently skipping a caller.
-- Grants, ownership and authorization are otherwise unchanged.

begin;

set local role vortex_record_owner;
grant create on schema vortex_record to vortex_record_adapter;
reset role;
set local role vortex_record_adapter;

-- ---------------------------------------------------------------------------
-- The stored outcome of a completed deleting action, for its replay. Returns
-- null unless the installed action declares `soft_delete_subject` and the same
-- command identity completed a delete of this subject at this revision.
-- ---------------------------------------------------------------------------
create function vortex_record.named_action_deleted_subject_replay_internal(
  p_command_id uuid,
  p_action_owner_kind text,
  p_action_owner_id uuid,
  p_action_release_revision bigint,
  p_action_id uuid,
  p_record_type_id uuid,
  p_record_id uuid,
  p_expected_concurrency_number bigint
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  action_context jsonb;
  replay jsonb;
begin
  action_context := vortex_record.resolve_named_action_context_internal(
    p_action_owner_kind, p_action_owner_id, p_action_release_revision,
    p_action_id, p_record_type_id
  );
  if not exists (
    select 1 from pg_catalog.jsonb_array_elements(
      action_context -> 'action' -> 'effects'
    ) item(value)
    where item.value ->> 'kind' = 'soft_delete_subject'
  ) then
    return null;
  end if;
  replay := vortex_record.record_lifecycle_receipt_outcome_internal(
    p_command_id, 'delete',
    vortex_record.record_lifecycle_command_fingerprint_internal(
      p_command_id, 'delete', p_record_type_id, p_record_id,
      p_expected_concurrency_number
    )
  );
  if replay ->> 'outcome' is distinct from 'deleted' then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'completed',
    'recordId', replay -> 'recordId',
    'concurrencyNumber', replay -> 'concurrencyNumber',
    'values', '{}'::jsonb,
    'correlationId', replay -> 'correlationId',
    'backgroundDelivery', 'pending',
    'replayed', true
  );
end
$function$;

-- Migration-time patch guard: returns the current definition with every
-- `[old, new]` pair substituted, each old fragment occurring exactly once.
create function vortex_record.apply_named_action_delete_patch_internal(
  p_procedure pg_catalog.regprocedure,
  p_patches jsonb
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  definition text;
  patch jsonb;
  old_text text;
  occurrences integer;
begin
  definition := pg_catalog.pg_get_functiondef(p_procedure);
  if definition is not null then
    definition := pg_catalog.replace(definition, E'\r\n', E'\n');
  end if;
  if definition is null or pg_catalog.jsonb_typeof(p_patches) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_patches) = 0 then
    raise exception using errcode = '22023',
      message = 'Named action delete patch is invalid';
  end if;
  for patch in select item.value from pg_catalog.jsonb_array_elements(p_patches) as item(value)
  loop
    old_text := patch ->> 0;
    if old_text is null or old_text = '' or patch ->> 1 is null then
      raise exception using errcode = '22023',
        message = 'Named action delete patch is invalid';
    end if;
    occurrences := (
      pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_text, ''))
    ) / pg_catalog.length(old_text);
    if occurrences <> 1 then
      raise exception using errcode = '55000',
        message = 'Named action delete patch does not match exactly once',
        detail = p_procedure::text;
    end if;
    definition := pg_catalog.replace(definition, old_text, patch ->> 1);
  end loop;
  return definition;
end
$function$;

do $migration$
declare
  -- The two preparation and writer guards that refused every other effect kind,
  -- as `20260924360000` left them.
  prepare_kind_old constant text :=
    $q$item.value ->> 'kind' not in ('set_field', 'create_record', 'copy_relationships', 'announce_event')$q$;
  prepare_kind_new constant text :=
    $q$item.value ->> 'kind' not in ('set_field', 'create_record', 'copy_relationships', 'soft_delete_subject', 'announce_event')$q$;
  save_kind_old constant text :=
    $q$effect.value ->> 'kind' not in ('set_field', 'create_record', 'copy_relationships', 'announce_event')$q$;
  save_kind_new constant text :=
    $q$effect.value ->> 'kind' not in ('set_field', 'create_record', 'copy_relationships', 'soft_delete_subject', 'announce_event')$q$;

  -- The replay of a completed command projects the subject, which a deleted
  -- subject cannot be; it reports the delete's own stored outcome instead.
  replay_old constant text := $q$    projection := vortex_record.project_named_action_record_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id
    );
    if projection ->> 'outcome' <> 'completed' then$q$;
  replay_new constant text := $q$    projection := vortex_record.project_named_action_record_internal(
      p_action_owner_kind, p_action_owner_id, p_action_release_revision,
      p_action_id, p_record_type_id, p_record_id
    );
    -- #571: a deleting action's subject is soft-deleted, so it cannot be
    -- projected; its replay is the delete's own stored outcome.
    if projection ->> 'outcome' <> 'completed' then
      projection := coalesce(
        vortex_record.named_action_deleted_subject_replay_internal(
          p_command_id, p_action_owner_kind, p_action_owner_id,
          p_action_release_revision, p_action_id, p_record_type_id, p_record_id,
          p_expected_concurrency_number
        ),
        projection
      );
    end if;
    if projection ->> 'outcome' <> 'completed' then$q$;

  target record;
  definition text;
  owner_name name;
begin
  for target in
    select candidate.procedure_id, candidate.patches
    from (values
      ('vortex_record.prepare_named_action_set_announce_internal(boolean,uuid,text,uuid,bigint,uuid,uuid,uuid,bigint,jsonb,uuid)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_array(prepare_kind_old, prepare_kind_new),
          pg_catalog.jsonb_build_array(replay_old, replay_new)
        )),
      ('vortex_record.save_named_action_set_announce(uuid,uuid,uuid,bigint,jsonb,jsonb,uuid,uuid,jsonb,text,uuid,bigint,uuid,jsonb)'::pg_catalog.regprocedure,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_array(save_kind_old, save_kind_new)))
    ) as candidate(procedure_id, patches)
  loop
    -- Patched as this migration's adapter role, then re-created under the
    -- function's own current owner so its grants, comment and OID stay put.
    definition := vortex_record.apply_named_action_delete_patch_internal(
      target.procedure_id, target.patches
    );
    select pg_catalog.pg_get_userbyid(procedure.proowner) into strict owner_name
    from pg_catalog.pg_proc as procedure
    where procedure.oid = target.procedure_id;
    execute pg_catalog.format('set local role %I', owner_name);
    execute definition;
    set local role vortex_record_adapter;
  end loop;
end
$migration$;

-- Migration-time patch guard; it has no runtime role once the callers above
-- have been rewritten.
drop function vortex_record.apply_named_action_delete_patch_internal(
  pg_catalog.regprocedure, jsonb
);

alter function vortex_record.named_action_deleted_subject_replay_internal(
  uuid, text, uuid, bigint, uuid, uuid, uuid, bigint
) owner to vortex_record_adapter;

revoke all on function vortex_record.named_action_deleted_subject_replay_internal(
  uuid, text, uuid, bigint, uuid, uuid, uuid, bigint
) from public, anon, authenticated, service_role, vortex_runtime, vortex_request,
  vortex_record_owner, vortex_module_owner;
grant execute on function vortex_record.named_action_deleted_subject_replay_internal(
  uuid, text, uuid, bigint, uuid, uuid, uuid, bigint
) to vortex_record_adapter;

comment on function vortex_record.named_action_deleted_subject_replay_internal(
  uuid, text, uuid, bigint, uuid, uuid, uuid, bigint
) is
  'Private named-action step: for an installed action that declares soft_delete_subject, reports the stored outcome of the completed protected delete carrying the same command identity and revision (the deleted revision and no values), because a deleted subject cannot be projected. Returns null otherwise.';

reset role;

set local role vortex_record_owner;
revoke create on schema vortex_record from vortex_record_adapter;
reset role;

commit;
