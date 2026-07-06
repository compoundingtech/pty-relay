import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import sodium from "libsodium-wrappers-sumo";
import { ready } from "../src/crypto/index.ts";
import {
  saveKnownHost,
  savePublicKnownHost,
  saveSshKnownHost,
} from "../src/relay/known-hosts.ts";
import { resolveHost } from "../src/relay/host-resolve.ts";
import {
  savePublicAccount,
  type KeyIdentity,
  type PublicAccount,
} from "../src/storage/public-account.ts";
import type { SecretName, SecretStore } from "../src/storage/secret-store.ts";

/**
 * Guardrails for the public-relay dispatch path. Prevents a near-miss:
 * `connect-public.ts` is imported from `connect.ts` at run time via
 * `await import(...)`, so a superficial "grep for connect-public in
 * cli.ts" audit misses that it's live. If the file is deleted or the
 * dispatch is stubbed out, these tests fail loudly and pin the
 * regression at the exact site.
 *
 * Two halves:
 *  1. Live resolveHost() coverage: kind:"public" must be returned when
 *     the label maps to a public host AND the store has a client key.
 *     The three failure modes (no account, wrong relay, daemon-only)
 *     each raise a user-facing message.
 *  2. Structural invariant on connect.ts: the `resolved.kind ===
 *     "public"` branch must dispatch to `connectPublic` from
 *     `./connect-public.ts`, and `connect-public.ts` must still exist
 *     with that export.
 */

class MemStore implements SecretStore {
  readonly backend = "passphrase" as const;
  private data = new Map<SecretName, Uint8Array>();
  async load(n: SecretName) { return this.data.get(n) ?? null; }
  async save(n: SecretName, p: Uint8Array) { this.data.set(n, p); }
  async delete(n: SecretName) { this.data.delete(n); }
}

async function makeKeyIdentity(): Promise<KeyIdentity> {
  await ready();
  const kp = sodium.crypto_sign_keypair();
  return {
    signingKeys: {
      public: sodium.to_base64(kp.publicKey, sodium.base64_variants.URLSAFE_NO_PADDING),
      secret: sodium.to_base64(kp.privateKey, sodium.base64_variants.URLSAFE_NO_PADDING),
    },
    registeredKeyId: "01HTESTKEYID000000000000000",
    enrolledAt: new Date(0).toISOString(),
  };
}

async function makeAccount(overrides: Partial<PublicAccount> = {}): Promise<PublicAccount> {
  const clientKey = await makeKeyIdentity();
  return {
    relayUrl: "http://localhost:4000",
    email: "me@example.com",
    accountId: "01HTESTACCTID000000000000000",
    label: "test-device",
    clientKey,
    ...overrides,
  };
}

