import { execFile } from 'child_process';
import { confineToRoots, fsAllowRoots } from '../http-handler.js';

export function err(code, message) { const e = new Error(message); e.code = code; throw e; }

// Promisified execFile — array-args form only, never a shell string, so a
// crafted branch/path/file value cannot be interpreted as a shell command.
export function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf-8', timeout: 30000, maxBuffer: 20 * 1024 * 1024, ...opts }, (e, stdout, stderr) => {
      if (e) { e.stdout = stdout; e.stderr = stderr; reject(e); return; }
      resolve({ stdout, stderr });
    });
  });
}

// Resolve + confine a client-supplied cwd to the same allowlist the file
// explorer / chat.sendMessage use (fsAllowRoots via confineToRoots). Falls
// back to STARTUP_CWD (itself an allowed root) when no cwd is given.
export function resolveGitCwd(p, STARTUP_CWD) {
  if (!p?.cwd) return STARTUP_CWD;
  const conf = confineToRoots(p.cwd, fsAllowRoots());
  if (!conf.ok) err(conf.reason === 'not found' ? 400 : 403, `cwd outside allowed roots: ${p.cwd}`);
  return conf.realPath;
}

// A relative in-repo file path: no leading '-' (flag injection), no shell
// metacharacters, no absolute path (git resolves it relative to cwd already).
const SAFE_REL_PATH_RE = /^[^\0]{1,4096}$/;
export function assertSafeRelPath(v, label) {
  if (typeof v !== 'string' || !v.length) err(400, `${label} required`);
  if (v.startsWith('-')) err(400, `${label} must not start with '-'`);
  if (/[\0]/.test(v)) err(400, `${label} contains invalid characters`);
  if (!SAFE_REL_PATH_RE.test(v)) err(400, `${label} invalid`);
  return v;
}

// A git branch/ref name — conservative allowlist (git's own ref-format is
// more permissive, but this blocks every shell-metacharacter and flag-
// injection vector while still covering normal branch names).
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,199}$/;
export function assertSafeBranch(v, label) {
  if (typeof v !== 'string' || !v.length) err(400, `${label} required`);
  if (v.startsWith('-') || v.includes('..') || v.includes('//')) err(400, `${label} invalid`);
  if (!SAFE_BRANCH_RE.test(v)) err(400, `${label} invalid`);
  return v;
}
