-- Issue #831: an Application that declares flows or flow bindings can be
-- published, read by consumers and restored. Flow-target evidence is stored in
-- the immutable dependency store as first-class kinds, so publication, consumer
-- read and restore all agree on the same complete exact dependency manifest.
--
-- The full manifest entry is preserved losslessly in dependency_entry; the
-- scalar columns keep their existing shape so the four original kinds and every
-- reader that only inspects module dependencies keep working unchanged.

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
  add constraint release_dependencies_entry_shape check (
    (
      dependency_kind in (
        'platform_flow', 'application_flow', 'application_flow_node', 'application_query',
        'module_query', 'application_form', 'application_workflow', 'application_action',
        'protected_operation'
      )
      and dependency_entry is not null
      and pg_catalog.jsonb_typeof(dependency_entry) = 'object'
      and dependency_entry ->> 'kind' = dependency_kind
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
-- so every earlier lock, field-policy and transitive-closure change survives.
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
  supplied_entry jsonb;$r1$,
    $r2$    elsif supplied_kind in (
      'platform_flow', 'application_flow', 'application_flow_node', 'application_query',
      'module_query', 'application_form', 'application_workflow', 'application_action',
      'protected_operation'
    ) then
      supplied_entry := supplied_dependency;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_evidence_fingerprint := coalesce(
        supplied_dependency ->> 'resolutionFingerprint',
        supplied_dependency ->> 'catalogueFingerprint'
      );
      supplied_target_root_id := null;
      supplied_target_release_revision := null;
      supplied_catalogue_item_id := null;
      if supplied_kind = 'platform_flow' then
        supplied_reference := supplied_dependency ->> 'flowId';
      elsif supplied_kind = 'application_flow' then
        supplied_reference := (supplied_dependency ->> 'applicationRootId')
          || ':' || (supplied_dependency ->> 'flowId');
      elsif supplied_kind = 'application_flow_node' then
        supplied_reference := (supplied_dependency ->> 'applicationRootId')
          || ':' || (supplied_dependency ->> 'flowId')
          || ':' || (supplied_dependency ->> 'nodeId');
      elsif supplied_kind = 'application_query' then
        supplied_reference := (supplied_dependency ->> 'applicationRootId')
          || ':' || (supplied_dependency ->> 'queryId');
      elsif supplied_kind = 'module_query' then
        supplied_reference := (supplied_dependency ->> 'moduleRootId')
          || ':' || (supplied_dependency ->> 'queryId');
      elsif supplied_kind = 'application_form' then
        supplied_reference := (supplied_dependency ->> 'applicationRootId')
          || ':' || (supplied_dependency ->> 'formId');
      elsif supplied_kind = 'application_workflow' then
        supplied_reference := (supplied_dependency ->> 'applicationRootId')
          || ':' || (supplied_dependency ->> 'workflowId');
      elsif supplied_kind = 'application_action' then
        supplied_reference := (supplied_dependency ->> 'applicationRootId')
          || ':' || (supplied_dependency ->> 'actionId');
      else
        supplied_reference := (supplied_dependency #>> '{operation,owner,kind}')
          || ':' || case supplied_dependency #>> '{operation,owner,kind}'
            when 'application' then supplied_dependency #>> '{operation,owner,applicationRootId}'
            when 'module' then supplied_dependency #>> '{operation,owner,moduleRootId}'
            else supplied_dependency #>> '{operation,owner,serviceId}'
          end
          || ':' || (supplied_dependency #>> '{operation,operationId}');
      end if;
      if supplied_reference is null
        or pg_catalog.char_length(supplied_reference) not between 1 and 500
        or supplied_reference ~ '[[:space:]]'
        or supplied_version is null
        or supplied_version !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
        or supplied_content_fingerprint is null
        or supplied_content_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or supplied_evidence_fingerprint is null
        or supplied_evidence_fingerprint !~ '^sha256:[a-f0-9]{64}$'
        or exists (
          select 1
          from pg_catalog.jsonb_object_keys(supplied_dependency) as supplied(key)
          where supplied.key not in (
            'kind', 'flowId', 'applicationRootId', 'nodeId', 'queryId', 'moduleRootId',
            'declaredRequirement', 'operation', 'releaseVersion', 'contentFingerprint',
            'resolutionFingerprint', 'catalogueFingerprint', 'formId', 'workflowId', 'actionId'
          )
        )
        or (supplied_kind = 'module_query'
          and pg_catalog.jsonb_typeof(supplied_dependency -> 'declaredRequirement') is distinct from 'object')
        or (supplied_kind = 'protected_operation'
          and pg_catalog.jsonb_typeof(supplied_dependency -> 'operation') is distinct from 'object')
        or (supplied_kind = 'platform_flow'
          and supplied_dependency ->> 'catalogueFingerprint' is null) then
        raise exception using errcode = '22023',
          message = 'Definition flow target dependency has invalid evidence';
      end if;
    else
      raise exception using errcode = '22023', message = 'Definition dependency has an unknown kind';
    end if;$r2$,
    $r3$        case supplied.value ->> 'kind'
          when 'platform_theme' then supplied.value ->> 'catalogueThemeId'
          when 'platform_block' then supplied.value ->> 'blockId'
          when 'platform_flow' then supplied.value ->> 'flowId'
          when 'application_flow' then (supplied.value ->> 'applicationRootId') || ':' || (supplied.value ->> 'flowId')
          when 'application_flow_node' then (supplied.value ->> 'applicationRootId') || ':' || (supplied.value ->> 'flowId') || ':' || (supplied.value ->> 'nodeId')
          when 'application_query' then (supplied.value ->> 'applicationRootId') || ':' || (supplied.value ->> 'queryId')
          when 'module_query' then (supplied.value ->> 'moduleRootId') || ':' || (supplied.value ->> 'queryId')
          when 'application_form' then (supplied.value ->> 'applicationRootId') || ':' || (supplied.value ->> 'formId')
          when 'application_workflow' then (supplied.value ->> 'applicationRootId') || ':' || (supplied.value ->> 'workflowId')
          when 'application_action' then (supplied.value ->> 'applicationRootId') || ':' || (supplied.value ->> 'actionId')
          when 'protected_operation' then (supplied.value #>> '{operation,owner,kind}') || ':' || case supplied.value #>> '{operation,owner,kind}'
            when 'application' then supplied.value #>> '{operation,owner,applicationRootId}'
            when 'module' then supplied.value #>> '{operation,owner,moduleRootId}'
            else supplied.value #>> '{operation,owner,serviceId}'
          end || ':' || (supplied.value #>> '{operation,operationId}')
          else supplied.value ->> 'key'
        end as dependency_reference,$r3$,
    $r4$    supplied_catalogue_item_id := case supplied_kind
      when 'connection_type' then (supplied_dependency ->> 'rootId')::uuid
      when 'platform_block' then (supplied_dependency ->> 'blockId')::uuid
      else null
    end;

    if supplied_kind in (
      'platform_flow', 'application_flow', 'application_flow_node', 'application_query',
      'module_query', 'application_form', 'application_workflow', 'application_action',
      'protected_operation'
    ) then
      supplied_entry := supplied_dependency;
      supplied_version := supplied_dependency ->> 'releaseVersion';
      supplied_content_fingerprint := supplied_dependency ->> 'contentFingerprint';
      supplied_evidence_fingerprint := coalesce(
        supplied_dependency ->> 'resolutionFingerprint',
        supplied_dependency ->> 'catalogueFingerprint'
      );
      supplied_reference := case supplied_kind
        when 'platform_flow' then supplied_dependency ->> 'flowId'
        when 'application_flow' then (supplied_dependency ->> 'applicationRootId') || ':' || (supplied_dependency ->> 'flowId')
        when 'application_flow_node' then (supplied_dependency ->> 'applicationRootId') || ':' || (supplied_dependency ->> 'flowId') || ':' || (supplied_dependency ->> 'nodeId')
        when 'application_query' then (supplied_dependency ->> 'applicationRootId') || ':' || (supplied_dependency ->> 'queryId')
        when 'module_query' then (supplied_dependency ->> 'moduleRootId') || ':' || (supplied_dependency ->> 'queryId')
        when 'application_form' then (supplied_dependency ->> 'applicationRootId') || ':' || (supplied_dependency ->> 'formId')
        when 'application_workflow' then (supplied_dependency ->> 'applicationRootId') || ':' || (supplied_dependency ->> 'workflowId')
        when 'application_action' then (supplied_dependency ->> 'applicationRootId') || ':' || (supplied_dependency ->> 'actionId')
        else (supplied_dependency #>> '{operation,owner,kind}') || ':' || case supplied_dependency #>> '{operation,owner,kind}'
          when 'application' then supplied_dependency #>> '{operation,owner,applicationRootId}'
          when 'module' then supplied_dependency #>> '{operation,owner,moduleRootId}'
          else supplied_dependency #>> '{operation,owner,serviceId}'
        end || ':' || (supplied_dependency #>> '{operation,operationId}')
      end;
    else
      supplied_entry := null;
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
    $r5$          else case
            when dependency.dependency_kind in (
              'platform_flow', 'application_flow', 'application_flow_node', 'application_query',
              'module_query', 'application_form', 'application_workflow', 'application_action',
              'protected_operation'
            ) then dependency.dependency_entry
            else pg_catalog.jsonb_build_object(
              'kind', 'platform_theme', 'catalogueThemeId', dependency.dependency_reference,
              'releaseVersion', dependency.dependency_version,
              'contentFingerprint', dependency.dependency_content_fingerprint,
              'catalogueFingerprint', dependency.evidence_fingerprint
            )
          end$r5$
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
  replacement text := $replacement$          else case
            when dependency.dependency_kind in (
              'platform_flow', 'application_flow', 'application_flow_node', 'application_query',
              'module_query', 'application_form', 'application_workflow', 'application_action',
              'protected_operation'
            ) then dependency.dependency_entry
            else pg_catalog.jsonb_build_object(
              'kind', 'platform_theme',
              'catalogueThemeId', dependency.dependency_reference,
              'releaseVersion', dependency.dependency_version,
              'contentFingerprint', dependency.dependency_content_fingerprint,
              'catalogueFingerprint', dependency.evidence_fingerprint
            )
          end$replacement$;
  source text;
  occurrence_count integer;
  signature text;
begin
  foreach signature in array function_signatures loop
    select pg_catalog.pg_get_functiondef(signature::regprocedure) into source;
    if source is null then
      raise exception 'Definition reader % is missing', signature;
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
