import { z } from "zod";
import type { ChatMessage } from "@vendor/chat/types";

export type AgentChatMessage = ChatMessage;

export interface AgentChatTurnRequest {
  agentId: string;
  message: string;
  clientMessageId: string;
}

export const agentChatActionSchema = z.object({
  tool: z.string(),
  ok: z.boolean().default(true),
  code: z.string().optional(),
  ms: z.number().optional(),
  summary: z.string().optional(),
  commandId: z.string().nullable().optional(),
  commandVersion: z.number().optional(),
  prompt: z.string().optional(),
  runIds: z.array(z.string().uuid()).max(50).optional(),
});

export type AgentChatAction = z.infer<typeof agentChatActionSchema>;

export interface AgentChatTurnResponse {
  messageId?: string;
  reply: string;
  actions: AgentChatAction[];
  source: "llm" | "deterministic";
}

export interface AgentChatStoredMessage {
  id: string;
  agentId: string;
  role: "user" | "assistant";
  content: string;
  source: "owner" | "llm" | "deterministic" | "execution";
  status: "pending" | "complete" | "failed";
  actions: AgentChatAction[];
  executionId: string | null;
  createdAt: string;
}

export const AGENT_CHAT_MAX_MESSAGE_CHARS = 2000;
export const AGENT_CHAT_MAX_HISTORY_TURNS = 12;
