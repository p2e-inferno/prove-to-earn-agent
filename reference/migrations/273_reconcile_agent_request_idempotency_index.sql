DROP INDEX IF EXISTS public.uq_agent_requests_actor_identity;

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_requests_identity
  ON public.agent_requests (agent_id, method, route, idempotency_key);
