# ECHO Web - Local-First Autonomous Browser Agent

> A Chrome extension that drives your browser for you, built around a four-tier routing engine that answers roughly 85% of requests on-device and only spends LLM tokens on work that genuinely needs a model.

---

## The Problem

Every "AI browser agent" I tried had the same failure mode: it treated a large language model as the answer to every question. Say "hi" and it burns 500 tokens. Ask it to summarise a page and it re-uploads the entire DOM plus a 25-tool schema on every single reasoning step. On a free API tier that means you get two or three real tasks before you hit a rate limit and the product becomes useless.

I hit exactly this wall with the first version of ECHO. Two tasks and Groq's tokens-per-minute limit killed it. The instinctive fix is to shrink the prompt, and I did that, but it only bought maybe 20%. The actual problem was architectural: **the model was being asked questions it had no business answering.**

"What's my email address?" is a dictionary lookup. "Open YouTube" is a URL. "Extract every email on this page" is a regular expression. "Do the same seven clicks I did yesterday" is a replay. None of those need a neural network, and paying for one is both slower and less reliable than doing the work directly.

So I rebuilt ECHO around a router. Every request enters a four-tier ladder and exits at the cheapest tier that can genuinely answer it. The cloud model became the last resort instead of the front door. Measured across normal use, about 85% of requests now never touch the network, and the same free-tier quota lasts five to seven times longer.

The hard part was not the tiers. It was making each tier **honestly decline**. A local tier that guesses is worse than no local tier at all, because a confidently wrong instant answer is more damaging than a slow correct one. Most of the engineering below is about that.

---

## Ten-Second Recruiter Summary

* **What is it?** A Manifest V3 Chrome extension that reads, navigates and acts on web pages on your behalf, using voice or text.
* **The core idea:** A four-tier request router (deterministic logic, response cache, on-device model, cloud LLM). Each tier is allowed to decline, and every reply is tagged in the UI with the tier that produced it, so the cost of every answer is visible rather than hidden.
* **Why it matters:** Cut LLM token consumption per task by roughly 5-7x, taking the app from unusable on a free tier to comfortably usable all day. The extension remains substantially functional with no API key configured at all.
* **Tech:** TypeScript (strict), React 19, webpack, Chrome Extension MV3 (service worker, side panel, alarms, offscreen messaging), IndexedDB, Web Speech API, and a provider-agnostic LLM layer supporting Anthropic Claude, Google Gemini, Groq, Together AI and OpenRouter.
* **Scale:** 26 TypeScript modules, ~5,600 lines, zero runtime dependencies beyond React and the two vendor AI SDKs. No UI framework, no state library, no lodash.

---

## In-Depth Overview

ECHO is a browser assistant that actually operates the browser. It reads the DOM into a numbered index of interactive elements, then clicks and types against those indices rather than pixel coordinates, which is what makes it survive scrolling, sticky headers and overlays. It can navigate, manage tabs, extract structured data, fill forms, record and replay multi-step workflows, monitor pages for changes, and hold a persistent conversation in a side panel.

What separates it from a wrapper around a chat completion endpoint is that the language model is only one of four execution strategies, and the least-preferred one.

---

## The Routing Engine

This is the part of the project I would want to talk through in an interview.

```text
                        User request
                             |
                             v
                  +----------------------+
                  |    SMART ROUTER      |
                  | classify -> dispatch |
                  +----------+-----------+
                             |
     +----------------+------+-------+------------------+
     v                v              v                  v
+-----------+   +-----------+   +-----------+   +-----------------+
|  TIER 0   |   |  TIER 1   |   |  TIER 2   |   |     TIER 3      |
|  Instant  |   |  Cached   |   | On-device |   |   Cloud LLM     |
+-----------+   +-----------+   +-----------+   +-----------------+
| storage   |   | IndexedDB |   | Chrome    |   | Claude / Gemini |
| DOM       |   | keyed on  |   | built-in  |   | Groq / Together |
| regex     |   | normalised|   | AI, or a  |   | OpenRouter      |
| site map  |   | query+URL |   | built-in  |   |                 |
|           |   |           |   | extractive|   | agentic tool    |
|           |   |           |   | summariser|   | loop            |
+-----------+   +-----------+   +-----------+   +-----------------+
   ~0 ms           <5 ms          ~500 ms          1-8 s
   free            free            free           costs quota
   ~60%            ~15%            ~10%             ~15%
     |                |              |                  |
     +----------------+------+-------+------------------+
                             |
                             v
                    Answer, tagged with
                    the tier that produced it
                             |
                     (Tier 3 results are
                      written back to the
                      Tier 1 cache)
```

