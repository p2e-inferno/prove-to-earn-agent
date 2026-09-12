-- Credentials are bound to the stable agent_id, not to one authorization
-- version: an authorization renewal supersedes the old row with a brand-new
-- id, and a credential that stored (and was re-checked against) that exact
-- id would silently stop authenticating on every renewal even though it was
-- never revoked. Live authority still comes from whatever authorization is
-- CURRENTLY active for the agent, checked fresh on every request/rotation
-- (see `rotate_agent_authorization_credential` below and
-- `verifyHeadlessCredential` in headless-authorization.ts) — no column is
-- needed on the credential row itself to express that.

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
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_authorizations
    WHERE id = v_challenge.authorization_id
      AND agent_id = p_agent_id
      AND owner_user_id = p_owner_user_id
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
  ) THEN
    RETURN jsonb_build_object('outcome', 'authorization_required');
  END IF;

  UPDATE public.agent_credential_rotation_challenges
  SET consumed_at = now()
  WHERE id = v_challenge.id;

  UPDATE public.agent_authorization_credentials
  SET status = 'revoked', revoked_at = now()
  WHERE agent_id = p_agent_id AND status = 'active';

  INSERT INTO public.agent_authorization_credentials (
    agent_id, client_id, secret_digest, pepper_kid,
    scopes, expires_at, secret_hint
  ) VALUES (
    p_agent_id, p_client_id, p_secret_digest,
    p_pepper_kid, p_scopes, p_expires_at, p_secret_hint
  ) RETURNING id INTO v_credential_id;

  INSERT INTO public.agent_authorization_audit (
    agent_id, authorization_id, credential_id, owner_user_id, event
  ) VALUES (
    p_agent_id, v_challenge.authorization_id, v_credential_id,
    p_owner_user_id, 'credential_rotated'
  );

  RETURN jsonb_build_object(
    'outcome', 'active',
    'authorization_id', v_challenge.authorization_id,
    'credential_id', v_credential_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.create_headless_agent_command(
  p_agent_id uuid,
  p_authorization_id uuid,
  p_owner_user_id text,
  p_client_request_id text,
  p_run_id uuid,
  p_max_x402_fee_raw numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_command public.agent_commands%ROWTYPE;
BEGIN
  IF char_length(p_client_request_id) NOT BETWEEN 1 AND 200
     OR p_run_id IS NULL
     OR p_max_x402_fee_raw < 0 THEN
    RETURN jsonb_build_object('outcome', 'invalid_request');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_agent_id::text, 173205));

  SELECT * INTO v_command
  FROM public.agent_commands
  WHERE agent_id = p_agent_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_command.requested_run_id IS DISTINCT FROM p_run_id
       OR v_command.max_x402_fee_raw IS DISTINCT FROM p_max_x402_fee_raw THEN
      RETURN jsonb_build_object('outcome', 'conflict');
    END IF;
    RETURN jsonb_build_object(
      'outcome', 'queued', 'command_id', v_command.id,
      'state_version', v_command.state_version, 'status', v_command.status,
      'replayed', true
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.registered_agents
    WHERE id = p_agent_id AND owner_user_id = p_owner_user_id AND status = 'ready'
  ) THEN
    RETURN jsonb_build_object('outcome', 'agent_unavailable');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_authorizations
    WHERE id = p_authorization_id
      AND agent_id = p_agent_id
      AND owner_user_id = p_owner_user_id
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
      AND (
        jsonb_array_length(policy->'templateIds') = 0
        OR policy->'templateIds' ? (
          SELECT daily_quest_template_id::text
          FROM public.daily_quest_runs
          WHERE id = p_run_id
        )
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.daily_quest_runs run
    WHERE run.id = p_run_id
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(ARRAY[
          'quests.read', 'quests.start', 'tasks.complete', 'tasks.claim', 'quests.complete'
        ]) AS required(capability)
        WHERE NOT EXISTS (
          SELECT 1
          FROM public.agent_permissions permission
          WHERE permission.agent_id = p_agent_id
            AND permission.capability = required.capability
            AND (
              permission.daily_quest_template_id IS NULL
              OR permission.daily_quest_template_id = run.daily_quest_template_id
            )
        )
      )
  ) THEN
    RETURN jsonb_build_object('outcome', 'authorization_unavailable');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.agent_commands
    WHERE agent_id = p_agent_id
      AND status IN ('queued', 'running', 'decision_required')
  ) THEN
    RETURN jsonb_build_object('outcome', 'busy');
  END IF;

  INSERT INTO public.agent_commands (
    agent_id, owner_user_id, source_message_id, command_type,
    requested_run_id, controller, client_request_id, max_x402_fee_raw
  ) VALUES (
    p_agent_id, p_owner_user_id, NULL, 'run_daily_quest',
    p_run_id, 'headless', p_client_request_id, p_max_x402_fee_raw
  ) RETURNING * INTO v_command;

  RETURN jsonb_build_object(
    'outcome', 'queued', 'command_id', v_command.id,
    'state_version', v_command.state_version, 'status', v_command.status,
    'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_headless_agent_admission_decision(
  p_agent_id uuid,
  p_authorization_id uuid,
  p_command_id uuid,
  p_expected_version integer,
  p_resolution text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_command public.agent_commands%ROWTYPE;
BEGIN
  IF p_resolution NOT IN ('proceed', 'retry', 'cancel') THEN
    RETURN jsonb_build_object('outcome', 'invalid_resolution');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_authorizations
    WHERE id = p_authorization_id AND agent_id = p_agent_id
      AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
  ) THEN
    RETURN jsonb_build_object('outcome', 'authorization_unavailable');
  END IF;

  SELECT * INTO v_command
  FROM public.agent_commands
  WHERE id = p_command_id
    AND agent_id = p_agent_id
    AND controller = 'headless'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  IF v_command.state_version = p_expected_version + 1
     AND v_command.execution_id IS NULL
     AND (
       (p_resolution = 'proceed'
        AND v_command.status = 'queued'
        AND v_command.pending_decision->>'kind' = 'admission_proceed')
       OR (p_resolution = 'retry'
           AND v_command.status = 'queued'
           AND v_command.pending_decision->>'kind' = 'admission_retry')
       OR (p_resolution = 'cancel' AND v_command.status = 'cancelled')
     ) THEN
    RETURN jsonb_build_object(
      'outcome', 'resolved', 'command_id', v_command.id,
      'command_state_version', v_command.state_version,
      'resolution', p_resolution, 'replayed', true
    );
  END IF;

  IF v_command.status <> 'decision_required'
     OR v_command.execution_id IS NOT NULL
     OR v_command.state_version <> p_expected_version
     OR v_command.pending_decision->>'kind' <> 'admission'
     OR NOT (v_command.pending_decision->'options' ? p_resolution) THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  UPDATE public.agent_commands
  SET status = CASE WHEN p_resolution = 'cancel' THEN 'cancelled' ELSE 'queued' END,
      pending_decision = CASE
        WHEN p_resolution = 'cancel' THEN NULL
        WHEN p_resolution = 'proceed' THEN jsonb_build_object(
          'kind', 'admission_proceed',
          'runId', v_command.pending_decision->'runId',
          'assessment', v_command.pending_decision->'assessment'
        )
        ELSE jsonb_build_object(
          'kind', 'admission_retry',
          'runId', v_command.pending_decision->'runId',
          'assessment', v_command.pending_decision->'assessment'
        )
      END,
      last_error_code = NULL,
      state_version = state_version + 1
  WHERE id = v_command.id;

  RETURN jsonb_build_object(
    'outcome', 'resolved', 'command_id', v_command.id,
    'command_state_version', p_expected_version + 1,
    'resolution', p_resolution, 'replayed', false
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_headless_agent_admission_decision(
  uuid, uuid, uuid, integer, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_headless_agent_admission_decision(
  uuid, uuid, uuid, integer, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_headless_agent_run_decision(
  p_agent_id uuid,
  p_authorization_id uuid,
  p_command_id uuid,
  p_decision_id uuid,
  p_expected_execution_version integer,
  p_expected_command_version integer,
  p_resolution text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_command public.agent_commands%ROWTYPE;
  v_result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_authorizations
    WHERE id = p_authorization_id AND agent_id = p_agent_id
      AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
  ) THEN
    RETURN jsonb_build_object('outcome', 'authorization_unavailable');
  END IF;

  SELECT * INTO v_command
  FROM public.agent_commands
  WHERE id = p_command_id
    AND agent_id = p_agent_id
    AND controller = 'headless';
  IF NOT FOUND OR v_command.execution_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  v_result := public.resolve_agent_command_run_decision(
    v_command.execution_id,
    p_agent_id,
    v_command.owner_user_id,
    p_decision_id,
    p_expected_execution_version,
    p_expected_command_version,
    p_resolution
  );
  RETURN v_result || jsonb_build_object('execution_id', v_command.execution_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_headless_agent_run_decision(
  uuid, uuid, uuid, uuid, integer, integer, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_headless_agent_run_decision(
  uuid, uuid, uuid, uuid, integer, integer, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.settle_agent_nonchain_effect(
  p_effect_id uuid,
  p_settled boolean,
  p_outcome text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_effect public.agent_effect_reservations%ROWTYPE;
BEGIN
  SELECT * INTO v_effect
  FROM public.agent_effect_reservations
  WHERE id = p_effect_id AND action_id = 'x402.payment'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_settled AND v_effect.state = 'reconciled' THEN RETURN true; END IF;
  IF NOT p_settled AND v_effect.state = 'released' THEN RETURN true; END IF;
  IF v_effect.state <> 'reserved' THEN RETURN false; END IF;

  IF p_settled THEN
    UPDATE public.agent_effect_usage_lines
    SET actual_raw = reserved_raw, reconciled_at = now()
    WHERE effect_id = p_effect_id AND category = 'x402';
    UPDATE public.agent_effect_reservations
    SET state = 'reconciled', outcome = p_outcome, reconciled_at = now()
    WHERE id = p_effect_id;
  ELSE
    UPDATE public.agent_effect_reservations
    SET state = 'released', outcome = p_outcome, released_at = now()
    WHERE id = p_effect_id;
  END IF;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.settle_agent_nonchain_effect(
  uuid, boolean, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_agent_nonchain_effect(
  uuid, boolean, text
) TO service_role;
