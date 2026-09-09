// Unicommerce HTTP client + OAuth token manager. All env is read lazily
// inside functions (PRD §11). The token is cached in-process, refreshed on
// 401, and NEVER logged — error messages carry only status + endpoint path.

const TOKEN_SAFETY_MS = 60_000; // refresh a minute before expiry

interface TokenState {
  token: string;
  expiresAt: number; // epoch ms
}

const g = globalThis as unknown as { __ucToken?: TokenState };

export function ucConfigured(): boolean {
  return Boolean(process.env.UC_BASE_URL && process.env.UC_USERNAME && process.env.UC_PASSWORD);
}

function baseUrl(): string {
  const url = process.env.UC_BASE_URL;
  if (!url) throw new Error("UC_BASE_URL is not set");
  return url.replace(/\/+$/, "");
}

async function fetchToken(): Promise<TokenState> {
  const params = new URLSearchParams({
    grant_type: "password",
    client_id: process.env.UC_CLIENT_ID ?? "my-trusted-client",
    username: process.env.UC_USERNAME ?? "",
    password: process.env.UC_PASSWORD ?? "",
  });
  const res = await fetch(`${baseUrl()}/oauth/token?${params}`, { method: "POST" });
  if (!res.ok) {
    // Do not include the URL — it carries credentials in the query string.
    throw new Error(`UC auth failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("UC auth failed: no access_token in response");
  const ttlMs = (body.expires_in ?? 3600) * 1000;
  return { token: body.access_token, expiresAt: Date.now() + ttlMs - TOKEN_SAFETY_MS };
}

async function getToken(force = false): Promise<string> {
  if (force || !g.__ucToken || Date.now() >= g.__ucToken.expiresAt) {
    g.__ucToken = await fetchToken();
  }
  return g.__ucToken.token;
}

export interface UcRequestOptions {
  /** Facility header for facility-level APIs (manifest etc.). */
  facility?: string;
  body?: unknown;
}

/** POST a UC REST endpoint (path like "/services/rest/v1/oms/saleorder/get"). */
export async function ucPost<T>(path: string, opts: UcRequestOptions = {}): Promise<T> {
  const doFetch = async (token: string) =>
    fetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `bearer ${token}`,
        ...(opts.facility ? { Facility: opts.facility } : {}),
      },
      body: JSON.stringify(opts.body ?? {}),
    });

  let res = await doFetch(await getToken());
  if (res.status === 401) {
    // Token expired server-side — refresh once and retry.
    res = await doFetch(await getToken(true));
  }
  if (!res.ok) {
    throw new Error(`UC ${path} failed: ${await describeFailure(res)}`);
  }
  return (await res.json()) as T;
}

/**
 * Turn a failed UC response into something an operator can act on.
 *
 * The distinction that matters is JSON vs HTML. Unicommerce's API answers a
 * genuine API problem in JSON ("Illegal Access, facility is required"), and
 * that text is worth quoting verbatim. An HTML body means the request never
 * reached the API at all — it was stopped by a gateway, WAF or login redirect
 * in front of it — and quoting that is worse than useless: a 300-character
 * slice of a stylesheet and a postMessage shim fills the sync log and the
 * admin toast with noise while hiding the one fact that matters.
 *
 * The IP is called out because it is nearly always the difference. The same
 * credentials and the same endpoint succeed from a developer machine and fail
 * from the deploy host when only one of the two is allowlisted on the tenant.
 */
export async function describeFailure(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  const looksHtml = /^\s*(<!doctype|<html|<script)/i.test(body) || /<\/html>/i.test(body);
  if (!looksHtml) return `HTTP ${res.status} ${body.trim().slice(0, 300)}`;

  // Whatever readable text the page carries — usually a title or a one-line
  // reason — with the markup stripped out.
  const gist = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  return (
    `HTTP ${res.status} — an HTML error page, not an API response, so the request was blocked BEFORE it reached ` +
    `the Unicommerce API. Credentials are not the problem: the OAuth token was issued successfully. ` +
    `The usual cause is the calling host's public IP not being allowlisted on the tenant — the same call ` +
    `succeeds from an allowlisted machine. Find this host's egress IP with \`curl -s ifconfig.me\` from inside ` +
    `the container and have it added.` +
    (gist ? ` Page said: "${gist}"` : "")
  );
}

/** Download a UC export file (absolute URL from the export-job status). */
export async function ucDownload(fileUrl: string): Promise<string> {
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`UC export download failed: HTTP ${res.status}`);
  return res.text();
}
