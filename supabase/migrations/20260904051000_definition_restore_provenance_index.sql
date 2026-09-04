create index drafts_restored_release_source_idx
  on vortex_definition.drafts (
    root_id,
    restored_from_release_revision,
    restored_from_source_fingerprint
  )
  where restored_from_release_revision is not null;
