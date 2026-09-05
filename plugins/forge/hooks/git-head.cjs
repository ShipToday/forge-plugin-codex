/**
 * git-head.cjs — resolve the current HEAD sha without spawning git.
 *
 * Shared by two hooks that between them implement the git-milestone route to
 * observer eligibility (SHI-906 AC2):
 *
 *   - prompt-router.cjs (UserPromptSubmit) SEEDS `git_head_baseline` on the
 *     session's first prompt, BEFORE any work has happened.
 *   - stop-observer.cjs (Stop) COMPARES HEAD against that baseline after the
 *     turn, fires the nudge when it moved, and advances the baseline.
 *
 * The seed has to happen on the prompt side. Seeded at the first Stop — after
 * the turn's work — a commit made during turn 1 became the baseline itself
 * and was never seen, which is exactly the high-intent moment the milestone
 * exists to catch.
 *
 * WORKTREE-AWARE, and that is the whole difficulty. In a normal checkout
 * `.git` is a directory. In a worktree it is a FILE containing a `gitdir:`
 * pointer, the real HEAD lives at `<gitdir>/HEAD`, and the main repository's
 * own `.git/HEAD` names a DIFFERENT branch. Reading `.git/HEAD` naively
 * therefore returns the WRONG branch rather than nothing — it would compare
 * the developer's feature-branch work against `main` and either miss the
 * milestone or report a phantom one. A lot of agent work happens in
 * worktrees, so this is the common case, not an edge case.
 *
 * NO SUBPROCESS. This runs on every prompt and every Stop in every session,
 * which makes it the hottest path in the plugin; `git rev-parse` was rejected
 * on that ground alone. Everything here is a handful of bounded local file
 * reads.
 *
 * Every failure — not a repo, malformed pointer, dangling ref, unreadable
 * file — returns null. A milestone we cannot prove is not a milestone.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Where do this git dir's refs actually live?
 *
 * For a normal repo, in the git dir itself. For a WORKTREE, in the shared
 * git dir of the main checkout — the worktree's own dir holds only HEAD and
 * a few per-worktree files.
 *
 * Git answers this itself: it writes a `commondir` file inside every
 * worktree git dir, holding a path (usually the relative `../..`) to the
 * shared dir. Reading it is exact.
 *
 * The earlier version instead sniffed the gitdir path for
 * `${path.sep}worktrees${path.sep}`, which NEVER matched on Windows: git
 * writes the gitdir pointer with FORWARD slashes on every platform, while
 * `path.sep` there is a backslash. The check silently failed, refs resolved
 * against the worktree dir where they do not exist, and readHeadRef fell
 * through to returning the branch NAME as the baseline — so a later commit
 * compared equal and the milestone never fired. Silently, and only on
 * Windows worktrees. Hence: ask git, and keep a separator-agnostic regex
 * as the fallback rather than a separator-specific one.
 */
function resolveCommonDir(gitDir, fromPointer) {
  try {
    const commonDir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (commonDir) return path.resolve(gitDir, commonDir);
  } catch { /* not a worktree, or unreadable — fall through */ }
  // Only a git dir reached THROUGH a `.git` file can be a worktree dir. A
  // plain `.git` DIRECTORY is its own common dir however its path happens
  // to be spelled — a checkout living under a folder called `worktrees`
  // must not have its refs looked up two levels above the repo.
  if (!fromPointer) return gitDir;
  // Match either separator: the pointer git writes and the one the host
  // platform uses are not necessarily the same character.
  return /[\\/]worktrees[\\/]/.test(gitDir)
    ? path.resolve(gitDir, '..', '..')
    : gitDir;
}

/**
 * Find the nearest `.git` at or above `cwd`, the way git itself does.
 *
 * A session is very often started somewhere below the repository root —
 * `src/`, a package directory, a test folder. Checking only `cwd/.git` meant
 * the milestone never fired for any of those, silently: no error, just an
 * eligibility route that quietly did not exist. Git walks up to the
 * filesystem root, so this does too.
 *
 * STOPS AT THE HOME DIRECTORY, and that boundary is load-bearing. A `.git`
 * at exactly `~` is almost always a dotfiles repo, so without the stop a
 * session in any non-repo folder under home (`~/Documents/notes`, a temp
 * dir) walks up and adopts it — and then an unrelated dotfiles commit fires
 * the nudge for a session that has nothing to do with it. That is a WRONG
 * signal, not a missing one, which is the more expensive of the two: the
 * error-handling NFR ranks over-prompting above a missed offer. Projects
 * living under home are unaffected, because the walk stops AT `~` rather
 * than before reaching them.
 *
 * Otherwise bounded by construction — `path.dirname` reaches a fixed point
 * at the filesystem root (and at a drive root on Windows), which ends the
 * loop. MAX_DEPTH is a belt-and-braces stop so a pathological path can never
 * spin: this runs on every prompt and every Stop in every session.
 */
