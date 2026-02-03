/**
 * StateManager - Explicit state machine for all prompt processing
 * Ensures predictable, auditable state transitions with no surprises
 */

export class StateManager {
  // Valid session states
  static STATES = {
    PENDING: 'pending',
    ACQUIRING_ACP: 'acquiring_acp',
    ACP_ACQUIRED: 'acp_acquired',
    SENDING_PROMPT: 'sending_prompt',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    ERROR: 'error',
    TIMEOUT: 'timeout',
    CANCELLED: 'cancelled'
  };

  // Valid state transitions - only these are allowed
  static VALID_TRANSITIONS = {
    [this.STATES.PENDING]: [
      this.STATES.ACQUIRING_ACP,
      this.STATES.CANCELLED
    ],
    [this.STATES.ACQUIRING_ACP]: [
      this.STATES.ACP_ACQUIRED,
      this.STATES.ERROR,
      this.STATES.TIMEOUT,
      this.STATES.CANCELLED
    ],
    [this.STATES.ACP_ACQUIRED]: [
      this.STATES.SENDING_PROMPT,
      this.STATES.ERROR,
      this.STATES.TIMEOUT,
      this.STATES.CANCELLED
    ],
    [this.STATES.SENDING_PROMPT]: [
      this.STATES.PROCESSING,
      this.STATES.ERROR,
      this.STATES.TIMEOUT,
      this.STATES.CANCELLED
    ],
    [this.STATES.PROCESSING]: [
      this.STATES.COMPLETED,
      this.STATES.ERROR,
      this.STATES.TIMEOUT,
      this.STATES.CANCELLED
    ],
    [this.STATES.COMPLETED]: [],
    [this.STATES.ERROR]: [],
    [this.STATES.TIMEOUT]: [],
    [this.STATES.CANCELLED]: []
  };

  constructor(sessionId, conversationId, messageId, timeout = 120000) {
    this.sessionId = sessionId;
    this.conversationId = conversationId;
    this.messageId = messageId;
    this.timeout = timeout;

    // State tracking
    this.state = this.constructor.STATES.PENDING;
    this.previousState = null;
    this.stateHistory = [{ state: this.state, timestamp: Date.now(), reason: 'initialized' }];
    
    // Data tracking
    this.data = {
      acpConnectionTime: null,
      promptSentTime: null,
      responseReceivedTime: null,
      fullText: '',
      blocks: [],
      error: null,
      stackTrace: null
    };

    // Promise resolution
    this.promiseResolve = null;
    this.promiseReject = null;
    this.completionPromise = new Promise((resolve, reject) => {
      this.promiseResolve = resolve;
      this.promiseReject = reject;
    });

    // Start timeout
    this.startTimeout();

    console.log(`[StateManager] Session ${sessionId} initialized (timeout: ${timeout}ms)`);
  }

  /**
   * Transition to a new state with validation
   * @param {string} newState - Target state
   * @param {object} data - State-specific data
   * @throws {Error} If transition is invalid
   */
  transition(newState, data = {}) {
    const validTransitions = this.constructor.VALID_TRANSITIONS[this.state] || [];
    
    if (!validTransitions.includes(newState)) {
      const error = `Invalid state transition: ${this.state} → ${newState}. Valid: [${validTransitions.join(', ')}]`;
      console.error(`[StateManager] ${error}`);
      throw new Error(error);
    }

    this.previousState = this.state;
    this.state = newState;

    // Record transition
    this.stateHistory.push({
      state: newState,
      timestamp: Date.now(),
      reason: data.reason || 'manual transition',
      details: data.details || {}
    });

    // Update data
    Object.assign(this.data, data.data || {});

    // Log transition
    const duration = this.stateHistory.length > 1 
      ? Date.now() - this.stateHistory[this.stateHistory.length - 2].timestamp
      : 0;
    
    console.log(`[StateManager] ${this.sessionId} transitioned: ${this.previousState} → ${newState} (+${duration}ms) | ${data.reason || ''}`);

    // Handle terminal states
    if (newState === this.constructor.STATES.COMPLETED) {
      this.completeSuccess(data.data);
    } else if (newState === this.constructor.STATES.ERROR) {
      this.completeError(data.data?.error, data.data?.stackTrace);
    } else if (newState === this.constructor.STATES.TIMEOUT) {
      this.completeError('Operation timeout', data.data?.stackTrace);
    } else if (newState === this.constructor.STATES.CANCELLED) {
      this.completeError('Operation cancelled', null);
    }
  }

  /**
   * Start timeout watchdog
   */
  startTimeout() {
    this.timeoutHandle = setTimeout(() => {
      if (![
        this.constructor.STATES.COMPLETED,
        this.constructor.STATES.ERROR,
        this.constructor.STATES.CANCELLED,
        this.constructor.STATES.TIMEOUT
      ].includes(this.state)) {
        console.error(`[StateManager] ${this.sessionId} TIMEOUT after ${this.timeout}ms in state: ${this.state}`);
        this.transition(this.constructor.STATES.TIMEOUT, {
          reason: 'timeout watchdog fired',
          data: { error: 'Operation exceeded timeout', timeout: this.timeout }
        });
      }
    }, this.timeout);
  }

