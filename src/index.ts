// Google Search Console MCP server for Cloudflare Workers.
// Each person signs in with their own Google account; tools only see the
// Search Console properties that account already has access to.

import {
  OAuthProvider,
  OAuthError,
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type OAuthHelpers,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { env as workerEnv } from "cloudflare:workers";
import { z } from "zod";

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  MCP_RESOURCE: string;
  /** Comma-separated Google account emails allowed to sign in. Empty = nobody. */
  ALLOWED_EMAILS?: string;
}

type Props = {
  email: string;
  name: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
};

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_SCOPES = "openid email profile https://www.googleapis.com/auth/webmasters";
const WEBMASTERS = "https://www.googleapis.com/webmasters/v3";
const INSPECT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

// ---------------------------------------------------------------- Google API

async function refreshGoogle(refreshToken: string, env: Env) {
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  return { ok: res.ok && !!body.access_token, status: res.status, ...body };
}

// Within one tool call: use the token from props, refreshing if it has expired.
async function googleToken(): Promise<string> {
  const props = getMcpAuthContext()?.props as Props | undefined;
  if (!props?.accessToken) throw new Error("Not signed in to Google. Reconnect the connector.");
  if (Date.now() < props.expiresAt - 60_000) return props.accessToken;
  const r = await refreshGoogle(props.refreshToken, workerEnv as unknown as Env);
  if (!r.ok) throw new Error("Google sign-in has expired or was revoked. Reconnect the connector.");
  props.accessToken = r.access_token!;
  props.expiresAt = Date.now() + (r.expires_in ?? 3600) * 1000;
  return props.accessToken;
}

