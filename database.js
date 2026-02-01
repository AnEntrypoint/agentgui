import fs from 'fs';
import path from 'path';
import os from 'os';

const dbDir = path.join(os.homedir(), '.gmgui');
const dbFilePath = path.join(dbDir, 'data.json');

// Ensure directory exists
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Load or initialize database
let dbData = {
  conversations: {},
  messages: {},
  sessions: {},
  events: {}
};

function loadDatabase() {
  if (fs.existsSync(dbFilePath)) {
    try {
      const content = fs.readFileSync(dbFilePath, 'utf-8');
      dbData = JSON.parse(content);
      console.log('Database loaded successfully');
    } catch (e) {
      console.error('Error loading database:', e.message);
    }
  } else {
    saveDatabase();
    console.log('Database initialized successfully');
  }
}

function saveDatabase() {
  try {
    fs.writeFileSync(dbFilePath, JSON.stringify(dbData, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error saving database:', e.message);
  }
}

loadDatabase();

// Generate unique IDs
function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Query helpers
export const queries = {
  // Conversations
  createConversation(agentId, title = null) {
    const id = generateId('conv');
    const now = Date.now();
    const conversation = {
      id,
      agentId,
      title,
      created_at: now,
      updated_at: now,
      status: 'active'
    };
    dbData.conversations[id] = conversation;
    saveDatabase();
    return conversation;
  },

  getConversation(id) {
    return dbData.conversations[id];
  },

  getAllConversations() {
    return Object.values(dbData.conversations).sort((a, b) => b.updated_at - a.updated_at);
  },

  updateConversation(id, data) {
    const conversation = dbData.conversations[id];
    if (!conversation) return null;

    if (data.title !== undefined) {
      conversation.title = data.title;
    }
    if (data.status !== undefined) {
      conversation.status = data.status;
    }
    conversation.updated_at = Date.now();

    saveDatabase();
    return conversation;
  },

  // Messages
  createMessage(conversationId, role, content) {
    const id = generateId('msg');
    const now = Date.now();
    const message = {
      id,
      conversationId,
      role,
      content,
      created_at: now
    };
    dbData.messages[id] = message;

    // Update conversation's updated_at
    if (dbData.conversations[conversationId]) {
      dbData.conversations[conversationId].updated_at = now;
    }

    saveDatabase();
    return message;
  },

  getMessage(id) {
    return dbData.messages[id];
  },

  getConversationMessages(conversationId) {
    return Object.values(dbData.messages)
      .filter(m => m.conversationId === conversationId)
      .sort((a, b) => a.created_at - b.created_at);
  },

  // Sessions
  createSession(conversationId) {
    const id = generateId('sess');
    const now = Date.now();
    const session = {
      id,
      conversationId,
      status: 'pending',
      started_at: now,
      completed_at: null,
      response: null,
      error: null
    };
    dbData.sessions[id] = session;
    saveDatabase();
    return session;
  },

  getSession(id) {
    return dbData.sessions[id];
  },

  getConversationSessions(conversationId) {
    return Object.values(dbData.sessions)
      .filter(s => s.conversationId === conversationId)
      .sort((a, b) => b.started_at - a.started_at);
  },

  updateSession(id, data) {
    const session = dbData.sessions[id];
    if (!session) return null;

    if (data.status !== undefined) {
      session.status = data.status;
    }
    if (data.response !== undefined) {
      session.response = data.response;
    }
    if (data.error !== undefined) {
      session.error = data.error;
    }
    if (data.completed_at !== undefined) {
      session.completed_at = data.completed_at;
    }

    saveDatabase();
    return session;
  },

  // Events (event sourcing)
  createEvent(type, data, conversationId = null, sessionId = null) {
    const id = generateId('evt');
    const now = Date.now();
    const event = {
      id,
      type,
      conversationId,
      sessionId,
      data,
      created_at: now
    };
    dbData.events[id] = event;
    saveDatabase();
    return event;
  },

  getEvent(id) {
    return dbData.events[id];
  },

  getConversationEvents(conversationId) {
    return Object.values(dbData.events)
      .filter(e => e.conversationId === conversationId)
      .sort((a, b) => a.created_at - b.created_at);
  },

  getSessionEvents(sessionId) {
    return Object.values(dbData.events)
      .filter(e => e.sessionId === sessionId)
      .sort((a, b) => a.created_at - b.created_at);
  },

  // Clean up old data
  cleanup() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

    // Delete old events
    for (const id in dbData.events) {
      if (dbData.events[id].created_at < thirtyDaysAgo) {
        delete dbData.events[id];
      }
    }

    // Delete old sessions
    for (const id in dbData.sessions) {
      if (dbData.sessions[id].completed_at && dbData.sessions[id].completed_at < thirtyDaysAgo) {
        delete dbData.sessions[id];
      }
    }

    saveDatabase();
  }
};

export default { queries };
