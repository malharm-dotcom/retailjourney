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
    const text = await res.text().catch(() => "");
    throw new Error(`UC ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** Download a UC export file (absolute URL from the export-job status). */
export async function ucDownload(fileUrl: string): Promise<string> {
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`UC export download failed: HTTP ${res.status}`);
  return res.text();
}
