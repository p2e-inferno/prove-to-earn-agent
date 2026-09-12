ALTER TABLE public.registered_agents
  ALTER COLUMN max_funding_swaps DROP NOT NULL,
  ALTER COLUMN max_funding_swaps DROP DEFAULT;

ALTER TABLE public.registered_agents
  DROP CONSTRAINT IF EXISTS registered_agents_max_funding_swaps_check,
  ADD CONSTRAINT registered_agents_max_funding_swaps_check
    CHECK (max_funding_swaps IS NULL OR max_funding_swaps BETWEEN 0 AND 32);

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

  IF p_max_funding_swaps IS NOT NULL
     AND (p_max_funding_swaps < 0 OR p_max_funding_swaps > 32) THEN
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

REVOKE EXECUTE ON FUNCTION public.create_platform_agent(
  text, text, text, text[], uuid[], integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_platform_agent(
  text, text, text, text[], uuid[], integer, integer
) TO service_role;

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
     OR (
       p_max_funding_swaps IS NOT NULL
       AND (p_max_funding_swaps < 0 OR p_max_funding_swaps > 32)
     ) THEN
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

REVOKE EXECUTE ON FUNCTION public.update_platform_agent_policy(
  uuid, text, text, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_platform_agent_policy(
  uuid, text, text, integer, integer
) TO service_role;
