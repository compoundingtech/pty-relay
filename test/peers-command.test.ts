import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SecretName, SecretStore } from "../src/storage/secret-store.ts";
import {
  loadAllKnownHostsWithSource,
  saveKnownHost,
  savePublicKnownHost,
  saveSshKnownHost,
} from "../src/relay/known-hosts.ts";

/**
 * Tests for loadAllKnownHostsWithSource — the tagged-tuple variant of
 * loadAllKnownHosts. This is what `pty-relay peers --json` uses to
 * populate the `source` column, so its provenance tagging (and the
 * store-wins collision behavior) has to stay correct even as the
 * peers-file merge evolves.
 *
 * We drive the peers file via PTY_RELAY_PEERS_FILE so we don't touch
 * the developer's real XDG_CONFIG_HOME while tests run.
 */

class MemStore implements SecretStore {
  readonly backend = "passphrase" as const;
  private data = new Map<SecretName, Uint8Array>();
  async load(n: SecretName) {
    return this.data.get(n) ?? null;
  }
  async save(n: SecretName, p: Uint8Array) {
    this.data.set(n, p);
  }
  async delete(n: SecretName) {
    this.data.delete(n);
  }
}

let tmpDir: string;
let peersFile: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "peers-cmd-"));
  peersFile = path.join(tmpDir, "peers");
  env = { ...process.env };
  delete process.env.XDG_CONFIG_HOME;
  process.env.PTY_RELAY_PEERS_FILE = peersFile;
});

afterEach(() => {
  process.env = env;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadAllKnownHostsWithSource", () => {
  it("tags store-only entries as source: known-hosts", async () => {
    const store = new MemStore();
    await saveSshKnownHost({ label: "web1", sshUrl: "ssh://me@web1" }, store);
    // No peers file on disk.
    const entries = await loadAllKnownHostsWithSource(store);
    expect(entries).toEqual([
      {
        host: { label: "web1", sshUrl: "ssh://me@web1" },
        source: "known-hosts",
      },
    ]);
  });

  it("tags peers-file entries as source: peers-file", async () => {
    const store = new MemStore();
    fs.writeFileSync(peersFile, "ssh://me@web1  prod-web\n");
    const entries = await loadAllKnownHostsWithSource(store);
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("peers-file");
    expect(entries[0].host.label).toBe("prod-web");
  });

  it("returns both sources with correct tags when mixed", async () => {
    const store = new MemStore();
    await saveKnownHost("local", "http://localhost:8099#pk.s", store);
    fs.writeFileSync(peersFile, "ssh://me@web1  prod-web\n");
    const entries = await loadAllKnownHostsWithSource(store);
    const bySource = Object.fromEntries(entries.map((e) => [e.host.label, e.source]));
    expect(bySource).toEqual({
      local: "known-hosts",
      "prod-web": "peers-file",
    });
  });

  it("preserves store-wins semantics: file line with same label is dropped, not tagged", async () => {
    // If the operator has both an explicit store entry and a peers-file
    // line for the same label, the file row is skipped entirely — so
    // there's only one entry, tagged known-hosts. Otherwise `peers`
    // would double-list under different provenances, which is worse
    // than the silent-winner behavior.
    const store = new MemStore();
    await saveSshKnownHost({ label: "web1", sshUrl: "ssh://me@web1" }, store);
    fs.writeFileSync(peersFile, "ssh://you@web1  web1\n");
    const entries = await loadAllKnownHostsWithSource(store);
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("known-hosts");
    expect(entries[0].host.sshUrl).toBe("ssh://me@web1");
  });

  it("keeps entry counts right when many public / self / ssh mix", async () => {
    const store = new MemStore();
    await saveKnownHost("home", "http://home:8099#pk.s", store);
    await savePublicKnownHost(
      { label: "cloud", relayUrl: "http://relay", publicKey: "pk" },
      store,
    );
    await saveSshKnownHost({ label: "shell", sshUrl: "ssh://shell" }, store);
    fs.writeFileSync(peersFile, "ssh://me@web1  prod-web\n");
    const entries = await loadAllKnownHostsWithSource(store);
    expect(entries).toHaveLength(4);
    const known = entries.filter((e) => e.source === "known-hosts");
    const file = entries.filter((e) => e.source === "peers-file");
    expect(known).toHaveLength(3);
    expect(file).toHaveLength(1);
  });

  it("returns empty when neither store nor file has entries", async () => {
    const store = new MemStore();
    const entries = await loadAllKnownHostsWithSource(store);
    expect(entries).toEqual([]);
  });
});
