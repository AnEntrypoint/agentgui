import { spawn } from 'child_process';
import { AgentRunner, getSpawnOptions, resolveBinaryPath } from './claude-runner.js';

AgentRunner.prototype.runDirect = function(prompt, cwd, config = {}) {
  return new Promise((resolve, reject) => {
    const { timeout = 300000, onEvent = null, onError = null, onRateLimit = null } = config;
    const args = this.buildArgs(prompt, config);
    // The direct runner passes the untrusted user prompt as an argv element.
    // Spawn with shell:false against a resolved binary so the prompt cannot be
    // interpreted by a shell (shell:true would let "& cmd" inject). If the
    // binary resolves to a .cmd/.bat shim, resolveBinaryPath returns the name
    // unchanged and we fall back to the shell (npx-style fallback launchers).
    const binary = resolveBinaryPath(this.command);
    const spawnOpts = getSpawnOptions(cwd, { shell: false });
    if (Object.keys(this.spawnEnv).length > 0) spawnOpts.env = { ...spawnOpts.env, ...this.spawnEnv };
    if (this.closeStdin) spawnOpts.stdio = ['ignore', 'pipe', 'pipe'];
    const proc = spawn(binary, args, spawnOpts);
    console.log(`[${this.id}] Spawned PID ${proc.pid} closeStdin=${this.closeStdin}`);

    if (config.onPid) { try { config.onPid(proc.pid); } catch (e) { console.error(`[${this.id}] onPid callback failed:`, e.message); } }
    if (config.onProcess) { try { config.onProcess(proc); } catch (e) { console.error(`[${this.id}] onProcess callback failed:`, e.message); } }

    let jsonBuffer = '';
    const outputs = [];
    let timedOut = false;
    let sessionId = null;
    let rateLimited = false;
    let retryAfterSec = 60;
    let authError = false;
    let authErrorMessage = '';

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill();
      reject(new Error(`${this.name} timeout after ${timeout}ms`));
    }, timeout);

    if (this.supportsStdin) proc.stdin.write(prompt);

    proc.stdout.on('error', () => {});
    if (proc.stderr) proc.stderr.on('error', () => {});
    proc.stdout.on('data', (chunk) => {
      if (timedOut) return;
      jsonBuffer += chunk.toString();
      const lines = jsonBuffer.split('\n');
      jsonBuffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          const parsed = this.parseOutput(line);
          if (!parsed) continue;
          outputs.push(parsed);
          if (parsed.session_id) sessionId = parsed.session_id;
          if (onEvent) { try { onEvent(parsed); } catch (e) { console.error(`[${this.id}] onEvent error: ${e.message}`); } }
        }
      }
    });

    if (proc.stderr) proc.stderr.on('data', (chunk) => {
      const errorText = chunk.toString();
      console.error(`[${this.id}] stderr:`, errorText);
      if (/401|unauthorized|invalid.*auth|invalid.*token|auth.*failed|permission denied|access denied/i.test(errorText)) {
        authError = true;
        authErrorMessage = errorText.trim();
      }
      const rateLimitMatch = errorText.match(/rate.?limit|429|too many requests|overloaded|throttl|hit your limit/i);
      if (rateLimitMatch) {
        rateLimited = true;
        const retryMatch = errorText.match(/retry.?after[:\s]+(\d+)/i);
        if (retryMatch) {
          retryAfterSec = parseInt(retryMatch[1], 10) || 60;
        } else {
          const resetTimeMatch = errorText.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?(UTC|[A-Z]{2,4})\)?/i);
          if (resetTimeMatch) {
            let hours = parseInt(resetTimeMatch[1], 10);
            const minutes = resetTimeMatch[2] ? parseInt(resetTimeMatch[2], 10) : 0;
            const period = resetTimeMatch[3]?.toLowerCase();
            if (period === 'pm' && hours !== 12) hours += 12;
            if (period === 'am' && hours === 12) hours = 0;
            const now = new Date();
            const resetTime = new Date(now);
            resetTime.setUTCHours(hours, minutes, 0, 0);
            if (resetTime <= now) resetTime.setUTCDate(resetTime.getUTCDate() + 1);
            retryAfterSec = Math.max(60, Math.ceil((resetTime.getTime() - now.getTime()) / 1000));
          }
        }
      }
      if (onError) { try { onError(errorText); } catch (e) {} }
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (timedOut) return;
      if (authError) {
        const err = new Error(`Authentication failed: ${authErrorMessage || 'Invalid credentials or unauthorized access'}`);
        err.authError = true;
        err.nonRetryable = true;
        reject(err);
        return;
      }
      if (rateLimited) {
        const err = new Error(`Rate limited - retry after ${retryAfterSec}s`);
        err.rateLimited = true;
        err.retryAfterSec = retryAfterSec;
        if (onRateLimit) { try { onRateLimit({ retryAfterSec }); } catch (e) {} }
        reject(err);
        return;
      }
      if (jsonBuffer.trim()) {
        const parsed = this.parseOutput(jsonBuffer);
        if (parsed) {
          outputs.push(parsed);
          if (parsed.session_id) sessionId = parsed.session_id;
          if (onEvent) { try { onEvent(parsed); } catch (e) {} }
        }
      }
      if (code === 0 || outputs.length > 0) resolve({ outputs, sessionId });
      else reject(new Error(`${this.name} exited with code ${code}`));
    });

    proc.on('error', (err) => { clearTimeout(timeoutHandle); reject(err); });
  });
};
