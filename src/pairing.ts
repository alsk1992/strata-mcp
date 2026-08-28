import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_API_BASE,
  generateSessionKeypair,
} from "@stratabook/sdk";

const PUBLIC_KEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SECRET_KEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const PAIRING_TIMEOUT_MS = 30 * 60_000;

export const DEFAULT_PAIRING_WEB_BASE = "https://stratabook.app";

export interface StoredTradingConnection {
  readonly schema_version: 1;
  readonly owner_wallet: string;
  readonly session_public_key: string;
  readonly session_secret_key: string;
  readonly autonomy: "ask" | "limits" | "instant";
  readonly connected_at_ms: number;
}

export type PairingAction = "connect" | "disconnect";

export interface PairingOptions {
  readonly action: PairingAction;
  readonly webBase?: string;
  readonly openBrowser?: boolean;
  readonly credentialsFile?: string;
  readonly apiBase?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly nowMs?: () => number;
}

/** Local success page: close the helper tab when allowed, otherwise return to Strata. */
export function pairingCompletionDocument(returnUrl: string): string {
  const destination = JSON.stringify(returnUrl).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent connected · Strata</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090b10;color:#f4f7fa;font:16px/1.5 system-ui,sans-serif}.card{max-width:34rem;margin:2rem;padding:2rem;border:1px solid #1b8596;border-radius:18px;background:linear-gradient(135deg,#0c171d,#100d1e)}h1{margin:.25rem 0 .5rem;font-size:1.7rem}p{margin:0;color:#aeb8c5}.mark{color:#34d6c4;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:.75rem}
</style></head><body><main class="card"><div class="mark">Strata</div><h1>Agent connected</h1><p>Your local credential is saved. You can close this tab.</p></main>
<script>const destination=${destination};window.close();setTimeout(()=>location.replace(destination),700);</script></body></html>`;
}

function validPublicKey(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_KEY_PATTERN.test(value);
}

function validSecretKey(value: unknown): value is string {
  return typeof value === "string" && SECRET_KEY_PATTERN.test(value);
}

export function tradingCredentialsPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform,
  home = homedir(),
): string {
  const override = env.STRATA_MCP_CREDENTIALS_FILE?.trim();
  if (override) return resolve(override);
  if (platform === "win32") {
    const appData = env.APPDATA?.trim()
      || join(env.USERPROFILE?.trim() || home, "AppData", "Roaming");
    return join(appData, "Strata", "mcp.json");
  }
  const configRoot = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(configRoot, "strata", "mcp.json");
}

export async function readTradingConnection(
  path = tradingCredentialsPath(),
): Promise<StoredTradingConnection | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Strata trading credentials are not valid JSON: ${path}`);
  }
  if (!value || typeof value !== "object") {
    throw new Error(`Strata trading credentials are invalid: ${path}`);
  }
  const candidate = value as Partial<StoredTradingConnection>;
  if (
    candidate.schema_version !== 1
    || !validPublicKey(candidate.owner_wallet)
    || !validPublicKey(candidate.session_public_key)
    || !validSecretKey(candidate.session_secret_key)
    || !["ask", "limits", "instant"].includes(candidate.autonomy ?? "")
    || !Number.isSafeInteger(candidate.connected_at_ms)
  ) {
    throw new Error(`Strata trading credentials are invalid: ${path}`);
  }
  return candidate as StoredTradingConnection;
}

