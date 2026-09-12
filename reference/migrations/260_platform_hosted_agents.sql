ALTER TABLE public.registered_agents
  ALTER COLUMN agent_wallet DROP NOT NULL,
  ALTER COLUMN status SET DEFAULT 'ready';

ALTER TABLE public.registered_agents
  DROP CONSTRAINT IF EXISTS registered_agents_status_check;

UPDATE public.registered_agents
SET status = 'ready'
WHERE status = 'active';

ALTER TABLE public.registered_agents
  DROP CONSTRAINT IF EXISTS registered_agents_wallet_provider_check,
  DROP CONSTRAINT IF EXISTS registered_agents_execution_mode_check,
  DROP CONSTRAINT IF EXISTS registered_agents_max_funding_swaps_check,
  DROP CONSTRAINT IF EXISTS registered_agents_world_status_check,
  DROP CONSTRAINT IF EXISTS registered_agents_agent_wallet_format_check,
  DROP CONSTRAINT IF EXISTS registered_agents_reward_wallet_format_check,
  DROP CONSTRAINT IF EXISTS registered_agents_provider_account_name_check,
  DROP CONSTRAINT IF EXISTS registered_agents_ready_wallet_check,
  DROP CONSTRAINT IF EXISTS registered_agents_world_verified_check;

ALTER TABLE public.registered_agents
  ADD COLUMN IF NOT EXISTS wallet_provider text NOT NULL DEFAULT 'cdp',
  ADD COLUMN IF NOT EXISTS provider_account_name text,
  ADD COLUMN IF NOT EXISTS execution_mode text NOT NULL DEFAULT 'owner_invoked',
  ADD COLUMN IF NOT EXISTS max_funding_swaps integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS world_status text NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS world_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS world_registration_tx_hash text,
  ADD COLUMN IF NOT EXISTS world_last_error_code text,
  ADD COLUMN IF NOT EXISTS ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS lifecycle_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_provisioning_error_code text;

