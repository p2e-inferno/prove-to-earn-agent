export type ChatRole = "user" | "assistant";
export type ChatMessageStatus = "complete" | "streaming" | "error";

export type ChatRequestStatus = "idle" | "hydrating" | "sending" | "error";
export type ChatRateLimitTier = "anonymous" | "authenticated" | "member";

export interface ChatMessageRequestError {
  status: number;
  reason?: "burst" | "quota";
  retryAfterSeconds?: number;
  tier?: ChatRateLimitTier;
}

export type ChatConversationSource = "anonymous" | "authenticated";
export type ChatAssistantMode =
  | "general"
  | "quests"
  | "bootcamp"
  | "application"
  | "dashboard"
  | "admin";

export interface ChatAttachment {
  type: "image" | "video";
  data: string; // data URL or app/blob-backed URL
  name?: string;
  size?: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  ts: number;
  status: ChatMessageStatus;
  error?: string | null;
  requestError?: ChatMessageRequestError | null;
  attachments?: ChatAttachment[];
}

export interface SuggestedPrompt {
  label: string;
  prompt: string;
}

export interface ChatConversation {
  id: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  source: ChatConversationSource;
}

export interface ChatRouteContext {
  pathname: string;
  routeKey: string;
  pageLabel: string;
  segment: string | null;
  behavior: ChatRouteBehavior;
}

export interface ChatRouteBehavior {
  key: ChatAssistantMode;
  assistantLabel: string;
  systemHint: string;
}

export interface ChatAssistantContext {
  mode: ChatAssistantMode;
  systemHint: string;
  starterPrompt: string;
}

export interface ChatAuthContext {
  isReady: boolean;
  isAuthenticated: boolean;
  privyUserId: string | null;
  walletAddress: string | null;
}

export interface ChatWidgetSession {
  isOpen: boolean;
  isPeekVisible: boolean;
  isPeekDismissed: boolean;
  draft: string;
  activeConversationId: string | null;
}

export interface RestoreConversationResult {
  conversation: ChatConversation | null;
  widget: ChatWidgetSession | null;
}

export interface ChatWidgetState extends ChatWidgetSession {
  messages: ChatMessage[];
  status: ChatRequestStatus;
  error: string | null;
  rateLimitedUntil: number | null;
  auth: ChatAuthContext;
  route: ChatRouteContext | null;
  hasHydrated: boolean;
  lastHydratedUserId: string | null;
}

export interface ChatAdapterRequest {
  conversationId: string;
  message: ChatMessage;
  messages: ChatMessage[];
  auth: ChatAuthContext;
  route: ChatRouteContext | null;
  assistantContext: ChatAssistantContext;
  accessToken?: string | null;
  lifecycle?: ChatAdapterLifecycleHandlers;
}

export interface ChatSourceReference {
  id: string;
  title: string;
  href?: string;
}

export type ChatAdapterResponse =
  | {
      // Non-streaming adapters return the final assistant message here.
      // Source references are transport-only right now; the widget does not yet
      // persist or render citations end-to-end.
      mode: "final";
      message: ChatMessage;
      sources?: ChatSourceReference[];
    }
  | {
      // Lifecycle-driven adapters must finalize via callbacks and not return a second message.
      // Source references are transport-only right now; the widget does not yet
      // persist or render citations end-to-end.
      mode: "lifecycle";
      sources?: ChatSourceReference[];
    };

export interface ChatAdapterLifecycleHandlers {
  onAssistantMessageStart?: (message: ChatMessage) => void | Promise<void>;
  onAssistantMessageUpdate?: (
    messageId: string,
    content: string,
  ) => void | Promise<void>;
  onAssistantMessageComplete?: (
    messageId: string,
    content?: string,
  ) => void | Promise<void>;
  onAssistantMessageError?: (
    messageId: string,
    error: string,
  ) => void | Promise<void>;
}

export interface ChatControllerBootstrapOptions {
  auth: ChatAuthContext;
  route: ChatRouteContext;
  accessToken?: string | null;
}

export interface ChatControllerActionOptions {
  accessToken?: string | null;
}

export type ChatReconciliationAction =
  | "none"
  | "fallback_only"
  | "promote_fallback"
  | "merge_fallback_messages"
  | "prefer_durable";

export interface ChatReconciliationPlan {
  action: ChatReconciliationAction;
  resolved: RestoreConversationResult;
  pendingMessages: ChatMessage[];
}
