CREATE OR REPLACE FUNCTION public.resolve_agent_command_admission_decision(
  p_agent_id uuid,
  p_owner_user_id text,
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

  SELECT * INTO v_command
  FROM public.agent_commands
  WHERE id = p_command_id
    AND agent_id = p_agent_id
    AND owner_user_id = p_owner_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'conflict');
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
       OR (p_resolution = 'cancel'
           AND v_command.status = 'cancelled')
     ) THEN
    RETURN jsonb_build_object(
      'outcome', 'resolved',
      'command_id', v_command.id,
      'command_state_version', v_command.state_version,
      'resolution', p_resolution,
      'replayed', true
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
  SET
    status = CASE
      WHEN p_resolution = 'cancel' THEN 'cancelled'
      ELSE 'queued'
    END,
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
    'outcome', 'resolved',
    'command_id', v_command.id,
    'command_state_version', p_expected_version + 1,
    'resolution', p_resolution,
    'replayed', false
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_agent_command_admission_decision(
  uuid, text, uuid, integer, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_agent_command_admission_decision(
  uuid, text, uuid, integer, text
) TO service_role;
