# Local validation with curl

A collection of requests to exercise the `antigravity-wrapper` API on a local machine.
The values below come from the implemented code, not from the design plan.

## Preparation

The API requires three variables: the ingress credential (`API_KEY`) and the OAuth client
(`ANTIGRAVITY_CLIENT_ID` / `ANTIGRAVITY_CLIENT_SECRET`). Copy the example and fill it in:

```bash
cp .env.example .env
```

Start the API with the database pointed at a throwaway file:

```bash
API_KEY=chave-local-de-teste DB_PATH=./data/local.db npm run dev
```

In another terminal, export the two variables the examples use:

```bash
export BASE=http://127.0.0.1:3000
```

```bash
export KEY=chave-local-de-teste
```

> **Two things worth knowing before you test the chat.**
>
> 1. **Every** route requires the `Authorization: Bearer <API_KEY>` header, including `/health`.
>    Without it the response is always `401`. That is intentional: the API does not distinguish
>    a public route, so the container's healthcheck sends the credential too.
> 2. The chat only works **once an account has been registered**. With an empty pool the
>    route answers `503` with the reason — registering an account means completing Google's
>    consent step (section 2 below), and that is the only step in this collection you cannot
>    do with curl alone.

---

## 1. API health

```bash
curl -sS "$BASE/health" -H "Authorization: Bearer $KEY"
```

Expected response: `{"status":"ok"}`

Without a credential — to confirm the API fails closed:

```bash
curl -sS -i "$BASE/health" | head -1
```

Expected: `HTTP/1.1 401 Unauthorized`

---

## 2. Register a pool account

The flow is two steps because the browser doing the consent may be a machine other than the
server.

### Step 1 — request the consent URL

```bash
curl -sS -X POST "$BASE/admin/accounts/start" -H "Authorization: Bearer $KEY"
```

Response: `{"authUrl":"https://accounts.google.com/...","state":"..."}`

Open the `authUrl` in a browser **on any machine**, complete the login with the Google
account you want in the pool, and at the end the browser will try to open
`http://localhost:51121/oauth-callback?code=…&state=…` — **copy that full URL out of the
address bar**. It is normal for it not to load; the value you need is in the bar.

> The `state` is single-use and expires after 5 minutes. If it lapses, restart from step 1.

### Step 2 — hand over the callback URL

Paste the copied URL in place of `<CALLBACK_URL>`:

```bash
curl -sS -X POST "$BASE/admin/accounts/complete" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"callbackUrl":"<CALLBACK_URL>"}'
```

Response: `{"account":{...,"email":"h***n@gmail.com","projectId":"..."},"paidTier":"Google AI Pro"}`

The email comes back **masked** and `paidTier` shows the subscription the account carries —
if it comes back `null`, the account authenticated but has no paid tier associated.

---

## 3. Manage the pool

List the linked accounts:

```bash
curl -sS "$BASE/admin/accounts" -H "Authorization: Bearer $KEY"
```

Detail of one account (the `id` comes from the listing above):

```bash
curl -sS "$BASE/admin/accounts/account-0000000000000000" -H "Authorization: Bearer $KEY"
```

Disable an account without removing it (it leaves the rotation but keeps its tokens and
history):

```bash
curl -sS -X PATCH "$BASE/admin/accounts/account-0000000000000000" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"enabled":false}'
```

Give an account priority — an explicit priority beats quota in the ordering, so this is how
you pin a preferred account:

```bash
curl -sS -X PATCH "$BASE/admin/accounts/account-0000000000000000" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"priority":10}'
```

Force a refresh of that account's quota:

```bash
curl -sS -X POST "$BASE/admin/accounts/account-0000000000000000/refresh" -H "Authorization: Bearer $KEY"
```

See the aggregated quota snapshot for the whole pool:

```bash
curl -sS "$BASE/admin/accounts/quota" -H "Authorization: Bearer $KEY"
```

Remove the account and its quota rows:

```bash
curl -sS -X DELETE "$BASE/admin/accounts/account-0000000000000000" -H "Authorization: Bearer $KEY"
```

---

## 4. Model catalog

```bash
curl -sS "$BASE/v1/models" -H "Authorization: Bearer $KEY"
```

Response in the OpenAI format (`{"object":"list","data":[…]}`). Each entry's
`context_length` and `max_output_tokens` come from the static table plus whatever has been
discovered in the active account's catalog.

---

## 5. Chat — full response (no stream)

```bash
curl -sS -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"gemini-3.8-flash","messages":[{"role":"user","content":"Say hello in one sentence."}]}'
```

Choosing the reasoning level — `reasoning_effort` accepts
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; an unknown value falls back to `off`
without breaking the request:

```bash
curl -sS -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"gemini-3.8-flash","reasoning_effort":"high","messages":[{"role":"user","content":"Explain what a mutex is in two sentences."}]}'
```

