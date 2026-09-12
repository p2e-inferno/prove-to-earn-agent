CREATE TABLE public.agent_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.registered_agents(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL,
  owner_wallet text NOT NULL,
  agent_wallet text NOT NULL,
  reward_wallet text NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version = 1),
  policy jsonb NOT NULL,
  policy_hash text NOT NULL CHECK (policy_hash ~ '^0x[0-9a-f]{64}$'),
  resource text NOT NULL,
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  nonce text NOT NULL UNIQUE CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL,
  -- NULL means the authorization never expires automatically; it remains
  -- valid until the owner revokes or supersedes it.
  expires_at timestamptz NULL,
  draft_expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'superseded', 'revoked', 'expired')),
  owner_signature text NULL,
  activated_at timestamptz NULL,
  superseded_at timestamptz NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_authorizations_owner_wallet_lowercase
    CHECK (owner_wallet = lower(owner_wallet)),
  CONSTRAINT agent_authorizations_agent_wallet_lowercase
    CHECK (agent_wallet = lower(agent_wallet)),
  CONSTRAINT agent_authorizations_reward_wallet_lowercase
    CHECK (reward_wallet = lower(reward_wallet)),
  CONSTRAINT agent_authorizations_expiry_order
    CHECK ((expires_at IS NULL OR expires_at > issued_at) AND draft_expires_at > created_at)
);

CREATE UNIQUE INDEX uq_agent_authorizations_active
  ON public.agent_authorizations (agent_id)
  WHERE status = 'active';
CREATE INDEX idx_agent_authorizations_owner
  ON public.agent_authorizations (owner_user_id, created_at DESC);
CREATE INDEX idx_agent_authorizations_agent_expiry
  ON public.agent_authorizations (agent_id, expires_at)
  WHERE status = 'active';

CREATE TABLE public.agent_authorization_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.registered_agents(id) ON DELETE CASCADE,
  client_id text NOT NULL UNIQUE,
  secret_digest text NOT NULL,
  secret_hint text NULL,
  pepper_kid text NOT NULL,
  scopes text[] NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  expires_at timestamptz NULL,
  last_used_at timestamptz NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_agent_authorization_credentials_active
  ON public.agent_authorization_credentials (agent_id)
  WHERE status = 'active';
CREATE INDEX idx_agent_authorization_credentials_agent
  ON public.agent_authorization_credentials (agent_id, created_at DESC);

CREATE TABLE public.agent_credential_rotation_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.registered_agents(id) ON DELETE CASCADE,
  owner_user_id text NOT NULL,
  owner_wallet text NOT NULL,
  authorization_id uuid NOT NULL REFERENCES public.agent_authorizations(id) ON DELETE CASCADE,
  nonce text NOT NULL UNIQUE CHECK (nonce ~ '^0x[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_credential_rotation_wallet_lowercase
    CHECK (owner_wallet = lower(owner_wallet))
);

CREATE INDEX idx_agent_credential_rotation_challenges_expiry
  ON public.agent_credential_rotation_challenges (expires_at);