Any tier may return null, which means "I am not confident, pass it on". That single rule is what makes the design safe.

### Tier 0 — Deterministic

37 ordered intent rules matched against the request. Handles greetings, memory reads and writes, saved-task and workflow listings, direct navigation, site-scoped search, pattern extraction, form filling, workflow record and replay, and page watchers.

The interesting problem here was **rule collision**. My first pass matched `\bhelp\b`, which meant "help me fill this form" returned the capabilities list instead of filling the form. `\bwatch\b` was worse: "watch this YouTube video" silently created a background page monitor. I built a small harness that replays a corpus of realistic phrasings through the rule list in order and reports which rule wins, which surfaced both bugs plus two more, and now guards against ordering regressions when rules are added.

Rules also decline at the handler level, not just the pattern level. "Open a new tab and search for headphones" matches the navigation pattern, but the handler sees the conjunction and the verb "search", recognises it as a multi-step task, and returns null so a real tier gets it.

### Tier 1 — Response cache

An IndexedDB store keyed on the page URL plus a normalised form of the question, with a TTL chosen by question type: 3 minutes for anything time-sensitive (price, score, weather), 15 minutes for page-derived summaries, 24 hours for stable factual answers.

Normalisation strips filler and stopwords, so "summarize this page", "Can you summarize this page please?", "summarize the page" and "please summarize this page for me" all collapse to the identical key and hit the exact-match path. Near-misses fall back to a set-overlap similarity score with a 0.72 threshold, tuned against labelled pairs so that genuine rephrasings match (0.75-0.80) while different questions about the same page do not (0.25-0.50).

Questions are also scope-classified: "summarize this page" is cached per-URL, "what is the capital of France" is cached globally. Error strings are never cached, so a transient API failure cannot be replayed as an answer.

### Tier 2 — On-device language work

Uses Chrome's built-in Gemini Nano via the `Summarizer` and `LanguageModel` APIs when the browser and hardware support it. Because that support is far from universal, it is feature-detected rather than assumed, and there is a **dependency-free extractive engine underneath it that always works**.

That fallback is classic frequency-based sentence ranking: tokenise, drop stopwords, score each sentence by the summed frequency weight of its terms, normalise by the square root of sentence length so long sentences do not automatically win, apply a positional boost to the opening fifth of the document, take the top N and re-emit them in original reading order so the output still reads as prose. Question answering uses term-overlap passage retrieval with a threshold requiring at least a third of the question's content terms to appear.

The threshold matters more than the ranking. Validated against a real article, it correctly surfaces the distance sentence for "how far away is the planet" and the instrument sentence for "what instrument was used" — and critically, returns **empty** for "what is the price of bitcoin", so the router falls through to the cloud instead of fabricating an answer from unrelated text.

### Tier 3 — Cloud LLM

The original agentic loop, now reached only when the tiers above have all declined. Five providers behind one interface, each with a different function-calling dialect.

---

## Token Economics

Reducing cost per cloud call was a separate exercise from routing, and produced the larger part of the improvement.

**Tool schema tax.** The agentic loop resends every tool definition on every reasoning step. 25 tools at roughly 100 tokens each is ~2,500 tokens per step, so a five-step task spent ~12,500 tokens on schemas before any content. I split the set into 10 always-sent core tools and 15 conditionally-attached ones, selected by keyword against the request, and cut every description to a single line. Typical requests now carry ~800 tokens of schema instead of ~2,500.

**Conversation growth.** Screen reads are large and accumulate. Before every request, all tool results except the most recent are collapsed to a short stub, so per-request size stays bounded no matter how many steps a task runs. Combined with a sliding window and a hard step cap, a long task can no longer spiral into a rate limit.

**Prompt caching.** On Anthropic, the system prompt and tool block are marked with `cache_control`, so repeated in-task requests bill the static prefix at the reduced cache-read rate.

**Wasted calls.** The original Gemini model list led with two models that did not exist, costing a guaranteed 404 round-trip before every task. Removing them was a two-line fix worth two requests per task.

Instrumentation is part of the feature: real token counts are read from each provider's usage fields and surfaced live, and the side panel shows the running split across all four tiers.

---

## Reliability Work

The bugs that mattered were not crashes. They were silent wrong behaviour.

**Tab identity.** `open_url` created a new tab but returned the old tab's id, so every subsequent action — read, click, type — was dispatched to the page the user had left. "Go to YouTube and search for X" typed into the previous site. Tools now return the new tab id and all three provider loops track an `activeTabId` across `open_url` and `switch_tab`.

