---
name: code-review
description: "Automated deep code review using pi -p. Runs a rigorous, evidence-based review of current workspace changes, a specified PR, or an entire repository by launching pi with a review prompt via `pi -p`. Supports `$code-review`, `$code-review --base main`, `$code-review --pr 123`, and `$code-review --all`. Produces a structured review artifact in docs/reviews/ and optionally applies fixes iteratively."
---

# Code Review Skill

Run a rigorous, evidence-based code review by launching `pi -p` with a structured review prompt. Combines deep adversarial review methodology with automated execution via pi subprocesses.

## Invocation Handling

```text
$code-review                     → Current Changes Mode, base = main
$code-review --base <ref>        → Current Changes Mode, base = <ref>
$code-review --pr <number>       → PR Review Mode
$code-review --all               → All Repository Mode
$code-review --fix               → Review + apply fixes iteratively
```

If ambiguous, ask one short clarification question.

## Execution Method

### Step 1: Determine scope and generate review prompt

Based on the mode, construct a review prompt that will be passed to `pi -p`.

### Step 2: Run pi with the review prompt

Use `pi -p` to execute the review in a subprocess. The `-p` flag passes a prompt directly to pi.

```bash
pi -p "<review_prompt>" 2>&1 | tee /tmp/code-review-output.txt
```

The review prompt MUST instruct the spawned pi to:

1. Gather the relevant diff/files based on mode
2. Perform the full deep review method (described below)
3. Write the review artifact to `docs/reviews/`
4. Output findings in the fixed finding format

### Step 3: Capture and evaluate results

Read the output and the generated review artifact. If `--fix` was specified, apply meaningful fixes and re-run.

### Step 4: Report

Report the review conclusion and output file path to the user.

## Review Prompt Templates

### Current Changes Mode

```
You are a rigorous code reviewer performing a deep, adversarial review. Review all changes relative to the base ref.

Run these commands to gather context:
  git branch --show-current
  git status --short
  git diff <base>...HEAD
  git diff
  git diff --cached

Then perform a full deep review following the method below. Write the complete review artifact to docs/reviews/code-review-$(date +%Y%m%d-%H%M%S).md

<REVIEW_METHOD>
```

### PR Review Mode

```
You are a rigorous code reviewer performing a deep, adversarial review of PR #<number>.

Run these commands to gather context:
  gh pr view <number> --json title,url,author,headRefName,baseRefName
  gh pr diff <number>
  gh pr checks <number>

Then perform a full deep review following the method below. Write the complete review artifact to docs/reviews/pr-<number>-review-$(date +%Y%m%d-%H%M%S).md

<REVIEW_METHOD>
```

### All Repository Mode

```
You are a rigorous code reviewer performing a full repository review.

First build a repository map:
  git branch --show-current
  rg --files
  fd -t f 'README*' -d 3
  fd -t f 'AGENTS.md' -d 3

Then perform a full deep review following the method below. Write the complete review artifact to docs/reviews/repo-review-$(date +%Y%m%d-%H%M%S).md

<REVIEW_METHOD>
```

## Review Method

The `<REVIEW_METHOD>` placeholder in prompts above expands to the full review methodology:

### Intent and Context

1. Understand change intent: read related notes, diff, commit scope, key implementation and tests to determine what the change claims to solve.
2. Align contracts and sources of truth: check `AGENTS.md` / `CLAUDE.md`, related README or design docs, public interfaces, schemas, state machines, configuration, storage or external protocols.

### Implementation Path Analysis

3. Trace implementation paths: follow key call chains, data flow, error paths and risk points (concurrency, idempotency, retry, cancellation, recovery). Do not only review surface diff.
4. Start from real entry points and check the complete main path. Walk through real code paths line by line; root cause must come from direct evidence on the same logic/data path.
5. For key public functions and complex private helpers, expand in this order:
   ```
   params → conditions → downstream calls → return/raise → side effects
   ```
6. Check all key `if`/`elif`/`match`/dispatch/router branches are driven by facts that actually determine the branch, not indirect signals, historical flags, cached markers, or coincidentally related fields.
7. For key parameters, config, overrides and request options, expand the effectiveness chain: source → override relationship → final consumption point → invalid value handling.
8. Consistency check on return values, persisted state, externally visible state, events/logs/traces.

### Adversarial Failure Pass

9. Default to suspicion. Find the strongest evidence-based reason the change should NOT ship. If only happy path is covered, treat it as a real weakness.

