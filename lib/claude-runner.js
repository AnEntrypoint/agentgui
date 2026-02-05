import { spawn } from 'child_process';

export async function runClaudeWithStreaming(prompt, cwd, agentId = 'claude-code') {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [
      '--print',
      '--verbose',
      '--output-format=stream-json'
    ], { cwd });
    let jsonBuffer = '';
    const outputs = [];
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill();
      reject(new Error(`Claude CLI timeout after 5 minutes for agent ${agentId}`));
    }, 300000);

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
      clearTimeout(timeout);
      if (timedOut) return;

      if (code === 0) {
        if (jsonBuffer.trim()) {
          try {
            outputs.push(JSON.parse(jsonBuffer));
          } catch (e) {
            console.error(`[claude-runner] Final JSON parse error: ${jsonBuffer.substring(0, 100)}`);
          }
        }
        resolve(outputs);
      } else {
        reject(new Error(`Claude CLI exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

export default runClaudeWithStreaming;
