/**
 * SCHEMAS.TS - Zod validation schemas for all data structures
 * Ensures data integrity at every boundary (API, database, client)
 * Provides type-safe parsing and validation
 */

import { z } from 'zod';

// ============================================================================
// CONVERSATION SCHEMAS
// ============================================================================

export const ConversationStatusSchema = z.enum(['active', 'archived', 'deleted']);

export const ConversationSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  title: z.string().nullable().optional(),
  created_at: z.number().int().positive(),
  updated_at: z.number().int().positive(),
  status: ConversationStatusSchema,
  agentType: z.string().optional(),
  source: z.enum(['gui', 'imported']).optional(),
  externalId: z.string().optional(),
  firstPrompt: z.string().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  projectPath: z.string().optional(),
  gitBranch: z.string().optional(),
  sourcePath: z.string().optional(),
  lastSyncedAt: z.number().int().optional(),
});

export const ConversationCreateInputSchema = z.object({
  agentId: z.string().min(1, 'agentId is required'),
  title: z.string().max(500).nullable().optional(),
});

export const ConversationUpdateInputSchema = z.object({
  title: z.string().max(500).optional(),
  status: ConversationStatusSchema.optional(),
});

export const ConversationsListSchema = z.object({
  conversations: z.array(ConversationSchema),
  total: z.number().int().nonnegative(),
});

// ============================================================================
// MESSAGE SCHEMAS
// ============================================================================

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system']);

export const MessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  role: MessageRoleSchema,
  content: z.string(),
  created_at: z.number().int().positive(),
});

export const MessageCreateInputSchema = z.object({
  conversationId: z.string().min(1),
  role: MessageRoleSchema,
  content: z.string().min(1, 'content cannot be empty').max(1000000),
  idempotencyKey: z.string().optional(),
});

export const MessagesListSchema = z.object({
  messages: z.array(MessageSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

// ============================================================================
// SESSION SCHEMAS
// ============================================================================

export const SessionStatusSchema = z.enum(['pending', 'processing', 'completed', 'error', 'cancelled']);

export const SessionResponseSchema = z.object({
  text: z.string(),
  messageId: z.string().min(1),
});

export const SessionSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  status: SessionStatusSchema,
  started_at: z.number().int().positive(),
  completed_at: z.number().int().positive().optional(),
  response: SessionResponseSchema.optional(),
  error: z.string().optional(),
});

// ============================================================================
// SYNC STATE SCHEMAS
// ============================================================================

export const SyncStateSchema = z.enum(['idle', 'loading', 'synced', 'error', 'offline', 'reconciling']);

export const SyncStatusSchema = z.object({
  state: SyncStateSchema,
  lastSyncTime: z.number().int().optional(),
  nextRetryTime: z.number().int().optional(),
  error: z.string().optional(),
  retryCount: z.number().int().nonnegative(),
  maxRetries: z.number().int().positive(),
});

export const SyncEventTypeSchema = z.enum([
  'conversation_created',
  'conversation_updated',
  'conversation_deleted',
  'message_created',
  'message_updated',
  'message_deleted',
  'sync_started',
  'sync_completed',
  'sync_failed',
  'offline_detected',
  'online_detected',
]);

export const SyncEventSchema = z.object({
  type: SyncEventTypeSchema,
  timestamp: z.number().int().positive(),
  data: z.record(z.unknown()),
});

// ============================================================================
// PAGINATION SCHEMAS
// ============================================================================

export const PaginationParamsSchema = z.object({
  limit: z.number().int().positive().max(100),
  offset: z.number().int().nonnegative(),
});

export const PaginatedResultSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    hasMore: z.boolean(),
  });

// ============================================================================
// IDEMPOTENCY SCHEMAS
// ============================================================================

export const IdempotencyKeySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  created_at: z.number().int().positive(),
  ttl: z.number().int().positive(),
});

// ============================================================================
// API RESPONSE SCHEMAS
// ============================================================================

export const ApiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    data: dataSchema.optional(),
    error: z.string().optional(),
    timestamp: z.number().int().positive(),
  });

// ============================================================================
// VALIDATION HELPER FUNCTIONS
// ============================================================================

export function validateConversation(data: unknown) {
  try {
    return { valid: true, data: ConversationSchema.parse(data) };
  } catch (error) {
    return { valid: false, error: String(error) };
  }
}

export function validateMessage(data: unknown) {
  try {
    return { valid: true, data: MessageSchema.parse(data) };
  } catch (error) {
    return { valid: false, error: String(error) };
  }
}

export function validateConversationsList(data: unknown) {
  try {
    return { valid: true, data: ConversationsListSchema.parse(data) };
  } catch (error) {
    return { valid: false, error: String(error) };
  }
}

export function validateMessagesList(data: unknown) {
  try {
    return { valid: true, data: MessagesListSchema.parse(data) };
  } catch (error) {
    return { valid: false, error: String(error) };
  }
}

export function validatePaginationParams(data: unknown) {
  try {
    return { valid: true, data: PaginationParamsSchema.parse(data) };
  } catch (error) {
    return { valid: false, error: String(error) };
  }
}