  /**
   * Cancel the timeout
   */
  cancelTimeout() {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  /**
   * Mark as successfully completed
   */
  completeSuccess(data) {
    this.cancelTimeout();
    this.data = { ...this.data, ...data };
    if (this.promiseResolve) {
      this.promiseResolve({ state: this.state, data: this.data });
    }
  }

  /**
   * Mark as failed
   */
  completeError(error, stackTrace) {
    this.cancelTimeout();
    this.data.error = error;
    this.data.stackTrace = stackTrace;
    if (this.promiseReject) {
      this.promiseReject(new Error(`Session failed: ${error}`));
    }
  }

  /**
   * Get current state
   */
  getState() {
    return this.state;
  }

  /**
   * Get full state history
   */
  getHistory() {
    return this.stateHistory;
  }

  /**
   * Get human-readable summary
   */
  getSummary() {
    const duration = this.stateHistory[this.stateHistory.length - 1].timestamp - this.stateHistory[0].timestamp;
    return {
      sessionId: this.sessionId,
      conversationId: this.conversationId,
      messageId: this.messageId,
      state: this.state,
      previousState: this.previousState,
      duration: `${duration}ms`,
      historyLength: this.stateHistory.length,
      history: this.stateHistory.map(h => `${h.timestamp - this.stateHistory[0].timestamp}ms: ${h.state} (${h.reason})`),
      data: {
        fullTextLength: this.data.fullText.length,
        blocksCount: this.data.blocks.length,
        error: this.data.error,
        hasStackTrace: !!this.data.stackTrace
      }
    };
  }

  /**
   * Wait for completion
   */
  async waitForCompletion() {
    return this.completionPromise;
  }

  /**
   * Check if session is in a terminal state
   */
  isTerminal() {
    return [
      this.constructor.STATES.COMPLETED,
      this.constructor.STATES.ERROR,
      this.constructor.STATES.TIMEOUT,
      this.constructor.STATES.CANCELLED
    ].includes(this.state);
  }

  /**
   * Check if session is in a running state
   */
  isRunning() {
    return !this.isTerminal();
  }

  /**
   * Assert session is in specific state
   */
  assertState(expectedState) {
    if (this.state !== expectedState) {
      throw new Error(`Expected state ${expectedState}, got ${this.state}`);
    }
  }

  /**
   * Assert session can transition to state
   */
  assertCanTransition(targetState) {
    const validTransitions = this.constructor.VALID_TRANSITIONS[this.state] || [];
    if (!validTransitions.includes(targetState)) {
      throw new Error(`Cannot transition from ${this.state} to ${targetState}`);
    }
  }
}

export class SessionStateStore {
  constructor() {
    this.sessions = new Map(); // sessionId -> StateManager
  }

  create(sessionId, conversationId, messageId, timeout) {
    const stateManager = new StateManager(sessionId, conversationId, messageId, timeout);
    this.sessions.set(sessionId, stateManager);
    return stateManager;
  }

  get(sessionId) {
    return this.sessions.get(sessionId);
  }

  getOrThrow(sessionId) {
    const manager = this.sessions.get(sessionId);
    if (!manager) {
      throw new Error(`Session ${sessionId} not found in state store`);
    }
    return manager;
  }

  remove(sessionId) {
    const manager = this.sessions.get(sessionId);
    if (manager) {
      manager.cancelTimeout();
      this.sessions.delete(sessionId);
    }
  }

  getAll() {
    return Array.from(this.sessions.values());
  }

  getAllActive() {
    return this.getAll().filter(m => m.isRunning());
  }

  getAllTerminal() {
    return this.getAll().filter(m => m.isTerminal());
  }

  /**
   * Get diagnostic summary of all sessions
   */
  getDiagnostics() {
    const active = this.getAllActive();
    const terminal = this.getAllTerminal();
    return {
      timestamp: new Date().toISOString(),
      activeSessions: active.length,
      terminalSessions: terminal.length,
      totalSessions: this.sessions.size,
      active: active.map(m => ({
        sessionId: m.sessionId,
        state: m.state,
        uptime: Date.now() - m.stateHistory[0].timestamp
      })),
      recentTerminal: terminal.slice(-5).map(m => m.getSummary())
    };
  }

  /**
   * Cleanup old terminal sessions (older than ttl)
   */
  cleanup(ttl = 3600000) {
    const now = Date.now();
    const toDelete = [];

    for (const [sessionId, manager] of this.sessions) {
      if (manager.isTerminal()) {
        const age = now - manager.stateHistory[manager.stateHistory.length - 1].timestamp;
        if (age > ttl) {
          toDelete.push(sessionId);
        }
      }
    }

    toDelete.forEach(sessionId => this.remove(sessionId));
    if (toDelete.length > 0) {
      console.log(`[SessionStateStore] Cleaned up ${toDelete.length} old sessions`);
    }
  }
}
