/**
 * Minimal stand-in for the private platform's generated `Json` column type
 * (`lib/supabase/types-gen.ts`). Vendoring the full generated types file
 * would pull in the entire app's database schema; this repo only needs the
 * `Json` alias that a couple of vendored files use for JSONB columns.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];
