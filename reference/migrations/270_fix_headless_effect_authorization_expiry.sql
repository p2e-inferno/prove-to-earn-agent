CREATE OR REPLACE FUNCTION public.cancel_headless_agent_command(
  p_agent_id uuid,
  p_authorization_id uuid,
  p_command_id uuid,
  p_expected_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_command public.agent_commands%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_authorizations
    WHERE id = p_authorization_id AND agent_id = p_agent_id
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
  ) THEN
    RETURN jsonb_build_object('outcome', 'authorization_unavailable');
  END IF;
  SELECT * INTO v_command
  FROM public.agent_commands
  WHERE id = p_command_id AND agent_id = p_agent_id AND controller = 'headless'
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
  IF v_command.status = 'cancelled' THEN
    RETURN jsonb_build_object('outcome', 'cancelled', 'state_version', v_command.state_version, 'replayed', true);
  END IF;
  IF v_command.status IN ('completed', 'failed') OR v_command.state_version <> p_expected_version THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;
  UPDATE public.agent_commands
  SET status = 'cancelled', pending_decision = NULL, state_version = state_version + 1
  WHERE id = v_command.id;
  RETURN jsonb_build_object('outcome', 'cancelled', 'state_version', v_command.state_version + 1, 'replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_headless_agent_candidate(
  p_agent_id uuid,
  p_authorization_id uuid,
  p_command_id uuid,
  p_frame_id uuid,
  p_candidate_id text,
  p_expected_execution_version integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_command public.agent_commands%ROWTYPE;
  v_execution public.agent_run_executions%ROWTYPE;
  v_candidate jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.agent_authorizations
    WHERE id = p_authorization_id AND agent_id = p_agent_id
      AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now())
  ) THEN
    RETURN jsonb_build_object('outcome', 'authorization_unavailable');
  END IF;
  SELECT * INTO v_command
  FROM public.agent_commands
  WHERE id = p_command_id AND agent_id = p_agent_id AND controller = 'headless'
  FOR UPDATE;
  IF NOT FOUND OR v_command.execution_id IS NULL THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;
  SELECT * INTO v_execution
  FROM public.agent_run_executions
  WHERE id = v_command.execution_id AND agent_id = p_agent_id
  FOR UPDATE;
  IF FOUND
     AND v_execution.checkpoint->'delegatedSelection'->>'frameId' = p_frame_id::text
     AND v_execution.checkpoint->'delegatedSelection'->>'candidateId' = p_candidate_id
     AND (v_execution.checkpoint->'delegatedSelection'->>'expectedExecutionVersion')::integer = p_expected_execution_version THEN
    RETURN jsonb_build_object(
      'outcome', 'resolved',
      'execution_id', v_execution.id,
      'execution_state_version', v_execution.state_version,
      'command_state_version', v_command.state_version,
      'replayed', true
    );
  END IF;
  IF NOT FOUND
     OR v_execution.status <> 'decision_required'
     OR v_execution.state_version <> p_expected_execution_version
     OR v_execution.pending_decision->>'kind' <> 'action_selection'
     OR v_execution.pending_decision->>'frameId' <> p_frame_id::text
     OR (v_execution.pending_decision->>'expiresAt')::timestamptz <= now() THEN
    RETURN jsonb_build_object('outcome', 'conflict');
  END IF;

  SELECT value INTO v_candidate
  FROM jsonb_array_elements(v_execution.pending_decision->'candidates')
  WHERE value->>'candidateId' = p_candidate_id
    AND (value->>'expiresAt')::timestamptz > now();
  IF v_candidate IS NULL THEN
    RETURN jsonb_build_object('outcome', 'candidate_unavailable');
  END IF;

  UPDATE public.agent_run_executions
  SET status = 'waiting_retry',
      checkpoint = checkpoint || jsonb_build_object(
        'delegatedSelection', jsonb_build_object(
          'frameId', p_frame_id,
          'candidateId', p_candidate_id,
          'expectedExecutionVersion', p_expected_execution_version,
          'fingerprint', v_candidate->>'fingerprint',
          'candidateStateVersion', v_candidate->>'stateVersion'
        )
      ),
      pending_decision = NULL,
      decision_deadline = NULL,
      next_retry_at = now(),
      state_version = state_version + 1
  WHERE id = v_execution.id;

  UPDATE public.agent_commands
  SET status = 'running', pending_decision = NULL, state_version = state_version + 1
  WHERE id = v_command.id;

  RETURN jsonb_build_object(
    'outcome', 'resolved',
    'execution_id', v_execution.id,
    'execution_state_version', v_execution.state_version + 1,
    'command_state_version', v_command.state_version + 1,
    'candidate', v_candidate
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_agent_effect(
  p_agent_id uuid,
  p_authorization_id uuid,
  p_command_id uuid,
  p_execution_id uuid,
  p_idempotency_key text,
  p_frame_id uuid,
  p_candidate_id text,
  p_candidate_fingerprint text,
  p_action_id text,
  p_action_version integer,
  p_target text,
  p_calldata_hash text,
  p_usage_lines jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_authorization public.agent_authorizations%ROWTYPE;
  v_effect_id uuid;
  v_existing public.agent_effect_reservations%ROWTYPE;
  v_line jsonb;
  v_limit jsonb;
  v_reserved numeric(78, 0);
  v_per_action numeric(78, 0);
  v_per_run numeric(78, 0);
  v_rolling numeric(78, 0);
  v_run_used numeric(78, 0);
  v_window_used numeric(78, 0);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_agent_id::text, 141421));

  SELECT * INTO v_existing
  FROM public.agent_effect_reservations
  WHERE agent_id = p_agent_id
    AND idempotency_key = p_idempotency_key
    AND action_id = p_action_id;
  IF FOUND THEN
    IF v_existing.candidate_fingerprint <> lower(p_candidate_fingerprint) THEN
      RETURN jsonb_build_object('outcome', 'conflict');
    END IF;
    RETURN jsonb_build_object('outcome', 'reserved', 'effect_id', v_existing.id, 'state', v_existing.state, 'replayed', true);
  END IF;

  PERFORM 1 FROM public.registered_agents
  WHERE id = p_agent_id AND status = 'ready'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'agent_unavailable');
  END IF;

  SELECT * INTO v_authorization
  FROM public.agent_authorizations
  WHERE id = p_authorization_id
    AND agent_id = p_agent_id
    AND status = 'active'
    AND (expires_at IS NULL OR expires_at > now())
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'authorization_unavailable');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_authorization.policy->'actions') AS action
    WHERE action->>'actionId' = p_action_id
      AND (action->>'version')::integer = p_action_version
  ) THEN
    RETURN jsonb_build_object('outcome', 'action_denied');
  END IF;

  IF jsonb_typeof(p_usage_lines) <> 'array' OR jsonb_array_length(p_usage_lines) = 0 THEN
    RETURN jsonb_build_object('outcome', 'invalid_usage');
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_usage_lines) LOOP
    IF COALESCE(v_line->>'reservedRaw', '') !~ '^(0|[1-9][0-9]*)$' THEN
      RETURN jsonb_build_object('outcome', 'invalid_usage');
    END IF;
    v_reserved := (v_line->>'reservedRaw')::numeric;

    IF v_line->>'category' = 'asset' THEN
      SELECT value INTO v_limit
      FROM jsonb_array_elements(v_authorization.policy->'assetLimits')
      WHERE value->>'asset' = v_line->>'asset'
        AND COALESCE(lower(value->>'tokenAddress'), '') = COALESCE(lower(v_line->>'tokenAddress'), '');
      IF v_limit IS NULL THEN
        RETURN jsonb_build_object('outcome', 'asset_denied');
      END IF;
      v_per_action := (v_limit->>'perActionRaw')::numeric;
      v_per_run := (v_limit->>'perRunRaw')::numeric;
      v_rolling := (v_limit->>'rolling24hRaw')::numeric;
    ELSIF v_line->>'category' = 'gas' THEN
      v_per_action := (v_authorization.policy->>'maxGasPerActionRaw')::numeric;
      v_per_run := (v_authorization.policy->>'maxGasPerRunRaw')::numeric;
      v_rolling := (v_authorization.policy->>'maxGasRolling24hRaw')::numeric;
    ELSIF v_line->>'category' = 'x402' THEN
      v_per_action := (v_authorization.policy->>'maxX402PerRequestRaw')::numeric;
      v_per_run := (v_authorization.policy->>'maxX402PerRunRaw')::numeric;
      v_rolling := (v_authorization.policy->>'maxX402Rolling24hRaw')::numeric;
    ELSIF v_line->>'category' = 'service_fee' THEN
      v_per_action := (v_authorization.policy->>'maxServiceFeePerActionRaw')::numeric;
      v_per_run := (v_authorization.policy->>'maxServiceFeePerRunRaw')::numeric;
      v_rolling := (v_authorization.policy->>'maxServiceFeeRolling24hRaw')::numeric;
    ELSE
      RETURN jsonb_build_object('outcome', 'category_denied');
    END IF;

    IF v_per_action IS NULL OR v_per_run IS NULL OR v_rolling IS NULL THEN
      RETURN jsonb_build_object('outcome', 'category_denied');
    END IF;

    SELECT COALESCE(sum(COALESCE(line.actual_raw, line.reserved_raw)), 0)
      INTO v_run_used
    FROM public.agent_effect_usage_lines line
    JOIN public.agent_effect_reservations effect ON effect.id = line.effect_id
    WHERE line.agent_id = p_agent_id
      AND line.command_id = p_command_id
      AND line.category = v_line->>'category'
      AND line.asset = v_line->>'asset'
      AND COALESCE(line.token_address, '') = COALESCE(lower(v_line->>'tokenAddress'), '')
      AND effect.state <> 'released';

    SELECT COALESCE(sum(COALESCE(line.actual_raw, line.reserved_raw)), 0)
      INTO v_window_used
    FROM public.agent_effect_usage_lines line
    JOIN public.agent_effect_reservations effect ON effect.id = line.effect_id
    WHERE line.agent_id = p_agent_id
      AND line.created_at >= now() - interval '24 hours'
      AND line.category = v_line->>'category'
      AND line.asset = v_line->>'asset'
      AND COALESCE(line.token_address, '') = COALESCE(lower(v_line->>'tokenAddress'), '')
      AND effect.state <> 'released';

    IF v_reserved > v_per_action OR v_run_used + v_reserved > v_per_run
       OR v_window_used + v_reserved > v_rolling THEN
      RETURN jsonb_build_object('outcome', 'budget_exceeded');
    END IF;
  END LOOP;

  INSERT INTO public.agent_effect_reservations (
    agent_id, authorization_id, command_id, execution_id, idempotency_key,
    frame_id, candidate_id, candidate_fingerprint, action_id, action_version,
    target, calldata_hash
  ) VALUES (
    p_agent_id, p_authorization_id, p_command_id, p_execution_id,
    p_idempotency_key, p_frame_id, p_candidate_id,
    lower(p_candidate_fingerprint), p_action_id, p_action_version,
    lower(p_target), lower(p_calldata_hash)
  ) RETURNING id INTO v_effect_id;

  INSERT INTO public.agent_effect_usage_lines (
    effect_id, agent_id, command_id, category, asset, token_address, reserved_raw
  )
  SELECT
    v_effect_id,
    p_agent_id,
    p_command_id,
    value->>'category',
    value->>'asset',
    lower(value->>'tokenAddress'),
    (value->>'reservedRaw')::numeric
  FROM jsonb_array_elements(p_usage_lines);

  RETURN jsonb_build_object('outcome', 'reserved', 'effect_id', v_effect_id, 'state', 'reserved', 'replayed', false);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.cancel_headless_agent_command(uuid, uuid, uuid, integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_headless_agent_command(uuid, uuid, uuid, integer)
TO service_role;

REVOKE EXECUTE ON FUNCTION public.resolve_headless_agent_candidate(uuid, uuid, uuid, uuid, text, integer)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_headless_agent_candidate(uuid, uuid, uuid, uuid, text, integer)
TO service_role;

REVOKE EXECUTE ON FUNCTION public.reserve_agent_effect(uuid, uuid, uuid, uuid, text, uuid, text, text, text, integer, text, text, jsonb)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_agent_effect(uuid, uuid, uuid, uuid, text, uuid, text, text, text, integer, text, text, jsonb)
TO service_role;