Priority attack surfaces:
- Auth, permissions, tenant isolation, trust boundaries, privilege escalation
- Data loss, corruption, duplication, stale facts, irreversible state changes
- Rollback safety, retries, partial failure, re-entrancy, idempotency gaps
- Race conditions, ordering assumptions, stale state, ownership conflicts, late writes
- Empty-state, null, timeout, cancellation, degraded/unavailable dependency behavior
- Missing required parameters, type errors, invalid enum/string values, empty content, out-of-range numbers, oversized inputs
- Duplicate requests, conflicting parameters, already-terminal state being advanced again
- Version skew, schema drift, migration hazards, compatibility regressions
- Observability gaps hiding failures or making recovery harder
- Externally visible inconsistency between return values, persisted state, events, logs, traces
- External protocol/API boundary issues: payload shape mismatch, correlation id mismatch, stream/page/chunk assembly bugs, malformed response handling
- Overcoupling: layers/modules/state machines/data models that should evolve independently being tied together
- Statically provable performance problems: loop-internal expensive recomputation or I/O, repeated JSON/regex parsing, list membership where set is required, N+1 I/O patterns, blocking I/O in async code
- Test gaps that only prove happy path

### Tests and Risk

10. Judge whether tests truly prove key behavior, whether they miss failure paths, boundary conditions or regression scenarios, whether assertions are weakened to fit implementation.

## Review Requirements

- Use code review mode. Prioritize defects affecting correctness, stability, or maintainability.
- Default to suspicion. Goal is NOT to prove the change looks reasonable, but to find the strongest evidence it may not be fit to merge.
- Do not give credit for good intent, partial fixes, or possible follow-up work.
- Check whether changes violate repository instructions (`AGENTS.md` / `CLAUDE.md`).
- Findings must be based on direct evidence: code, diff, docs, test gaps, CI information, or reproducible reasoning.
- Uncertain issues go to `Open Questions`, not definite defects.
- Root cause must be on the same logic/data path as the triggering input, actual branch, state write, return value, or side effect.
- Prefer one strong finding over many weak findings. Do not dilute with style feedback, naming feedback, or low-value cleanup.
- If no material issues found, write `未发现实质性问题`.

## Review Artifact Format

```markdown
# Code Review

## Scope

- Mode: current changes | PR | all repository
- Branch or PR:
- Base:
- Output file:
- Included scope:
- Excluded scope:
- Parallel review coverage: none, or list subagent coverage and uncovered areas

## Findings

### #-未修复-[severity(低/中/高/严重)]-brief summary
- **入口/函数**: entry point or function where issue occurs
- **文件(行号)**: specific location
- **输入场景**: what input triggers the issue
- **实际分支**: which branch the code actually takes
- **预期行为**: expected behavior per system design
- **实际行为**: actual return value, state written, or omission
- **直接证据**: specific condition, parameter path, return value or state update location (line numbers)
- **影响**: wrong answer / wrong state / silent failure / unrecoverable / local behavior error
- **建议改法和验证点**:
- **修复风险（低/中/高）**:
- **严重程度（低/中/高/严重）**:

## Open Questions

- None, or list issues blocking confident judgment.

## Residual Risk

- Record test gaps, CI gaps, or unchecked areas.
```

## Iterative Fix Mode (--fix)

When `--fix` is specified:

1. After the initial review, parse findings from the artifact
2. For each Critical/High severity finding:
   - Read the relevant file
   - Apply the fix using `edit` tool
   - Verify the fix makes sense in context
3. Re-run `pi -p` with a focused prompt asking to verify fixes and find remaining issues
4. Repeat until pi reports no more meaningful issues or max 3 cycles
5. Produce a summary:

```markdown
## Fix Summary

### Issues Fixed
- [file:line] severity: description → fix applied

### Issues Intentionally Skipped
- [file:line] severity: description → reason

### Review Cycles
- Cycle 1: X issues found, Y fixed
- Cycle 2: ...
- Final: REVIEW COMPLETE or remaining issues documented
```

## Important Rules

1. **Use `pi -p` for review execution** — do not run pi interactively or in tmux
2. **Be patient** — pi may take time to analyze large diffs
3. **Critically evaluate feedback** — pi can make mistakes or hallucinate problems in unchanged code
4. **Verify before fixing** — always read the actual file before applying edits
5. **Don't fix blindly** — if a suggestion doesn't make sense, document why and skip it
6. **Stop when meaningful issues are exhausted** — don't chase nits indefinitely
7. **Write artifact before reporting** — always produce the docs/reviews/ file first

## Boundaries

During review, do not modify code unless `--fix` is specified or the user explicitly asks. Do not stage, commit, push, approve, request changes, or comment on GitHub/GitLab unless explicitly instructed.
