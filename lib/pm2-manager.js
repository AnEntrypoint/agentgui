import pm2 from 'pm2';

class PM2Manager {
  constructor() {
    this.connected = false;
    this.monitoring = false;
    this.processes = new Map();
    this.monitorInterval = null;
    this.subscribers = new Set();
    this.logStreams = new Map();
  }

  async connect() {
    if (this.connected) return true;
    try {
      await pm2.connect({
        promisify: true,
        cluster: false,
        conf: {},
        pm2_path: process.env.PM2_PATH || 'pm2'
      });
      this.connected = true;
      console.log('[PM2] Connected to PM2 daemon');
      return true;
    } catch (err) {
      console.error('[PM2] Connection failed:', err.message);
      throw err;
    }
  }

  async ensureConnected() {
    if (!this.connected) {
      await this.connect();
    }
    return this.connected;
  }

  async listProcesses() {
    try {
      await this.ensureConnected();
      const listResult = await pm2.list();
      return listResult.map(proc => ({
        name: proc.name,
        pm_id: proc.pm_id,
        status: proc.status,
        mode: proc.mode,
        pid: proc.pid,
        cpu: proc.monit ? proc.monit.cpu : 0,
        memory: proc.monit ? (typeof proc.monit.memory === 'number' ? proc.monit.memory : 0) : 0,
        memoryRss: proc.monit ? (proc.monit.memoryRss || 0) : 0,
        uptime: proc.uptime,
        createdAt: proc.created_at,
        isClusterMode: proc.mode === 'cluster',
        instances: proc.instances || 1,
        execMode: proc.exec_mode || proc.mode,
        pm2_env: proc.pm2_env || {},
        nodeVersion: proc.node_version,
        pm2Version: proc.pm2_version,
        restarts: proc.restarts || 0,
        watching: proc.watching || false
      }));
    } catch (err) {
      console.error('[PM2] List error:', err.message);
      return [];
    }
  }

  async startMonitoring(broadcastFn) {
    if (this.monitoring) return;
    this.monitoring = true;
    this.broadcastFn = broadcastFn;

    const update = async () => {
      if (!this.monitoring) return;
      try {
        const processes = await this.listProcesses();
        const broadcastData = {
          type: 'pm2_monit_update',
          timestamp: Date.now(),
          processes
        };
        if (this.broadcastFn) {
          this.broadcastFn(broadcastData);
        }
      } catch (err) {
        console.error('[PM2] Monitoring update error:', err.message);
      }
    };

    this.monitorInterval = setInterval(update, 2000);
    await update(); // Initial update
  }

  stopMonitoring() {
    this.monitoring = false;
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.broadcastFn = null;
  }

  async startProcess(name) {
    try {
      await this.ensureConnected();
      await pm2.start(name);
      return { success: true };
    } catch (err) {
      console.error('[PM2] Start error:', err.message);
      return { success: false, error: err.message };
    }
  }

  async stopProcess(name) {
    try {
      await this.ensureConnected();
      await pm2.stop(name);
      return { success: true };
    } catch (err) {
      console.error('[PM2] Stop error:', err.message);
      return { success: false, error: err.message };
    }
  }

  async restartProcess(name) {
    try {
      await this.ensureConnected();
      await pm2.restart(name);
      return { success: true };
    } catch (err) {
      console.error('[PM2] Restart error:', err.message);
      return { success: false, error: err.message };
    }
  }

  async deleteProcess(name) {
    try {
      await this.ensureConnected();
      await pm2.delete(name);
      return { success: true };
    } catch (err) {
      console.error('[PM2] Delete error:', err.message);
      return { success: false, error: err.message };
    }
  }

  async getLogs(name, options = {}) {
    try {
      await this.ensureConnected();
      const logStream = this.logStreams.get(name);
      if (logStream) {
        logStream.destroy();
        this.logStreams.delete(name);
      }

      const stream = pm2.logs(name, {
        raw: true,
        lines: options.lines || 100,
        follow: options.follow || false,
        timestamp: options.timestamp || false
      });

      this.logStreams.set(name, stream);

      return new Promise((resolve, reject) => {
        let logsBuffer = '';
        stream.on('data', (chunk) => {
          logsBuffer += chunk.toString();
        });
        stream.on('end', () => {
          resolve({ success: true, logs: logsBuffer });
        });
        stream.on('error', (err) => {
          reject({ success: false, error: err.message });
        });

        setTimeout(() => {
          stream.destroy();
          this.logStreams.delete(name);
          resolve({ success: true, logs: logsBuffer });
        }, 5000);
      });
    } catch (err) {
      console.error('[PM2] Logs error:', err.message);
      return { success: false, error: err.message };
    }
  }

  async flushLogs(name) {
    try {
      await this.ensureConnected();
      await pm2.flush(name);
      return { success: true };
    } catch (err) {
      console.error('[PM2] Flush logs error:', err.message);
      return { success: false, error: err.message };
    }
  }

   async reloadDaemon() {
     try {
       await this.ensureConnected();
       await pm2.reload();
       return { success: true };
     } catch (err) {
       console.error('[PM2] Reload daemon error:', err.message);
       return { success: false, error: err.message };
     }
   }

   async ping() {
    try {
      await this.ensureConnected();
      return { success: true, status: 'connected' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async heal() {
    try {
      this.connected = false;
      await this.connect();
      return { success: true, status: 'healed' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async disconnect() {
    this.stopMonitoring();
    for (const [name, stream] of this.logStreams) {
      try { stream.destroy(); } catch (_) {}
    }
    this.logStreams.clear();
    this.connected = false;
  }
}

export const pm2Manager = new PM2Manager();
export default pm2Manager;