Requesting a lower token ceiling:

```bash
curl -sS -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"gemini-3.8-flash","max_tokens":64,"messages":[{"role":"user","content":"Count to three."}]}'
```

---

## 6. Chat — streaming (SSE)

Use `-N` to turn off curl's buffering; without it you only see the stream at the end.

```bash
curl -sS -N -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"gemini-3.8-flash","stream":true,"messages":[{"role":"user","content":"Write a haiku about network packets."}]}'
```

The stream ends with `data: [DONE]`. If an error happens **after** the first byte has already
left, it arrives as a `data: {"error":{…}}` frame followed by the `[DONE]` — that is
intentional, so a client waiting on the `[DONE]` does not sit hanging.

The SSE head is not flushed immediately: for `STREAM_FLUSH_PATIENCE_MS` (default 1.5 s) the
route holds the headers back, so an **instant** failure (unknown model, empty pool) still
answers with its real HTTP status. If the first content byte takes longer than the patience,
the head goes out first — with the OpenAI-shaped `{"role":"assistant","content":""}` leading
delta — and a failure that arrives after that point is an error frame inside the 200. The
access log therefore reads 200 for such turns; the truthful signal is the `chat failed` log
line with `headersSent: true`.

---

## 7. Tool calling

Send a tool and explicitly ask for it to be used:

```bash
curl -sS -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"gemini-3.8-flash","tool_choice":"required","tools":[{"type":"function","function":{"name":"get_weather","description":"Current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"messages":[{"role":"user","content":"What is the weather in Paris right now?"}]}'
```

The response carries `finish_reason: "tool_calls"` and a `tool_calls` array. In a Gemini
model's response, each tool call can also carry a `thoughtSignature` field — **keep it**:
to continue the tool conversation you re-send the assistant message exactly as it came,
including that field. Without it the backend rejects the next turn.

Returning the tool result and asking for the conclusion:

```bash
curl -sS -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"gemini-3.8-flash","tools":[{"type":"function","function":{"name":"get_weather","description":"Current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"messages":[{"role":"user","content":"What is the weather in Paris right now?"},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Paris\"}"}}]},{"role":"tool","tool_call_id":"call_1","name":"get_weather","content":"{\"temp_c\":18,\"condition\":\"cloudy\"}"}]}'
```

To prevent tool use while keeping the tools advertised:

```bash
curl -sS -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"gemini-3.8-flash","tool_choice":"none","tools":[{"type":"function","function":{"name":"get_weather","description":"Weather","parameters":{"type":"object"}}}],"messages":[{"role":"user","content":"What is today's date?"}]}'
```

---

## 8. Error paths (to confirm the codes)

A nonexistent model should give `404`:

```bash
curl -sS -i -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"does-not-exist","messages":[{"role":"user","content":"hi"}]}'
```

An empty pool should give `503` with the reason — test this before registering any account:

```bash
curl -sS -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"gemini-3.8-flash","messages":[{"role":"user","content":"oi"}]}'
```

An empty message list should give `400`:

```bash
curl -sS -i -X POST "$BASE/v1/chat/completions" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"model":"gemini-3.8-flash","messages":[]}'
```

A callback without `state` should give `400`:

```bash
curl -sS -X POST "$BASE/admin/accounts/complete" -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"callbackUrl":"http://localhost:51121/oauth-callback?code=x"}'
```

A nonexistent account should give `404`:

```bash
curl -sS -i "$BASE/admin/accounts/does-not-exist" -H "Authorization: Bearer $KEY"
```

---

## 9. An OpenAI client pointing here

The design decision is that existing clients work by just changing the base URL. With the
official SDK:

```bash
OPENAI_BASE_URL="$BASE/v1" OPENAI_API_KEY="$KEY" npx --yes openai@latest api chat.completions.create -m gemini-3.8-flash -g user "Diga ola em uma frase."
```

`OPENAI_API_KEY` carries the API's ingress credential, not an OpenAI key.

---

## 10. If something does not work

Check the reason by the most direct route — the API's error response already carries the
cause:

```bash
curl -sS "$BASE/admin/accounts" -H "Authorization: Bearer $KEY"
```

- **`401` on everything** — the `Authorization` did not arrive or the process's `API_KEY`
  is a different one.
- **`503` on chat** — the pool is empty or every account is in cooldown/invalid; the
  message lists each account's state.
- **`403` with "valid license"** — the fingerprint `User-Agent` was not sent; it is a wrapper
  configuration fault, not the account's.
- **`403` with `VALIDATION_REQUIRED`** — the account needs browser verification; logging in
  again does not fix it.
- **`429`** — the account hit its quota. The API puts the account in cooldown and tries the
  next one automatically; if all fail, the final error carries each one's reason.
