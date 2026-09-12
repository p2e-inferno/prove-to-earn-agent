/**
 * OpenRouter AI Types
 *
 * Typed interfaces for the OpenRouter chat completion API.
 * Supports text, vision (images), and multi-turn chat via one message format.
 */

// --- Message content types (OpenAI-compatible) ---

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageUrlContent {
  type: "image_url";
  image_url: {
    /** HTTPS URL or data:image/...;base64,... */
    url: string;
  };
}

export interface VideoUrlContent {
  type: "video_url";
  video_url: {
    /** HTTPS URL or data:video/mp4;base64,... */
    url: string;
  };
}

/** Plain string for text-only, or array for vision/multi-part messages. */
export type MessageContent = string | Array<TextContent | ImageUrlContent | VideoUrlContent>;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: MessageContent;
}

export interface AIToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface AIToolDefinition {
  type: "function";
  function: AIToolFunction;
}

export interface AIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface AIAssistantToolCallMessage {
  role: "assistant";
  content: MessageContent | null;
  tool_calls: AIToolCall[];
}

export interface AIToolResultMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type AIConversationMessage =
  | ChatMessage
  | AIAssistantToolCallMessage
  | AIToolResultMessage;

export type AIToolChoice = "auto" | "none" | "required";

// --- Request options ---

export interface AIRequestOptions {
  /** OpenRouter model ID, e.g. "google/gemini-2.0-flash-001". Falls back to env/default. */
  model?: string;
  /** Chat messages (required). */
  messages: AIConversationMessage[];
  /** Max tokens in response. Omit to use model default. */
  maxTokens?: number;
  /** Temperature 0-2. Omit to use model default. */
  temperature?: number;
  /** Fallback model IDs if primary is unavailable. Uses OpenRouter native fallback routing. */
  fallbacks?: string[];
  /** Optional provider-side response format contract. */
  responseFormat?: AIResponseFormat;
  /** Optional reasoning depth for models that support it (e.g. Gemini 3.1 'minimal' | 'low' | 'medium' | 'high'). */
  thinkingLevel?: string;
  /** Optional tools for tool-calling capable models. */
  tools?: AIToolDefinition[];
  /** Tool-choice hint for providers that support it. */
  toolChoice?: AIToolChoice;
  /** Whether parallel tool calls may be returned. */
  parallelToolCalls?: boolean;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

export interface AIJsonSchemaResponseFormat {
  type: "json_schema";
  json_schema: {
    name: string;
    strict?: boolean;
    schema: Record<string, unknown>;
  };
}

export interface AIJsonObjectResponseFormat {
  type: "json_object";
}

export type AIResponseFormat =
  | AIJsonSchemaResponseFormat
  | AIJsonObjectResponseFormat;

// --- Response types ---

export interface AITextResponse {
  success: true;
  /** The text content of the AI response. */
  content: string;
  /** The model that actually responded (may differ from requested if fallback triggered). */
  model: string;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AIToolCallsResponse {
  success: true;
  model: string;
  finishReason: "tool_calls";
  toolCalls: AIToolCall[];
  assistantMessage: AIAssistantToolCallMessage;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AIError {
  success: false;
  error: string;
  code: string;
}

export type AIResponse = AITextResponse | AIToolCallsResponse;
export type AIResult = AIResponse | AIError;
