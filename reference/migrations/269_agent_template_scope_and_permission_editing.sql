-- create_platform_agent (260) and its nullable-funding-swap-limit redefinition
-- (262) both used template_ids IS NULL/empty to mean "grant ALL templates" —
-- an empty array is a legitimate deliberate NONE, never distinguishable from
-- "the owner didn't set anything." This migration replaces that collapse with
-- an explicit ALL/SELECTED/NONE discriminator, and adds an RPC so an owner
-- can edit an agent's capability/template grants after creation instead of
-- only at creation time.
--
-- Adding a parameter to create_platform_agent creates a new overload rather
-- than replacing the existing one, so the prior signature is dropped first.
DROP FUNCTION IF EXISTS public.create_platform_agent(
  text, text, text, text[], uuid[], integer, integer
);

CREATE FUNCTION public.create_platform_agent(
  p_owner_user_id text,
  p_reward_wallet text,
  p_label text,
  p_capabilities text[],
  p_template_scope text,
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

  -- ALL/SELECTED/NONE is an explicit discriminator, not inferred from
  -- whether p_template_ids happens to be null or empty: an empty array is a
  -- deliberate NONE, never silently read back as ALL.
  IF p_template_scope NOT IN ('all', 'selected', 'none') THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_TEMPLATE_SCOPE');
  END IF;
  IF p_template_scope = 'selected'
     AND (p_template_ids IS NULL OR array_length(p_template_ids, 1) IS NULL) THEN
    RETURN jsonb_build_object('success', false, 'error', 'TEMPLATE_SELECTION_REQUIRED');
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
    IF v_capability = 'quests.read' OR p_template_scope = 'all' THEN
      INSERT INTO public.agent_permissions (agent_id, capability)
      VALUES (v_agent_id, v_capability)
      ON CONFLICT DO NOTHING;
    ELSIF p_template_scope = 'none' THEN
      -- Deny by default: granting no row for this capability means the agent
      -- may run no Daily Quest template under it.
      CONTINUE;
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
  text, text, text, text[], text, uuid[], integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_platform_agent(
  text, text, text, text[], text, uuid[], integer, integer
) TO service_role;

-- Owner-editable capability/template grants, post-creation: the owner
-- resubmits the complete desired capability set and template scope, and this
-- reconciles agent_permissions atomically (full delete + reinsert) so there
-- is never a window with a partially-applied grant. Every input is validated
-- before any write, so an invalid request never leaves a partial DELETE
-- committed.
CREATE FUNCTION public.update_platform_agent_permissions(
  p_agent_id uuid,
  p_owner_user_id text,
  p_capabilities text[],
  p_template_scope text,
  p_template_ids uuid[],
  p_expected_version integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_capability text;
  v_template_id uuid;
BEGIN
  IF p_capabilities IS NULL OR array_length(p_capabilities, 1) IS NULL THEN
    RETURN false;
  END IF;
  FOREACH v_capability IN ARRAY p_capabilities LOOP
    IF v_capability NOT IN (
      'quests.read', 'quests.start', 'tasks.complete', 'tasks.claim', 'quests.complete'
    ) THEN
      RETURN false;
    END IF;
  END LOOP;
  IF p_template_scope NOT IN ('all', 'selected', 'none') THEN
    RETURN false;
  END IF;
  IF p_template_scope = 'selected'
     AND (p_template_ids IS NULL OR array_length(p_template_ids, 1) IS NULL) THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM public.registered_agents
  WHERE id = p_agent_id
    AND owner_user_id = p_owner_user_id
    AND status <> 'revoked'
    AND lifecycle_version = p_expected_version
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  DELETE FROM public.agent_permissions WHERE agent_id = p_agent_id;

  FOREACH v_capability IN ARRAY p_capabilities LOOP
    IF v_capability = 'quests.read' OR p_template_scope = 'all' THEN
      INSERT INTO public.agent_permissions (agent_id, capability)
      VALUES (p_agent_id, v_capability)
      ON CONFLICT DO NOTHING;
    ELSIF p_template_scope = 'none' THEN
      CONTINUE;
    ELSE
      FOREACH v_template_id IN ARRAY p_template_ids LOOP
        INSERT INTO public.agent_permissions (
          agent_id, capability, daily_quest_template_id
        ) VALUES (
          p_agent_id, v_capability, v_template_id
        ) ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;
  END LOOP;

  UPDATE public.registered_agents
  SET lifecycle_version = lifecycle_version + 1
  WHERE id = p_agent_id;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.update_platform_agent_permissions(
  uuid, text, text[], text, uuid[], integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_platform_agent_permissions(
  uuid, text, text[], text, uuid[], integer
) TO service_role;