**Navigation races.** Navigation resolved as soon as Chrome accepted the URL, so the agent read a blank or stale DOM. Both navigation tools now poll `chrome.tabs.get` until the tab reports `complete`, with a timeout so a hanging page cannot deadlock a task.

**Malformed tool calls.** Llama models on Groq intermittently emit a call as raw text — `<function=open_url{"url":"..."}>` — instead of a structured `tool_calls` entry. Groq's parser then reads the whole string as the function name and returns a 400. Rather than surfacing that as a failure, the loop extracts the intended call from the `failed_generation` payload with a brace-balancing parser and executes it, recovering the turn transparently.

**Error translation.** A Gemini quota error reporting `limit: 0` does not mean "you ran out", it means the key's project has no free-tier allocation at all, and the `retry in 31s` field in the payload is misleading. The error layer distinguishes the two and tells the user what will actually fix it instead of dumping raw JSON.

**Prompt injection.** The proactive suggestion system posts messages on the page's own window, which means any script on the page can forge one. Rather than trusting the message, the receiver treats the action as an index into a fixed allowlist. A hostile page can at worst cause ECHO to offer one of its own harmless local commands.

**Privacy boundaries.** The form filler refuses password, card, CVV, SSN, PIN and account-number fields by both input type and label pattern, never overwrites a field the user has already typed into, and never submits. The page indexer excludes login, checkout, auth and payment URLs.

---

## Feature Breakdown

**Page understanding**
Indexed DOM reading (numbered interactive elements plus visible text), full-text extraction, table extraction to JSON, screenshot capture for genuinely visual questions.

**Page control**
Click and type by element index, key dispatch, scroll, find-and-highlight, form submission. Typing uses the native value setter so React and Vue controlled inputs register the change, which naive `.value` assignment silently fails to do.

**Workflow recorder**
Records clicks and typed values, storing each step as a ranked list of selector candidates plus the element's visible label. Playback walks the list until one resolves, falling back to label matching, which is what lets a recorded flow survive the hashed class names and generated ids that break single-selector automation. Typing is captured on commit rather than per keystroke, so a 20-character field is one step and not twenty. Password fields are never recorded.

**Page watchers**
Persist a URL, an optional selector and a condition (below, above, contains, disappears, any change). A `chrome.alarms` job opens the page in a background tab, reads the value, evaluates the condition and fires a desktop notification. Watchers re-arm when the condition relaxes and are rehydrated after a browser restart.

**Site intelligence**
Hand-built DOM profiles for 20 major sites, including direct search URL construction and named action selectors. "Search YouTube for lo-fi" becomes a URL construction, not an inference task.

**Extractors**
Emails, phone numbers, prices across five currencies, links, dates in three formats, social handles, headings. The phone matcher includes a plausibility filter that rejects long undelimited digit runs, which are order ids rather than numbers anyone dials.

**Knowledge base**
Pages you read are indexed locally and ranked on recall by weighted term hits across title, domain and body, with a recency decay term. Answers "what was that article about X" and "what did I read today" with no network call.

**Highlights**
Select text, save it, and it is re-injected via TreeWalker text matching when you return to the page. Exports to Markdown.

**Proactive suggestions**
Rule-based observation of dwell time, scroll depth and form shape. Offers a summary on a long read or to fill a long form. No model runs until the offer is accepted, and suggestions are rate-limited globally and suppressed while the user is typing.

**Voice**
Speech recognition runs in a sandboxed iframe so microphone permission works on any origin, with speech synthesis for replies and an optional hands-free mode that reopens the microphone after each answer.

---

## Skills This Project Demonstrates

I am currently targeting AI Engineer, BI Developer and Data Analyst/Scientist roles. This is a systems project rather than a modelling one, so here is an honest mapping of what transfers.

**AI / LLM Engineering**
Provider-agnostic abstraction over five LLM APIs with three incompatible function-calling dialects and a generic JSON-Schema to Google-Schema converter. Agentic reason-act-observe loops with step caps and abort handling. Context window management under a hard token budget. Prompt caching. Structured-output recovery from malformed model responses. Cost instrumentation from real provider usage fields. The central lesson — route work to the cheapest component that can do it correctly, and make every component able to say "I don't know" — is the same lesson that separates a production RAG system from a demo.

**Data & Analytics**
Information retrieval and ranking: TF-based sentence scoring with length normalisation and positional weighting, term-overlap passage retrieval, weighted multi-field search with recency decay. Similarity thresholds selected against labelled pairs rather than guessed. Schema design across four IndexedDB stores with indices, TTL eviction and size-bounded trimming. Text normalisation and entity extraction with precision-oriented filtering.

