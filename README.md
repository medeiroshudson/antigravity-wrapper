# Antigravity Wrapper

An OpenAI-compatible API in front of Google Antigravity / Cloud Code Assist models,
backed by a **pool of Google accounts** that is load-balanced by remaining quota.

Point any OpenAI client at this service's `baseURL` and you get the Antigravity model
catalog without knowing anything about the `v1internal` protocol. Requests are spread
across the Google accounts you register, so the quota ceiling stops being per-account:
what you can spend is the sum of every account in the pool.

> [!WARNING]
> **Unofficial integration.** Not affiliated with, endorsed by, or supported by Google.
> It rides the Antigravity application's own first-party channel, which is **not a public
> API and carries no stability contract** — a backend change can break it without notice.
> Use it only with accounts and services you are authorised to access.

---

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Authentication](#authentication)
- [Obtaining the OAuth client credentials](#obtaining-the-oauth-client-credentials)
- [Adding accounts](#adding-accounts)
- [Account lifecycle](#account-lifecycle)
- [Using it from an OpenAI client](#using-it-from-an-openai-client)
- [Models and reasoning effort](#models-and-reasoning-effort)
- [Tool calling](#tool-calling)
- [Configuration](#configuration)
- [How load balancing works](#how-load-balancing-works)
- [Security and operations](#security-and-operations)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

---

## Requirements

- Node.js **22.13 or later** (the storage layer uses the built-in `node:sqlite`), or Docker.
- At least one Google account holding a paid tier (the wrapper reports the tier it discovers).
- A browser, to complete the Google consent step. It may be on a different machine than
  the server — see [Adding accounts](#adding-accounts).
- An OAuth client id and secret for the Antigravity client — see
  [Obtaining the OAuth client credentials](#obtaining-the-oauth-client-credentials).

---

## Quick start

`docker-compose.yml` requires `API_KEY`, `ANTIGRAVITY_CLIENT_ID` and
`ANTIGRAVITY_CLIENT_SECRET`. It fails at startup without them, on purpose — a service
holding Google refresh tokens should not boot half-configured.

```bash
cp .env.example .env       # fill in the three values; .env is git-ignored
docker compose up --build
```

```bash
curl -s http://127.0.0.1:3000/health -H "Authorization: Bearer $API_KEY"
# → {"status":"ok"}
```

The chat route works as soon as the pool has an account in it:

```bash
curl -s http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

With an empty pool it answers `503` and names the reason — that is the expected state
before you register an account, not a misconfiguration.

> **`Authorization: Bearer <API_KEY>` is required on every route**, including `/health`
> and `/admin`. There is no unauthenticated surface, which is why the container's own
> healthcheck sends the header too.

---

## Authentication

Two separate credentials are in play, and conflating them is the most common setup mistake.

| Credential | What it authenticates | Where it lives |
|---|---|---|
| `API_KEY` | **Callers → this wrapper.** Your own shared secret, protecting every route. | You choose it; `.env` |
| `ANTIGRAVITY_CLIENT_ID` / `_CLIENT_SECRET` | **This wrapper → Google**, for the OAuth login that registers accounts. | `.env`; see below |

`API_KEY` fails closed: absent, empty, or containing Bearer-invalid characters
(whitespace, comma) and the process refuses to start.

The login uses **OAuth 2.0 Authorization Code with PKCE (S256)**. It requests these scopes:

| Scope | Why the API needs it |
|---|---|
| `auth/aicode` | Access to the Cloud Code Assist / Antigravity model catalog and endpoints |
| `auth/cloud-platform` | General Cloud Code Assist API access |
| `auth/userinfo.email`, `auth/userinfo.profile` | Identify the signed-in account |
| `auth/cclog` | The logging/telemetry endpoints the API itself calls |
| `auth/experimentsandconfigs` | Server-side experiment and config flags for the API |

---

## Obtaining the OAuth client credentials

The consent URL needs a `client_id`, and the token exchange needs the matching secret.
**This repository ships neither** — the design decision is that a third party's
credential is not redistributed here, so each deployment obtains its own.

### Why you cannot simply register your own OAuth client

Three of the six scopes above — `aicode`, `cclog` and `experimentsandconfigs` — are
Google-internal. A client you register in Google Cloud Console will be rejected at the
consent screen for requesting them. This is a provider restriction, not a configuration
error, and no amount of console fiddling changes it.

Practical consequence: the working client is the one the Antigravity application itself
ships with, which is why it grants those scopes.

### Option A — extract it from an installed Antigravity or Gemini CLI

If you already have one of those installed, the client is in the package. Search the
install directory (typically under `~/.npm`, `/usr/lib/node_modules`, or the application
bundle) for the client-id shape:

```bash
grep -roh '[0-9]\{6,\}-[a-z0-9]\{10,\}\.apps\.googleusercontent\.com' \
  ~/.npm /usr/lib/node_modules "$HOME/Library/Application Support" 2>/dev/null | sort -u
```

Then locate the `GOCSPX-` string near it in the same package to get the secret. Sanity-check
before use: the id ends in `.apps.googleusercontent.com` and the secret starts with
`GOCSPX-`. A pair that fails either check is the wrong literal.

### Option B — set your own values

`ANTIGRAVITY_CLIENT_ID` and `ANTIGRAVITY_CLIENT_SECRET` are plain environment variables.
If you obtain a working pair by any other route — including one issued to an app that is
permitted the internal scopes — set it there and the wrapper uses it.

> [!CAUTION]
> **Treat the secret as sensitive in your deployment, even though it is publicly known.**
> It is a shared third-party client: whoever holds it can initiate consent flows as that
> application. Keep it in `.env` (git-ignored) or your secret manager — never in a commit,
> an image layer, an issue, or a log. The `docker-compose.yml` intentionally requires the
> variable with no default, so a missing value stops the stack instead of embedding one.

---

## Adding accounts

Logging in takes **two HTTP calls** and needs no installed client on the operator's
machine, because the consent step happens in a browser that may be anywhere.

### 1. Start the login

```bash
curl -s -X POST http://127.0.0.1:3000/admin/accounts/start \
  -H "Authorization: Bearer $API_KEY"
```

No request body — the endpoint takes no parameters. It mints a PKCE verifier plus a
one-time `state`, stores the verifier against that state, and returns the consent URL:

```json
{
  "authUrl": "https://accounts.google.com/o/oauth2/v2/auth?client_id=…&code_challenge=…&state=…",
  "state": "4Gi6srHgBAxluADBMwUjGTSC7bsbuxu387SWWDhBH_M"
}
```

The `state` is drawn independently of the PKCE verifier, so a leaked callback URL cannot
reveal the verifier needed to mint tokens.

### 2. Consent in a browser

Open the `authUrl` **in any browser, on any machine**, and sign in with the account you
want in the pool. At the end the browser is redirected to
`http://localhost:51121/oauth-callback?code=…&state=…` and **fails to load — that is
expected and correct.**

That address is the transport for the authorization code, not a service you are running.
Nothing in this project listens on port 51121. **Copy the full URL out of the address
bar**; the `code` and `state` you need are in it.

> [!IMPORTANT]
> - **The `state` is single-use and expires after 5 minutes.** If it lapses, restart from
>   step 1 — the old URL is dead.
> - **Do not change the port.** `redirect_uri` must match a URI registered for the OAuth
>   client exactly, and this client has `http://localhost:51121/oauth-callback`
>   registered. Pointing it elsewhere fails the consent with `redirect_uri_mismatch`.
> - **Close any running Antigravity or Gemini CLI session first.** If either is listening
>   on 51121 it can consume your authorization code before you copy it, and the code is
>   single-use — the next step then fails with `invalid_grant` and cannot be retried.

### 3. Complete the login

Paste the whole callback URL as `callbackUrl` — the only field this endpoint accepts:

```bash
curl -s -X POST http://127.0.0.1:3000/admin/accounts/complete \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"callbackUrl": "http://localhost:51121/oauth-callback?code=4/0AX…&state=4Gi6sr…"}'
```

The wrapper checks the `state`, exchanges the code for tokens, discovers the account's
`projectId` and paid tier, reads the account's email (best-effort — a failure here does
not fail the login), and stores everything:

```json
{
  "account": {
    "id": "account-3f2a91bc77de0d14",
    "email": "h***n@gmail.com",
    "projectId": "aicode-consumers",
    "status": "active",
    "cooldownUntil": null,
    "lastError": null,
    "enabled": true,
    "priority": 0,
    "createdAt": 1760399400000,
    "lastUsedAt": null
  },
  "paidTier": "Google AI Pro"
}
```

`paidTier` is `null` when the backend reports no paid tier for the account. The account
is still registered and usable, but expect no usable quota. The email is always returned
**masked**; when it could not be read, `id` is the only label.

Adding more accounts is repeating these three steps, with the same Google account or a
different one. Each `start` mints an independent `state`, so logins can even run in
parallel. The account `id` is randomly drawn at `complete` time, not derived from the
email.

### Error responses from this flow

| Response | Meaning |
|---|---|
| `500` + "…sao obrigatorios" | `ANTIGRAVITY_CLIENT_ID` / `_CLIENT_SECRET` missing from the process environment |
| `400` `callbackUrl e obrigatorio` | Empty or absent body field |
| `400` `callbackUrl invalida` | Not parseable as a URL — usually a bare query string instead of the full URL |
| `400` `callbackUrl sem code ou state` | URL parsed, but one of the two query parameters is absent |
| `400` `state desconhecido ou expirado` | The `state` was already consumed, never existed, or passed its 5-minute TTL |

---

## Account lifecycle

Every route below requires `Authorization: Bearer $API_KEY`. Replace
`account-3f2a91bc77de0d14` with an id from the listing.

### List the pool

```bash
curl -s http://127.0.0.1:3000/admin/accounts -H "Authorization: Bearer $API_KEY"
```

```json
{
  "accounts": [
    {
      "id": "account-3f2a91bc77de0d14",
      "email": "h***n@gmail.com",
      "projectId": "aicode-consumers",
      "status": "active",
      "cooldownUntil": null,
      "lastError": null,
      "enabled": true,
      "priority": 0,
      "createdAt": 1760399400000,
      "lastUsedAt": 1760400012345
    }
  ]
}
```

No token field is ever serialized on any account response — `refreshToken` and
`accessToken` exist only in the SQLite file.

### Inspect one account

```bash
curl -s http://127.0.0.1:3000/admin/accounts/account-3f2a91bc77de0d14 \
  -H "Authorization: Bearer $API_KEY"
```

Returns `{ "account": { … }, "quota": [ … ] }`, where each quota row is
`{ accountId, modelId, window, remainingFraction, resetAt, fetchedAt }`.

### Park an account without deleting it

Disabling keeps the tokens and history but removes the account from rotation:

```bash
curl -s -X PATCH http://127.0.0.1:3000/admin/accounts/account-3f2a91bc77de0d14 \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

### Pin a preferred account

Explicit `priority` outranks quota in the ordering, so this is how you make one account
be tried first:

```bash
curl -s -X PATCH http://127.0.0.1:3000/admin/accounts/account-3f2a91bc77de0d14 \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"priority": 10}'
```

Both fields are optional and independent; send one or both. An unknown id returns `404`.

### Refresh one account's quota

Forces a token refresh if needed, re-reads the catalog, and rewrites that account's
quota snapshot:

```bash
curl -s -X POST http://127.0.0.1:3000/admin/accounts/account-3f2a91bc77de0d14/refresh \
  -H "Authorization: Bearer $API_KEY"
```

### Inspect the whole pool's quota

```bash
curl -s http://127.0.0.1:3000/admin/accounts/quota -H "Authorization: Bearer $API_KEY"
```

```json
{
  "accounts": [
    {
      "id": "account-3f2a91bc77de0d14",
      "email": "h***n@gmail.com",
      "status": "active",
      "quota": [
        {
          "modelId": "gemini-3.8-flash-low",
          "window": "model",
          "remainingFraction": 0.8,
          "resetAt": 1760794413000,
          "fetchedAt": 1760400012345
        }
      ]
    }
  ]
}
```

This is the data the selection order is built from, so it is the view to check when you
want to confirm the pool is actually being balanced by quota rather than by round-robin.
A row appears only after a refresh has measured it, so a freshly added account shows an
empty `quota` array and is treated as *unknown* by the selector — sorted last, not assumed
full. Availability, quota groups and reset times are returned by the service and differ
per account.

### Remove an account

Deletes the account **and** its quota rows:

```bash
curl -s -X DELETE http://127.0.0.1:3000/admin/accounts/account-3f2a91bc77de0d14 \
  -H "Authorization: Bearer $API_KEY"
```

```json
{ "removed": "account-3f2a91bc77de0d14" }
```

Removing the last account leaves the pool empty and the chat route answering `503` until
another is registered.

---

## Using it from an OpenAI client

The API speaks the OpenAI wire format, so existing clients work by changing the base URL
and the key. The SDK's `apiKey` carries **this wrapper's** `API_KEY`; upstream
authentication is the pool's business, so no extra header is needed.

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3000/v1",
    api_key="your-wrapper-api-key",
)

response = client.chat.completions.create(
    model="gemini-3.8-flash",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)
```

### Node

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:3000/v1",
  apiKey: process.env.API_KEY!,
});

const response = await client.chat.completions.create({
  model: "gemini-3.8-flash",
  messages: [{ role: "user", content: "Hello" }],
});

console.log(response.choices[0]?.message.content);
```

### Streaming

Real server-sent events. Every chunk carries `delta.role` on the first frame, and the
stream terminates with `data: [DONE]`:

```bash
curl -N -s http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.8-flash","stream":true,"messages":[{"role":"user","content":"Count to three."}]}'
```

If a failure happens **after** the first byte has left, the error arrives as a
`data: {"error":{…}}` frame followed by an explicit `[DONE]`, so a client keyed on
`[DONE]` does not sit waiting on a truncated stream.

---

## Models and reasoning effort

Select a **public model id** and, optionally, a `reasoning_effort`. The wrapper resolves
the backend's runtime id and thinking budget itself, so the public ids survive the
backend renaming things underneath.

```bash
curl -s http://127.0.0.1:3000/v1/models -H "Authorization: Bearer $API_KEY"
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "gemini-3.8-flash",
      "object": "model",
      "owned_by": "antigravity",
      "context_length": 1048576,
      "max_model_len": 1048576,
      "max_output_tokens": 65536
    }
  ]
}
```

The static table is the conservative fallback; the wrapper also refreshes the catalogs the
accounts actually advertise, so a model newly enabled for your account becomes selectable
without a code change. Some ids are only advertised to paid tiers.

`reasoning_effort` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. It maps to
the backend's own thinking levels; an unknown value falls back to `off` rather than
failing the request.

`max_tokens` is clamped to the ceiling the backend accepts for the resolved model, so
asking for more than the model allows cannot produce a `400`.

---

## Tool calling

Tools use the OpenAI function shape. Set `tool_choice` to `"required"`, to
`{"type":"function","function":{"name":"…"}}`, or to `"none"`.

> **`tool_choice` is emulated, not native.** The backend accepts its own
> `functionCallingConfig.mode` field and then ignores it — `AUTO`, `NONE` and `ANY` were
> measured to behave identically, and `NONE` still called the tool. The wrapper therefore
> expresses your intent in the prompt. It also means `none` is a strong request, not a
> guarantee: a model that ignores the instruction can still emit a call.

```bash
curl -s http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash",
    "tool_choice": "required",
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Current weather for a city",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }],
    "messages": [{"role": "user", "content": "What is the weather in Paris?"}]
  }'
```

The response carries `finish_reason: "tool_calls"` and a `tool_calls` array. Send the
result back on the next turn:

```bash
curl -s http://127.0.0.1:3000/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash",
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Current weather for a city",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
      }
    }],
    "messages": [
      {"role": "user", "content": "What is the weather in Paris?"},
      {"role": "assistant", "content": null, "tool_calls": [
        {"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\":\"Paris\"}"}}
      ]},
      {"role": "tool", "tool_call_id": "call_1", "name": "get_weather", "content": "{\"temp_c\":18}"}
    ]
  }'
