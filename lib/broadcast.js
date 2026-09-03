export const BROADCAST_TYPES = new Set([
  'message_created', 'conversation_created', 'conversation_updated',
  'conversations_updated', 'conversation_deleted', 'all_conversations_deleted', 'queue_status', 'queue_updated', 'queue_item_dequeued',
  'rate_limit_hit', 'rate_limit_clear',
  'script_started', 'script_stopped', 'script_output',
  'model_download_progress', 'stt_progress', 'tts_setup_progress', 'voice_list',
  'streaming_start', 'streaming_progress', 'streaming_complete', 'streaming_error',
  'streaming_cancelled', 'chat_active_changed',
  'tool_install_started', 'tool_install_progress', 'tool_install_complete', 'tool_install_failed',
  'tool_update_progress', 'tool_update_complete', 'tool_update_failed',
  'tool_status_update', 'tool_update_available',
  'tools_update_started', 'tools_update_complete', 'tools_refresh_complete',
  'pm2_monit_update', 'pm2_monitoring_started', 'pm2_monitoring_stopped',
  'pm2_list_response', 'pm2_start_response', 'pm2_stop_response',
  'pm2_restart_response', 'pm2_delete_response', 'pm2_logs_response',
  'pm2_flush_logs_response', 'pm2_ping_response', 'pm2_unavailable'
]);

export function createBroadcast({ syncClients, subscriptionIndex, wsOptimizer, broadcastTypes, getSeq }) {
  return function broadcastSync(event) {
    try {
      if (!event.seq) {
        event.seq = getSeq();
      }
      const isBroadcast = broadcastTypes.has(event.type);
      if (syncClients.size > 0) {
        if (isBroadcast) {
          for (const ws of syncClients) { try { wsOptimizer.sendToClient(ws, event); } catch (e) {} }
        } else {
          const targets = new Set();
          if (event.sessionId) {
            const subs = subscriptionIndex.get(event.sessionId);
            if (subs) for (const ws of subs) targets.add(ws);
          }
          if (event.conversationId) {
            const subs = subscriptionIndex.get(`conv-${event.conversationId}`);
            if (subs) for (const ws of subs) targets.add(ws);
          }
          for (const ws of targets) { try { wsOptimizer.sendToClient(ws, event); } catch (e) {} }
        }
      }
    } catch (err) {
      console.error('[BROADCAST] Error (contained):', err.message);
    }
  };
}