const MAX_GIT_WALK_DEPTH = 64;

// Path equality for the home stop. Windows paths are case-insensitive, and
// the two sides here come from different sources — `process.cwd()` keeps
// whatever drive-letter case the session was launched with, `os.homedir()`
// comes from USERPROFILE — so a byte compare can miss `c:\Users\me` against
// `C:\Users\me`, walk straight past home, and adopt `~/.git` after all.
function samePath(a, b) {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/**
 * Shape check for a symbolic ref read from HEAD, before it is used as a
 * path segment. Git's own rules are stricter than this; the point here is
 * only that nothing outside `<git dir>/refs/…` can be reached through it.
 */
function isSafeRefName(ref) {
  if (!/^refs\/[A-Za-z0-9._@+\-\/]+$/.test(ref)) return false;
  return ref.split('/').every((segment) => segment !== '' && segment !== '.' && !segment.includes('..'));
}

function findDotGit(startDir) {
  let home = null;
  try { home = path.resolve(os.homedir()); } catch { /* no home — rely on the root stop */ }
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < MAX_GIT_WALK_DEPTH; depth += 1) {
    // Reaching home means every real project directory has been checked
    // already. Stop before adopting a dotfiles repo as this session's repo.
    if (home && samePath(dir, home)) return null;
    const candidate = path.join(dir, '.git');
    try {
      return { dotGit: candidate, stat: fs.statSync(candidate) };
    } catch { /* not here — keep walking up */ }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the root
    dir = parent;
  }
  return null;
}

/**
 * The current HEAD sha for the repository containing `cwd`, the ref name
 * when the ref resolves to nothing (an unborn branch still distinguishes
 * one branch from another), or null when there is no repository to read.
 */
function readHeadRef(cwd) {
  try {
    const found = findDotGit(cwd);
    if (!found) return null;
    const { dotGit, stat } = found;

    // A worktree (or submodule): follow the gitdir: pointer to the real dir.
    let gitDir = dotGit;
    if (stat.isFile()) {
      const pointer = fs.readFileSync(dotGit, 'utf8').trim();
      if (!pointer.startsWith('gitdir:')) return null;
      const target = pointer.slice('gitdir:'.length).trim();
      if (!target) return null;
      // Git writes the pointer ABSOLUTE for worktrees and RELATIVE for
      // submodules (`gitdir: ../.git/modules/<name>`), relative to the
      // `.git` file itself. Resolve against that file's directory, never the
      // process cwd — after the walk-up the two can be several levels apart,
      // and a cwd-relative resolve lands on a path that does not exist.
      gitDir = path.resolve(path.dirname(dotGit), target);
    }

    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();

    // Detached HEAD: the file holds the sha directly.
    if (!head.startsWith('ref:')) return head || null;

    const ref = head.slice('ref:'.length).trim();
    if (!ref) return null;
    // The ref is joined into a filesystem path below, and HEAD is content
    // the repository controls. Refuse anything git itself would refuse —
    // `.`/`..` segments, names outside refs/, stray characters — rather than
    // read an arbitrary file's first line into the state file.
    if (!isSafeRefName(ref)) return null;

    // Loose ref. A worktree's refs live in the SHARED git dir, not its own,
    // so resolve against the common dir when this is a worktree.
    const commonDir = resolveCommonDir(gitDir, stat.isFile());
    try {
      const sha = fs.readFileSync(path.join(commonDir, ref), 'utf8').trim();
      if (sha) return sha;
    } catch { /* fall through to packed-refs */ }

    // Packed ref: a branch that has never been checked out loosely.
    try {
      const packed = fs.readFileSync(path.join(commonDir, 'packed-refs'), 'utf8');
      for (const line of packed.split('\n')) {
        const [sha, name] = line.trim().split(/\s+/);
        if (name === ref && sha) return sha;
      }
    } catch { /* no packed-refs */ }

    // A ref that resolves to nothing (e.g. an unborn branch) is not a
    // milestone, but the ref NAME still distinguishes one branch from
    // another, so it is a usable baseline on its own.
    return ref;
  } catch {
    return null;
  }
}

module.exports = { readHeadRef };
