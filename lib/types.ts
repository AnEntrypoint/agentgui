/**
 * TYPES.TS - Complete type definitions for the separated data and sync system
 * Guarantees type safety across CLI tests, server, and client
 * Immutable by design - all structures are readonly
 */

// ============================================================================
// CONVERSATION TYPES
// ============================================================================

export interface Conversation {
  readonly id: string;
  readonly agentId: string;
  readonly title: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly status: ConversationStatus;
  readonly agentType?: string;
  readonly source?: 'gui' | 'imported';
  readonly externalId?: string;
  readonly firstPrompt?: string;
  readonly messageCount?: number;
  readonly projectPath?: string;
  readonly gitBranch?: string;
  readonly sourcePath?: string;
  readonly lastSyncedAt?: number;
}

export type ConversationStatus = 'active' | 'archived' | 'deleted';

export interface ConversationCreateInput {
  agentId: string;
  title?: string | null;
}

export interface ConversationUpdateInput {
  title?: string;
  status?: ConversationStatus;
}

// ============================================================================
// MESSAGE TYPES
// ============================================================================

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly created_at: number;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export interface MessageCreateInput {
  conversationId: string;
  role: MessageRole;
  content: string;
  idempotencyKey?: string;
}

// ============================================================================
// SESSION TYPES (for message processing)
// ============================================================================

export interface Session {
  readonly id: string;
  readonly conversationId: string;
  readonly status: SessionStatus;
  readonly started_at: number;
  readonly completed_at?: number;
  readonly response?: SessionResponse;
  readonly error?: string;
}

export type SessionStatus = 'pending' | 'processing' | 'completed' | 'error' | 'cancelled';

export interface SessionResponse {
  readonly text: string;
  readonly messageId: string;
}

// ============================================================================
// SYNC STATE TYPES
// ============================================================================

export type SyncState = 'idle' | 'loading' | 'synced' | 'error' | 'offline' | 'reconciling';

export interface SyncStatus {
  readonly state: SyncState;
  readonly lastSyncTime?: number;
  readonly nextRetryTime?: number;
  readonly error?: string;
  readonly retryCount: number;
  readonly maxRetries: number;
}

export interface SyncEvent {
  readonly type: SyncEventType;
  readonly timestamp: number;
  readonly data: Record<string, unknown>;
}

export type SyncEventType =
  | 'conversation_created'
  | 'conversation_updated'
  | 'conversation_deleted'
  | 'message_created'
  | 'message_updated'
  | 'message_deleted'
  | 'sync_started'
  | 'sync_completed'
  | 'sync_failed'
  | 'offline_detected'
  | 'online_detected';

// ============================================================================
// PAGINATION TYPES
// ============================================================================

export interface PaginationParams {
  readonly limit: number;
  readonly offset: number;
}

export interface PaginatedResult<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

// ============================================================================
// IDEMPOTENCY TYPES
// ============================================================================

export interface IdempotencyKey {
  readonly key: string;
  readonly value: string;
  readonly created_at: number;
  readonly ttl: number;
}

// ============================================================================
// ERROR TYPES
// ============================================================================

export class SyncError extends Error {
  constructor(
    public code: string,
    public message: string,
    public retryable: boolean = false,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export type ErrorCode =
  | 'DATABASE_ERROR'
  | 'NETWORK_ERROR'
  | 'SYNC_CONFLICT'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'TIMEOUT'
  | 'UNKNOWN';

// ============================================================================
// STATE MACHINE CONTEXT
// ============================================================================

export interface SyncMachineContext {
  readonly conversationId?: string;
  readonly messageId?: string;
  readonly lastError?: Error;
  readonly retryCount: number;
  readonly syncData: Record<string, unknown>;
}

// ============================================================================
// API RESPONSE TYPES
// ============================================================================

export interface ApiResponse<T> {
  readonly data?: T;
  readonly error?: string;
  readonly timestamp: number;
}

export interface ConversationsListResponse {
  readonly conversations: readonly Conversation[];
  readonly total: number;
}

export interface MessagesListResponse {
  readonly messages: readonly Message[];
  readonly total: number;
  readonly hasMore: boolean;
}

// ============================================================================
// VALIDATION RESULT TYPES
// ============================================================================

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
}

export interface ValidationError {
  readonly field: string;
  readonly message: string;
  readonly value?: unknown;
}

// ============================================================================
// CONFLICT RESOLUTION TYPES
// ============================================================================

export type ConflictResolutionStrategy = 'last-write-wins' | 'server-wins' | 'client-wins';

export interface ConflictInfo {
  readonly localVersion: unknown;
  readonly remoteVersion: unknown;
  readonly resolution: ConflictResolutionStrategy;
}

// ============================================================================
// RECOVERY TYPES
// ============================================================================

export interface RecoveryCheckpoint {
  readonly timestamp: number;
  readonly synced: boolean;
  readonly data: Record<string, unknown>;
}

export interface RecoveryState {
  readonly lastCheckpoint?: RecoveryCheckpoint;
  readonly pendingOperations: readonly unknown[];
  readonly offline: boolean;
}
