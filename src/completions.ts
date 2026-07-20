// completions.ts — print shell completion scripts for `pty-relay`.
//
// pty-relay dispatches subcommands via hand-written `switch` statements in
// cli.ts and its `--help` output is prose, so there is no machine-readable
// command table to derive completions from. Instead this module owns a small
// declarative spec of the command tree (groups → verbs → flags, plus
// enum-valued flags and positionals) and generates fish / bash / zsh from
// that ONE spec, so the three scripts can't drift apart.
//
// This mirrors `pty completions` (src/completions.ts) and `st completions`
// (src/commands/completions.ts) so the three sibling CLIs stay consistent.
// pty-relay's shape differs from pty's flat surface in one way: it has
// namespaced groups (`server`, `client`, `local`, `clients`) that dispatch
// their own verbs, so the spec carries `verbs` like `st`'s does.
//
// Deliberately NOT dynamic: pty completes live session names off disk, but
// pty-relay's peers live in the encrypted secret store (the plaintext
// ~/.config/pty-relay/peers file is optional and usually absent), so there is
// no cheap, reliable source for host-label completion at completion time.
//
// This module must stay free of top-level side effects — cli.ts runs `main()`
// on import, so tests import THIS file, not cli.ts. It also runs under Node's
// --experimental-strip-types, so keep to type annotations and `as const`.
//
// Keep the spec in sync with the `switch` dispatch in cli.ts.

// ─── Spec ──────────────────────────────────────────────────────────────────

/** A `--flag`. `values` (when present) is the closed set of completions for
 *  the flag's argument; absence means a boolean flag or a free-form value. */
interface FlagSpec {
  readonly name: string;
  readonly desc: string;
  /** Short spelling, e.g. `d` for `--detach`. */
  readonly short?: string;
  readonly values?: readonly string[];
}

/** A command node: a top-level subcommand, a group, or a verb under a group. */
interface CommandSpec {
  readonly name: string;
  readonly desc: string;
  /** Aliases for the command name (e.g. `ls` for `list`). */
  readonly aliases?: readonly string[];
  /** Nested verbs (e.g. `signin` under `server`). */
  readonly verbs?: readonly CommandSpec[];
  /** Flags accepted directly by this command/verb. */
  readonly flags?: readonly FlagSpec[];
  /** A closed set of values for a positional argument (e.g. `show|code` in
   *  `server totp <show|code>`). */
  readonly positionalValues?: readonly string[];
  /** Offer file/path completion for a positional (e.g. `rsync <src> <dst>`). */
  readonly takesPath?: boolean;
}

/** Storage backends accepted by `init --backend`. */
const BACKEND_VALUES = ["keychain", "passphrase"] as const;

/** Key roles accepted by `server rotate --role`. */
const ROLE_VALUES = ["daemon", "client"] as const;

const SHELL_VALUES = ["bash", "fish", "zsh"] as const;

const JSON_FLAG: FlagSpec = { name: "json", desc: "Emit JSON" };
const FORCE_FLAG: FlagSpec = { name: "force", desc: "Skip confirmation" };
const YES_FLAG: FlagSpec = { name: "yes", short: "y", desc: "Skip the y/N prompt" };
const CONFIG_DIR_FLAG: FlagSpec = { name: "config-dir", desc: "Config directory" };
const PASSPHRASE_FILE_FLAG: FlagSpec = {
  name: "passphrase-file",
  desc: "Read passphrase from file (non-interactive)",
};
const RELAY_FLAG: FlagSpec = { name: "relay", desc: "Relay origin URL" };
const LABEL_FLAG: FlagSpec = { name: "label", desc: "Label for this device" };
const DETACH_FLAG: FlagSpec = {
  name: "detach",
  short: "d",
  desc: "Run detached in a 'pty' session",
};
const NAME_FLAG: FlagSpec = { name: "name", desc: "Name for the wrapped pty session" };