async function gsc(url: string, init: RequestInit = {}): Promise<unknown> {
  const token = await googleToken();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
    } catch {}
    throw new Error(`Search Console API ${res.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : { ok: true };
}

const site = (s: string) => encodeURIComponent(s);
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});

// ---------------------------------------------------------------- MCP tools

const siteUrl = z
  .string()
  .describe("Property as Search Console names it, e.g. 'sc-domain:example.com' or 'https://www.example.com/'. Use list_sites to find it.");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");

function createServer() {
  const server = new McpServer({ name: "Google Search Console", version: "1.0.0" });

  server.registerTool(
    "list_sites",
    {
      description: "List the Search Console properties the signed-in Google account can access, with permission level.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return ok(await gsc(`${WEBMASTERS}/sites`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "search_analytics",
    {
      description:
        "Query Search Console performance data (clicks, impressions, CTR, position). Dates are in Pacific Time. " +
        "Use data_state 'all' to include the latest preliminary days (Search Console's UI default); 'final' for finalised data only. " +
        "Up to 25,000 rows per call; page with start_row.",
      inputSchema: {
        site_url: siteUrl,
        start_date: isoDate,
        end_date: isoDate,
        dimensions: z
          .array(z.enum(["date", "query", "page", "country", "device", "searchAppearance", "hour"]))
          .optional()
          .describe("Group-by dimensions. Omit for a single total row."),
        search_type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional().default("web"),
        filters: z
          .array(
            z.object({
              dimension: z.enum(["query", "page", "country", "device", "searchAppearance"]),
              operator: z
                .enum(["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"])
                .default("equals"),
              expression: z.string(),
            }),
          )
          .optional()
          .describe("All filters are ANDed. Countries are ISO 3166-1 alpha-3 lowercase (aus, nzl). Devices: DESKTOP, MOBILE, TABLET."),
        aggregation_type: z.enum(["auto", "byPage", "byProperty", "byNewsShowcasePanel"]).optional(),
        data_state: z.enum(["final", "all", "hourly_all"]).optional().default("all"),
        row_limit: z.number().int().min(1).max(25000).optional().default(1000),
        start_row: z.number().int().min(0).optional().default(0),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      try {
        const body: Record<string, unknown> = {
          startDate: a.start_date,
          endDate: a.end_date,
          type: a.search_type,
          dataState: a.data_state,
          rowLimit: a.row_limit,
          startRow: a.start_row,
        };
        if (a.dimensions?.length) body.dimensions = a.dimensions;
        if (a.aggregation_type) body.aggregationType = a.aggregation_type;
        if (a.filters?.length) body.dimensionFilterGroups = [{ groupType: "and", filters: a.filters }];
        const r = (await gsc(`${WEBMASTERS}/sites/${site(a.site_url)}/searchAnalytics/query`, {
          method: "POST",
          body: JSON.stringify(body),
        })) as { rows?: unknown[]; responseAggregationType?: string; metadata?: unknown };
        return ok({
          rowCount: r.rows?.length ?? 0,
          responseAggregationType: r.responseAggregationType,
          metadata: r.metadata,
          rows: r.rows ?? [],
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "inspect_url",
    {
      description:
        "Inspect one URL in Google's index: coverage/index status, Google-selected vs user canonical, last crawl, robots, mobile usability and rich results. Quota: about 2,000 per property per day.",
      inputSchema: {
        site_url: siteUrl,
        url: z.string().url().describe("Full URL to inspect; must belong to site_url."),
        language_code: z.string().optional().default("en-AU"),
      },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      try {
        return ok(
          await gsc(INSPECT, {
            method: "POST",
            body: JSON.stringify({ inspectionUrl: a.url, siteUrl: a.site_url, languageCode: a.language_code }),
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_sitemaps",
    {
      description: "List sitemaps submitted for a property, with last download, warnings, errors and indexed counts.",
      inputSchema: { site_url: siteUrl },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      try {
        return ok(await gsc(`${WEBMASTERS}/sites/${site(a.site_url)}/sitemaps`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "submit_sitemap",
    {
      description: "Submit or resubmit a sitemap URL to Search Console, asking Google to recrawl it.",
      inputSchema: {
        site_url: siteUrl,
        sitemap_url: z.string().url().describe("Full sitemap URL, e.g. https://www.example.com/sitemap.xml"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (a) => {
      try {
        await gsc(`${WEBMASTERS}/sites/${site(a.site_url)}/sitemaps/${site(a.sitemap_url)}`, { method: "PUT" });
        return ok({ submitted: a.sitemap_url });
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

// ---------------------------------------------------------------- sign-in flow

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#1f1f1f}
h1{font-size:22px}.box{border:1px solid #ddd;border-radius:10px;padding:16px 20px}
button{font:inherit;padding:8px 18px;border-radius:8px;border:1px solid #888;background:#fff;cursor:pointer;margin-right:8px}
button.primary{background:#1a73e8;color:#fff;border-color:#1a73e8}.warn{color:#b3261e}</style>
<body>${body}</body></html>`;
}

