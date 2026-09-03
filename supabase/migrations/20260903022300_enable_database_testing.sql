-- pgTAP powers the committed database tests run locally and against Testing.
-- Supabase now installs the default extension version, so no version is pinned.
create extension if not exists pgtap with schema extensions;