describe("resolveHost — public kind", () => {
  it("returns kind:public with a PublicTarget when the label maps to a public host + client key", async () => {
    const store = new MemStore();
    const daemonPubkeyB64 = sodium.to_base64(
      sodium.crypto_sign_keypair().publicKey,
      sodium.base64_variants.URLSAFE_NO_PADDING,
    );
    await savePublicKnownHost(
      {
        label: "laptop-b",
        relayUrl: "http://localhost:4000",
        publicKey: daemonPubkeyB64,
      },
      store,
    );
    await savePublicAccount(await makeAccount(), store);

    const resolved = await resolveHost("laptop-b", store);
    expect(resolved.kind).toBe("public");
    if (resolved.kind !== "public") return;
    expect(resolved.label).toBe("laptop-b");
    expect(resolved.target.relayUrl).toBe("http://localhost:4000");
    expect(resolved.target.targetPublicKeyB64).toBe(daemonPubkeyB64);
    // accountKeys are byte-decoded from the stored base64url client key.
    expect(resolved.target.accountKeys.public).toBeInstanceOf(Uint8Array);
    expect(resolved.target.accountKeys.public.length).toBe(sodium.crypto_sign_PUBLICKEYBYTES);
    expect(resolved.target.accountKeys.secret.length).toBe(sodium.crypto_sign_SECRETKEYBYTES);
  });

  it("throws a user-facing 'not enrolled' error when the public host has no matching public_account", async () => {
    const store = new MemStore();
    await savePublicKnownHost(
      {
        label: "laptop-b",
        relayUrl: "http://localhost:4000",
        publicKey: "AAAA_pubkey_placeholder",
      },
      store,
    );

    await expect(resolveHost("laptop-b", store)).rejects.toThrow(/isn't enrolled/i);
  });

  it("throws when the account exists but is on a different relay than the host", async () => {
    const store = new MemStore();
    await savePublicKnownHost(
      {
        label: "laptop-b",
        relayUrl: "https://relay.pty.computer",
        publicKey: "AAAA_pubkey_placeholder",
      },
      store,
    );
    await savePublicAccount(
      await makeAccount({ relayUrl: "http://localhost:4000" }),
      store,
    );

    await expect(resolveHost("laptop-b", store)).rejects.toThrow(
      /is on relay .* but this device is enrolled on/i,
    );
  });

  it("throws 'no client key' when the account is daemon-only (server signin without join)", async () => {
    const store = new MemStore();
    await savePublicKnownHost(
      {
        label: "laptop-b",
        relayUrl: "http://localhost:4000",
        publicKey: "AAAA_pubkey_placeholder",
      },
      store,
    );
    const daemonOnly = await makeAccount({ clientKey: undefined });
    daemonOnly.daemonKey = await makeKeyIdentity();
    await savePublicAccount(daemonOnly, store);

    await expect(resolveHost("laptop-b", store)).rejects.toThrow(/no client key/i);
  });

  it("still returns kind:self for a self-hosted label sharing the same store", async () => {
    const store = new MemStore();
    await savePublicKnownHost(
      {
        label: "laptop-b",
        relayUrl: "http://localhost:4000",
        publicKey: "AAAA_pubkey_placeholder",
      },
      store,
    );
    await saveKnownHost("home", "http://home:8099#pk.s", store);
    await savePublicAccount(await makeAccount(), store);

    const resolved = await resolveHost("home", store);
    expect(resolved.kind).toBe("self");
    if (resolved.kind !== "self") return;
    expect(resolved.url).toBe("http://home:8099#pk.s");
  });

  it("still returns kind:ssh for an ssh label sharing the same store", async () => {
    const store = new MemStore();
    await savePublicKnownHost(
      {
        label: "laptop-b",
        relayUrl: "http://localhost:4000",
        publicKey: "AAAA_pubkey_placeholder",
      },
      store,
    );
    await saveSshKnownHost({ label: "headless", sshUrl: "ssh://me@h" }, store);
    await savePublicAccount(await makeAccount(), store);

    const resolved = await resolveHost("headless", store);
    expect(resolved.kind).toBe("ssh");
    if (resolved.kind !== "ssh") return;
    expect(resolved.sshUrl).toBe("ssh://me@h");
  });
});

describe("connect.ts → connect-public.ts dispatch invariant", () => {
  const connectSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src/commands/connect.ts"),
    "utf8",
  );

  it("connect.ts imports connectPublic from ./connect-public.ts", () => {
    // Dynamic import inside a function body — the exact string. If a
    // future refactor renames the module or the export, this fails and
    // points at the branch that needs to change.
    expect(connectSrc).toMatch(
      /const\s*\{\s*connectPublic\s*\}\s*=\s*await\s+import\(\s*["']\.\/connect-public\.ts["']\s*\)/,
    );
  });

  it("the connectPublic dispatch lives inside the resolved.kind === \"public\" branch", () => {
    // Locate the `if (resolved.kind === "public")` line and assert that
    // `connectPublic` appears in the block that opens it. This pins
    // the dispatch to the right conditional; if someone moves the
    // dispatch out of the public branch (or wires it to something else
    // like kind:"self"), the test fails.
    const lines = connectSrc.split("\n");
    const branchIdx = lines.findIndex((l) =>
      l.match(/resolved\.kind\s*===\s*["']public["']/),
    );
    expect(branchIdx).toBeGreaterThan(-1);

    // Walk forward to find the matching closing brace of the if block,
    // starting depth at 0 and counting from the opening `{` on the same
    // line or a subsequent line.
    let depth = 0;
    let started = false;
    let branchEnd = -1;
    for (let i = branchIdx; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth++; started = true; }
        else if (ch === "}") {
          depth--;
          if (started && depth === 0) { branchEnd = i; break; }
        }
      }
      if (branchEnd !== -1) break;
    }
    expect(branchEnd).toBeGreaterThan(branchIdx);

    const branchBody = lines.slice(branchIdx, branchEnd + 1).join("\n");
    expect(branchBody).toContain("connectPublic");
  });

  it("connect-public.ts exists and exports connectPublic as a function", async () => {
    // Static file-existence check — if someone deletes the file, this
    // fails BEFORE the dynamic import lands, giving a clearer failure
    // than a `Cannot find module './connect-public.ts'` at runtime.
    const p = path.join(import.meta.dirname, "..", "src/commands/connect-public.ts");
    expect(fs.existsSync(p)).toBe(true);

    // Load the module and confirm the export shape. This will fail with
    // a strip-types load error if the file exports don't parse.
    const mod = await import("../src/commands/connect-public.ts");
    expect(typeof mod.connectPublic).toBe("function");
  });
});