**BI & Instrumentation**
The routing telemetry is a small BI problem: define the metric that matters (share of requests avoiding paid inference), instrument the pipeline to capture it accurately at every branch, persist it, and surface it where the user makes decisions. The side panel is effectively a cost dashboard, with per-answer attribution so the number is auditable rather than asserted.

**Software Engineering**
TypeScript under `strict`, no `any` in module boundaries. Chrome MV3 constraints throughout: a service worker that is killed and restarted arbitrarily, so all state is persisted and connections lazily reopened; message passing across four contexts. Graceful degradation as a design rule — every storage helper resolves rather than throws, so losing IndexedDB costs you memory, not the request.

---

## Technology Stack

| Component | Technology | Focus |
| :--- | :--- | :--- |
| Language | TypeScript 5 | Strict mode across all 26 modules |
| UI | React 19 | Content-script overlay, side panel, options page |
| Build | webpack 5 + ts-loader | Five entry points, async chunking for the vendor AI SDKs only |
| Platform | Chrome Extension MV3 | Service worker, side panel, alarms, notifications, downloads, context menus, commands |
| Local storage | IndexedDB | Four stores: cache, knowledge base, highlights, with indices and TTL eviction |
| Sync storage | chrome.storage.local | Settings, memory, workflows, watchers, transcript |
| On-device AI | Chrome built-in AI | `Summarizer` / `LanguageModel`, feature-detected with a dependency-free fallback |
| Cloud AI | Anthropic Claude | `@anthropic-ai/sdk`, with `cache_control` prompt caching |
| Cloud AI | Google Gemini | `@google/genai`, four-model fallback chain |
| Cloud AI | Groq / Together / OpenRouter | OpenAI-compatible REST, with malformed tool-call recovery |
| Voice | Web Speech API | Sandboxed iframe for cross-origin microphone access |
| Runtime deps | React, React DOM, two AI SDKs | No UI framework, no state library, no utility library |

---

## Local Development

### Prerequisites

* Node.js 18 or later
* Chrome or Edge with developer mode available
* Optionally an API key from any one of Groq, Google AI Studio, Anthropic, Together AI or OpenRouter. Groq is the recommended starting point: genuinely free tier, fastest inference. The extension is substantially functional with no key at all.

### Build

```bash
git clone https://github.com/thedeepakreddy/Echo---Web-Assistant-Extension-..git echo-web-assistant
cd echo-web-assistant
npm install
npx webpack --config webpack.config.js
```

The build emits to `dist/`.

### Load into the browser

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `dist/` folder
4. Right-click the ECHO icon, choose **Options**, pick a provider and paste a key

### Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Cmd/Ctrl + Shift + E` | Wake or dismiss the floating orb |
| `Cmd/Ctrl + Shift + O` | Open the persistent side panel |
| `Cmd/Ctrl + Shift + K` | Open the inline command box |

### Things to try

```
summarize this page
extract all emails
fill this form
record a workflow          (then: stop recording and call it my routine)
watch this page and tell me when the price drops below 800
what did I read today
search youtube for lo-fi
```

The first four run entirely on-device. The side panel tags each answer with the tier that produced it.

---

## Project Structure

```text
echo-web-assistant/
├── manifest.json                  Chrome MV3 manifest
├── webpack.config.js              Five entry points
├── src/
│   ├── background/                Service worker
│   │   ├── smart-router.ts        Four-tier dispatch, the core of the design
│   │   ├── local-brain.ts         Tier 0: 37 deterministic intent rules
│   │   ├── response-cache.ts      Tier 1: TTL cache, query normalisation, similarity
│   │   ├── knowledge-base.ts      Tier 1: page index and weighted ranked recall
│   │   ├── highlights.ts          Tier 1: saved passages
│   │   ├── local-llm.ts           Tier 2: built-in AI plus extractive fallback
│   │   ├── brain.ts               Tier 3: five-provider agentic loop
│   │   ├── site-knowledge.ts      DOM profiles for 20 sites
│   │   ├── workflow-engine.ts     Record and replay orchestration
│   │   ├── page-watcher.ts        Alarm-driven monitoring
│   │   ├── tools.ts               Tool dispatch
│   │   ├── db.ts                  IndexedDB layer
│   │   ├── bus.ts                 Unified UI messaging
│   │   └── auth.ts                Provider configuration
│   ├── content/                   Injected into every page
│   │   ├── actions.ts             Indexed DOM engine, 19 actions
│   │   ├── recorder.ts            Selector generation and step replay
│   │   ├── form-filler.ts         Field scoring and safe fill
│   │   ├── extractors.ts          Pattern extraction
│   │   ├── highlighter.ts         Selection capture and re-injection
│   │   ├── passive-observer.ts    Rule-based proactive suggestions
│   │   └── ui.tsx                 Reactor orb, chat, suggestion toast
│   └── popup/
│       ├── sidepanel.tsx          Persistent chat, tier badges, cost dashboard
│       └── options.tsx            Provider and local-brain settings
└── dist/                          Build output, load this folder
```

