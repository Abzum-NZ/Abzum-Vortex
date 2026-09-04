-- Synthetic development and test data will be added by the issue that owns
-- each schema. Production delivery never applies this file.

-- The application connects as the same restricted runtime login in Local as it does when hosted.
-- This credential is intentionally fixed and Local-only; it is never valid outside the disposable
-- Supabase CLI database on exact loopback.
alter role vortex_runtime password 'vortex-runtime-local-only';
