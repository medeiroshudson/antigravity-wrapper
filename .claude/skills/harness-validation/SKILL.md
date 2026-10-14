---
name: harness-validation
description: "Use when validating a change to this service's HTTP surface, before reporting a wrapper bug as fixed, or when a bug report describes behaviour a real client sees — drives the running service with opencode as a third-party client instead of trusting stubs, then falsifies each new test by injecting the defect it targets"
metadata:
  version: "1.0.0"
  scope: project
---

# Harness validation

The unit suite proves the code does what the tests say. It cannot prove the service works for a
client. This skill closes that gap by pointing a real, independent client — **opencode** — at the
running service and making it do the things users do.

## When this applies

- A change touches the HTTP surface: `/v1/models`, `/v1/chat/completions`, `/admin/accounts*`.
- A bug report describes what a *user* saw: a wrong error message, a hung stream, a model that
  errors although the app works. Those reports are about the contract, and only a real client
  exercises the contract end to end.
- Before saying a reported bug is fixed. A green unit suite is not that evidence.
- After adding a test for any of the hard cases below — see **Falsification**, which is not optional.

## The principle

Three layers, and each catches what the one below cannot:

| Layer | Proves | Cannot see |
|---|---|---|
| Unit (`tests/`) | the code does what its tests say | whether a client can use it |
| Harness (opencode) | a real client completes real work: streams, tool calls, error handling | *why* a unit-level invariant holds |
| Falsification | the new test actually fails on the defect | — |

The middle layer earned its place: on this service a caller reported `All accounts failed:
…(transient_rate_limit)` for a model that did not exist, with healthy quota, while the Antigravity app
served the same request. The unit suite was green throughout. Driving the service with opencode
reproduced it immediately and, later, proved the fix from outside.

## Recipe: sandbox

Keep the sandbox in `/tmp`, never in the repository, and never reuse the user's own opencode config
(`~/.config/opencode/opencode.json`) — it holds their providers and credentials.

```
/tmp/<name>/xdg/opencode.json    isolated config, pointed at by OPENCODE_CONFIG
/tmp/<name>/project/             scratch cwd, so tool calls touch nothing real
/tmp/<name>/run-tests.sh         the battery
```

The provider block, for a service exposing an OpenAI-compatible surface:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "<provider>/<default-model>",
  "provider": {
    "<provider>": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "<label>",
      "options": {
        "baseURL": "http://127.0.0.1:3000/v1",
        "apiKey": "{env:HARNESS_API_KEY}"
      },
      "models": {
        "<public-id>": { "name": "<label>" }
      }
    }
  }
}
```

Drive it with `OPENCODE_CONFIG=/tmp/<name>/xdg/opencode.json`, and confirm the config was accepted
before running anything else: `opencode models` must list the declared ids under `<provider>/`.

Useful invocations:

```bash
opencode models                                  # discovery works at all
opencode run -m <provider>/<model> "<prompt>"    # one-shot, non-interactive
opencode run -m <provider>/<model> --auto "..."  # allow tool calls (writes files)
opencode run -m <provider>/<model> --format json # raw events, for asserting on structure
opencode run -m <provider>/<model> --thinking    # reasoning budget path
```

Include at least one id the backend does **not** have in the `models` map. That is what tests the
error path.

**Concrete values for this service** (so the next run does not have to reverse-engineer them):

```
provider id:   antigravity
label:         Antigravity Wrapper
baseURL:       http://127.0.0.1:3000/v1
valid ids:     claude-opus-4-6   claude-sonnet-4-6   gemini-3.8-flash
               gemini-2.5-pro    gpt-oss-120b
