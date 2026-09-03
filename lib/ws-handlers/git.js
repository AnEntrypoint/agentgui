import os from 'os';
import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import { err, execFileP, resolveGitCwd, assertSafeRelPath, assertSafeBranch } from './shared.js';

export function register(router, deps) {
  const { STARTUP_CWD } = deps;

  router.handle('clone', (p) => {
    const repo = (p.repo || '').trim();
    if (!repo || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
      err(400, 'Invalid repo format. Use org/repo or user/repo');
    }
    const cloneDir = STARTUP_CWD || os.homedir();
    const repoName = repo.split('/')[1];
    const targetPath = path.join(cloneDir, repoName);
    if (fs.existsSync(targetPath)) err(409, `Directory already exists: ${repoName}`);
    try {
      execFileSync('git', ['clone', 'https://github.com/' + repo + '.git'], {
        cwd: cloneDir, encoding: 'utf-8', timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return { ok: true, repo, path: targetPath, name: repoName };
    } catch (e) { err(500, (e.stderr || e.message || 'Clone failed').trim()); }
  });

  router.handle('git.check', () => {
    try {
      const isWindows = os.platform() === 'win32';
      const devnull = isWindows ? '' : ' 2>/dev/null';
      const remoteUrl = execSync('git remote get-url origin' + devnull, { encoding: 'utf-8', cwd: STARTUP_CWD, shell: isWindows }).trim();
      const statusResult = execSync('git status --porcelain' + devnull, { encoding: 'utf-8', cwd: STARTUP_CWD, shell: isWindows });
      const hasChanges = statusResult.trim().length > 0;
      const unpushedResult = execSync('git rev-list --count --not --remotes' + devnull, { encoding: 'utf-8', cwd: STARTUP_CWD, shell: isWindows });
      const hasUnpushed = parseInt(unpushedResult.trim() || '0', 10) > 0;
      const githubUser = process.env.GITHUB_USER;
      const ownsRemote = !remoteUrl.includes('github.com/') || (!!githubUser && remoteUrl.includes(githubUser));
      return { ownsRemote, hasChanges, hasUnpushed, remoteUrl };
    } catch {
      return { ownsRemote: false, hasChanges: false, hasUnpushed: false, remoteUrl: '' };
    }
  });

  router.handle('git.push', (p) => {
    if (!p?.confirm) err(400, 'confirm required: git.push commits and pushes the entire working tree');
    try {
      const isWindows = os.platform() === 'win32';
      const cmd = isWindows
        ? 'git add -A & git commit -m "Auto-commit" & git push'
        : 'git add -A && git commit -m "Auto-commit" && git push';
      execSync(cmd, { encoding: 'utf-8', cwd: STARTUP_CWD, shell: isWindows });
      return { success: true };
    } catch (e) { err(500, e.message); }
  });

  // --- git.status: changed-file list (staged/unstaged/untracked) for
  // GitStatusPanel. Porcelain=v1 line format "XY PATH" (rename: "XY OLD -> NEW"),
  // X = index state, Y = worktree state, '?'/' ' = untouched/untracked.
  router.handle('git.status', async (p) => {
    const cwd = resolveGitCwd(p, STARTUP_CWD);
    try {
      const { stdout } = await execFileP('git', ['status', '--porcelain=v1'], { cwd });
      const files = [];
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const x = line[0], y = line[1];
        const filePath = line.slice(3);
        if (x === '?' && y === '?') { files.push({ path: filePath, status: '?' }); continue; }
        if (x !== ' ' && x !== '?') files.push({ path: filePath, status: x, staged: true });
        else if (y !== ' ' && y !== '?') files.push({ path: filePath, status: y, staged: false });
      }
      return { files };
    } catch (e) { err(500, (e.stderr || e.message || 'git status failed').trim()); }
  });

  // --- git.diff: unified diff for a single file or the whole working tree.
  // p.cwd (optional) is confined via confineToRoots/fsAllowRoots, same as
  // chat.sendMessage; p.file (optional) is validated to reject flags/shell
  // metacharacters. execFile array-args form only, never a shell string.
  router.handle('git.diff', async (p) => {
    const cwd = resolveGitCwd(p, STARTUP_CWD);
    const args = ['diff', '--no-color'];
    if (p?.staged) args.push('--staged');
    if (p?.file) args.push('--', assertSafeRelPath(p.file, 'file'));
    try {
      const { stdout } = await execFileP('git', args, { cwd });
      // git prints "Binary files a/x and b/x differ" for binary paths instead
      // of a unified diff - an empty `diff` string then reads to the client as
      // "no diff to show" with no explanation. Detect it so the UI can say why.
      const binary = /^Binary files .* differ$/m.test(stdout);
      return { diff: stdout, binary, file: p?.file || null, staged: !!p?.staged };
    } catch (e) { err(500, (e.stderr || e.message || 'git diff failed').trim()); }
  });

  // --- git.log: recent commit list, limit param (default 20, capped 200).
  router.handle('git.log', async (p) => {
    const cwd = resolveGitCwd(p, STARTUP_CWD);
    const limit = Math.max(1, Math.min(200, parseInt(p?.limit, 10) || 20));
    const FIELD_SEP = '\x1f';
    const REC_SEP = '\x1e';
    const args = ['log', `-n${limit}`, `--pretty=format:%H${FIELD_SEP}%an${FIELD_SEP}%ad${FIELD_SEP}%s${REC_SEP}`, '--date=iso-strict'];
    try {
      const { stdout } = await execFileP('git', args, { cwd });
      const commits = stdout.split(REC_SEP).map(s => s.trim()).filter(Boolean).map(rec => {
        const [hash, author, date, ...rest] = rec.split(FIELD_SEP);
        return { hash, author, date, subject: rest.join(FIELD_SEP) };
      });
      return { commits };
    } catch (e) { err(500, (e.stderr || e.message || 'git log failed').trim()); }
  });

  // --- worktree.list / create / remove ---
  router.handle('worktree.list', async (p) => {
    const cwd = resolveGitCwd(p, STARTUP_CWD);
    try {
      const { stdout } = await execFileP('git', ['worktree', 'list', '--porcelain'], { cwd });
      // Parse the porcelain block format: records separated by blank lines,
      // each line "key value" or a bare flag ("bare", "detached", "locked").
      const worktrees = [];
      let cur = null;
      for (const line of stdout.split('\n')) {
        if (!line.trim()) { if (cur) { worktrees.push(cur); cur = null; } continue; }
        if (!cur) cur = {};
        const sp = line.indexOf(' ');
        if (sp === -1) { cur[line] = true; continue; }
        cur[line.slice(0, sp)] = line.slice(sp + 1);
      }
      if (cur) worktrees.push(cur);
      return { worktrees: worktrees.map(w => ({ path: w.worktree || null, head: w.HEAD || null, branch: w.branch || null, bare: !!w.bare, detached: !!w.detached, locked: !!w.locked })) };
    } catch (e) { err(500, (e.stderr || e.message || 'git worktree list failed').trim()); }
  });

  router.handle('worktree.create', async (p) => {
    const cwd = resolveGitCwd(p, STARTUP_CWD);
    const wtPath = assertSafeRelPath(p?.path, 'path');
    const args = ['worktree', 'add'];
    if (p?.newBranch) { args.push('-b', assertSafeBranch(p.newBranch, 'newBranch')); }
    args.push(wtPath);
    if (p?.branch) args.push(assertSafeBranch(p.branch, 'branch'));
    try {
      const { stdout, stderr } = await execFileP('git', args, { cwd });
      return { ok: true, output: (stdout || stderr || '').trim(), path: wtPath };
    } catch (e) { err(500, (e.stderr || e.message || 'git worktree add failed').trim()); }
  });

  router.handle('worktree.remove', async (p) => {
    const cwd = resolveGitCwd(p, STARTUP_CWD);
    const wtPath = assertSafeRelPath(p?.path, 'path');
    const args = ['worktree', 'remove'];
    if (p?.force) args.push('--force');
    args.push(wtPath);
    try {
      const { stdout, stderr } = await execFileP('git', args, { cwd });
      return { ok: true, output: (stdout || stderr || '').trim() };
    } catch (e) { err(500, (e.stderr || e.message || 'git worktree remove failed').trim()); }
  });
}