CREATE TABLE public.agent_authorization_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES public.registered_agents(id) ON DELETE CASCADE,
  authorization_id uuid NULL REFERENCES public.agent_authorizations(id) ON DELETE SET NULL,
  credential_id uuid NULL REFERENCES public.agent_authorization_credentials(id) ON DELETE SET NULL,
  owner_user_id text NOT NULL,
  event text NOT NULL CHECK (event IN (
    'authorization_activated',
    'authorization_superseded',
    'authorization_revoked',
    'credential_rotated',
    'credential_revoked'
  )),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_authorization_audit_agent
  ON public.agent_authorization_audit (agent_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.guard_agent_authorization_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
BEGIN
  IF ROW(
    NEW.agent_id, NEW.owner_user_id, NEW.owner_wallet, NEW.agent_wallet,
    NEW.reward_wallet, NEW.policy_version, NEW.policy, NEW.policy_hash,
    NEW.resource, NEW.chain_id, NEW.nonce, NEW.issued_at, NEW.expires_at,
    NEW.draft_expires_at, NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.agent_id, OLD.owner_user_id, OLD.owner_wallet, OLD.agent_wallet,
    OLD.reward_wallet, OLD.policy_version, OLD.policy, OLD.policy_hash,
    OLD.resource, OLD.chain_id, OLD.nonce, OLD.issued_at, OLD.expires_at,
    OLD.draft_expires_at, OLD.created_at
  ) THEN
    RAISE EXCEPTION 'agent authorization payload is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_agent_authorization_immutability
  BEFORE UPDATE ON public.agent_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.guard_agent_authorization_immutability();

CREATE OR REPLACE FUNCTION public.activate_agent_authorization(
  p_authorization_id uuid,
  p_agent_id uuid,
  p_owner_user_id text,
  p_owner_wallet text,
  p_policy_hash text,
  p_nonce text,
  p_owner_signature text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_authorization public.agent_authorizations%ROWTYPE;
  v_superseded_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_agent_id::text, 314159));

  SELECT * INTO v_authorization
  FROM public.agent_authorizations
  WHERE id = p_authorization_id
    AND agent_id = p_agent_id
    AND owner_user_id = p_owner_user_id
    AND owner_wallet = lower(p_owner_wallet)
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  IF v_authorization.status = 'active' THEN
    RETURN jsonb_build_object('outcome', 'active', 'authorization_id', v_authorization.id, 'replayed', true);
  END IF;
  IF v_authorization.status <> 'draft' THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;
  IF v_authorization.draft_expires_at <= now() THEN
    UPDATE public.agent_authorizations SET status = 'expired' WHERE id = v_authorization.id;
    RETURN jsonb_build_object('outcome', 'expired');
  END IF;
  IF (v_authorization.expires_at IS NOT NULL AND v_authorization.expires_at <= now())
     OR v_authorization.policy_hash <> lower(p_policy_hash)
     OR v_authorization.nonce <> lower(p_nonce) THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  UPDATE public.agent_authorizations
  SET status = 'superseded', superseded_at = now()
  WHERE agent_id = p_agent_id AND status = 'active'
  RETURNING id INTO v_superseded_id;

  IF v_superseded_id IS NOT NULL THEN
    INSERT INTO public.agent_authorization_audit (
      agent_id, authorization_id, owner_user_id, event
    ) VALUES (
      p_agent_id, v_superseded_id, p_owner_user_id, 'authorization_superseded'
    );
  END IF;

  UPDATE public.agent_authorizations
  SET status = 'active', owner_signature = p_owner_signature, activated_at = now()
  WHERE id = v_authorization.id;

  INSERT INTO public.agent_authorization_audit (
    agent_id, authorization_id, owner_user_id, event
  ) VALUES (
    p_agent_id, v_authorization.id, p_owner_user_id, 'authorization_activated'
  );

  RETURN jsonb_build_object('outcome', 'active', 'authorization_id', v_authorization.id, 'replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.rotate_agent_authorization_credential(
  p_challenge_id uuid,
  p_agent_id uuid,
  p_owner_user_id text,
  p_client_id text,
  p_secret_digest text,
  p_pepper_kid text,
  p_scopes text[],
  p_expires_at timestamptz DEFAULT NULL,
  p_secret_hint text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_credential_id uuid;
  v_challenge public.agent_credential_rotation_challenges%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_agent_id::text, 271828));

  IF NOT EXISTS (
    SELECT 1 FROM public.registered_agents
    WHERE id = p_agent_id AND owner_user_id = p_owner_user_id AND status = 'ready'
  ) THEN
    RETURN jsonb_build_object('outcome', 'agent_unavailable');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_authorizations
    WHERE agent_id = p_agent_id
      AND owner_user_id = p_owner_user_id
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
  ) THEN
    RETURN jsonb_build_object('outcome', 'authorization_required');
  END IF;

  SELECT * INTO v_challenge
  FROM public.agent_credential_rotation_challenges
  WHERE id = p_challenge_id
    AND agent_id = p_agent_id
    AND owner_user_id = p_owner_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_challenge.consumed_at IS NOT NULL
     OR v_challenge.expires_at <= now() THEN
    RETURN jsonb_build_object('outcome', 'challenge_invalid');
  END IF;

  UPDATE public.agent_credential_rotation_challenges
  SET consumed_at = now()
  WHERE id = v_challenge.id;

  UPDATE public.agent_authorization_credentials
  SET status = 'revoked', revoked_at = now()
  WHERE agent_id = p_agent_id AND status = 'active';

  INSERT INTO public.agent_authorization_credentials (
    agent_id, client_id, secret_digest, pepper_kid, scopes, expires_at, secret_hint
  ) VALUES (
    p_agent_id, p_client_id, p_secret_digest, p_pepper_kid, p_scopes, p_expires_at, p_secret_hint
  ) RETURNING id INTO v_credential_id;

  INSERT INTO public.agent_authorization_audit (
    agent_id, credential_id, owner_user_id, event
  ) VALUES (
    p_agent_id, v_credential_id, p_owner_user_id, 'credential_rotated'
  );

  RETURN jsonb_build_object('outcome', 'active', 'credential_id', v_credential_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_agent_headless_access(
  p_agent_id uuid,
  p_owner_user_id text,
  p_revoke_authorization boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_authorization_id uuid;
  v_credential_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_agent_id::text, 161803));

  IF NOT EXISTS (
    SELECT 1 FROM public.registered_agents
    WHERE id = p_agent_id AND owner_user_id = p_owner_user_id
  ) THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  UPDATE public.agent_authorization_credentials
  SET status = 'revoked', revoked_at = now()
  WHERE agent_id = p_agent_id AND status = 'active'
  RETURNING id INTO v_credential_id;

  IF p_revoke_authorization THEN
    UPDATE public.agent_authorizations
    SET status = 'revoked', revoked_at = now()
    WHERE agent_id = p_agent_id AND status = 'active'
    RETURNING id INTO v_authorization_id;
  END IF;

  IF v_credential_id IS NOT NULL THEN
    INSERT INTO public.agent_authorization_audit (
      agent_id, credential_id, owner_user_id, event
    ) VALUES (p_agent_id, v_credential_id, p_owner_user_id, 'credential_revoked');
  END IF;
  IF v_authorization_id IS NOT NULL THEN
    INSERT INTO public.agent_authorization_audit (
      agent_id, authorization_id, owner_user_id, event
    ) VALUES (p_agent_id, v_authorization_id, p_owner_user_id, 'authorization_revoked');
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'revoked',
    'authorization_revoked', v_authorization_id IS NOT NULL,
    'credential_revoked', v_credential_id IS NOT NULL
  );
END;
$$;

ALTER TABLE public.agent_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_authorizations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_authorization_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_authorization_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_credential_rotation_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_credential_rotation_challenges FORCE ROW LEVEL SECURITY;
ALTER TABLE public.agent_authorization_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_authorization_audit FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.agent_authorizations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.agent_authorization_credentials FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.agent_credential_rotation_challenges FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.agent_authorization_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_authorizations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_authorization_credentials TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_credential_rotation_challenges TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_authorization_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.agent_authorization_audit_id_seq TO service_role;

REVOKE EXECUTE ON FUNCTION public.guard_agent_authorization_immutability()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_agent_authorization_immutability()
  TO service_role;
REVOKE EXECUTE ON FUNCTION public.activate_agent_authorization(uuid, uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_agent_authorization(uuid, uuid, text, text, text, text, text)
  TO service_role;
REVOKE EXECUTE ON FUNCTION public.rotate_agent_authorization_credential(uuid, uuid, text, text, text, text, text[], timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_agent_authorization_credential(uuid, uuid, text, text, text, text, text[], timestamptz, text)
  TO service_role;
REVOKE EXECUTE ON FUNCTION public.revoke_agent_headless_access(uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_agent_headless_access(uuid, text, boolean)
  TO service_role;