---

## What I Would Do Next

Being straight about the current limits:

* The Tier 0 rules are regular expressions. They are fast, debuggable and free, but they are brittle at the edges of natural phrasing. A small on-device intent classifier would generalise better, at the cost of the transparency that makes the current approach easy to reason about.
* The extractive summariser is genuinely extractive. It selects real sentences and never invents, which is the right trade for a fallback, but it cannot compress or rephrase the way an abstractive model can.
* The verification I ran against the routing rules, cache similarity thresholds and summariser quality lives in throwaway scripts. It belongs in a committed test suite with CI, and that is the next thing I would add.
* Tier 2 depends on Chrome's built-in AI for its best output, which is not yet widely available. A bundled WebGPU model would close that gap at the cost of a large first-run download.

---
## 🚀 Coming Soon: ECHO Mac (Desktop Assistant)

While the ECHO Web Extension rules your browser, **ECHO Mac** (currently 90% complete) is about to rule your entire operating system.

ECHO Mac is a super-autonomous desktop assistant being built to operate completely outside the browser. It features mind-blowing capabilities that will make it feel like you have a true AI engineer sitting inside your machine. **Currently, ECHO Mac already boasts over 100+ active features.**

**20 of the Mind-Blowing Features of ECHO Mac:**
1. **Infinite Autonomous Cloning (The Best Feature):** ECHO Mac can literally clone itself an unlimited number of times. If you give it 10 massive tasks, it spawns 10 independent sub-agents that execute everything simultaneously in the background.
2. **Full File-System Control:** Automatically read, write, and organize local files and folders.
3. **Autonomous Software Engineer:** Clones repositories, reads Jira tickets, writes code, runs tests, and opens PRs completely unattended.
4. **Vision OS Integration:** Natively sees the screen via Apple Screen Capture frameworks at 60fps.
5. **Deep System Control:** Direct integration with Spotify, Mail, Calendar, and System Preferences via AppleScript.
6. **Always-On Context:** Constantly learns from everything you do on your Mac to build a personalized, local AI brain.
7. **Local Sandbox Execution:** Safely tests untrusted code in Docker containers automatically.
8. **Overnight Work Mode:** Give ECHO Mac a massive, multi-step goal before you go to sleep, and it will work overnight to finish it.
9. **Self-Healing Code:** Automatically detects runtime errors in your local environment, analyzes the stack trace, and applies patches.
10. **Native Desktop Voice:** Speaks directly through MacOS CoreAudio with ultra-low latency conversational capabilities.
11. **Intelligent Screen OCR:** Instantly reads and extracts text from videos, images, and unselectable UI elements across the whole OS.
12. **Cross-App Workflows:** Can move files from Finder into Photoshop, apply edits, and email the result without human intervention.
13. **Automated Meeting Proxy:** Attends Zoom or Google Meet calls on your behalf, records transcripts, and extracts action items.
14. **Local LLM Hosting:** Runs massive AI models entirely locally on Apple Silicon (M-series) to guarantee zero latency and 100% privacy.
15. **Database Architect:** Connects to local PostgreSQL/MySQL databases, analyzes schemas, and writes complex SQL migrations on demand.
16. **Proactive System Maintenance:** Monitors CPU, RAM, and disk space, automatically clearing caches and optimizing performance.
17. **Dynamic UI Generation:** Instantly codes and renders custom SwiftUI or React widgets on your desktop to display data you ask for.
18. **Continuous Deployment Agent:** Monitors your local git branches and auto-deploys to AWS/Vercel when tests pass.
19. **Semantic File Search:** Stop searching by file name. Just say "Find the PDF where the lawyer talked about the severance package," and it finds it instantly.
20. **Automated Social Engineering:** Can log into LinkedIn on your browser, find leads, and send personalized connection requests.
21. **Self-Evolving Architecture:** ECHO Mac rewrites its own core logic scripts to optimize its speed based on your daily usage patterns.

Stay tuned. The future of operating systems is arriving soon.

Built by Deepak Reddy.
