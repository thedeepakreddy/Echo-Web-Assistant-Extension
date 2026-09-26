# EchoBench

ECHO's own benchmark. Each task opens a local copy of a web page
(`fixtures/`) in headless Chrome for Testing, gives it to an avatar, sends the
request through ECHO exactly as the side panel does, and scores the result
with automatic checks only: required or forbidden reply text, page state
afterwards, and how many approvals ECHO asked for. No AI judge.

```bash
npm run bench                                   # tasks that need no model
npm run bench -- --runs 3                       # repeat; reports pass^3
npm run bench -- --only shop-price,article-facts
```

Tasks that need a model run when you pass `--model` and name a provider and
key in the environment. The key is written only into the throwaway Chrome
profile, which is deleted after the run; it is never printed or saved.

```bash
ECHOBENCH_PROVIDER=gemini ECHOBENCH_API_KEY=... ECHOBENCH_MODEL=gemini-3.8-flash \
  npm run bench -- --model --runs 3
```

Providers: `gemini`, `claude`, `groq`, `openrouter`, `togetherai`.

With `--openclaw` the avatars run on the local "echo" OpenClaw gateway and its
model instead (no key needed here): the throwaway ECHO pairs with the gateway
for the run and is removed afterwards, and avatars another browser is using
are swapped for free ones. Tokens per task come from the gateway's session
records. `--extension dir` runs a build other than `dist/` (for before/after
comparisons).

```bash
npm run build && node tools/echobench/run.cjs --openclaw --label phase3
```

## Tasks

`tasks.json` — each task names a fixture page, a prompt, whether it needs a
model, and what counts as success:

| Field | Meaning |
| --- | --- |
| `replyIncludes` / `replyExcludes` | text the reply must / must not contain |
| `replyIncludesAtLeast` | at least `count` of the listed facts |
| `replyMatches` / `replyExcludesPattern` | regular expressions (e.g. "no invented phone number") |
| `page` | expressions evaluated in the page afterwards, with expected values |
| `approvals` | `min` / `max` approval prompts (payments and sends must ask) |
| `parallel` | several avatars at once; all must succeed |

Categories: `small`, `medium`, `long`, `grounding` (no made-up answers),
`safety` (payment approval, prompt injection), `multi-agent`.

## Reading results

Each run prints success with a Wilson 95% interval, pass^k when `--runs` > 1,
per-category results, median time and tokens per success. Full results go to
`results/` (gitignored). With few tasks the interval is wide: compare two
versions on the same tasks, task by task, rather than trusting a small
headline difference.
