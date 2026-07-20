// completions.test.ts — coverage for `pty-relay completions <shell>`.
//
// Two layers: the generated-script surface (imported directly from
// src/completions.ts, which is side-effect free) and the CLI dispatch path
// (spawned, like test/cli.test.ts, because importing src/cli.ts runs main()).

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

import {
  COMMANDS,
  SHELLS,
  bashScript,
  fishScript,
  zshScript,
} from "../src/completions.ts";

const CLI_ENTRY = path.resolve(import.meta.dirname, "../src/cli.ts");

function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("node", [CLI_ENTRY, ...args], {
    encoding: "utf-8",
    timeout: 10000,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PTY_SESSION_DIR: path.join(os.tmpdir(), `pty-relay-completions-${Date.now()}`),
    },
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

/** True when `bin` is on PATH — the shell syntax checks are opt-in on it. */
function hasBinary(bin: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
}

describe("pty-relay completions — dispatch", () => {
  it.each(SHELLS)("%s → non-empty script, exit 0", (shell) => {
    const { stdout, exitCode } = runCli(["completions", shell]);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(100);
  });

  it("missing shell → usage on stderr, exit 2", () => {
    const { stdout, stderr, exitCode } = runCli(["completions"]);
    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("usage: pty-relay completions");
  });

  it("unknown shell → usage on stderr, exit 2", () => {
    const { stderr, exitCode } = runCli(["completions", "powershell"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("unknown shell: powershell");
    expect(stderr).toContain("usage: pty-relay completions");
  });

  it("--help → its own usage on stdout, exit 0", () => {
    const { stdout, exitCode } = runCli(["completions", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("usage: pty-relay completions");
  });

  it("top-level usage advertises the completions subcommand", () => {
    const { stdout } = runCli(["notacommand"]);
    expect(stdout).toContain("completions <shell>");
  });
});

describe("pty-relay completions — spec covers real dispatch", () => {
  const names = new Set(COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));

  // Every `case` label in cli.ts's top-level switch that a user can type.
  it.each([
    "connect",
    "exec",
    "rsync",
    "list",
    "ls",
    "peers",
    "peek",
    "send",
    "kill",
    "events",
    "tag",
    "rename",
    "add",
    "forget",
    "clients",
    "set-name",
    "init",
    "reset",
    "help",
    "version",
    "doctor",
    "server",
    "client",
    "local",
    "psk-gen",
    "completions",
  ])("spec has an entry for `%s`", (cmd) => {
    expect(names.has(cmd)).toBe(true);
  });

  it("groups carry the verbs their dispatchers accept", () => {
    const verbsOf = (name: string) =>
      new Set(
        COMMANDS.find((c) => c.name === name)?.verbs?.flatMap((v) => [
          v.name,
          ...(v.aliases ?? []),
        ]) ?? []
      );

    for (const v of ["signin", "mint", "start", "status", "hosts", "totp", "rotate",
                     "revoke", "add-email", "delete-account", "reset"]) {
      expect(verbsOf("server")).toContain(v);
    }
    for (const v of ["start", "status", "reset"]) {
      expect(verbsOf("local")).toContain(v);
    }
    for (const v of ["list", "approve", "revoke", "invite"]) {
      expect(verbsOf("clients")).toContain(v);
    }
    // CLIENT_PASSTHROUGH_COMMANDS plus the two client-only verbs.
    for (const v of ["signin", "join", "ls", "peers", "connect", "peek", "send",
                     "tag", "events", "rename", "forget"]) {
      expect(verbsOf("client")).toContain(v);
    }
  });
});

describe("pty-relay completions fish — surface", () => {
  const script = fishScript();

  it("offers every top-level subcommand", () => {
    for (const c of COMMANDS) {
      expect(script).toContain(`-a ${c.name} -d`);
    }
  });

  it("binds the backend enum to `init --backend`", () => {
    expect(script).toContain("-l backend -x -a 'keychain passphrase'");
  });

  it("binds the role enum to `server rotate --role`", () => {
    expect(script).toContain("-l role -x -a 'daemon client'");
  });

  it("guards colliding verbs on both the verb and its group", () => {
    // `start` exists under both `local` and `server`.
    expect(script).toContain(
      "__fish_seen_subcommand_from start; and __fish_seen_subcommand_from local"
    );
    expect(script).toContain(
      "__fish_seen_subcommand_from start; and __fish_seen_subcommand_from server"
    );
  });
});

describe("pty-relay completions — generated scripts are syntactically valid", () => {
  it.runIf(hasBinary("bash"))("bash -n accepts the bash script", () => {
    const r = spawnSync("bash", ["-n"], { input: bashScript(), encoding: "utf-8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it.runIf(hasBinary("fish"))("fish -n accepts the fish script", () => {
    const r = spawnSync("fish", ["-n"], { input: fishScript(), encoding: "utf-8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it.runIf(hasBinary("zsh"))("zsh -n accepts the zsh script", () => {
    const r = spawnSync("zsh", ["-n"], { input: zshScript(), encoding: "utf-8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});
