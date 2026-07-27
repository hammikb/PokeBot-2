# Supabase migrations

These are incremental migrations for the existing PokeAlert Supabase project.
The project predates this repository's local Supabase directory, so its base
schema must be pulled before using `supabase db reset` against a new local
database. No production data or secrets are stored here.