ALTER TABLE public.registered_agents
  ADD CONSTRAINT registered_agents_status_check
    CHECK (status IN (
      'provisioning_wallet',
      'ready',
      'suspended',
      'provisioning_failed',
      'revoked'
    )),
  ADD CONSTRAINT registered_agents_wallet_provider_check
    CHECK (wallet_provider IN ('cdp', 'local')),
  ADD CONSTRAINT registered_agents_execution_mode_check
    CHECK (execution_mode IN ('owner_invoked', 'scheduled')),
  ADD CONSTRAINT registered_agents_max_funding_swaps_check
    CHECK (max_funding_swaps BETWEEN 0 AND 20),
  ADD CONSTRAINT registered_agents_world_status_check
    CHECK (world_status IN (
      'not_started',
      'in_progress',
      'skipped',
      'submitted',
      'verified',
      'failed'
    )),
  ADD CONSTRAINT registered_agents_agent_wallet_format_check
    CHECK (agent_wallet IS NULL OR agent_wallet ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT registered_agents_reward_wallet_format_check
    CHECK (reward_wallet ~ '^0x[0-9a-f]{40}$'),
  ADD CONSTRAINT registered_agents_provider_account_name_check
    CHECK (
      provider_account_name IS NULL
      OR provider_account_name ~ '^[A-Za-z0-9-]{2,36}$'
    ),
  ADD CONSTRAINT registered_agents_ready_wallet_check
    CHECK (status <> 'ready' OR agent_wallet IS NOT NULL),
  ADD CONSTRAINT registered_agents_world_verified_check
    CHECK (
      world_status <> 'verified'
      OR (agentbook_human_id IS NOT NULL AND world_verified_at IS NOT NULL)
    );

UPDATE public.registered_agents
SET
  world_status = CASE
    WHEN agentbook_human_id IS NOT NULL THEN 'verified'
    ELSE 'not_started'
  END,
  world_verified_at = CASE
    WHEN agentbook_human_id IS NOT NULL THEN COALESCE(world_verified_at, updated_at)
    ELSE NULL
  END,
  ready_at = CASE
    WHEN status = 'ready' THEN COALESCE(ready_at, updated_at)
    ELSE ready_at
  END,
  wallet_provider = CASE
    WHEN provider_account_name IS NULL AND agent_wallet IS NOT NULL THEN 'local'
    ELSE wallet_provider
  END,
  execution_mode = CASE
    WHEN provider_account_name IS NULL AND agent_wallet IS NOT NULL THEN 'scheduled'
    ELSE execution_mode
  END;

CREATE UNIQUE INDEX IF NOT EXISTS uq_registered_agents_provider_account_name
  ON public.registered_agents (provider_account_name)
  WHERE provider_account_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_registered_agents_owner_created
  ON public.registered_agents (owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_registered_agents_owner_status
  ON public.registered_agents (owner_user_id, status);

CREATE INDEX IF NOT EXISTS idx_registered_agents_human_present
  ON public.registered_agents (agentbook_human_id)
  WHERE agentbook_human_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.preserve_agent_provider_account_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
BEGIN
  IF OLD.provider_account_name IS DISTINCT FROM NEW.provider_account_name THEN
    RAISE EXCEPTION 'AGENT_PROVIDER_ACCOUNT_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS preserve_agent_provider_account_name
  ON public.registered_agents;
CREATE TRIGGER preserve_agent_provider_account_name
  BEFORE UPDATE OF provider_account_name ON public.registered_agents
  FOR EACH ROW EXECUTE FUNCTION public.preserve_agent_provider_account_name();

REVOKE EXECUTE ON FUNCTION public.preserve_agent_provider_account_name()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.classify_legacy_registered_agent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
BEGIN
  IF NEW.provider_account_name IS NULL AND NEW.agent_wallet IS NOT NULL THEN
    NEW.wallet_provider := 'local';
    NEW.execution_mode := 'scheduled';
  END IF;
  IF NEW.agentbook_human_id IS NOT NULL THEN
    NEW.world_status := 'verified';
    NEW.world_verified_at := COALESCE(NEW.world_verified_at, now());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS classify_legacy_registered_agent
  ON public.registered_agents;
CREATE TRIGGER classify_legacy_registered_agent
  BEFORE INSERT ON public.registered_agents
  FOR EACH ROW EXECUTE FUNCTION public.classify_legacy_registered_agent();

REVOKE EXECUTE ON FUNCTION public.classify_legacy_registered_agent()
  FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.agent_world_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL
    REFERENCES public.registered_agents(id) ON DELETE CASCADE,
  nonce text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN (
      'in_progress', 'relaying', 'submitted', 'verified', 'failed', 'expired'
    )),
  expires_at timestamptz NOT NULL,
  relay_transaction_hash text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_world_registrations_agent_status
  ON public.agent_world_registrations (agent_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_world_registrations_expiry
  ON public.agent_world_registrations (expires_at)
  WHERE status = 'in_progress';

CREATE TABLE IF NOT EXISTS public.agent_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL
    REFERENCES public.registered_agents(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_conversations_current
  ON public.agent_conversations (agent_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_conversations_owner
  ON public.agent_conversations (owner_user_id, updated_at DESC);

INSERT INTO public.agent_conversations (agent_id, owner_user_id)
SELECT id, owner_user_id
FROM public.registered_agents
ON CONFLICT (agent_id) WHERE archived_at IS NULL DO NOTHING;

CREATE TABLE IF NOT EXISTS public.agent_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL
    REFERENCES public.agent_conversations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL
    REFERENCES public.registered_agents(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  source text NOT NULL DEFAULT 'llm'
    CHECK (source IN ('owner', 'llm', 'deterministic', 'execution')),
  status text NOT NULL DEFAULT 'complete'
    CHECK (status IN ('pending', 'complete', 'failed')),
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  execution_id uuid
    REFERENCES public.agent_run_executions(id) ON DELETE SET NULL,
  client_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_chat_messages_client_id
  ON public.agent_chat_messages (conversation_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_chat_messages_conversation_recent
  ON public.agent_chat_messages (conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_agent_chat_messages_agent_recent
  ON public.agent_chat_messages (agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL
    REFERENCES public.registered_agents(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL,
  source_message_id uuid NOT NULL UNIQUE
    REFERENCES public.agent_chat_messages(id) ON DELETE CASCADE,
  command_type text NOT NULL CHECK (command_type IN ('run_daily_quest')),
  requested_run_id uuid
    REFERENCES public.daily_quest_runs(id) ON DELETE SET NULL,
  execution_id uuid UNIQUE
    REFERENCES public.agent_run_executions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued',
      'running',
      'decision_required',
      'completed',
      'failed',
      'cancelled'
    )),
  state_version integer NOT NULL DEFAULT 0,
  pending_decision jsonb,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_commands_agent_status
  ON public.agent_commands (agent_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_commands_owner_recent
  ON public.agent_commands (owner_user_id, created_at DESC);

-- One live run per agent: two active commands resolve to the same execution row
-- and collide on agent_commands.execution_id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_commands_active
  ON public.agent_commands (agent_id)
  WHERE status IN ('queued', 'running', 'decision_required');

CREATE INDEX IF NOT EXISTS idx_agent_requests_agent_state
  ON public.agent_requests (agent_id, state)
  WHERE agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_run_executions_agent_status
  ON public.agent_run_executions (agent_id, status, updated_at DESC);

ALTER TABLE public.agent_run_executions
  ADD COLUMN IF NOT EXISTS command_id uuid UNIQUE
    REFERENCES public.agent_commands(id) ON DELETE SET NULL;

ALTER TABLE public.agent_world_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_world_registrations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_chat_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_commands FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.agent_world_registrations FROM anon, authenticated;
REVOKE ALL ON TABLE public.agent_conversations FROM anon, authenticated;
REVOKE ALL ON TABLE public.agent_chat_messages FROM anon, authenticated;
REVOKE ALL ON TABLE public.agent_commands FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.agent_world_registrations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.agent_conversations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.agent_chat_messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.agent_commands TO service_role;

DROP TRIGGER IF EXISTS update_agent_world_registrations_updated_at
  ON public.agent_world_registrations;
CREATE TRIGGER update_agent_world_registrations_updated_at
  BEFORE UPDATE ON public.agent_world_registrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_agent_conversations_updated_at
  ON public.agent_conversations;
CREATE TRIGGER update_agent_conversations_updated_at
  BEFORE UPDATE ON public.agent_conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_agent_chat_messages_updated_at
  ON public.agent_chat_messages;
CREATE TRIGGER update_agent_chat_messages_updated_at
  BEFORE UPDATE ON public.agent_chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_agent_commands_updated_at
  ON public.agent_commands;
CREATE TRIGGER update_agent_commands_updated_at
  BEFORE UPDATE ON public.agent_commands
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.create_platform_agent(
  p_owner_user_id text,
  p_reward_wallet text,
  p_label text,
  p_capabilities text[],
  p_template_ids uuid[],
  p_max_funding_swaps integer,
  p_owner_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_agent_id uuid := gen_random_uuid();
  v_current integer;
  v_capability text;
  v_template_id uuid;
BEGIN
  IF p_owner_limit < 1 OR p_owner_limit > 100 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_OWNER_LIMIT');
  END IF;

  IF p_max_funding_swaps < 0 OR p_max_funding_swaps > 20 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_FUNDING_SWAP_LIMIT');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_owner_user_id, 271828));

  SELECT count(*) INTO v_current
  FROM public.registered_agents
  WHERE owner_user_id = p_owner_user_id
    AND status <> 'revoked';

  IF v_current >= p_owner_limit THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'AGENT_CAPACITY_REACHED',
      'current', v_current,
      'limit', p_owner_limit
    );
  END IF;

  INSERT INTO public.registered_agents (
    id,
    owner_user_id,
    agent_wallet,
    reward_wallet,
    label,
    status,
    wallet_provider,
    provider_account_name,
    execution_mode,
    max_funding_swaps,
    world_status
  ) VALUES (
    v_agent_id,
    p_owner_user_id,
    NULL,
    lower(p_reward_wallet),
    COALESCE(NULLIF(btrim(p_label), ''), 'agent'),
    'provisioning_wallet',
    'cdp',
    'p2e-' || replace(v_agent_id::text, '-', ''),
    'owner_invoked',
    p_max_funding_swaps,
    'not_started'
  );

  FOREACH v_capability IN ARRAY COALESCE(p_capabilities, ARRAY[]::text[]) LOOP
    IF v_capability = 'quests.read'
       OR p_template_ids IS NULL
       OR array_length(p_template_ids, 1) IS NULL THEN
      INSERT INTO public.agent_permissions (agent_id, capability)
      VALUES (v_agent_id, v_capability)
      ON CONFLICT DO NOTHING;
    ELSE
      FOREACH v_template_id IN ARRAY p_template_ids LOOP
        INSERT INTO public.agent_permissions (
          agent_id, capability, daily_quest_template_id
        ) VALUES (
          v_agent_id, v_capability, v_template_id
        ) ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;
  END LOOP;

  INSERT INTO public.agent_conversations (agent_id, owner_user_id)
  VALUES (v_agent_id, p_owner_user_id);

  RETURN jsonb_build_object(
    'success', true,
    'agent_id', v_agent_id,
    'current', v_current + 1,
    'limit', p_owner_limit
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_platform_agent_wallet(
  p_agent_id uuid,
  p_owner_user_id text,
  p_agent_wallet text,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_agent public.registered_agents%ROWTYPE;
BEGIN
  SELECT * INTO v_agent
  FROM public.registered_agents
  WHERE id = p_agent_id
    AND owner_user_id = p_owner_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_UNKNOWN');
  END IF;

  IF v_agent.status = 'revoked' THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_REVOKED');
  END IF;

  IF v_agent.agent_wallet IS NOT NULL THEN
    IF v_agent.agent_wallet = lower(p_agent_wallet) THEN
      RETURN jsonb_build_object(
        'success', true,
        'agent_id', v_agent.id,
        'agent_wallet', v_agent.agent_wallet,
        'status', v_agent.status,
        'state_version', v_agent.lifecycle_version,
        'replayed', true
      );
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'WALLET_MISMATCH');
  END IF;

  IF v_agent.lifecycle_version <> p_expected_version THEN
    RETURN jsonb_build_object('success', false, 'error', 'VERSION_CONFLICT');
  END IF;

  UPDATE public.registered_agents
  SET
    agent_wallet = lower(p_agent_wallet),
    status = 'ready',
    ready_at = now(),
    lifecycle_version = lifecycle_version + 1,
    last_provisioning_error_code = NULL
  WHERE id = p_agent_id
  RETURNING * INTO v_agent;

  RETURN jsonb_build_object(
    'success', true,
    'agent_id', v_agent.id,
    'agent_wallet', v_agent.agent_wallet,
    'status', v_agent.status,
    'state_version', v_agent.lifecycle_version,
    'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_platform_agent_world_state(
  p_agent_id uuid,
  p_owner_user_id text,
  p_world_status text,
  p_agentbook_human_id text,
  p_transaction_hash text,
  p_error_code text,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_agent public.registered_agents%ROWTYPE;
BEGIN
  IF p_world_status NOT IN (
    'not_started', 'in_progress', 'skipped', 'submitted', 'verified', 'failed'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_WORLD_STATUS');
  END IF;

  IF p_world_status = 'verified'
     AND COALESCE(btrim(p_agentbook_human_id), '') = '' THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'MISSING_AGENTBOOK_HUMAN_ID'
    );
  END IF;

  SELECT * INTO v_agent
  FROM public.registered_agents
  WHERE id = p_agent_id
    AND owner_user_id = p_owner_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_UNKNOWN');
  END IF;

  IF v_agent.status = 'revoked' THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_REVOKED');
  END IF;

  IF v_agent.lifecycle_version <> p_expected_version THEN
    RETURN jsonb_build_object('success', false, 'error', 'VERSION_CONFLICT');
  END IF;

  UPDATE public.registered_agents
  SET
    world_status = p_world_status,
    agentbook_human_id = CASE
      WHEN p_world_status = 'verified' THEN p_agentbook_human_id
      ELSE agentbook_human_id
    END,
    world_verified_at = CASE
      WHEN p_world_status = 'verified' THEN now()
      ELSE world_verified_at
    END,
    world_registration_tx_hash = COALESCE(
      p_transaction_hash,
      world_registration_tx_hash
    ),
    world_last_error_code = p_error_code,
    lifecycle_version = lifecycle_version + 1
  WHERE id = p_agent_id
  RETURNING * INTO v_agent;

  RETURN jsonb_build_object(
    'success', true,
    'agent_id', v_agent.id,
    'world_status', v_agent.world_status,
    'state_version', v_agent.lifecycle_version
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_platform_agent_provisioning(
  p_agent_id uuid,
  p_owner_user_id text,
  p_status text,
  p_error_code text,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_agent public.registered_agents%ROWTYPE;
BEGIN
  IF p_status NOT IN ('provisioning_wallet', 'provisioning_failed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_AGENT_STATUS');
  END IF;

  UPDATE public.registered_agents
  SET
    status = p_status,
    last_provisioning_error_code = p_error_code,
    lifecycle_version = lifecycle_version + 1
  WHERE id = p_agent_id
    AND owner_user_id = p_owner_user_id
    AND agent_wallet IS NULL
    AND status IN ('provisioning_wallet', 'provisioning_failed')
    AND lifecycle_version = p_expected_version
  RETURNING * INTO v_agent;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'VERSION_CONFLICT');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'status', v_agent.status,
    'state_version', v_agent.lifecycle_version
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.start_agent_world_registration(
  p_agent_id uuid,
  p_owner_user_id text,
  p_nonce text,
  p_expires_at timestamptz,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_agent public.registered_agents%ROWTYPE;
  v_registration_id uuid;
BEGIN
  SELECT * INTO v_agent
  FROM public.registered_agents
  WHERE id = p_agent_id
    AND owner_user_id = p_owner_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_UNKNOWN');
  END IF;
  IF v_agent.status <> 'ready' OR v_agent.agent_wallet IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_NOT_READY');
  END IF;
  IF v_agent.lifecycle_version <> p_expected_version THEN
    RETURN jsonb_build_object('success', false, 'error', 'VERSION_CONFLICT');
  END IF;

  UPDATE public.agent_world_registrations
  SET status = 'expired'
  WHERE agent_id = p_agent_id
    AND status IN ('in_progress', 'relaying')
    AND expires_at <= now();

  IF EXISTS (
    SELECT 1
    FROM public.agent_world_registrations
    WHERE agent_id = p_agent_id
      AND status IN ('relaying', 'submitted')
  ) THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'WORLD_SUBMISSION_IN_PROGRESS'
    );
  END IF;

  UPDATE public.agent_world_registrations
  SET status = 'expired'
  WHERE agent_id = p_agent_id
    AND status = 'in_progress';

  INSERT INTO public.agent_world_registrations (
    agent_id, nonce, status, expires_at
  ) VALUES (
    p_agent_id, p_nonce, 'in_progress', p_expires_at
  )
  RETURNING id INTO v_registration_id;

  UPDATE public.registered_agents
  SET
    world_status = 'in_progress',
    world_last_error_code = NULL,
    lifecycle_version = lifecycle_version + 1
  WHERE id = p_agent_id;

  RETURN jsonb_build_object(
    'success', true,
    'registration_id', v_registration_id,
    'state_version', p_expected_version + 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_agent_world_registration_submission(
  p_registration_id uuid,
  p_agent_id uuid,
  p_owner_user_id text,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_agent public.registered_agents%ROWTYPE;
  v_registration public.agent_world_registrations%ROWTYPE;
BEGIN
  SELECT * INTO v_agent
  FROM public.registered_agents
  WHERE id = p_agent_id
    AND owner_user_id = p_owner_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_UNKNOWN');
  END IF;
  IF v_agent.status <> 'ready' OR v_agent.agent_wallet IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_NOT_READY');
  END IF;
  IF v_agent.lifecycle_version <> p_expected_version THEN
    RETURN jsonb_build_object('success', false, 'error', 'VERSION_CONFLICT');
  END IF;

  SELECT * INTO v_registration
  FROM public.agent_world_registrations
  WHERE id = p_registration_id
    AND agent_id = p_agent_id
  FOR UPDATE;

  IF NOT FOUND OR v_registration.status <> 'in_progress' THEN
    RETURN jsonb_build_object('success', false, 'error', 'REGISTRATION_UNKNOWN');
  END IF;
  IF v_registration.expires_at <= now() THEN
    UPDATE public.agent_world_registrations
    SET status = 'expired'
    WHERE id = p_registration_id;
    RETURN jsonb_build_object('success', false, 'error', 'REGISTRATION_EXPIRED');
  END IF;

  UPDATE public.agent_world_registrations
  SET status = 'relaying', last_error_code = NULL
  WHERE id = p_registration_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_agent_world_registration(
  p_registration_id uuid,
  p_agent_id uuid,
  p_owner_user_id text,
  p_transaction_hash text,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_agent public.registered_agents%ROWTYPE;
BEGIN
  SELECT * INTO v_agent
  FROM public.registered_agents
  WHERE id = p_agent_id
    AND owner_user_id = p_owner_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_UNKNOWN');
  END IF;
  IF v_agent.status = 'revoked' THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_REVOKED');
  END IF;
  IF v_agent.lifecycle_version <> p_expected_version THEN
    RETURN jsonb_build_object('success', false, 'error', 'VERSION_CONFLICT');
  END IF;

  UPDATE public.agent_world_registrations
  SET
    status = 'submitted',
    relay_transaction_hash = p_transaction_hash,
    last_error_code = NULL
  WHERE id = p_registration_id
    AND agent_id = p_agent_id
    AND status = 'relaying';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'REGISTRATION_UNKNOWN');
  END IF;

  UPDATE public.registered_agents
  SET
    world_status = 'submitted',
    world_registration_tx_hash = COALESCE(
      p_transaction_hash,
      world_registration_tx_hash
    ),
    world_last_error_code = NULL,
    lifecycle_version = lifecycle_version + 1
  WHERE id = p_agent_id;

  RETURN jsonb_build_object(
    'success', true,
    'state_version', p_expected_version + 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_agent_world_registration(
  p_registration_id uuid,
  p_agent_id uuid,
  p_owner_user_id text,
  p_error_code text,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_agent public.registered_agents%ROWTYPE;
  v_registration_closed boolean;
BEGIN
  SELECT * INTO v_agent
  FROM public.registered_agents
  WHERE id = p_agent_id
    AND owner_user_id = p_owner_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_UNKNOWN');
  END IF;
  IF v_agent.status = 'revoked' THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_REVOKED');
  END IF;
  IF v_agent.world_status = 'verified' THEN
    RETURN jsonb_build_object(
      'success', true,
      'world_status', 'verified',
      'state_version', v_agent.lifecycle_version
    );
  END IF;
  IF v_agent.lifecycle_version <> p_expected_version THEN
    RETURN jsonb_build_object('success', false, 'error', 'VERSION_CONFLICT');
  END IF;

  UPDATE public.agent_world_registrations
  SET status = 'failed', last_error_code = p_error_code
  WHERE id = p_registration_id
    AND agent_id = p_agent_id
    AND status IN ('in_progress', 'relaying');
  v_registration_closed := FOUND;

  UPDATE public.registered_agents
  SET
    world_status = 'failed',
    world_last_error_code = p_error_code,
    lifecycle_version = lifecycle_version + 1
  WHERE id = p_agent_id;

  RETURN jsonb_build_object(
    'success', true,
    'registration_closed', v_registration_closed,
    'state_version', p_expected_version + 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_agent_chat_turn(
  p_agent_id uuid,
  p_owner_user_id text,
  p_client_message_id uuid,
  p_message text,
  p_command_type text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_agent public.registered_agents%ROWTYPE;
  v_conversation_id uuid;
  v_message_id uuid;
  v_existing_message text;
  v_command_id uuid;
  v_command_version integer;
  v_command_status text;
  v_active_command_id uuid;
  v_replayed boolean := false;
BEGIN
  IF char_length(btrim(p_message)) < 1 OR char_length(p_message) > 2000 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_MESSAGE');
  END IF;

  IF p_command_type IS NOT NULL AND p_command_type <> 'run_daily_quest' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_COMMAND');
  END IF;

  SELECT * INTO v_agent
  FROM public.registered_agents
  WHERE id = p_agent_id
    AND owner_user_id = p_owner_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_UNKNOWN');
  END IF;
  IF v_agent.status <> 'ready' THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_NOT_READY');
  END IF;

  IF p_command_type IS NOT NULL THEN
    SELECT id INTO v_active_command_id
    FROM public.agent_commands
    WHERE agent_id = p_agent_id
      AND status IN ('queued', 'running', 'decision_required')
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  SELECT id INTO v_conversation_id
  FROM public.agent_conversations
  WHERE agent_id = p_agent_id
    AND owner_user_id = p_owner_user_id
    AND archived_at IS NULL
  FOR UPDATE;

  IF v_conversation_id IS NULL THEN
    INSERT INTO public.agent_conversations (agent_id, owner_user_id)
    VALUES (p_agent_id, p_owner_user_id)
    RETURNING id INTO v_conversation_id;
  END IF;

  SELECT id, content INTO v_message_id, v_existing_message
  FROM public.agent_chat_messages
  WHERE conversation_id = v_conversation_id
    AND client_message_id = p_client_message_id;

  IF v_message_id IS NULL THEN
    INSERT INTO public.agent_chat_messages (
      conversation_id,
      agent_id,
      role,
      content,
      source,
      client_message_id
    ) VALUES (
      v_conversation_id,
      p_agent_id,
      'user',
      btrim(p_message),
      'owner',
      p_client_message_id
    )
    RETURNING id INTO v_message_id;
  ELSE
    IF v_existing_message <> btrim(p_message) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'CLIENT_MESSAGE_ID_CONFLICT'
      );
    END IF;
    v_replayed := true;
  END IF;

  IF p_command_type IS NOT NULL
     AND NOT v_replayed
     AND v_active_command_id IS NULL THEN
    INSERT INTO public.agent_commands (
      agent_id,
      owner_user_id,
      source_message_id,
      command_type
    ) VALUES (
      p_agent_id,
      p_owner_user_id,
      v_message_id,
      p_command_type
    )
    ON CONFLICT (source_message_id) DO UPDATE
      SET source_message_id = EXCLUDED.source_message_id
    RETURNING id, state_version, status
      INTO v_command_id, v_command_version, v_command_status;
  ELSIF v_replayed THEN
    SELECT id, state_version, status
      INTO v_command_id, v_command_version, v_command_status
    FROM public.agent_commands
    WHERE source_message_id = v_message_id
      AND agent_id = p_agent_id
      AND owner_user_id = p_owner_user_id;
  END IF;

  UPDATE public.agent_conversations
  SET updated_at = now()
  WHERE id = v_conversation_id;

  RETURN jsonb_build_object(
    'success', true,
    'conversation_id', v_conversation_id,
    'message_id', v_message_id,
    'command_id', v_command_id,
    'command_version', v_command_version,
    'command_status', v_command_status,
    'active_command_id', v_active_command_id,
    'command_suppressed',
      p_command_type IS NOT NULL
      AND NOT v_replayed
      AND v_active_command_id IS NOT NULL,
    'replayed', v_replayed
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_agentbook_confirmation(
  p_registration_id uuid,
  p_agent_id uuid,
  p_owner_user_id text,
  p_agentbook_human_id text,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_agent public.registered_agents%ROWTYPE;
BEGIN
  SELECT * INTO v_agent
  FROM public.registered_agents
  WHERE id = p_agent_id
    AND owner_user_id = p_owner_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_UNKNOWN');
  END IF;
  IF v_agent.status = 'revoked' THEN
    RETURN jsonb_build_object('success', false, 'error', 'AGENT_REVOKED');
  END IF;
  IF v_agent.lifecycle_version <> p_expected_version THEN
    RETURN jsonb_build_object('success', false, 'error', 'VERSION_CONFLICT');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_world_registrations
    WHERE id = p_registration_id
      AND agent_id = p_agent_id
      AND status IN ('relaying', 'submitted', 'verified')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'REGISTRATION_UNKNOWN');
  END IF;

  UPDATE public.registered_agents
  SET
    world_status = 'verified',
    agentbook_human_id = p_agentbook_human_id,
    world_verified_at = now(),
    world_last_error_code = NULL,
    lifecycle_version = lifecycle_version + 1
  WHERE id = p_agent_id;

  UPDATE public.agent_world_registrations
  SET status = 'verified', last_error_code = NULL
  WHERE id = p_registration_id
    AND agent_id = p_agent_id;

  RETURN jsonb_build_object(
    'success', true,
    'agent_id', p_agent_id,
    'state_version', p_expected_version + 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.append_agent_chat_message(
  p_agent_id uuid,
  p_owner_user_id text,
  p_role text,
  p_content text,
  p_source text,
  p_actions jsonb DEFAULT '[]'::jsonb,
  p_execution_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_conversation_id uuid;
  v_message_id uuid;
BEGIN
  IF p_role NOT IN ('assistant', 'system')
     OR p_source NOT IN ('llm', 'deterministic', 'execution')
     OR char_length(btrim(p_content)) < 1
     OR char_length(p_content) > 4000 THEN
    RAISE EXCEPTION 'INVALID_AGENT_MESSAGE';
  END IF;

  SELECT c.id INTO v_conversation_id
  FROM public.agent_conversations c
  JOIN public.registered_agents a ON a.id = c.agent_id
  WHERE c.agent_id = p_agent_id
    AND c.owner_user_id = p_owner_user_id
    AND a.owner_user_id = p_owner_user_id
    AND c.archived_at IS NULL
  FOR UPDATE OF c;

  IF v_conversation_id IS NULL THEN
    RAISE EXCEPTION 'AGENT_CONVERSATION_UNKNOWN';
  END IF;

  IF p_execution_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.agent_run_executions
    WHERE id = p_execution_id
      AND agent_id = p_agent_id
      AND owner_user_id = p_owner_user_id
  ) THEN
    RAISE EXCEPTION 'AGENT_EXECUTION_UNKNOWN';
  END IF;

  INSERT INTO public.agent_chat_messages (
    conversation_id,
    agent_id,
    role,
    content,
    source,
    actions,
    execution_id
  ) VALUES (
    v_conversation_id,
    p_agent_id,
    p_role,
    btrim(p_content),
    p_source,
    COALESCE(p_actions, '[]'::jsonb),
    p_execution_id
  ) RETURNING id INTO v_message_id;

  UPDATE public.agent_conversations
  SET updated_at = now()
  WHERE id = v_conversation_id;

  RETURN v_message_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.link_agent_command_execution(
  p_agent_id uuid,
  p_owner_user_id text,
  p_command_id uuid,
  p_execution_id uuid,
  p_expected_status text,
  p_expected_version integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  PERFORM 1
  FROM public.agent_run_executions
  WHERE id = p_execution_id
    AND agent_id = p_agent_id
    AND owner_user_id = p_owner_user_id
    AND (command_id IS NULL OR command_id = p_command_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.agent_commands
  SET
    execution_id = p_execution_id,
    status = 'running',
    last_error_code = NULL,
    state_version = state_version + 1
  WHERE id = p_command_id
    AND agent_id = p_agent_id
    AND owner_user_id = p_owner_user_id
    AND status = p_expected_status
    AND state_version = p_expected_version;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.agent_run_executions
  SET command_id = p_command_id
  WHERE id = p_execution_id
    AND agent_id = p_agent_id
    AND owner_user_id = p_owner_user_id
    AND (command_id IS NULL OR command_id = p_command_id);

  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_agent_command_selection(
  p_agent_id uuid,
  p_owner_user_id text,
  p_command_id uuid,
  p_run_id uuid,
  p_expected_version integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  UPDATE public.agent_commands
  SET
    requested_run_id = p_run_id,
    status = 'queued',
    state_version = state_version + 1,
    pending_decision = NULL,
    last_error_code = NULL
  WHERE id = p_command_id
    AND agent_id = p_agent_id
    AND owner_user_id = p_owner_user_id
    AND status = 'decision_required'
    AND state_version = p_expected_version
    AND pending_decision @> jsonb_build_object('runIds', jsonb_build_array(p_run_id));
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_agent_command_run_decision(
  p_execution_id uuid,
  p_agent_id uuid,
  p_owner_user_id text,
  p_decision_id uuid,
  p_expected_execution_version bigint,
  p_expected_command_version integer,
  p_resolution text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_execution public.agent_run_executions%ROWTYPE;
  v_command public.agent_commands%ROWTYPE;
BEGIN
  IF p_resolution NOT IN ('retry', 'finalize', 'cancel') THEN
    RETURN jsonb_build_object('outcome', 'invalid_resolution');
  END IF;

  SELECT * INTO v_execution
  FROM public.agent_run_executions
  WHERE id = p_execution_id
    AND agent_id = p_agent_id
    AND owner_user_id = p_owner_user_id
    AND status = 'decision_required'
    AND state_version = p_expected_execution_version
    AND pending_decision->>'id' = p_decision_id::text
    AND pending_decision->'options' ? p_resolution
  FOR UPDATE;

  IF NOT FOUND OR v_execution.command_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  SELECT * INTO v_command
  FROM public.agent_commands
  WHERE id = v_execution.command_id
    AND agent_id = p_agent_id
    AND owner_user_id = p_owner_user_id
    AND execution_id = p_execution_id
    AND status = 'decision_required'
    AND state_version = p_expected_command_version
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  UPDATE public.agent_run_executions
  SET
    checkpoint = COALESCE(checkpoint, '{}'::jsonb) || jsonb_build_object(
      'ownerResolution', p_resolution,
      'ownerResolvedAt', to_jsonb(now())
    ),
    pending_decision = NULL,
    status = CASE
      WHEN p_resolution = 'cancel' THEN 'failed'
      ELSE 'waiting_retry'
    END,
    next_retry_at = now(),
    state_version = state_version + 1
  WHERE id = p_execution_id;

  UPDATE public.agent_commands
  SET
    status = CASE
      WHEN p_resolution = 'cancel' THEN 'cancelled'
      ELSE 'running'
    END,
    pending_decision = NULL,
    last_error_code = NULL,
    state_version = state_version + 1
  WHERE id = v_command.id;

  RETURN jsonb_build_object(
    'outcome', 'resolved',
    'execution_state_version', p_expected_execution_version + 1,
    'command_state_version', p_expected_command_version + 1,
    'command_id', v_command.id,
    'resolution', p_resolution
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_platform_agent_policy(
  p_agent_id uuid,
  p_owner_user_id text,
  p_label text,
  p_max_funding_swaps integer,
  p_expected_version integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  IF char_length(btrim(p_label)) < 2
     OR char_length(p_label) > 40
     OR p_max_funding_swaps < 0
     OR p_max_funding_swaps > 20 THEN
    RETURN false;
  END IF;
  UPDATE public.registered_agents
  SET
    label = COALESCE(NULLIF(btrim(p_label), ''), label),
    max_funding_swaps = p_max_funding_swaps,
    lifecycle_version = lifecycle_version + 1
  WHERE id = p_agent_id
    AND owner_user_id = p_owner_user_id
    AND status <> 'revoked'
    AND lifecycle_version = p_expected_version;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_platform_agent(
  p_agent_id uuid,
  p_owner_user_id text,
  p_expected_version integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  UPDATE public.registered_agents
  SET
    status = 'revoked',
    revoked_at = now(),
    lifecycle_version = lifecycle_version + 1
  WHERE id = p_agent_id
    AND owner_user_id = p_owner_user_id
    AND status <> 'revoked'
    AND lifecycle_version = p_expected_version;
  RETURN FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_platform_agent(
  text, text, text, text[], uuid[], integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_platform_agent(
  text, text, text, text[], uuid[], integer, integer
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.attach_platform_agent_wallet(
  uuid, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attach_platform_agent_wallet(
  uuid, text, text, integer
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.set_platform_agent_world_state(
  uuid, text, text, text, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_platform_agent_world_state(
  uuid, text, text, text, text, text, integer
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.transition_platform_agent_provisioning(
  uuid, text, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_platform_agent_provisioning(
  uuid, text, text, text, integer
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.start_agent_world_registration(
  uuid, text, text, timestamptz, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_agent_world_registration(
  uuid, text, text, timestamptz, integer
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.claim_agent_world_registration_submission(
  uuid, uuid, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_agent_world_registration_submission(
  uuid, uuid, text, integer
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.submit_agent_world_registration(
  uuid, uuid, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_agent_world_registration(
  uuid, uuid, text, text, integer
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.fail_agent_world_registration(
  uuid, uuid, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_agent_world_registration(
  uuid, uuid, text, text, integer
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.create_agent_chat_turn(
  uuid, text, uuid, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_agent_chat_turn(
  uuid, text, uuid, text, text
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.append_agent_chat_message(
  uuid, text, text, text, text, jsonb, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_agent_chat_message(
  uuid, text, text, text, text, jsonb, uuid
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.link_agent_command_execution(
  uuid, text, uuid, uuid, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_agent_command_execution(
  uuid, text, uuid, uuid, text, integer
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.resolve_agent_command_selection(
  uuid, text, uuid, uuid, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_agent_command_selection(
  uuid, text, uuid, uuid, integer
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.resolve_agent_command_run_decision(
  uuid, uuid, text, uuid, bigint, integer, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_agent_command_run_decision(
  uuid, uuid, text, uuid, bigint, integer, text
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.update_platform_agent_policy(
  uuid, text, text, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_platform_agent_policy(
  uuid, text, text, integer, integer
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.revoke_platform_agent(
  uuid, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_platform_agent(
  uuid, text, integer
) TO service_role;

REVOKE EXECUTE ON FUNCTION public.record_agentbook_confirmation(
  uuid, uuid, text, text, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_agentbook_confirmation(
  uuid, uuid, text, text, integer
) TO service_role;
