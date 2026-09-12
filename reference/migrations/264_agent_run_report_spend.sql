ALTER TABLE public.agent_run_reports
  ADD COLUMN IF NOT EXISTS spend jsonb NOT NULL DEFAULT '{}'::jsonb;