/**
 * Flags every command accepts because they're parsed off the full argv in
 * cli.ts rather than per-command. Appended to each node so `--config-dir`
 * completes wherever it is actually honored.
 */
const COMMON_FLAGS: readonly FlagSpec[] = [CONFIG_DIR_FLAG, PASSPHRASE_FILE_FLAG];

/**
 * Flags accepted before the subcommand. `--verbose` is stripped from argv
 * before positional parsing, so it is genuinely position-independent.
 */
const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "verbose", desc: "Print timing + internal state to stderr" },
  CONFIG_DIR_FLAG,
  PASSPHRASE_FILE_FLAG,
  { name: "psk-file", desc: "Load a 32-byte PSK from <path>" },
  { name: "help", short: "h", desc: "Show usage" },
  { name: "version", short: "v", desc: "Print the pty-relay version" },
];

/**
 * The pty-relay command tree. Keep in sync with the `switch` dispatch in
 * src/cli.ts (`main`, `dispatchServer`, `dispatchClient`, `dispatchLocal`).
 */
const COMMANDS: readonly CommandSpec[] = [
  {
    name: "init",
    desc: "Initialize secret storage (first-time setup)",
    flags: [{ name: "backend", desc: "Storage backend", values: BACKEND_VALUES }, FORCE_FLAG],
  },
  {
    name: "reset",
    desc: "Delete all saved credentials (start over)",
    flags: [FORCE_FLAG],
  },
  {
    name: "peers",
    desc: "List known peers (terse — no session fanout)",
    flags: [JSON_FLAG],
  },
  {
    name: "list",
    aliases: ["ls"],
    desc: "List known peers and their sessions (fans out)",
    flags: [JSON_FLAG, { name: "filter-tag", desc: "Filter sessions by k=v (repeatable)" }],
  },
  {
    name: "peek",
    desc: "Print the current screen of a remote session",
    flags: [
      { name: "plain", desc: "Plain text (no ANSI)" },
      { name: "full", desc: "Include full scrollback" },
      { name: "wait", desc: "Poll until text appears (repeatable)" },
      { name: "timeout", short: "t", desc: "Timeout (seconds) for --wait" },
    ],
  },
  {
    name: "send",
    desc: "Send text or key events to a remote session",
    flags: [
      { name: "seq", desc: "Ordered chunk / key event (repeatable)" },
      { name: "with-delay", desc: "Delay between --seq items (seconds)" },
      { name: "paste", desc: "Wrap payload in bracketed-paste markers" },
    ],
  },
  {
    name: "kill",
    desc: "Terminate a session on a remote ssh:// peer",
  },
  {
    name: "tag",
    desc: "Show / set / remove tags on a remote session",
    flags: [{ name: "rm", desc: "Remove tag key (repeatable)" }, JSON_FLAG],
  },
  {
    name: "events",
    desc: "Follow events from a remote daemon",
    flags: [{ name: "session", desc: "Filter to a single session" }, JSON_FLAG],
  },
  {
    name: "rename",
    desc: "Rename a saved peer",
  },
  {
    name: "forget",
    desc: "Remove a saved peer",
  },
  {
    name: "add",
    desc: "Add an ssh-reachable peer",
    flags: [LABEL_FLAG],
  },
  {
    name: "connect",
    desc: "Connect to a remote pty session (or list sessions)",
    flags: [
      { name: "spawn", desc: "Spawn a new remote session" },
      { name: "cwd", desc: "Working directory for the spawned session" },
      { name: "session", desc: "Attach a named session" },
      { name: "tag", desc: "Tag the spawned session (k=v, repeatable)" },
      { name: "psk-file", desc: "Opt into Noise_NKpsk2 with the PSK in <path>" },
    ],
  },
  {
    name: "exec",
    desc: "Run a non-PTY command on a remote daemon",
  },
  {
    name: "rsync",
    desc: "Run rsync over an exec channel",
    takesPath: true,
  },
  {
    name: "local",
    desc: "Run a self-hosted relay on this machine",
    verbs: [
      {
        name: "start",
        desc: "Run a self-hosted relay (default port: 8099)",
        flags: [
          { name: "port", desc: "Listen port (default 8099)" },
          { name: "bind", desc: "Bind address" },
          { name: "tailscale", desc: "Enable Tailscale HTTPS via 'tailscale serve'" },
          { name: "auto-approve", desc: "Skip the per-client approval TUI" },
          { name: "psk-file", desc: "Require Noise_NKpsk2 using the PSK in <path>" },
          { name: "allow-new-sessions", desc: "Let remote clients spawn new pty sessions" },
          {
            name: "skip-allow-new-sessions-confirmation",
            desc: "Don't prompt before enabling remote spawn",
          },
          { name: "allow-exec", desc: "Let remote clients spawn non-PTY processes" },
          {
            name: "skip-allow-exec-confirmation",
            desc: "Don't prompt before enabling --allow-exec",
          },
          { name: "latency-stats", desc: "Enable web-UI latency telemetry" },
          { name: "mosh", desc: "(BETA) Predictive local echo in the web UI" },
          { name: "skip-osc8-confirm", desc: "Open OSC 8 links without confirming" },
          DETACH_FLAG,
          NAME_FLAG,
        ],
      },
      {
        name: "status",
        desc: "Show daemon pid, label, pubkey, approved-client count",
        flags: [
          { name: "show-token", desc: "Also print the token URL" },
          { name: "port", desc: "Probe the given port for liveness" },
          JSON_FLAG,
        ],
      },
      {
        name: "reset",
        desc: "Wipe just self-hosted daemon state",
        flags: [FORCE_FLAG],
      },
    ],
  },
  {
    name: "server",
    desc: "Public-relay account management",
    flags: [RELAY_FLAG],
    verbs: [
      {
        name: "signin",
        desc: "Register this daemon on a public relay",
        flags: [{ name: "email", desc: "Account email address" }, LABEL_FLAG, RELAY_FLAG],
      },
      {
        name: "mint",
        desc: "Mint a one-time preauth to invite a device",
        flags: [
          { name: "ttl-seconds", desc: "Preauth lifetime in seconds" },
          { name: "totp-code", desc: "Non-interactive TOTP code" },
        ],
      },
      {
        name: "start",
        desc: "Run the daemon attached to a public relay",
        flags: [
          { name: "allow-new-sessions", desc: "Let remote clients spawn new pty sessions" },
          DETACH_FLAG,
          NAME_FLAG,
        ],
      },
      {
        name: "status",
        desc: "Show this device's enrollment info",
        flags: [JSON_FLAG],
      },
      {
        name: "hosts",
        desc: "List registered keys on this account",
        flags: [{ name: "merge", desc: "Add peer daemons to known_hosts" }, JSON_FLAG],
      },
      {
        name: "totp",
        desc: "Show the TOTP secret / current code",
        positionalValues: ["show", "code"],
      },
      {
        name: "rotate",
        desc: "Two-step Ed25519 key rotation (per role)",
        flags: [
          { name: "role", desc: "Key role to rotate", values: ROLE_VALUES },
          { name: "complete", desc: "Complete a started rotation" },
        ],
      },
      {
        name: "revoke",
        desc: "Revoke a peer device's key",
        flags: [{ name: "force", desc: "Allow revoking THIS device's key" }, YES_FLAG],
      },
      {
        name: "add-email",
        desc: "Add a secondary email to the account",
        flags: [
          { name: "email", desc: "Email address to add" },
          { name: "email-code", desc: "Non-interactive verification code" },
        ],
      },
      {
        name: "delete-account",
        desc: "Permanently delete the account",
        flags: [YES_FLAG],
      },
      {
        name: "reset",
        desc: "Request an account-key reset email",
        flags: [{ name: "email", desc: "Account email address" }, RELAY_FLAG],
      },
    ],
  },
  {
    name: "client",
    desc: "Use sessions exposed by daemons (public or self-hosted)",
    flags: [RELAY_FLAG],
    verbs: [
      {
        name: "signin",
        desc: "Register this device as an account-wide client",
        flags: [{ name: "email", desc: "Account email address" }, LABEL_FLAG, RELAY_FLAG],
      },
      {
        name: "join",
        desc: "Claim a one-time preauth URL",
        flags: [LABEL_FLAG, { name: "totp-code", desc: "Non-interactive TOTP code" }],
      },
      // The rest are CLIENT_PASSTHROUGH_COMMANDS in cli.ts: `client <x>`
      // strips the group and re-dispatches to the top-level handler, so the
      // full top-level flag surface applies. Descriptions are kept terse
      // here; the canonical spec lives on the top-level entry.
      { name: "peers", desc: "List known peers (terse)" },
      { name: "list", aliases: ["ls"], desc: "List known peers and their sessions" },
      { name: "connect", desc: "Attach to a remote pty session" },
      { name: "peek", desc: "Print a remote session's screen" },
      { name: "send", desc: "Send input to a remote session" },
      { name: "tag", desc: "Show / set tags on a remote session" },
      { name: "events", desc: "Follow events from a remote daemon" },
      { name: "rename", desc: "Rename a saved known-host entry" },
      { name: "forget", desc: "Remove a saved host" },
    ],
  },
  {
    name: "clients",
    desc: "Interactive client approval TUI",
    verbs: [
      { name: "list", desc: "List client tokens", flags: [JSON_FLAG] },
      { name: "approve", desc: "Approve a pending client" },
      { name: "revoke", desc: "Revoke a client token", flags: [YES_FLAG] },
      { name: "invite", desc: "Generate a pre-approved invite URL", flags: [LABEL_FLAG] },
    ],
    flags: [JSON_FLAG],
  },
  {
    name: "set-name",
    desc: "Set a custom name for this daemon",
  },
  {
    name: "doctor",
    desc: "Print environment info for troubleshooting",
  },
  {
    name: "psk-gen",
    desc: "Print a fresh 32-byte PSK to stdout",
  },
  {
    name: "version",
    desc: "Print the pty-relay version",
  },
  {
    name: "help",
    desc: "Show usage",
  },
  {
    name: "completions",
    desc: "Print a shell completion script",
    positionalValues: SHELL_VALUES,
  },
];

