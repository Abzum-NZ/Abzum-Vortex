-- Issue #831: an Application that declares flows or flow bindings can be
-- published, read by consumers and restored. Flow-target evidence is stored in
-- the immutable dependency store as first-class kinds, so publication, consumer
-- read and restore all agree on the same complete exact dependency manifest.
--
-- The full manifest entry is preserved losslessly in dependency_entry; the
-- scalar columns keep their existing shape so the four original kinds and every
-- reader that only inspects module dependencies keep working unchanged.

-- The one stored subject reference for a flow-target manifest entry. It is the
-- manifest subject without its kind prefix, so the stored (kind, reference)
-- order equals the contract's deterministic subject order. Null for any other
-- kind or an incomplete entry.
create function vortex_definition.flow_target_dependency_reference(p_dependency jsonb)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case p_dependency ->> 'kind'
    when 'platform_flow' then p_dependency ->> 'flowId'
    when 'application_flow' then
      (p_dependency ->> 'applicationRootId') || ':' || (p_dependency ->> 'flowId')
    when 'application_flow_node' then
      (p_dependency ->> 'applicationRootId') || ':' || (p_dependency ->> 'flowId')
        || ':' || (p_dependency ->> 'nodeId')
    when 'application_query' then
      (p_dependency ->> 'applicationRootId') || ':' || (p_dependency ->> 'queryId')
    when 'module_query' then
      (p_dependency ->> 'moduleRootId') || ':' || (p_dependency ->> 'queryId')
    when 'application_form' then
      (p_dependency ->> 'applicationRootId') || ':' || (p_dependency ->> 'formId')
    when 'application_workflow' then
      (p_dependency ->> 'applicationRootId') || ':' || (p_dependency ->> 'workflowId')
    when 'application_action' then
      (p_dependency ->> 'applicationRootId') || ':' || (p_dependency ->> 'actionId')
    when 'protected_operation' then
      (p_dependency #>> '{operation,owner,kind}') || ':'
        || case p_dependency #>> '{operation,owner,kind}'
          when 'application' then p_dependency #>> '{operation,owner,applicationRootId}'
          when 'module' then p_dependency #>> '{operation,owner,moduleRootId}'
          when 'platform_service' then p_dependency #>> '{operation,owner,serviceId}'
        end
        || ':' || (p_dependency #>> '{operation,operationId}')
    else null
  end
$function$;

revoke all on function vortex_definition.flow_target_dependency_reference(jsonb)
  from public, anon, authenticated, service_role, vortex_runtime, vortex_request;

comment on function vortex_definition.flow_target_dependency_reference(jsonb) is
  'Owner-private canonical subject reference of one flow-target dependency manifest entry.';

alter table vortex_definition.release_dependencies
  add column dependency_entry jsonb,
  drop constraint release_dependencies_kind_valid,
  drop constraint release_dependencies_reference_shape,
  drop constraint release_dependencies_target_shape;

alter table vortex_definition.release_dependencies
  add constraint release_dependencies_kind_valid check (
    dependency_kind in (
      'module', 'connection_type', 'platform_block', 'platform_theme',
      'platform_flow', 'application_flow', 'application_flow_node', 'application_query',
      'module_query', 'application_form', 'application_workflow', 'application_action',
      'protected_operation'
    )
  ),
  add constraint release_dependencies_reference_shape check (
    (
      dependency_kind in ('module', 'connection_type')
      and pg_catalog.char_length(dependency_reference) between 3 and 120
      and dependency_reference ~ '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$'
      and dependency_reference !~ '(^|\.)[^.]{41,}(\.|$)'
    )
    or (
      dependency_kind in ('platform_block', 'platform_theme')
      and dependency_reference ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and dependency_reference <> '00000000-0000-0000-0000-000000000000'
    )
    or (
      dependency_kind in (
        'platform_flow', 'application_flow', 'application_flow_node', 'application_query',
        'module_query', 'application_form', 'application_workflow', 'application_action',
        'protected_operation'
      )
      and pg_catalog.char_length(dependency_reference) between 1 and 500
      and dependency_reference !~ '[[:space:]]'
    )
  ),
  add constraint release_dependencies_target_shape check (
    (dependency_kind = 'module' and target_root_id is not null and target_release_revision between 1 and 9007199254740991 and catalogue_item_id is null)
    or (dependency_kind = 'connection_type' and target_root_id is null and target_release_revision is null and catalogue_item_id is not null and catalogue_item_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    or (dependency_kind = 'platform_block' and target_root_id is null and target_release_revision is null and catalogue_item_id is not null and catalogue_item_id::text = dependency_reference)
    or (dependency_kind = 'platform_theme' and target_root_id is null and target_release_revision is null and catalogue_item_id is null)
    or (
      dependency_kind in (
        'platform_flow', 'application_flow', 'application_flow_node', 'application_query',
        'module_query', 'application_form', 'application_workflow', 'application_action',
        'protected_operation'
      )
      and target_root_id is null
      and target_release_revision is null
      and catalogue_item_id is null
    )
  ),
  -- A flow-target row is exactly its stored entry: the scalar columns are
  -- derived from it, so no reader can see a reference or evidence that differs
  -- from the entry it returns.
  add constraint release_dependencies_entry_shape check (
    coalesce(
      dependency_kind in (
        'platform_flow', 'application_flow', 'application_flow_node', 'application_query',
        'module_query', 'application_form', 'application_workflow', 'application_action',
        'protected_operation'
      )
      and pg_catalog.jsonb_typeof(dependency_entry) = 'object'
      and dependency_entry ->> 'kind' = dependency_kind
      and dependency_reference = vortex_definition.flow_target_dependency_reference(dependency_entry)
      and dependency_version = dependency_entry ->> 'releaseVersion'
      and dependency_content_fingerprint = dependency_entry ->> 'contentFingerprint'
      and evidence_fingerprint = case
        when dependency_kind = 'platform_flow' then dependency_entry ->> 'catalogueFingerprint'
        else dependency_entry ->> 'resolutionFingerprint'
      end,
      false
    )
    or (
      dependency_kind in ('module', 'connection_type', 'platform_block', 'platform_theme')
      and dependency_entry is null
    )
  );

comment on column vortex_definition.release_dependencies.dependency_entry is
  'Complete immutable flow-target manifest entry; present exactly for the Application flow-target kinds and null for the original scalar kinds.';

-- append_release: accept, validate and store the flow-target kinds, and return
-- the complete manifest. The live body is patched in place (pg_get_functiondef)
-- so every earlier lock, field-policy, history-pointer and transitive-closure
-- change survives. Each anchor must match exactly once and the patch refuses a
-- body that already carries it.
do $patch_append_release$
declare
  source text;
  anchors text[];
  replacements text[];
  occurrence_count integer;
  anchor_index integer;
begin
  select pg_catalog.pg_get_functiondef(
    'vortex_definition.append_release(uuid,bigint,text,jsonb)'::regprocedure
  ) into source;
  if source is null then
    raise exception 'Definition append release function is missing';
  end if;
  if pg_catalog.strpos(source, 'dependency_entry') <> 0
    or pg_catalog.strpos(source, 'flow_target_dependency_reference') <> 0 then
    raise exception 'Definition append release already stores flow-target dependencies';
  end if;

  anchors := array[
    $a1$  supplied_catalogue_item_id uuid;$a1$,
    $a2$    else
      raise exception using errcode = '22023', message = 'Definition dependency has an unknown kind';
    end if;$a2$,
    $a3$        case supplied.value ->> 'kind'
          when 'platform_theme' then supplied.value ->> 'catalogueThemeId'
          when 'platform_block' then supplied.value ->> 'blockId'
          else supplied.value ->> 'key'
        end as dependency_reference,$a3$,
    $a4$    supplied_catalogue_item_id := case supplied_kind
      when 'connection_type' then (supplied_dependency ->> 'rootId')::uuid
      when 'platform_block' then (supplied_dependency ->> 'blockId')::uuid
      else null
    end;

    insert into vortex_definition.release_dependencies (
      root_id, release_revision, dependency_kind, dependency_reference,
      dependency_version, dependency_content_fingerprint, evidence_fingerprint,
      target_root_id, target_release_revision, catalogue_item_id
    ) values (
      p_root_id, draft_row.draft_revision, supplied_kind, supplied_reference,
      supplied_version, supplied_content_fingerprint, supplied_evidence_fingerprint,
      supplied_target_root_id, supplied_target_release_revision, supplied_catalogue_item_id
    );$a4$,
    $a5$          else pg_catalog.jsonb_build_object(
            'kind', 'platform_theme', 'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'catalogueFingerprint', dependency.evidence_fingerprint
          )$a5$
  ];

  replacements := array[
    $r1$  supplied_catalogue_item_id uuid;
  supplied_entry jsonb;
  supplied_owner_kind text;
  supplied_owner_id_key text;
  supplied_expected_keys text[];$r1$,
    $r2$    elsif supplied_kind in (
      'platform_flow', 'application_flow', 'application_flow_node', 'application_query',
      'module_query', 'application_form', 'application_workflow', 'application_action',
      'protected_operation'
    ) then
      -- Flow targets are contained by, or pinned for, one exact Application
      -- release. Each entry has exactly its contract shape, and its owner is
      -- this release, an exact pinned Module release in this same manifest, or
      -- platform catalogue evidence that publication verifies before append.
      if root_row.kind is distinct from 'application' then
        raise exception using errcode = '23514',
          message = 'Flow target dependencies belong only to an Application release';
      end if;
      supplied_owner_kind := case supplied_kind
        when 'protected_operation' then supplied_dependency #>> '{operation,owner,kind}'
        when 'module_query' then 'module'
        when 'platform_flow' then 'platform_service'
        else 'application'
      end;
      supplied_expected_keys := pg_catalog.array_cat(
        array['kind', 'releaseVersion', 'contentFingerprint']::text[],
        case supplied_kind
          when 'platform_flow' then array['flowId', 'catalogueFingerprint']::text[]
          when 'application_flow' then
            array['applicationRootId', 'flowId', 'resolutionFingerprint']::text[]
          when 'application_flow_node' then
            array['applicationRootId', 'flowId', 'nodeId', 'resolutionFingerprint']::text[]
          when 'application_query' then
            array['applicationRootId', 'queryId', 'resolutionFingerprint']::text[]
          when 'module_query' then
            array['moduleRootId', 'queryId', 'declaredRequirement', 'resolutionFingerprint']::text[]
          when 'application_form' then
            array['applicationRootId', 'formId', 'resolutionFingerprint']::text[]
          when 'application_workflow' then
            array['applicationRootId', 'workflowId', 'resolutionFingerprint']::text[]
          when 'application_action' then
            array['applicationRootId', 'actionId', 'resolutionFingerprint']::text[]
          when 'protected_operation' then
            case when supplied_owner_kind = 'platform_service'
              then array['operation', 'resolutionFingerprint', 'catalogueFingerprint']::text[]
              else array['operation', 'resolutionFingerprint']::text[]
            end
        end
      );
      if exists (
          select 1
          from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
          where supplied.key <> all (supplied_expected_keys)
        )
        or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency))
          <> pg_catalog.cardinality(supplied_expected_keys)
        or exists (
          select 1
          from pg_catalog.unnest(supplied_expected_keys) as expected(key)
          where expected.key not in ('operation', 'declaredRequirement')
            and pg_catalog.jsonb_typeof(supplied_dependency -> expected.key) is distinct from 'string'
        )
        or (
          supplied_kind = 'module_query'
          and pg_catalog.jsonb_typeof(supplied_dependency -> 'declaredRequirement')
            is distinct from 'object'
        )
        or (
          supplied_kind = 'protected_operation'
          and (
            pg_catalog.jsonb_typeof(supplied_dependency -> 'operation') is distinct from 'object'
            or pg_catalog.jsonb_typeof(supplied_dependency #> '{operation,owner}')
              is distinct from 'object'
            or supplied_owner_kind is null
            or supplied_owner_kind not in ('application', 'module', 'platform_service')
          )
        ) then
        raise exception using errcode = '22023',
          message = 'Definition flow target dependency has an invalid shape';
      end if;
      if supplied_kind = 'protected_operation' then
        supplied_owner_id_key := case supplied_owner_kind
          when 'application' then 'applicationRootId'
          when 'module' then 'moduleRootId'
          else 'serviceId'
        end;
        if exists (
            select 1
            from pg_catalog.jsonb_object_keys(supplied_dependency -> 'operation') as operation_key(key)
            where operation_key.key not in ('owner', 'operationId')
          )
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency -> 'operation')) <> 2
          or pg_catalog.jsonb_typeof(supplied_dependency #> '{operation,operationId}')
            is distinct from 'string'
          or exists (
            select 1
            from pg_catalog.jsonb_object_keys(supplied_dependency #> '{operation,owner}') as owner_key(key)
            where owner_key.key not in ('kind', supplied_owner_id_key)
          )
          or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(supplied_dependency #> '{operation,owner}')) <> 2
          or pg_catalog.jsonb_typeof(
            supplied_dependency -> 'operation' -> 'owner' -> supplied_owner_id_key
          ) is distinct from 'string' then
          raise exception using errcode = '22023',
            message = 'Definition flow target dependency has an invalid shape';
        end if;
      end if;

      supplied_reference := vortex_definition.flow_target_dependency_reference(supplied_dependency);
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_evidence_fingerprint := case
        when supplied_kind = 'platform_flow' then supplied_dependency ->> 'catalogueFingerprint'
        else supplied_dependency ->> 'resolutionFingerprint'
      end;
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      supplied_catalogue_item_id := null;
      if supplied_reference is null
        or pg_catalog.char_length(supplied_reference) not between 1 and 500
        or supplied_reference ~ '[[:space:]]'
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or supplied_evidence_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or (
          supplied_dependency ? 'resolutionFingerprint'
          and supplied_dependency ->> 'resolutionFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        )
        or (
          supplied_dependency ? 'catalogueFingerprint'
          and supplied_dependency ->> 'catalogueFingerprint' !~ '^sha256:[a-f0-9]{64}$'
        ) then
        raise exception using errcode = '22023',
          message = 'Definition flow target dependency has invalid evidence';
      end if;

      if (
          supplied_owner_kind = 'application'
          and (
            case when supplied_kind = 'protected_operation'
              then supplied_dependency #>> '{operation,owner,applicationRootId}'
              else supplied_dependency ->> 'applicationRootId'
            end is distinct from p_root_id::text
            or supplied_version is distinct from release_version_value
            or supplied_dependency ->> 'resolutionFingerprint'
              is distinct from resolution_fingerprint_value
          )
        )
        or (
          supplied_owner_kind = 'module'
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements(dependency_manifest_value) as pinned(value)
            where pinned.value ->> 'kind' = 'module'
              and pinned.value ->> 'rootId' = case when supplied_kind = 'protected_operation'
                then supplied_dependency #>> '{operation,owner,moduleRootId}'
                else supplied_dependency ->> 'moduleRootId'
              end
              and pinned.value ->> 'releaseVersion' = supplied_version
              and pinned.value ->> 'resolutionFingerprint' =
                supplied_dependency ->> 'resolutionFingerprint'
          )
        ) then
        raise exception using errcode = '23514',
          message = 'Flow target dependency does not identify this release or an exact pinned module release';
      end if;
    else
      raise exception using errcode = '22023', message = 'Definition dependency has an unknown kind';
    end if;$r2$,
    $r3$        case supplied.value ->> 'kind'
          when 'platform_theme' then supplied.value ->> 'catalogueThemeId'
          when 'platform_block' then supplied.value ->> 'blockId'
          when 'module' then supplied.value ->> 'key'
          when 'connection_type' then supplied.value ->> 'key'
          else vortex_definition.flow_target_dependency_reference(supplied.value)
        end as dependency_reference,$r3$,
    $r4$    supplied_catalogue_item_id := case supplied_kind
      when 'connection_type' then (supplied_dependency ->> 'rootId')::uuid
      when 'platform_block' then (supplied_dependency ->> 'blockId')::uuid
      else null
    end;
    supplied_entry := null;
    if supplied_kind in (
      'platform_flow', 'application_flow', 'application_flow_node', 'application_query',
      'module_query', 'application_form', 'application_workflow', 'application_action',
      'protected_operation'
    ) then
      supplied_entry := supplied_dependency;
      supplied_reference := vortex_definition.flow_target_dependency_reference(supplied_dependency);
      supplied_evidence_fingerprint := case
        when supplied_kind = 'platform_flow' then supplied_dependency ->> 'catalogueFingerprint'
        else supplied_dependency ->> 'resolutionFingerprint'
      end;
    end if;

    insert into vortex_definition.release_dependencies (
      root_id, release_revision, dependency_kind, dependency_reference,
      dependency_version, dependency_content_fingerprint, evidence_fingerprint,
      target_root_id, target_release_revision, catalogue_item_id, dependency_entry
    ) values (
      p_root_id, draft_row.draft_revision, supplied_kind, supplied_reference,
      supplied_version, supplied_content_fingerprint, supplied_evidence_fingerprint,
      supplied_target_root_id, supplied_target_release_revision, supplied_catalogue_item_id,
      supplied_entry
    );$r4$,
    $r5$          when 'platform_theme' then pg_catalog.jsonb_build_object(
            'kind', 'platform_theme', 'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'catalogueFingerprint', dependency.evidence_fingerprint
          )
          else dependency.dependency_entry$r5$
  ];

  for anchor_index in 1..pg_catalog.array_length(anchors, 1) loop
    occurrence_count := (
      pg_catalog.char_length(source)
      - pg_catalog.char_length(pg_catalog.replace(source, anchors[anchor_index], ''))
    ) / pg_catalog.char_length(anchors[anchor_index]);
    if occurrence_count <> 1 then
      raise exception 'Definition append release patch anchor % matched % times', anchor_index, occurrence_count;
    end if;
    source := pg_catalog.replace(source, anchors[anchor_index], replacements[anchor_index]);
  end loop;

  execute source;
end
$patch_append_release$;

-- The two protected readers and the human application-bound projector rebuild
-- the complete manifest. They now emit the stored flow-target entry for every
-- flow-target kind and the original scalar object for the four original kinds.
do $patch_definition_readers$
declare
  function_signatures text[] := array[
    'vortex_definition.read_consumer_release(text,uuid,bigint)',
    'vortex_definition.read_restore_release_evidence(text,uuid,bigint)',
    'vortex_definition.project_consumer_release_evidence(text,uuid,bigint)'
  ];
  anchor text := $anchor$          else pg_catalog.jsonb_build_object(
            'kind', 'platform_theme',
            'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'catalogueFingerprint', dependency.evidence_fingerprint
          )$anchor$;
  replacement text := $replacement$          when 'platform_theme' then pg_catalog.jsonb_build_object(
            'kind', 'platform_theme',
            'catalogueThemeId', dependency.dependency_reference,
            'releaseVersion', dependency.dependency_version,
            'contentFingerprint', dependency.dependency_content_fingerprint,
            'catalogueFingerprint', dependency.evidence_fingerprint
          )
          else dependency.dependency_entry$replacement$;
  source text;
  occurrence_count integer;
  signature text;
begin
  foreach signature in array function_signatures loop
    select pg_catalog.pg_get_functiondef(signature::regprocedure) into source;
    if source is null then
      raise exception 'Definition reader % is missing', signature;
    end if;
    if pg_catalog.strpos(source, 'dependency_entry') <> 0 then
      raise exception 'Definition reader % already returns flow-target dependencies', signature;
    end if;
    occurrence_count := (
      pg_catalog.char_length(source)
      - pg_catalog.char_length(pg_catalog.replace(source, anchor, ''))
    ) / pg_catalog.char_length(anchor);
    if occurrence_count <> 1 then
      raise exception 'Definition reader % manifest patch anchor matched % times', signature, occurrence_count;
    end if;
    source := pg_catalog.replace(source, anchor, replacement);
    execute source;
  end loop;
end
$patch_definition_readers$;
