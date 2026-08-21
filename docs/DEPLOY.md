# Deploying behind Cloudflare Access

**Status: live and confirmed 2026-08-20.** Screener, fundamental gate, top-10 cap, company tooltips and ticker lookup all deployed. A real one-time-PIN login reached the
screener at `https://screener.williamstradingplatform.com`.

Three users, email allowlist, no auth code beyond JWT verification. Everything
here needs your Cloudflare and Vercel accounts, so these are steps for you to
run, not steps the repo can perform.

## The thing most people get wrong

Putting Access in front of Vercel protects the **custom domain**. It does not
protect `your-project.vercel.app`, which resolves straight to Vercel and never
touches Cloudflare's network. Anyone who learns that hostname walks in.

`proxy.ts` closes that hole by verifying the signed assertion Access attaches to
every proxied request. A request arriving at the bare Vercel URL carries no
assertion and is refused. Keep that file, or the side door reopens.

Verified locally:

| Condition | Response |
|---|---|
| Production, `CF_ACCESS_*` unset | `503` — fails closed |
| Configured, no assertion | `401` |
| Forged assertion | `401` |
| `NODE_ENV=development` | allowed, so local work is not blocked |

---

## 1. Deploy to Vercel — DONE 2026-08-20

Project `shonuff-7b68/ai-revolution-screener`, live at
`https://ai-revolution-screener.vercel.app`.

Production environment variables already set: `POLYGON_API_KEY`,
`SEC_EDGAR_USER_AGENT`, `CF_ACCESS_TEAM_DOMAIN`, `ALLOWED_EMAILS`,
`CRON_SECRET`, `FINNHUB_API_KEY`.

`CF_ACCESS_AUD` was added 2026-08-20 and the app redeployed. Still to add:
**`DATABASE_URL`** (Neon pooled string).

### Live configuration

| Item | Value |
|---|---|
| Custom domain | `screener.williamstradingplatform.com` |
| DNS | `A screener 76.76.21.21`, **proxied** |
| SSL/TLS mode | Full (Strict) |
| Access app | `screener`, self-hosted, Public DNS |
| Policy | `screener-allowlist`, Allow, rule type Emails |
| Session | 24 hours |

Verified end to end after the redeploy:

| Path | Result |
|---|---|
| `screener.williamstradingplatform.com` | `302` to the Access login, `kid` matching the AUD |
| `ai-revolution-screener.vercel.app` | `401` no assertion |
| `.../api/screen` on the alias | `401`, no data leaked |
| Forged assertion | `401`, algorithm-confusion rejected |

### Vercel SSO stays enabled

The project defaults to
`ssoProtection.deploymentType = "all_except_custom_domains"`. That exempts
production custom domains, so it never intercepts the three allowlisted users,
who arrive via the custom domain. What it *does* protect is the `*.vercel.app`
hostname — precisely the back door Cloudflare Access cannot see. Leave it on.

Check it any time with `vercel project protection`.

**But do not mistake SSO for full coverage.** Measured 2026-08-20 against the
live deployment:

| URL | Guarded by |
|---|---|
| `ai-revolution-screener.vercel.app` (production alias) | **`proxy.ts` only** — SSO does not apply |
| `ai-revolution-screener-shonuff-7b68.vercel.app` | SSO (302) |
| `ai-revolution-screener-<hash>-shonuff-7b68.vercel.app` | SSO (302) |

Vercel counts the clean production alias as a production domain, so
`all_except_custom_domains` exempts it as well. That URL is protected by the
assertion check in `proxy.ts` and nothing else. Delete `proxy.ts` and it serves
the full screener, and a Polygon-spending `/api/screen`, to anyone who types
it.

## 2. Point a domain at it

Access needs a hostname on Cloudflare. Add your domain to Cloudflare (Websites →
Add a site), move the nameservers, then in Vercel add the same domain under
**Settings → Domains**. Create the `CNAME` Vercel asks for in Cloudflare DNS and
leave it **proxied** (orange cloud). Grey-clouded records bypass Cloudflare and
therefore bypass Access.

## 3. Create the Access application

Cloudflare dashboard → **Zero Trust → Access → Applications → Add an
application → Self-hosted**.

- **Application domain:** the hostname from step 2
- **Session duration:** 24 hours is reasonable at this size
- **Policy:** Action `Allow`, rule type **Emails**, listing exactly the three
  addresses in `ALLOWED_EMAILS` (see `.env.local`; they are deliberately not
  written into this tracked file)

### One-time PIN must be added explicitly

Cloudflare's own wording: *"If you do not add an identity provider, a one-time
pin will be the default login method."* The inverse is the trap. This account
already had a **Cloudflare** identity provider, which displaced the default, so
the login screen offered only "Sign in with Cloudflare" and **no email box at
all** — unusable for anyone without a Cloudflare account.

Fix: **Team & Resources → Identity providers → Add an identity provider →
One-time PIN**. Added 2026-08-20; the login screen then shows Cloudflare *or*
an Email field with "Send login code".

Note the login page displays the label `proud-flower-7b68.cloudflareaccess.com`
while the real team domain is `shonuff-7b68.cloudflareaccess.com` — confirmed by
the redirect host, the signing `kid`, and the fact that proud-flower's JWKS
endpoint 404s. Cosmetic only; `CF_ACCESS_TEAM_DOMAIN` must stay `shonuff-7b68`.

When it saves, open the application's **Overview** tab and copy the
**Application Audience (AUD) Tag**.

## 4. Hand the app its half of the configuration

Back in Vercel environment variables:

| Name | Value |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | `shonuff-7b68.cloudflareaccess.com` (already set) |
| `CF_ACCESS_AUD` | the AUD tag from step 3 |
| `ALLOWED_EMAILS` | the same three addresses, comma separated, lowercase |

Redeploy. `ALLOWED_EMAILS` duplicates the Cloudflare policy on purpose: it lives
in git, so loosening the dashboard policy by accident does not silently widen
access.

## 5. Check it

```bash
# Through the custom domain: expect the Access login screen.
curl -sI https://screener.yourdomain.com | head -1

# Direct to Vercel, bypassing Cloudflare: expect 401, NOT 200.
curl -s -o /dev/null -w '%{http_code}\n' https://your-project.vercel.app
```

That second command is the one worth running. A `200` there means the assertion
check is not running and the app is public.

---

## Cron

`vercel.json` schedules `/api/refresh` at 22:00 UTC on weekdays. Vercel Cron
calls the deployment directly and carries no Access identity, so `proxy.ts`
exempts that path and the route authenticates with `CRON_SECRET` instead.

Note the data is delayed end-of-day: the newest session available is the
previous trading day, so a 22:00 UTC run picks up that day's close.

## Rotating a key

Change it in `~/.secrets/shared.env`, update the Vercel variable, redeploy.
Nothing in the browser bundle ever holds a secret — every value here is read
server-side, and none carries a `NEXT_PUBLIC_` prefix.