function consentPage(d: ConsentDescription, handle: string) {
  const who = d.clientDomain
    ? `Published by <strong>${esc(d.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  return page(
    "Connect Search Console",
    `<h1>Allow ${esc(d.clientName)} to use Google Search Console?</h1>
<div class="box"><p>${who} Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ""}
<p>Next you'll sign in with Google. The app can read performance data, inspect URLs and submit sitemaps for the Search Console properties your Google account can already access.</p>
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<button class="primary" name="decision" value="approve">Continue with Google</button><button name="decision" value="deny">Cancel</button></form></div>`,
  );
}

const textError = (msg: string, status = 400) =>
  new Response(page("Sign-in problem", `<h1>Sign-in problem</h1><p>${esc(msg)}</p>`), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

async function sha256b64url(input: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const defaultHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const oauth = env.OAUTH_PROVIDER;
    try {
      if (url.pathname === "/") {
        return new Response(
          page("Search Console MCP", `<h1>Google Search Console MCP</h1><p>Add <code>${esc(env.MCP_RESOURCE)}</code> as a custom connector in Claude or Grok.</p>`),
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      }

      if (url.pathname === "/authorize" && req.method === "GET") {
        const request = await oauth.parseAuthRequest(req);
        const details = await oauth.describeConsent(request);
        const consent = await oauth.beginConsent(request);
        consent.headers.set("Content-Type", "text/html; charset=utf-8");
        return new Response(consentPage(details, consent.handle), { headers: consent.headers });
      }

      if (url.pathname === "/authorize" && req.method === "POST") {
        const form = await req.formData();
        const handle = String(form.get("handle"));
        if (form.get("decision") !== "approve") {
          const denied = await oauth.denyConsent(req, handle);
          return new Response(null, { status: 302, headers: denied.headers });
        }
        const approved = await oauth.approveConsent(req, handle);
        const verifier = crypto.randomUUID() + crypto.randomUUID();
        const { state, headers } = await oauth.beginUpstream(approved.request, {
          data: { verifier },
          headers: approved.headers,
        });
        const g = new URL(GOOGLE_AUTH);
        g.search = new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          redirect_uri: `${url.origin}/callback`,
          response_type: "code",
          scope: GOOGLE_SCOPES,
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "true",
          state,
          code_challenge: await sha256b64url(verifier),
          code_challenge_method: "S256",
        }).toString();
        headers.set("Location", g.toString());
        return new Response(null, { status: 302, headers });
      }

      if (url.pathname === "/callback") {
        const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
        const code = url.searchParams.get("code");
        if (url.searchParams.get("error") || !code) {
          headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
          return new Response(null, { status: 302, headers });
        }
        const tokRes = await fetch(GOOGLE_TOKEN, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            code,
            code_verifier: data.verifier,
            grant_type: "authorization_code",
            redirect_uri: `${url.origin}/callback`,
          }),
        });
        const tok = (await tokRes.json()) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          scope?: string;
        };
        if (!tokRes.ok || !tok.access_token) return textError("Google did not return a token. Please try again.", 502);
        if (!tok.scope?.includes("webmasters")) {
          return textError("Search Console access wasn't granted. Start again and tick the Search Console permission.");
        }
        if (!tok.refresh_token) return textError("Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.");

        const uiRes = await fetch(GOOGLE_USERINFO, { headers: { Authorization: `Bearer ${tok.access_token}` } });
        const ui = (await uiRes.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
        if (!ui.sub || !ui.email || !ui.email_verified) return textError("Couldn't verify your Google account email.");

        const allowed = (env.ALLOWED_EMAILS ?? "")
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        if (!allowed.includes(ui.email.toLowerCase())) {
          headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
          return new Response(null, { status: 302, headers });
        }

        const props: Props = {
          email: ui.email,
          name: ui.name ?? ui.email,
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token,
          expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000,
        };
        const { redirectTo } = await oauth.completeAuthorization({
          request: original,
          userId: ui.sub,
          metadata: { email: ui.email },
          scope: original.scope,
          props,
        });
        headers.set("Location", redirectTo);
        return new Response(null, { status: 302, headers });
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError) return textError(error.description ?? "This sign-in link has expired. Start again from Claude or Grok.");
      if (error instanceof CimdFetchError) return textError("This app could not be verified.");
      throw error;
    }
  },
};

// ---------------------------------------------------------------- provider

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      return mcpHandler(request, env, ctx);
    },
  },
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: { resource: (workerEnv as unknown as Env).MCP_RESOURCE },
  refreshTokenTTL: 60 * 60 * 24 * 90,
  // Keep our access token no longer-lived than Google's, and refresh Google's on each refresh.
  tokenExchangeCallback: async ({ grantType, props, env }) => {
    const p = props as Props;
    if (grantType === "authorization_code") {
      return { accessTokenTTL: Math.max(300, Math.floor((p.expiresAt - Date.now()) / 1000) - 120) };
    }
    if (grantType === "refresh_token") {
      const r = await refreshGoogle(p.refreshToken, env as Env);
      if (r.error === "invalid_grant") throw new OAuthError("invalid_grant", { description: "Google access was revoked" });
      if (!r.ok) throw new OAuthError("temporarily_unavailable", { description: "Google is unavailable", statusCode: 503 });
      const next: Props = { ...p, accessToken: r.access_token!, expiresAt: Date.now() + (r.expires_in ?? 3600) * 1000 };
      return { newProps: next, accessTokenTTL: Math.max(300, (r.expires_in ?? 3600) - 120) };
    }
  },
});
