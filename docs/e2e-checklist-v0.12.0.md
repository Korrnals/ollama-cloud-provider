# E2E Checklist — v0.12.0 Verification (Monday, after quota reset)

**Purpose:** prove the two root causes of "agents loop / tool results ignored / disconnects" are dead in a REAL Copilot Chat session.
**Time:** ~10-15 min. **Model:** glm-5.2 (cloud default → native endpoint — the path where the P0 bug lived).
**Debug log:** Output → "Ollama Cloud (Debug)" (already enabled).

## Setup (1 min)

- [ ] Extension version shows **0.12.0** (Extensions panel)
- [ ] Model picker has an Ollama Cloud model selected (glm-5.2)
- [ ] Debug output channel visible: View → Output → "Ollama Cloud (Debug)"
- [ ] Clean the log: click the 🚫 (clear) icon in the Output panel — so every line below is from THIS test

## Test 1 — P0: tool results reach the model (THE critical test)

**Ask the agent to edit a real file:**
> Добавь комментарий "// e2e check v0.12.0" в конец файла README.md проекта и покажи последние 3 строки

| # | Check | Pass signal |
|---|---|---|
| 1.1 | File actually changed on disk | `tail -3 README.md` shows the comment |
| 1.2 | Agent SEES the tool result (does not re-run) | Edit tool called **once**; no second identical call |
| 1.3 | Agent quotes the result back | Response contains the file tail it just read/wrote |
| 1.4 | Debug log is clean | **No** `convertNative: dropped empty user message (parts=1)` spam |
| 1.5 | Report matches disk | Everything the agent claims it did exists |

**Why:** 1.2+1.4 are the direct proof of the P0 fix — before v0.12.0 that debug line fired 36× in a row and the model re-issued calls blind.

## Test 2 — Multi-step task (loop killer)

**Give a 3-step task requiring 3 different tools:**
> Прочитай package.json, найди версию; создай файл /tmp/e2e-v0120-test.txt с содержимым "version=<found>"; затем прочитай его обратно и процитируй

| # | Check | Pass signal |
|---|---|---|
| 2.1 | All 3 tools executed in order | read → write → read in the tool call timeline |
| 2.2 | Step 3 quotes ACTUAL file content | "version=0.12.0" — proves read result reached the model |
| 2.3 | Total tool calls ≈ 3-4, not 10+ | No blind retries of the same call |
| 2.4 | Task completes without user nudging | No "agent stuck repeating" symptom |

## Test 3 — Timer removal: no disconnects on reasoning

**Ask a reasoning-heavy question (slow TTFT — the old killer):**
> Напиши подробный разбор (500+ слов): какие компромиссы между CAP-теоремой и практикой микросервисов

| # | Check | Pass signal |
|---|---|---|
| 3.1 | Stream starts without error | No `соединение прервано` toast |
| 3.2 | Full answer arrives | Response is complete, not truncated mid-sentence |
| 3.3 | Debug log: no AbortError storms | No `AbortError: The operation was aborted` retries |
| 3.4 | No retry loop in log | `readStream START` fires once per request, not 3-4× |

## Test 4 — Subagent delegation (the original "thousands of requests" symptom)

**Trigger any subagent-using flow (e.g. this Tech Lead mode delegating a small task):**
> Делегируй субагенту: создай файл /tmp/e2e-subagent-check.md с текстом "subagent works"

| # | Check | Pass signal |
|---|---|---|
| 4.1 | Subagent completes and reports | Feedback comes back (not silence/loop) |
| 4.2 | File exists with exact content | `cat /tmp/e2e-subagent-check.md` |
| 4.3 | Subagent report matches reality | Claims = disk state |

## Test 5 — Sanity: vision fallback (optional, if image handy)

Attach a screenshot to a text-only model (glm-5.2) with `visionFallback.enabled=true` + model configured:

| # | Check | Pass signal |
|---|---|---|
| 5.1 | Fallback fires | 🖼️ annotation → vision model answers |
| 5.2 | Primary model stays selected | After the turn, picker still on glm-5.2 |

## Verdict rules

- **All green (1.1-4.3):** v0.12.0 fixes CONFIRMED → close the incident, compaction slices (B∥A) unblocked.
- **Any 1.x / 2.x / 4.x red:** tool-results path still broken somewhere → grab last 50 debug-log lines + exact repro, escalate to me same day.
- **3.x red only:** timer path — grab debug-log, check whether it's a NEW class (max-duration at 60min should never fire in a chat turn).

## Log capture (if anything is red)

Last 50 lines of the debug channel + the exact prompt used + timestamp. That triple is enough for root-cause without a reproducer.
