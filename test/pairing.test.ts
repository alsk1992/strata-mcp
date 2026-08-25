import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateSessionKeypair } from "@stratabook/sdk";
import {
  loadTradingEnvironment,
  readTradingConnection,
  tradingCredentialsPath,
  writeTradingConnection,
} from "../src/pairing.js";

test("credential paths follow each platform and allow an explicit override", () => {
  assert.equal(
    tradingCredentialsPath({ XDG_CONFIG_HOME: "/tmp/config" }, "linux", "/home/al"),
    "/tmp/config/strata/mcp.json",
  );
  assert.equal(
    tradingCredentialsPath({ APPDATA: String.raw`C:\Users\al\AppData\Roaming` }, "win32", "ignored"),
    String.raw`C:\Users\al\AppData\Roaming/Strata/mcp.json`,
  );
  assert.equal(
    tradingCredentialsPath({ STRATA_MCP_CREDENTIALS_FILE: "/tmp/strata-custom.json" }, "linux", "/home/al"),
    "/tmp/strata-custom.json",
  );
});

test("a private local connection is loaded without manual environment variables", async () => {
  const root = await mkdtemp(join(tmpdir(), "strata-mcp-pairing-"));
  const path = join(root, "private", "mcp.json");
  const keypair = await generateSessionKeypair();
  await writeTradingConnection({
    schema_version: 1,
    owner_wallet: "11111111111111111111111111111111",
    session_public_key: keypair.publicKey,
    session_secret_key: keypair.secretKey,
    autonomy: "instant",
    connected_at_ms: 123,
  }, path);
  const saved = await readTradingConnection(path);
  assert.equal(saved?.session_public_key, keypair.publicKey);
  const loaded = await loadTradingEnvironment({
    STRATA_MCP_CREDENTIALS_FILE: path,
    STRATA_AUTONOMY: "ask",
  });
  assert.equal(loaded.STRATA_OWNER_WALLET, "11111111111111111111111111111111");
  assert.equal(loaded.STRATA_SESSION_SECRET_KEY, keypair.secretKey);
  assert.equal(loaded.STRATA_SESSION_PUBLIC_KEY, keypair.publicKey);
  assert.equal(loaded.STRATA_AUTONOMY, "ask", "an explicit autonomy choice wins");
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test("explicit session environment remains authoritative", async () => {
  const loaded = await loadTradingEnvironment({
    STRATA_OWNER_WALLET: "owner-from-env",
    STRATA_SESSION_SECRET_KEY: "secret-from-env",
    STRATA_MCP_CREDENTIALS_FILE: "/does/not/exist",
  });
  assert.equal(loaded.STRATA_OWNER_WALLET, "owner-from-env");
  assert.equal(loaded.STRATA_SESSION_SECRET_KEY, "secret-from-env");
});
