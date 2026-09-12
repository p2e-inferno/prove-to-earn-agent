ALTER TABLE public.agent_run_reports
  ADD COLUMN IF NOT EXISTS completion jsonb NULL;