absent id:     gemini-3.1-pro    (the account does not offer it; use it for the error check)
```

Read the live list from `GET /v1/models` rather than trusting this block: the registry is built from
the backend's catalog, so the advertised set follows the account and can change without a release.
The env file is `.env` at the repository root.

## Credential discipline

**Resolve the key yourself, from the project's own `.env`.** This skill lives in the repository it
tests, so the key is one of the project's own configuration values — the same `.env` the service
reads at boot. The battery resolves it into an environment variable for its own process, and the
sandbox config stays value-free via `{env:HARNESS_API_KEY}`. No manual step is needed.

Put this at the top of `run-tests.sh`, substituting the repository root you are working in
(`git rev-parse --show-toplevel`):

```bash
REPO=<repo-root>
export HARNESS_API_KEY=$(sed -n 's/^API_KEY=//p' "$REPO/.env" | tr -d '"' | tr -d "'")
[ -n "$HARNESS_API_KEY" ] || { echo "BLOCKED: no API_KEY in $REPO/.env"; exit 2; }
```

Three rules that stay absolute, because they are the real leak vectors:

1. **Never print it.** Not the value, not a prefix of it, not its length in a context where it could
   be correlated. The battery reports pass/fail per check, never the credential.
2. **Never write it to a file.** Not the sandbox config, not a header dump, not a debug log. The
   value lives in the environment and in the HTTP header opencode builds from it; nowhere else.
3. **Never echo the command that contains it.** Do not run the battery under `set -x`, and do not
   paste an expanded `export HARNESS_API_KEY=<value>` line into any output.

If a guard refuses the read, report that and stop — do not work around it with `cat`, a base64
detour, or a substitute from another source. A guard firing is information, not an obstacle. The
fallback is one command for the user, and it is worth stating plainly which checks are therefore
unproven:

```bash
cd <repo-root> && bash /tmp/<name>/run-tests.sh
```

**A 401 is not a service finding.** If the battery runs without a resolved key, every call answers
`Invalid authentication credentials`. That proves the plumbing reached the port and nothing more —
never report it as a contract result.

Set the sandbox config to mode `600` once it exists, and tell the user to delete the sandbox when
done.

## The battery

Each check exists because a stub cannot make it:

| Check | What only the harness proves |
|---|---|
| **Config accepted** | the client loads the provider block and lists the declared ids. This proves *the config*, not the service — `opencode models` never talks to it |
| **The service's own list is usable** | read `GET /v1/models` from the service, take an id the config does **not** declare, and confirm the client can request it. This is the real discovery check: the client must handle ids the service advertises, not only the ones we hand-wrote into the config |
| **Completion** | the direct path works, including the response's date contract |
| **Tool calling** | a full agent loop: the client emits a tool call, executes it, returns the result, and receives a final answer. Exercises multi-turn continuity — on this service the `thoughtSignature` that only matters across turns |
| **Thinking** | the reasoning-budget path is accepted by the backend |
| **Error attribution** | asking for something the backend rejects reports *that*, and does not blame the pool |

Read the client's raw output for the error case; assert on what it printed, and be careful with
negated assertions: a `grep` that finds nothing yields an empty string, not the word "no".

**Bound every invocation.** macOS has no `timeout`, and an agent-loop call with a bad key can hang
inside the client. Use a portable wrapper (`perl -e 'alarm shift; exec @ARGV' <seconds> <cmd>`), or
run the battery's checks one at a time so a stall is visible and interruptible. A hanging battery
that was never bounded reports nothing and looks like a service problem.

## Hard cases: unit-level complements

The harness does not reach these, and they are where the subtle defects live. Each has a home:

- **A payload split across chunks** — `tests/rpc.test.ts`. Split a tool call's JSON at many byte
  boundaries and compare every reassembly with the intact result, plus one cut *inside* the
  signature token: that is where a per-chunk buffer truncates silently.
- **A stream that dies mid-body** — `tests/chat-route.test.ts`. After content has been sent, the
  client must receive an error frame **and** the DONE sentinel, and every frame in the body must
  still parse. A truncated-but-parseable body is worse than an announced failure.
- **Concurrency** — `tests/concurrency.test.ts`. Several streams at once, each carrying its own
  marker, must each receive exactly their own marker.

## Falsification

**After writing a test for a hard case, inject the defect it targets and confirm the test fails.**
A test that passes against the broken implementation is decoration, and it will read as coverage in
every review that follows.

Do it like this: back the file up, make the smallest edit that produces the defect, run the
narrowest test command, confirm the failure, restore, confirm green, and verify `git diff` on the
source is empty. Never commit with the defect in place.

This is not hypothetical. A concurrency test written for this service passed 22/22 against a
deliberately shared reassembly buffer — its stub delivered each body in one piece, so no reads
interleaved and nothing could collide. Rewriting the stub to pause **mid-frame** made it fail on the
defect and pass when clean. The first version would have shipped as false reassurance.

## Known limits

State these when reporting, rather than implying full coverage:

- **Chunk boundaries the stub does not model** — the client's own framing is not instrumented, only
  the service's reassembly.
- **Timing-dependent paths** — stall watchdogs and header timeouts are unit-level; the harness
  cannot reliably provoke them.
- **Load** — the concurrency tests are correctness checks at small scale, not benchmarks.

## Reporting

Report the battery's score, the raw output for any failure, and which checks map to which defect.
Separate failures of the *service* from failures of the *harness script* — both happen, and the
distinction matters to whoever reads the result. When a test was falsified, say so; when it was not,
say that too.
