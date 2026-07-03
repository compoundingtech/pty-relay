import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Vitest globalSetup/globalTeardown — reaps leaked pty daemons.
 *
 * Integration tests spawn detached pty daemons (that's how `pty attach`
 * survives a client crash by design). When vitest exits, any daemon still
 * running is reparented to init and its tmpdir + open ttys leak. Over days
 * of test runs this accumulates until the machine's ttys/socket ceiling is
 * hit and `posix_spawnp` starts failing everywhere.
 *
 * Fix: point TMPDIR at a per-run root under /tmp; at teardown, find every
 * pid holding a file or unix socket under that root and SIGTERM→SIGKILL
 * them, then rm the tree.
 *
 * Mirrors pty PR #52 (fix/vitest-globalTeardown-reap-daemons) — same file
 * layout, same env-var name (PTY_VITEST_RUN_ROOT), same TMPDIR-override
 * approach, same kill cascade — with one deliberate divergence: we union
 * `lsof +D` (regular files under root) with `lsof -U` (unix sockets whose
 * bound path is under root). `+D` on macOS doesn't index socket-name
 * entries in its directory walk, so a daemon that holds ONLY its listen
 * socket — which describes the pty daemon exactly — is invisible to
 * `+D` alone. See pty-relay commit message for the reproducer.
 *
 * `/tmp` (not `os.tmpdir()`) as the base: macOS resolves `os.tmpdir()` to
 * `/var/folders/<hash>/T/`, and nested socket paths exceed AF_UNIX's
 * 103-byte limit → `EINVAL: listen`. `/tmp/pv-XXXXXX` stays comfortably
 * under.
 */

let runRoot: string | undefined;

function shortBaseTmp(): string {
  return process.platform === "win32" ? os.tmpdir() : "/tmp";
}

export async function setup(): Promise<void> {
  runRoot = fs.mkdtempSync(path.join(shortBaseTmp(), `pv-`));
  process.env.PTY_VITEST_RUN_ROOT = runRoot;
  process.env.TMPDIR = runRoot;
  process.stderr.write(`[vitest-global] runRoot=${runRoot}\n`);
}

/** Collect pids from an lsof `-Fpn` stream whose `n` line starts under
 *  either the given root or its /private/-prefixed twin (macOS's real
 *  /tmp). Skips our own pid and pid 1. */
function collectPidsUnderRoot(lsofOut: string, root: string, into: Set<number>): void {
  const roots = [root + "/", `/private${root}/`];
  let currentPid: number | null = null;
  for (const line of lsofOut.split("\n")) {
    if (line.startsWith("p")) {
      const n = Number(line.slice(1));
      currentPid = Number.isFinite(n) ? n : null;
    } else if (line.startsWith("n") && currentPid !== null) {
      const name = line.slice(1);
      if (roots.some((r) => name.startsWith(r))) {
        if (currentPid !== process.pid && currentPid > 1) into.add(currentPid);
      }
    }
  }
}

export async function teardown(): Promise<void> {
  if (!runRoot) return;
  const root = runRoot;

  const pids = new Set<number>();

  // Regular files under root — daemon state / JSONL logs / etc.
  try {
    const out = execSync(`lsof -Fpn +D "${root}" 2>/dev/null || true`, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    // `+D` output has no `n` line for the daemon socket, but the `+D`
    // walk itself is scoped to root, so every `pN` block is a hit.
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) {
        const n = Number(line.slice(1));
        if (Number.isFinite(n) && n !== process.pid && n > 1) pids.add(n);
      }
    }
  } catch {
    // lsof may exit non-zero when no matches — treat as empty.
  }

  // Unix sockets whose bound path is under root — the pty daemon's
  // listen socket is often the ONLY file it keeps open, so `+D` above
  // misses it and we need this second sweep.
  try {
    const out = execSync(`lsof -Fpn -U 2>/dev/null || true`, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    collectPidsUnderRoot(out, root, pids);
  } catch {
    // ignore
  }

  const pidArr = Array.from(pids);
  if (pidArr.length > 0) {
    process.stderr.write(`[vitest-global] SIGTERM ${pidArr.length} leaked pids\n`);
    for (const pid of pidArr) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
    const survivors: number[] = [];
    for (const pid of pidArr) {
      try {
        process.kill(pid, 0);
        survivors.push(pid);
      } catch {
        // exited
      }
    }
    if (survivors.length > 0) {
      process.stderr.write(`[vitest-global] SIGKILL ${survivors.length} survivors\n`);
      for (const pid of survivors) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // gone between poll and kill
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // best-effort; something inside may still be busy briefly
  }
}
