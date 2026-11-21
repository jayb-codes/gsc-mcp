# Google Search Console MCP (House of Aloha / Mana for Men)

A remote MCP server on Cloudflare Workers that lets Claude or Grok query Google Search Console for House of Aloha and Mana for Men. You sign in with your own Google account and see only the properties that account can already access. Sign-in is limited to the emails in `ALLOWED_EMAILS` (`wrangler.jsonc`).

Endpoint: `https://gsc-mcp.ikaika-creative.workers.dev/mcp`

## Tools

| Tool | What it does |
| --- | --- |
| `list_sites` | Properties the signed-in account can access |
| `search_analytics` | Clicks, impressions, CTR and position by date, query, page, country, device, search appearance or hour, with filters. `data_state: "all"` includes preliminary days |
| `inspect_url` | URL Inspection: index status, canonicals, last crawl, rich results |
| `list_sitemaps` | Submitted sitemaps, with errors and warnings |
| `submit_sitemap` | Submit or resubmit a sitemap |

## Setup

### 1. One Google account for both brands (recommended)

`jay@houseofaloha.com.au` is a Google Workspace account. `jay%manaformen.com.au@gtempaccount.com` is a regular Google account (one made for a non-Gmail address), not part of that Workspace.

The simplest setup is to use **jay@houseofaloha.com.au for both**: in Search Console, open the Mana for Men property → **Settings → Users and permissions → Add user**, add `jay@houseofaloha.com.au` with **Owner** or **Full** permission. Then the Google app can be **Internal** (step 2), which needs no Google verification and never signs you out every 7 days.

If you'd rather keep signing in with the Mana account, use **External** instead (see the note in step 2).

### 2. Google OAuth client (Google Cloud console, signed in as jay@houseofaloha.com.au)

1. Create a project (e.g. `house-of-aloha-mcp`) or pick an existing one in the houseofaloha.com.au organisation.
2. **APIs & Services → Library**: enable the **Google Search Console API**.
3. **Google Auth Platform → Branding / Audience**: set the user type to **Internal**.
4. **Data Access**: add the scopes `openid`, `email`, `profile` and `https://www.googleapis.com/auth/webmasters`.
5. **Clients → Create client**: type **Web application**.
   - Authorised redirect URI: `https://gsc-mcp.ikaika-creative.workers.dev/callback`
6. Copy the client ID and client secret.

**External instead of Internal:** if the Mana account must sign in directly, set the user type to **External**, add both emails as test users, then click **Publish app**. In **Testing**, Google expires sign-ins after 7 days. Once published but unverified, you'll see a "Google hasn't verified this app" screen when signing in; click **Advanced → Go to …** to continue. That's fine for personal use.

### 3. Deploy on Cloudflare (ikaika account)

1. **Workers & Pages → Create → Import a repository**. Pick `jayb-codes/gsc-mcp`.
2. Keep the project name `gsc-mcp` and the deploy command `npx wrangler deploy`, then click **Deploy**.
3. In the Worker, go to **Settings → Variables and Secrets** and add two **Secrets**:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
4. Every push to `main` redeploys the Worker.

The KV namespace `gsc-mcp-oauth` already exists in the ikaika account, and its ID is set in `wrangler.jsonc`.

### 4. Add to Claude or Grok

- **Claude:** Settings → Connectors → **Add custom connector**. Keep "Sign in now" and "Use Claude's published identity".
- **Grok:** grok.com/connectors → **New Connector → Custom**.

Name it `Search Console (HoA + Mana)` with URL `https://gsc-mcp.ikaika-creative.workers.dev/mcp`. Click Connect, approve the consent page, then sign in with Google.

## Security notes

- Only the emails in `ALLOWED_EMAILS` can sign in. If it's empty, nobody can.
- Google tokens are stored only inside encrypted OAuth grants in KV. The AI client receives this server's own tokens, never Google's.
- The consent page is shown per client, is cookie-bound and can't be framed.
- Grants last 90 days. Revoke access at any time at myaccount.google.com/permissions.

## Local development

```sh
npm install
printf 'GOOGLE_CLIENT_ID=...\nGOOGLE_CLIENT_SECRET=...\n' > .dev.vars
npx wrangler dev --var MCP_RESOURCE:http://localhost:8787/mcp
```

For local sign-in, add `http://localhost:8787/callback` as a redirect URI on the OAuth client.
