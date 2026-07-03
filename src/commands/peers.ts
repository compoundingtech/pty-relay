import { ready } from "../crypto/index.ts";
import {
  loadAllKnownHostsWithSource,
  isPublicHost,
  isSshHost,
  type PeerEntry,
} from "../relay/known-hosts.ts";
import { openSecretStore } from "../storage/bootstrap.ts";
import { log } from "../log.ts";

/**
 * `pty-relay peers [--json]` — terse peer listing.
 *
 * Complement to `ls`: `ls` fans out over every known peer to fetch
 * their session lists (heavy, network-bound). `peers` answers "what
 * peers do I know" from local reads only — encrypted store + peers
 * file — with no network probes and no session fanout.
 *
 * The JSON shape includes provenance (`source`) so callers can tell
 * imperative-vs-declarative rows apart, and transport `kind` so they
 * can distinguish self-hosted / public / ssh peers without pattern-
 * matching the URL.
 */
export interface PeerRow {
  label: string;
  url: string;
  source: "known-hosts" | "peers-file";
  kind: "self" | "public" | "ssh";
}

export async function peers(
  configDir?: string,
  json = false,
  opts?: { passphraseFile?: string },
): Promise<void> {
  await ready();
  log("cli", "peers start", { configDir, json });

  const { store } = await openSecretStore(configDir, {
    interactive: true,
    passphraseFile: opts?.passphraseFile,
  });
  const entries = await loadAllKnownHostsWithSource(store);
  const rows = entries.map(toPeerRow);

  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("No known peers.");
    console.log("Add one:");
    console.log("  pty-relay add ssh://[user@]host[:port]");
    console.log("  pty-relay connect <token-url>");
    console.log("Or drop a peers file at ~/.config/pty-relay/peers.");
    return;
  }

  // One row per peer, `<label>  <url>`. Padding to the longest label
  // keeps the URL column aligned without pulling in a table renderer.
  const maxLabel = rows.reduce((n, r) => Math.max(n, r.label.length), 0);
  for (const row of rows) {
    const pad = " ".repeat(maxLabel - row.label.length + 2);
    console.log(`${row.label}${pad}${row.url}`);
  }
}

function toPeerRow(entry: PeerEntry): PeerRow {
  const h = entry.host;
  if (isSshHost(h)) {
    return { label: h.label, url: h.sshUrl, source: entry.source, kind: "ssh" };
  }
  if (isPublicHost(h)) {
    return {
      label: h.label,
      url: `${h.relayUrl}@${h.publicKey.slice(0, 8)}`,
      source: entry.source,
      kind: "public",
    };
  }
  return { label: h.label, url: h.url!, source: entry.source, kind: "self" };
}
