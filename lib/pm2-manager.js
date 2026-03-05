import pm2 from 'pm2';

const ACTIVE_STATES = new Set(['online', 'launching', 'stopping', 'waiting restart']);

class PM2Manager {
  constructor() {
    this.connected = false;
    this.monitoring = false;
    this.monitorInterval = null;
    this.broadcastFn = null;
    this.logStreams = new Map();
  }

  async connect() {
    if (this.connected) return true;
    return new Promise((resolve, reject) => {
      pm2.connect(false, (err) => {
        if (err) { this.connected = false; reject(err); }
        else { this.connected = true; resolve(true); }
      });
    });
  }

  async ensureConnected() {
    if (this.connected) return true;
    await this.connect();
    return true;
  }

  async listProcesses() {
    try {
      await this.ensureConnected();
      return new Promise((resolve) => {
        pm2.list((err, list) => {
          if (err) { this.connected = false; resolve([]); return; }
          if (!Array.isArray(list)) { resolve([]); return; }
          resolve(list.map(proc => ({
            name: proc.name,
            pm_id: proc.pm_id,
            status: proc.status,
            pid: proc.pid,
            cpu: proc.monit ? (proc.monit.cpu || 0) : 0,
            memory: proc.monit ? (typeof proc.monit.memory === 'number' ? proc.monit.memory : 0) : 0,
            uptime: proc.pm2_env ? proc.pm2_env.pm_uptime : null,
            restarts: proc.pm2_env ? (proc.pm2_env.restart_time || 0) : 0,
            watching: proc.pm2_env ? (proc.pm2_env.watch || false) : false,
            isActive: ACTIVE_STATES.has(proc.status)
          })));
        });
      });
    } catch (_) {
      this.connected = false;
      return [];
    }
  }

  async startMonitoring(broadcastFn) {
    if (this.monitoring) return;
    this.monitoring = true;
    this.broadcastFn = broadcastFn;
    const tick = async () => {
      if (!this.monitoring) return;
      try {
        const processes = await this.listProcesses();
        const hasActive = processes.some(p => p.isActive);
        broadcastFn({ type: 'pm2_monit_update', processes, hasActive, available: true, timestamp: Date.now() });
      } catch (_) {}
    };
    this.monitorInterval = setInterval(tick, 2000);
    await tick();
  }

  stopMonitoring() {
    this.monitoring = false;
    if (this.monitorInterval) { clearInterval(this.monitorInterval); this.monitorInterval = null; }
    this.broadcastFn = null;
  }

  async startProcess(name) {
    try {
      await this.ensureConnected();
      return new Promise((resolve) => {
        pm2.start(name, (err) => resolve(err ? { success: false, error: err.message } : { success: true }));
      });
    } catch (err) { return { success: false, error: err.message }; }
  }

  async stopProcess(name) {
    try {
      await this.ensureConnected();
      return new Promise((resolve) => {
        pm2.stop(name, (err) => resolve(err ? { success: false, error: err.message } : { success: true }));
      });
    } catch (err) { return { success: false, error: err.message }; }
  }

  async restartProcess(name) {
    try {
      await this.ensureConnected();
      return new Promise((resolve) => {
        pm2.restart(name, (err) => resolve(err ? { success: false, error: err.message } : { success: true }));
      });
    } catch (err) { return { success: false, error: err.message }; }
  }

  async deleteProcess(name) {
    try {
      await this.ensureConnected();
      return new Promise((resolve) => {
        pm2.delete(name, (err) => resolve(err ? { success: false, error: err.message } : { success: true }));
      });
    } catch (err) { return { success: false, error: err.message }; }
  }

  async getLogs(name, options = {}) {
    try {
      await this.ensureConnected();
      const existing = this.logStreams.get(name);
      if (existing) { try { existing.destroy(); } catch (_) {} this.logStreams.delete(name); }
      return new Promise((resolve) => {
        const lines = [];
        let settled = false;
        const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
        const timer = setTimeout(() => finish({ success: true, logs: lines.join('\n') }), 4000);
        try {
          const stream = pm2.logs(name, { raw: true, lines: options.lines || 100, follow: false });
          this.logStreams.set(name, stream);
          stream.on('data', (c) => lines.push(c.toString()));
          stream.on('end', () => { clearTimeout(timer); this.logStreams.delete(name); finish({ success: true, logs: lines.join('\n') }); });
          stream.on('error', (e) => { clearTimeout(timer); this.logStreams.delete(name); finish({ success: false, error: e.message }); });
        } catch (err) { clearTimeout(timer); finish({ success: false, error: err.message }); }
      });
    } catch (err) { return { success: false, error: err.message }; }
  }

  async flushLogs(name) {
    try {
      await this.ensureConnected();
      return new Promise((resolve) => {
        pm2.flush(name, (err) => resolve(err ? { success: false, error: err.message } : { success: true }));
      });
    } catch (err) { return { success: false, error: err.message }; }
  }

  async ping() {
    try {
      await this.ensureConnected();
      return { success: true, status: 'connected' };
    } catch (err) { return { success: false, error: err.message }; }
  }

  async heal() {
    this.connected = false;
    try {
      await this.connect();
      return { success: true };
    } catch (err) { return { success: false, error: err.message }; }
  }

  disconnect() {
    this.stopMonitoring();
    for (const [, s] of this.logStreams) { try { s.destroy(); } catch (_) {} }
    this.logStreams.clear();
    this.connected = false;
    try { pm2.disconnect(); } catch (_) {}
  }
}

export const pm2Manager = new PM2Manager();
export default pm2Manager;
