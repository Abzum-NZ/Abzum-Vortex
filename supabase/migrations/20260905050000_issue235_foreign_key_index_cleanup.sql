-- Cover the three Phase 2 foreign keys reported by the Supabase adviser.
-- The replacement target-release index keeps its existing target-root predicate:
-- only module dependency rows carry a target release, and those rows require a
-- non-null target_root_id. Its first two columns retain the prior lookup prefix.

drop index vortex_definition.release_dependencies_target_release_idx;

create index release_dependencies_target_release_idx
  on vortex_definition.release_dependencies (
    target_root_id,
    target_release_revision,
    dependency_version,
    dependency_content_fingerprint
  ) where target_root_id is not null;

create index roots_current_release_idx
  on vortex_definition.roots (root_id, current_release_revision);

create index source_identity_aliases_owner_idx
  on vortex_definition.source_identity_aliases (
    root_id,
    owner_scope,
    kind,
    component_owner,
    identity_id
  );
