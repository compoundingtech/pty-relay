---
name: pty-relay
description: >-
  Reach a `pty` session — or a shell — running on ANOTHER machine, over an
  end-to-end-encrypted WebSocket tunnel, from a browser, phone, or a second
  terminal. pty-relay is the remote-access / transport layer on top of `pty`:
  the same peek / send / wait / tag / events verbs, but addressed to a remote
  `<host>`. The relay in the middle only ever sees opaque encrypted frames.
when_to_use: >-
  Use when the `pty` session you need is on a DIFFERENT machine than the one you
  are on — attach to it, read its screen, send it input, follow its events, or
  expose your own machine's sessions to a browser/phone. NOT for local sessions
  on THIS machine (that is plain `pty`), and NOT for spawning or orchestrating
  agents (that is `convoy`). pty-relay is the transport, not the orchestrator.
---

# pty-relay — remote access to pty sessions

> **Experimental / pre-release.** Protocols and on-disk formats can still change.

## What it is
`pty-relay` gives you remote, end-to-end-encrypted access to
[`pty`](https://github.com/compoundingtech/pty) sessions. A daemon on the machine
that *owns* the sessions forwards Noise-encrypted bytes to clients (a browser, a
phone, another terminal); the relay in the middle only sees opaque frames. Two
modes, one session protocol:

- **Self-hosted** (`pty-relay local start`) — one process runs a lightweight
  relay + daemon on your machine. No accounts, no email; auth is the
  `#pk.secret` fragment in the token URL it prints. Great for a laptop reaching a
  desktop over Tailscale or a LAN.
- **Public relay** (`pty-relay server signin` + `server start`) — your daemon
  dials outbound to a multi-tenant relay (`relay.pty.computer`); email + TOTP
  auth, account-scoped devices, works across any NAT.

## When to reach for it
- You need to attach to / read / drive a `pty` session that lives on a *different*
  machine than the one you're typing on.
- You want to expose this machine's sessions to a browser or a phone.
- You're scripting against a remote daemon: the `ls / peek / send / tag / events`
  verbs mirror `pty`'s, but each takes a `<host>` peer first.

For a session on THIS machine, use plain `pty`. For "start N sessions on host Y
and orchestrate them," that's `convoy` — pty-relay just moves the bytes.

## The idiom (happy path)

**Serve this machine's sessions (self-hosted):**
```sh
pty-relay init                          # one-time secret storage
pty-relay local start --tailscale       # prints a token URL (auth = the #pk.secret fragment)
# background it: add -d, then reattach with `pty attach relay-daemon`
```

**Reach a remote daemon (client):**
```sh
pty-relay connect <token-url>           # attach to a self-hosted token URL
pty-relay ls                            # known peers + their sessions (fans out)
pty-relay peek --wait "<ready text>" --plain <host> <session> -t 30
pty-relay send <host> <session> --seq "<text>" --seq key:return
```

**Public relay instead of a token URL:**
```sh
# on the daemon machine:
pty-relay server signin --email you@example.com --relay https://relay.pty.computer
pty-relay server start
# on a client device:
pty-relay client signin --email you@example.com --relay https://relay.pty.computer
pty-relay server hosts --merge          # pull the account's daemons into known-hosts
pty-relay client connect <label>
```

## Footguns (the ones that actually bite)
- **Remote session verbs take a `<host>` FIRST.** `pty peek <session>` is local;
  the relay equivalent is `pty-relay peek <host> <session>`. The verbs look
  identical to `pty`'s but are addressed to a remote daemon — a missing peer arg
  is the #1 "why is this erroring." (`kill` only works on `ssh://` peers today;
  other peer kinds return "not yet supported.")
- **Three `reset`s at three altitudes — mind the blast radius.**
  `pty-relay reset` wipes **ALL** saved credentials on this machine.
  `pty-relay local reset` wipes only the self-hosted daemon's state (keeps your
  public-relay enrollment). `pty-relay server reset --email <addr>` does neither —
  it requests a locked-out account-key **recovery email**. Same word, three
  meanings; read twice before running the bare one.
- **`send` submits nothing on its own.** Like `pty`, `pty-relay send <host> <s>
  "text"` sends the text with **no newline**. To submit, add a key:
  `--seq "text" --seq key:return`. If a fast burst lands before the remote
  readline is ready, tune `--with-delay <sec>`; use `--paste` to wrap a
  multi-line payload in bracketed-paste markers.
- **Remote spawn is OFF by default — that's a feature.** Clients can only
  *attach* to sessions you already started with `pty run`. Starting new sessions
  (`connect --spawn`) needs the daemon running with `--allow-new-sessions`;
  running non-PTY commands (`exec` / `rsync`) needs `--allow-exec`. "It won't let
  me start a shell remotely" almost always means the daemon didn't opt in.
- **The token URL *is* the credential (self-hosted).** Anyone holding the full
  `…#pk.secret` URL can connect. Never paste it into a log, an issue, or anywhere
  that gets indexed. When it matters, keep `--tailscale` and per-client approval
  (i.e. don't add `--auto-approve`), so each new client is confirmed once.

## The exact surface
`pty-relay --help` prints the authoritative command + flag + files/env reference
(there is **no** per-verb `--help` for top-level verbs — the full usage is the
list). The namespaced helps drill in: `pty-relay local --help`,
`pty-relay server --help`, `pty-relay client --help`. `pty-relay --version` prints
`<semver>+<short-sha>`; `pty-relay doctor` prints a shareable, secret-free
environment report. See `README.md` for the full self-hosted and public-relay
quickstarts.
