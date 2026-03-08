/**
 * Checkpoint Manager
 * Handles session recovery by loading checkpoints and injecting into resume flow
 * Ensures idempotency and prevents duplicate event replay
 */

class CheckpointManager {
  constructor(queries) {
    this.queries = queries;
    this._injectedSessions = new Set(); // Track which sessions already had checkpoints injected
    this._pendingCheckpoints = new Map(); // Store checkpoints to inject on subscribe: { conversationId -> checkpoint }
  }

  /**
   * Load checkpoint for a session (all events + chunks from previous session)
   * Used when resuming after interruption
   */
  loadCheckpoint(previousSessionId) {
    if (!previousSessionId) return null;

    try {
      const session = this.queries.getSession(previousSessionId);
      if (!session) return null;

      const events = this.queries.getSessionEvents(previousSessionId);
      const chunks = this.queries.getChunksSinceSeq(previousSessionId, -1);

      return {
        sessionId: previousSessionId,
        conversationId: session.conversationId,
        events: events || [],
        chunks: chunks || [],
        lastSequence: chunks.length > 0 ? Math.max(...chunks.map(c => c.sequence)) : -1
      };
    } catch (e) {
      console.error(`[checkpoint] Failed to load checkpoint for session ${previousSessionId}:`, e.message);
      return null;
    }
  }

  /**
   * Inject checkpoint events into the new session
   * Marks them with resumeOrigin to prevent replay
   * Returns the next sequence number to use
   */
  injectCheckpointEvents(newSessionId, checkpoint, broadcastFn) {
    if (!checkpoint || !checkpoint.events || checkpoint.events.length === 0) {
      return -1;
    }

    // Prevent double-injection for same session
    const injectionKey = `${newSessionId}:checkpoint`;
    if (this._injectedSessions.has(injectionKey)) {
      console.log(`[checkpoint] Session ${newSessionId} already had checkpoint injected, skipping`);
      return checkpoint.lastSequence;
    }

    let sequenceStart = checkpoint.lastSequence + 1;

    try {
      // Broadcast each checkpoint event as if it's arriving now
      for (const evt of checkpoint.events) {
        // Skip internal session management events
        if (evt.type === 'session.created') continue;

        // Re-broadcast with resume markers
        broadcastFn({
          ...evt,
          resumeOrigin: 'checkpoint',
          originalSessionId: checkpoint.sessionId,
          newSessionId: newSessionId,
          timestamp: Date.now()
        });
      }

      // Mark this session as having been injected
      this._injectedSessions.add(injectionKey);

      console.log(
        `[checkpoint] Injected ${checkpoint.events.length} events from session ` +
        `${checkpoint.sessionId} into new session ${newSessionId}`
      );

      return sequenceStart;
    } catch (e) {
      console.error(`[checkpoint] Failed to inject checkpoint events:`, e.message);
      return checkpoint.lastSequence;
    }
  }

  /**
   * Copy checkpoint chunks to new session with modified sequence
   * Ensures chunks are marked as injected to distinguish from new streaming
   */
  copyCheckpointChunks(oldSessionId, newSessionId, startSequence = 0) {
    try {
      const chunks = this.queries.getChunksSinceSeq(oldSessionId, -1);
      if (!chunks || chunks.length === 0) return 0;

      let copiedCount = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const newSequence = startSequence + i;

        try {
          this.queries.createChunk(
            newSessionId,
            chunk.conversationId,
            newSequence,
            chunk.type,
            { ...chunk.data, resumeOrigin: 'checkpoint' }
          );
          copiedCount++;
        } catch (e) {
          console.error(`[checkpoint] Failed to copy chunk ${i}:`, e.message);
        }
      }

      console.log(`[checkpoint] Copied ${copiedCount} chunks from ${oldSessionId} to ${newSessionId}`);
      return startSequence + copiedCount;
    } catch (e) {
      console.error(`[checkpoint] Failed to copy checkpoint chunks:`, e.message);
      return startSequence;
    }
  }

  /**
   * Clean up: mark previous session as properly resumed
   * Prevents re-resuming the same interrupted session multiple times
   */
  markSessionResumed(previousSessionId) {
    try {
      this.queries.updateSession(previousSessionId, {
        status: 'resumed',
        completed_at: Date.now()
      });
      console.log(`[checkpoint] Marked session ${previousSessionId} as resumed`);
    } catch (e) {
      console.error(`[checkpoint] Failed to mark session as resumed:`, e.message);
    }
  }

  /**
   * Clear injected sessions cache (call on server restart)
   */
  reset() {
    this._injectedSessions.clear();
  }

  /**
   * Store a checkpoint to be injected when client subscribes
   * (Used during server startup when no clients are connected yet)
   */
  storeCheckpointForDelay(conversationId, checkpoint) {
    if (checkpoint && checkpoint.events && checkpoint.events.length > 0) {
      this._pendingCheckpoints.set(conversationId, checkpoint);
      console.log(`[checkpoint] Stored checkpoint for ${conversationId} to inject on subscribe (${checkpoint.events.length} events, ${checkpoint.chunks.length} chunks)`);
    }
  }

  /**
   * Get and remove a pending checkpoint (called when client subscribes)
   */
  getPendingCheckpoint(conversationId) {
    const checkpoint = this._pendingCheckpoints.get(conversationId);
    if (checkpoint) {
      this._pendingCheckpoints.delete(conversationId);
      console.log(`[checkpoint] Retrieved pending checkpoint for ${conversationId}`);
    }
    return checkpoint;
  }

  /**
   * Check if there's a pending checkpoint for a conversation
   */
  hasPendingCheckpoint(conversationId) {
    return this._pendingCheckpoints.has(conversationId);
  }
}

export default CheckpointManager;