export async function writeTradingConnection(
  connection: StoredTradingConnection,
  path = tradingCredentialsPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(connection, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    // `mode` is honored on creation. chmod also protects unusual umasks.
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    // Same-directory rename means the live MCP sees either the old complete
    // credential or the new complete credential, never a partially written file.
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function removeTradingConnection(
  path = tradingCredentialsPath(),
): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Explicit environment variables win; otherwise load the private local file. */
export async function loadTradingEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Record<string, string | undefined>> {
  if (env.STRATA_SESSION_SECRET_KEY || env.STRATA_OWNER_WALLET) return { ...env };
  const path = tradingCredentialsPath(env);
  const connection = await readTradingConnection(path);
  if (!connection) return { ...env };
  return {
    ...env,
    STRATA_OWNER_WALLET: connection.owner_wallet,
    STRATA_SESSION_PUBLIC_KEY: connection.session_public_key,
    STRATA_SESSION_SECRET_KEY: connection.session_secret_key,
    STRATA_AUTONOMY: env.STRATA_AUTONOMY ?? connection.autonomy,
  };
}

function pairingWebBase(raw: string): string {
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("pairing web base must use HTTPS (or HTTP on localhost)");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function launchBrowser(url: string): void {
  const command = process.platform === "darwin"
    ? { file: "open", args: [url] }
    : process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

export function pairingPageUrl(
  webBase: string,
  action: PairingAction,
  sessionPublicKey: string,
  callbackUrl: string,
  existing: Pick<StoredTradingConnection, "owner_wallet" | "session_public_key"> | null,
): string {
  const agentUrl = new URL("/agents", pairingWebBase(webBase));
  agentUrl.searchParams.set("pair", action);
  agentUrl.searchParams.set("session_public_key", sessionPublicKey);
  if (existing) agentUrl.searchParams.set("owner_wallet", existing.owner_wallet);
  if (action === "connect" && existing) {
    agentUrl.searchParams.set("replace_session_public_key", existing.session_public_key);
  }
  agentUrl.searchParams.set("callback", callbackUrl);
  return agentUrl.toString();
}

async function waitForOnChainSession(
  apiBase: string,
  action: PairingAction,
  ownerWallet: string,
  sessionPublicKey: string,
  replaceSessionPublicKey: string | null,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastState = "unavailable";
  const stateFor = async (key: string): Promise<string | null> => {
    const query = new URLSearchParams({
      wallet_address: ownerWallet,
      session_public_key: key,
    });
    const response = await fetch(
      `${apiBase.replace(/\/$/, "")}/v2/vault/status?${query.toString()}`,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) {
      lastState = `http_${response.status}`;
      return null;
    }
    const body = await response.json() as {
      wallet_address?: unknown;
      session?: { session_public_key?: unknown; state?: unknown } | null;
    };
    if (body.wallet_address !== ownerWallet) return null;
    if (!body.session) return "absent";
    if (body.session.session_public_key !== key || typeof body.session.state !== "string") return null;
    return body.session.state;
  };
  while (Date.now() < deadline) {
    try {
      const state = await stateFor(sessionPublicKey);
      lastState = state ?? lastState;
      if (action === "disconnect" && state === "absent") return;
      if (action === "connect" && state === "active") {
        if (!replaceSessionPublicKey || await stateFor(replaceSessionPublicKey) === "absent") return;
        lastState = "old_session_still_active";
      }
    } catch (error) {
      lastState = error instanceof Error ? error.name : "unavailable";
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(
    `Strata could not confirm the ${action === "connect" ? "active" : "revoked"} session on-chain `
    + `(last state: ${lastState}). The local credential was not changed.`,
  );
}

async function waitForPairingCallback(
  sessionPublicKey: string,
  state: string,
  returnUrl: string,
  onComplete: (ownerWallet: string) => Promise<void>,
): Promise<{ callbackUrl: string; completion: Promise<string> }> {
  let settle!: (ownerWallet: string) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<string>((resolvePromise, rejectPromise) => {
    settle = resolvePromise;
    reject = rejectPromise;
  });
  let finished = false;
  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== `/complete/${state}`) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Not found");
      return;
    }
    if (finished) {
      response.writeHead(409, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Pairing already completed");
      return;
    }
    const ownerWallet = requestUrl.searchParams.get("owner_wallet") ?? "";
    const returnedSession = requestUrl.searchParams.get("session_public_key") ?? "";
    if (!validPublicKey(ownerWallet) || returnedSession !== sessionPublicKey) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Invalid Strata pairing callback");
      return;
    }
    finished = true;
    try {
      await onComplete(ownerWallet);
      const document = pairingCompletionDocument(returnUrl);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(document),
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      });
      response.end(document);
      settle(ownerWallet);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("Could not save the local Strata connection");
      reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      server.close();
    }
  });
  server.on("error", (error) => reject(error));
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not start the local Strata pairing callback");
  }
  const timeout = setTimeout(() => {
    if (finished) return;
    finished = true;
    server.close();
    reject(new Error("Strata pairing timed out after 30 minutes"));
  }, PAIRING_TIMEOUT_MS);
  timeout.unref();
  completion.finally(() => clearTimeout(timeout)).catch(() => undefined);
  return {
    callbackUrl: `http://127.0.0.1:${address.port}/complete/${state}`,
    completion,
  };
}

export async function runLocalPairing(options: PairingOptions): Promise<void> {
  const env = options.env ?? process.env;
  const path = options.credentialsFile ?? tradingCredentialsPath(env);
  const existing = await readTradingConnection(path);
  if (options.action === "disconnect" && !existing) {
    process.stdout.write("Strata trading is not connected. Read-only tools remain ready.\n");
    return;
  }
  let generated: StoredTradingConnection;
  if (options.action === "disconnect" && existing) {
    generated = existing;
  } else {
    const keypair = await generateSessionKeypair();
    generated = {
      schema_version: 1,
      owner_wallet: "",
      session_public_key: keypair.publicKey,
      session_secret_key: keypair.secretKey,
      autonomy: "instant",
      connected_at_ms: 0,
    };
  }
  const state = randomBytes(24).toString("hex");
  const webBase = pairingWebBase(options.webBase ?? DEFAULT_PAIRING_WEB_BASE);
  const returnUrl = new URL("/agents", webBase);
  returnUrl.searchParams.set("paired", options.action === "connect" ? "connected" : "revoked");
  const replaceSessionPublicKey = options.action === "connect"
    ? existing?.session_public_key ?? null
    : null;
  const callback = await waitForPairingCallback(
    generated.session_public_key,
    state,
    returnUrl.toString(),
    async (ownerWallet) => {
      await waitForOnChainSession(
        options.apiBase ?? DEFAULT_API_BASE,
        options.action,
        ownerWallet,
        generated.session_public_key,
        replaceSessionPublicKey,
      );
      if (options.action === "disconnect") {
        if (existing?.owner_wallet !== ownerWallet) {
          throw new Error("the revoking wallet does not own this local Strata connection");
        }
        await removeTradingConnection(path);
        return;
      }
      await writeTradingConnection({
        ...generated,
        owner_wallet: ownerWallet,
        connected_at_ms: (options.nowMs ?? Date.now)(),
      }, path);
    },
  );
  const agentUrl = pairingPageUrl(
    webBase,
    options.action,
    generated.session_public_key,
    callback.callbackUrl,
    existing,
  );
  process.stdout.write(
    `${options.action === "disconnect" ? "Revoke" : replaceSessionPublicKey ? "Replace" : "Connect"} Strata agent access in your browser:\n${agentUrl}\n\n`,
  );
  if (options.openBrowser !== false) launchBrowser(agentUrl);
  process.stdout.write("Waiting for the owner-wallet signature…\n");
  const ownerWallet = await callback.completion;
  process.stdout.write(
    options.action === "connect"
      ? `✓ Trading connected for ${ownerWallet}. Credentials saved privately at ${path}.\nThis MCP release and newer pick it up automatically; restart only older clients.\n`
      : `✓ Session revoked for ${ownerWallet}. Local trading credentials removed.\n`,
  );
}
