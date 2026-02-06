import { spawn } from 'child_process';

export async function runClaudeWithStreaming(prompt, cwd, agentId = 'claude-code', config = {}) {
  return new Promise((resolve, reject) => {
    const {
      verbose = true,
      outputFormat = 'stream-json',
      timeout = 300000,
      print = true,
      resumeSessionId = null,
      systemPrompt = null,
      onEvent = null
    } = config;

    const flags = [];
    if (print) flags.push('--print');
    if (verbose) flags.push('--verbose');
    flags.push(`--output-format=${outputFormat}`);
    flags.push('--dangerously-skip-permissions');
    if (resumeSessionId) flags.push('--resume', resumeSessionId);
    if (systemPrompt) flags.push('--append-system-prompt', systemPrompt);

    const proc = spawn('claude', flags, { cwd });
    let jsonBuffer = '';
    const outputs = [];
    let timedOut = false;
    let sessionId = null;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill();
      reject(new Error(`Claude CLI timeout after ${timeout}ms for agent ${agentId}`));
    }, timeout);

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', (chunk) => {
      if (timedOut) return;

      jsonBuffer += chunk.toString();
      const lines = jsonBuffer.split('\n');
      jsonBuffer = lines.pop();

      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            outputs.push(parsed);

            if (parsed.session_id) {
              sessionId = parsed.session_id;
            }

            if (onEvent) {
              try { onEvent(parsed); } catch (e) {
                console.error(`[claude-runner] onEvent error: ${e.message}`);
              }
            }
          } catch (e) {
            console.error(`[claude-runner] JSON parse error on line: ${line.substring(0, 100)}`);
          }
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      console.error(`[claude-runner] stderr: ${chunk.toString()}`);
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (timedOut) return;

      if (code === 0) {
        if (jsonBuffer.trim()) {
          try {
            const parsed = JSON.parse(jsonBuffer);
            outputs.push(parsed);
            if (parsed.session_id) sessionId = parsed.session_id;
            if (onEvent) {
              try { onEvent(parsed); } catch (e) {}
            }
          } catch (e) {
            console.error(`[claude-runner] Final JSON parse error: ${jsonBuffer.substring(0, 100)}`);
          }
        }
        resolve({ outputs, sessionId });
      } else {
        reject(new Error(`Claude CLI exited with code ${code} for agent ${agentId}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(err);
    });
  });
}

export default runClaudeWithStreaming;