/** Every spelling (name + aliases) of a node. */
const spellings = (c: CommandSpec): readonly string[] => [c.name, ...(c.aliases ?? [])];

/** Every spelling of every top-level subcommand. */
const allCommandNames = (): readonly string[] => COMMANDS.flatMap(spellings);

/** A node's own flags plus the argv-wide ones cli.ts honors everywhere. */
const flagsOf = (c: CommandSpec): readonly FlagSpec[] => {
  const own = c.flags ?? [];
  const ownNames = new Set(own.map((f) => f.name));
  return [...own, ...COMMON_FLAGS.filter((f) => !ownNames.has(f.name))];
};

/** All `--flag` (and `-s`) spellings of a node, for bash/zsh candidate lists. */
const flagWords = (c: CommandSpec): string =>
  flagsOf(c)
    .map((f) => (f.short ? `-${f.short} --${f.name}` : `--${f.name}`))
    .join(" ");

// ─── fish ──────────────────────────────────────────────────────────────────

/** Single-quote a string for fish (fish only special-cases `'` and `\`). */
function q(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** All name spellings of a node, space-joined, for fish guards. */
const fishNames = (c: CommandSpec): string => spellings(c).join(" ");

function fishScript(): string {
  const out: string[] = [];
  out.push("# fish completions for pty-relay — generated by `pty-relay completions fish`.");
  out.push(
    "# Regenerate with: pty-relay completions fish > ~/.config/fish/completions/pty-relay.fish"
  );
  out.push("# (kept in sync with src/cli.ts; see src/completions.ts)");
  out.push("");
  out.push("complete -c pty-relay -e");
  out.push("complete -c pty-relay -f");
  out.push("");
  out.push("# ── Global flags ───────────────────────────────────────────────────────");
  for (const f of GLOBAL_FLAGS) {
    out.push(
      `complete -c pty-relay -n __fish_use_subcommand -l ${f.name}${f.short ? ` -s ${f.short}` : ""} -d ${q(f.desc)}`
    );
  }
  out.push("");
  out.push("# ── Subcommands ────────────────────────────────────────────────────────");
  for (const c of COMMANDS) {
    for (const name of spellings(c)) {
      out.push(
        `complete -c pty-relay -n __fish_use_subcommand -a ${name} -d ${q(c.desc)}`
      );
    }
  }

  for (const c of COMMANDS) {
    const verbs = c.verbs ?? [];
    if (verbs.length > 0) {
      out.push("");
      out.push(`# ${c.name} verbs`);
      // A verb is offered only once the group is seen and no verb yet is.
      const verbNames = verbs.flatMap(spellings).join(" ");
      const guard = `__fish_seen_subcommand_from ${fishNames(c)}; and not __fish_seen_subcommand_from ${verbNames}`;
      for (const v of verbs) {
        for (const name of spellings(v)) {
          out.push(`complete -c pty-relay -n ${q(guard)} -a ${name} -d ${q(v.desc)}`);
        }
      }
      // Verb names like `start`/`status`/`reset` collide across groups, so
      // guard on BOTH the verb and its group.
      for (const v of verbs) {
        fishEmitForNode(out, v, [
          `__fish_seen_subcommand_from ${fishNames(v)}`,
          `__fish_seen_subcommand_from ${fishNames(c)}`,
        ]);
      }
    }
    // Flags that live directly on the group/command (no verb).
    fishEmitForNode(out, c, [`__fish_seen_subcommand_from ${fishNames(c)}`]);
  }

  return out.join("\n") + "\n";
}

/** Emit fish `complete` lines for a node's flags and positional values,
 *  gated by `guards` (all must hold). */
function fishEmitForNode(
  out: string[],
  node: CommandSpec,
  guards: readonly string[]
): void {
  const cond = guards.join("; and ");
  for (const f of flagsOf(node)) {
    const short = f.short ? ` -s ${f.short}` : "";
    if (f.values) {
      out.push(
        `complete -c pty-relay -n ${q(cond)} -l ${f.name}${short} -x -a ${q(f.values.join(" "))} -d ${q(f.desc)}`
      );
    } else {
      out.push(`complete -c pty-relay -n ${q(cond)} -l ${f.name}${short} -d ${q(f.desc)}`);
    }
  }
  if (node.positionalValues) {
    out.push(
      `complete -c pty-relay -n ${q(cond)} -x -a ${q(node.positionalValues.join(" "))} -d ${q("Value")}`
    );
  }
  if (node.takesPath) {
    out.push(`complete -c pty-relay -n ${q(cond)} -F`);
  }
}

// ─── bash ────────────────────────────────────────────────────────────────────
//
// A flat completer: at depth 1 offer subcommands (or global flags); once a
// known group is the first word, offer its verbs and flags; at depth ≥ 3
// inside a group, offer the matched verb's flags. Behavioral parity with fish
// is a non-goal — this gives useful subcommand + flag completion and is
// syntactically sourceable (`bash -n`).

function bashScript(): string {
  const lines: string[] = [];
  lines.push("# bash completion for pty-relay — generated by `pty-relay completions bash`.");
  lines.push("# Regenerate with: pty-relay completions bash > /etc/bash_completion.d/pty-relay");
  lines.push("_pty_relay() {");
  lines.push("  local cur prev cmd verb words");
  lines.push("  COMPREPLY=()");
  lines.push('  cur="${COMP_WORDS[COMP_CWORD]}"');
  lines.push('  prev="${COMP_WORDS[COMP_CWORD-1]}"');
  lines.push('  cmd="${COMP_WORDS[1]}"');
  lines.push('  verb="${COMP_WORDS[2]}"');
  lines.push("");
  lines.push("  # Enum-valued flags complete their value set.");
  lines.push(...bashEnumCases());
  lines.push("");
  lines.push("  if [[ ${COMP_CWORD} -eq 1 ]]; then");
  lines.push('    if [[ "${cur}" == -* ]]; then');
  lines.push(
    `      COMPREPLY=($(compgen -W "${GLOBAL_FLAGS.map((f) => `--${f.name}`).join(" ")}" -- "\${cur}"))`
  );
  lines.push("    else");
  lines.push(
    `      COMPREPLY=($(compgen -W "${allCommandNames().join(" ")}" -- "\${cur}"))`
  );
  lines.push("    fi");
  lines.push("    return 0");
  lines.push("  fi");
  lines.push("");
  lines.push("  words=\"\"");
  lines.push('  case "${cmd}" in');
  for (const c of COMMANDS) {
    const names = spellings(c).join("|");
    const verbs = c.verbs ?? [];
    if (verbs.length === 0) {
      lines.push(`    ${names}) words="${flagWords(c)}" ;;`);
      continue;
    }
    // Group: depth 2 offers verbs + group flags; deeper offers verb flags.
    lines.push(`    ${names})`);
    lines.push("      if [[ ${COMP_CWORD} -eq 2 ]]; then");
    lines.push(
      `        words="${[...verbs.flatMap(spellings), ...flagsOf(c).map((f) => `--${f.name}`)].join(" ")}"`
    );
    lines.push("      else");
    lines.push('        case "${verb}" in');
    for (const v of verbs) {
      const vWords = [
        flagWords(v),
        ...(v.positionalValues ? [v.positionalValues.join(" ")] : []),
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(`          ${spellings(v).join("|")}) words="${vWords}" ;;`);
    }
    lines.push("        esac");
    lines.push("      fi");
    lines.push("      ;;");
  }
  lines.push("  esac");
  lines.push("");
  lines.push('  if [[ -n "${words}" ]]; then');
  lines.push('    COMPREPLY=($(compgen -W "${words}" -- "${cur}"))');
  lines.push("  fi");
  lines.push("  return 0");
  lines.push("}");
  lines.push("complete -F _pty_relay pty-relay");
  return lines.join("\n") + "\n";
}

/** The bash `case "$prev"` block completing enum flag values. Enum flag names
 *  (`--backend`, `--role`) are globally unambiguous in pty-relay, so no
 *  per-command scoping is needed. */
function bashEnumCases(): string[] {
  const lines: string[] = [];
  lines.push('  case "${prev}" in');
  for (const [flag, values] of enumFlags()) {
    lines.push(
      `    --${flag}) COMPREPLY=($(compgen -W "${values.join(" ")}" -- "\${cur}")); return 0 ;;`
    );
  }
  lines.push("  esac");
  return lines;
}

/** Every enum-valued flag in the tree, as `[flag-name, values]`. */
function enumFlags(): readonly (readonly [string, readonly string[]])[] {
  const seen = new Map<string, readonly string[]>();
  const walk = (nodes: readonly CommandSpec[]): void => {
    for (const c of nodes) {
      for (const f of c.flags ?? []) {
        if (f.values) seen.set(f.name, f.values);
      }
      if (c.verbs) walk(c.verbs);
    }
  };
  walk(COMMANDS);
  return [...seen.entries()];
}

// ─── zsh ─────────────────────────────────────────────────────────────────────
//
// A `#compdef`-style function. Like bash, behavioral parity with fish is a
// non-goal — this offers subcommands, verbs, flags and enum value sets, and
// is syntactically sourceable (`zsh -n`).

function zshScript(): string {
  const lines: string[] = [];
  lines.push("#compdef pty-relay");
  lines.push("# zsh completion for pty-relay — generated by `pty-relay completions zsh`.");
  lines.push('# Regenerate with: pty-relay completions zsh > "${fpath[1]}/_pty-relay"');
  lines.push("_pty_relay() {");
  lines.push('  local cmd="${words[2]}" verb="${words[3]}" prev="${words[CURRENT-1]}"');
  lines.push("");
  lines.push('  case "${prev}" in');
  for (const [flag, values] of enumFlags()) {
    lines.push(`    --${flag}) compadd ${values.join(" ")}; return ;;`);
  }
  lines.push("  esac");
  lines.push("");
  lines.push('  if [[ "${CURRENT}" -eq 2 ]]; then');
  lines.push(`    compadd ${allCommandNames().join(" ")}; return`);
  lines.push("  fi");
  lines.push("");
  lines.push('  case "${cmd}" in');
  for (const c of COMMANDS) {
    const names = spellings(c).join("|");
    const verbs = c.verbs ?? [];
    if (verbs.length === 0) {
      lines.push(`    ${names}) compadd ${flagWords(c)} ;;`);
      continue;
    }
    lines.push(`    ${names})`);
    lines.push('      if [[ "${CURRENT}" -eq 3 ]]; then');
    lines.push(
      `        compadd ${[...verbs.flatMap(spellings), ...flagsOf(c).map((f) => `--${f.name}`)].join(" ")}`
    );
    lines.push("      else");
    lines.push('        case "${verb}" in');
    for (const v of verbs) {
      const vWords = [
        flagWords(v),
        ...(v.positionalValues ? [v.positionalValues.join(" ")] : []),
      ]
        .filter(Boolean)
        .join(" ");
      lines.push(`          ${spellings(v).join("|")}) compadd ${vWords} ;;`);
    }
    lines.push("        esac");
    lines.push("      fi");
    lines.push("      ;;");
  }
  lines.push("  esac");
  lines.push("}");
  lines.push("");
  lines.push('_pty_relay "$@"');
  return lines.join("\n") + "\n";
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

const GENERATORS: Record<string, () => string> = {
  bash: bashScript,
  fish: fishScript,
  zsh: zshScript,
};

const SHELLS = Object.keys(GENERATORS);

function usageText(): string {
  return (
    "usage: pty-relay completions <shell>\n\n" +
    "Print a shell completion script to stdout.\n\n" +
    "Shells:\n" +
    SHELLS.map((s) => `  ${s}`).join("\n") +
    "\n\nExamples:\n" +
    "  pty-relay completions fish > ~/.config/fish/completions/pty-relay.fish\n" +
    "  pty-relay completions bash > /etc/bash_completion.d/pty-relay\n" +
    '  pty-relay completions zsh  > "${fpath[1]}/_pty-relay"\n'
  );
}

/**
 * `pty-relay completions <shell>` — write a completion script for `shell` to
 * stdout. Unknown or missing shell prints usage to stderr and returns 2;
 * `--help`/`-h` prints usage to stdout and returns 0.
 */
export function cmdCompletions(args: readonly string[]): number {
  const shell = args[0];
  if (shell === "--help" || shell === "-h") {
    console.log(usageText());
    return 0;
  }
  if (shell === undefined) {
    console.error(usageText());
    return 2;
  }
  const gen = GENERATORS[shell];
  if (gen === undefined) {
    console.error(`pty-relay completions: unknown shell: ${shell}\n`);
    console.error(usageText());
    return 2;
  }
  process.stdout.write(gen());
  return 0;
}

// Exposed for tests.
export { COMMANDS, SHELLS, fishScript, bashScript, zshScript };