```

> [!IMPORTANT]
> **Echo `thoughtSignature` back verbatim.** Gemini tool calls come back with an extra
> `thoughtSignature` field on each tool call. It is the continuity token for the exchange:
> re-send the assistant message exactly as you received it, signature included. The
> wrapper preserves it in both the streaming and non-streaming responses and re-attaches a
> signature you send back. Omitting it is not corrected for you — the backend is the one
> that rejects a continuation it cannot verify.

Tool schemas are encoded per model family, because the backend requires different shapes:
Gemini receives full JSON Schema, while Claude and GPT-OSS receive the legacy
`parameters` field restricted to the allowed subset. The reason is failure mode — with the
legacy field an invalid schema is rejected outright, whereas the other path was measured
to accept the request and then silently not call the tool.

---

## Configuration

All configuration is environment variables. Names are listed in `.env.example`; no secret
is embedded in the code.

| Variable | Default | Description |
|---|---:|---|
| `API_KEY` | required | Ingress credential; `Bearer` on **every** route |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Bind address and port |
| `DB_PATH` | `./data/antigravity.db` | SQLite file (in the container: `/app/data/antigravity.db`) |
| `ANTIGRAVITY_CLIENT_ID` | — | OAuth client id (required) |
| `ANTIGRAVITY_CLIENT_SECRET` | — | OAuth client secret (required) |
| `ANTIGRAVITY_BASE_URL` | — | Override the upstream base; `https` only, host must be `*.googleapis.com` |
| `ANTIGRAVITY_USER_AGENT` | CLI 1.2.4 fingerprint | Override the request fingerprint |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Upstream request timeout |
| `STREAM_HEADER_TIMEOUT_MS` | `180000` | Deadline for the stream's response headers |
| `STREAM_STALL_TIMEOUT_MS` | `120000` | Deadline for silence mid-stream |
| `QUOTA_REFRESH_TTL_MS` | `300000` | Quota snapshot TTL |
| `MODELS_TTL_MS` | `14400000` | Model catalog TTL |
| `COOLDOWN_TRANSIENT_MS` | `60000` | Fallback cooldown when a quota wall names no reset time |
| `TRANSIENT_RETRY_BACKOFF_MS` | `1000` | Wait before retrying the same account after a transient throttle (`0` retries at once) |
| `MAX_FAILOVER_ATTEMPTS` | `3` | Ceiling on accounts tried per request |
| `LOG_LEVEL` | `info` | Logger level |
| `APP_LOCALE` | `en-US` | Locale for the messages the API returns; an unknown value falls back to `en-US` |

`ANTIGRAVITY_BASE_URL` is deliberately restrictive: it accepts only `https` URLs on a
Google APIs host. That guard exists so a poisoned value cannot be used to exfiltrate the
bearer token to an arbitrary server.

---

## How load balancing works

Account selection happens **before** the stream starts, as a pure function over a snapshot
of the pool. Candidates are ordered like this:

1. **Filter** — keep only accounts that are `enabled` and `active` (or `cooldown` with an
   expiry that has already passed).
2. **Known quota before unknown** — accounts with a measured, healthy quota for the
   requested model come first; accounts whose quota is **unknown** come last. Unknown quota
   is deliberately neutral: not zero (which would exclude every newly added account) and
   not full (which would make a new account always win).
3. **Descending quota** — within each partition, the highest `remainingFraction` first,
   with ties broken by whichever account was used longest ago, which spreads load.
4. **Priority overrides all of it** — an explicit `priority` sorts ahead of the quota tiers.

**Cooldown on a quota wall.** A `429` carrying a wall signal (`Resets in …`, quota
exceeded) puts the account in `cooldown` until the reset time the backend named.

**A transient `429` does neither.** Throttling that carries no wall signal — pressure on
the backend, not an exhausted quota — leaves the pool untouched: the account stays
eligible, the request retries it once after `TRANSIENT_RETRY_BACKOFF_MS`, and only then
moves on. Cooling the account down instead would sideline a healthy account for the whole
cooldown window, which with a one-account pool means every request answering `503` while
its quota is still nearly full.

**Failover only before the first byte.** The selector returns the whole ordered list and
the transport walks it. While nothing has been written to the client, a recoverable
failure (`429`, `401` after a refresh attempt, `5xx`, timeout) simply moves to the next
account, and the failed account's state is updated so the next request skips it. A `400`
does **not** trigger failover — it is the caller's request that is wrong, and another
account cannot fix it. When every candidate is exhausted the response is `503` carrying
each account's reason, with no token in the message.

---

## Security and operations

### The account database holds long-lived credentials

The SQLite file at `DB_PATH` stores **real Google refresh tokens**. Treat it as sensitive
material:

- It is created with mode `0600`, and the WAL sidecars (`-wal`, `-shm`) are forced to the
  same mode — they hold token plaintext while the connection is open.
- Do not commit it, do not copy it into an image layer, do not share it.
- The compose file keeps it on a named volume (`antigravity-data`) so it lives outside the
  container filesystem and stays under the operator's control.

Backups of that file are backups of your Google credentials. Encrypt them accordingly and
delete them when you revoke an account.

### Protect `/admin`

`/admin` creates and deletes accounts holding Google refresh tokens, and it sits behind the
same single shared `Bearer` credential as everything else — no scoping, no second factor.
Exposed to the internet, one leaked key lets someone register accounts in your pool or
delete yours.

Publish only `/v1/*` if the deployment is reachable from outside. Reach `/admin` over a
private network, an allowlist of source addresses, or not at all.

### Token containment

Tokens are not serialized by any route — the admin surface has a single public-view mapper
with no bypass path, and error messages pass through a redactor that strips Google token
shapes. Accounts are identified to callers by id and masked email only.

### The request fingerprint

Requests carry the Antigravity CLI's `User-Agent`. This is **required, not cosmetic**: a
request without it is answered `403 "You do not have a valid license of this product."`
The backend licenses access by client identity, so the fingerprint is what makes the
signed-in account's entitlement apply. `ANTIGRAVITY_USER_AGENT` overrides it if you need
to pin a different one.

### Revoking access

To drop an account, `DELETE` it and revoke the grant at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions). Deleting the
row alone leaves the refresh token valid at Google until the grant is revoked.

---

## Limitations

- **Failover is impossible mid-stream.** After the reply is hijacked and the first byte is
  written, the headers are on the wire and the account cannot change. If quota runs out
  during a generation, the failure becomes an error frame inside the stream followed by an
  explicit `[DONE]`.
- **The backend ignores `tool_choice`.** `none`, `required` and named-function modes are
  emulated by prompt instruction, not by a native mechanism — see
  [Tool calling](#tool-calling).
- **No stable contract.** This is an application's internal façade, not a public API.
  Backend changes can break it without notice, and model ids, quota grouping and reset
  behaviour are all server-reported and vary per account.
- **One pool, one provider.** Every account draws on the same backend, so there is no
  redundancy if the service itself is unavailable.
- **`content_filter` is reported for safety stops.** A reply blocked by safety or
  recitation policies returns that finish reason rather than a truncation.

Pairing with the running service's own requests, a good first check when something looks
wrong is the pool view — `GET /admin/accounts/quota` shows the quota the selector is
actually working from.

---

## Development

```bash
npm install
npm run dev        # watch mode
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # emit dist/
```

The test suite never touches the network and never opens the real database, so a full run
leaves nothing behind. `docs/CURLS.md` holds ready-to-run requests for exercising the API
by hand.

---

## License

MIT. See [LICENSE](LICENSE).
