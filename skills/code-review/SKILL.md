---
name: code-review
description: Automated iterative code review. Launches pi in a tmux session, feeds it a review prompt for all uncommitted changes, captures feedback, filters meaningful suggestions, applies fixes, and repeats until pi approves. Use when reviewing uncommitted code or running pre-commit review loops.
---

# Code Review Skill

Iteratively review uncommitted code changes using pi itself as the reviewer.

## Workflow

### Phase 1: Launch pi in tmux

Start a detached tmux session named `pi-review` running pi in the project root:

```bash
tmux new-session -d -s pi-review -c "$PROJECT_ROOT" 'pi'
```

Where `$PROJECT_ROOT` is the root of the git repo being reviewed.

If a `pi-review` session already exists, kill it first:

```bash
tmux kill-session -t pi-review 2>/dev/null
tmux new-session -d -s pi-review -c "$PROJECT_ROOT" 'pi'
```

### Phase 2: Send review prompt

Send a structured review prompt to pi via `tmux send-keys`. The prompt should:

1. Ask pi to review ALL uncommitted changes (`git diff` + `git diff --cached` + untracked files)
2. Request specific, actionable feedback in categories: bugs, logic errors, style issues, missing edge cases, security concerns, performance issues
3. Ask pi to output findings in a structured format with file paths and line references
4. Instruct pi to note when it has NO more meaningful feedback to give

Example prompt template:

```
You are a rigorous code reviewer. Please review ALL uncommitted changes in this repo.

Run:
  git diff
  git diff --cached
  git status --short

For each issue you find, report:
- FILE: <path>
- LINE: <line or range>
- SEVERITY: critical | major | minor | nit
- CATEGORY: bug | logic | style | edge-case | security | performance | other
- DESCRIPTION: <clear explanation of the problem>
- SUGGESTION: <concrete fix>

CRITICAL: bugs that would cause runtime errors or incorrect behavior
MAJOR: logic flaws, missing error handling, architectural issues
MINOR: style inconsistencies, naming, minor improvements
NIT: cosmetic, optional suggestions

After reviewing, explicitly state one of:
- "FURTHER REVIEW NEEDED: <summary of remaining concerns>"
- "REVIEW COMPLETE: No more meaningful issues found."
```

Send the prompt:

```bash
tmux send-keys -t pi-review "$REVIEW_PROMPT" Enter
```

### Phase 3: Wait and capture output

Wait for pi to finish processing (this may take several turns as pi runs git commands). Monitor by checking if pi is still running:

```bash
# Wait for pi to finish (check if tmux pane is still alive)
while tmux has-session -t pi-review 2>/dev/null; do sleep 5; done
```

Or, more practically, capture output after giving pi enough time:

```bash
tmux capture-pane -t pi-review -p -S - > /tmp/pi-review-output.txt
```

### Phase 4: Parse and filter feedback

Read `/tmp/pi-review-output.txt` and extract:

1. **Meaningful issues**: Critical and major severity items, or minor items with clear correctness impact
2. **Noise to ignore**: 
   - Nits about formatting that don't affect behavior
   - Style preferences without objective justification
   - Suggestions that conflict with established project conventions
   - "Consider" suggestions without concrete benefit
   - Feedback on files unrelated to the actual changes

### Phase 5: Apply fixes

For each meaningful issue identified:
1. Read the relevant file
2. Apply the fix using `edit` tool
3. Verify the fix makes sense

### Phase 6: Loop

After fixing meaningful issues:
1. Check pi's conclusion statement
2. If "REVIEW COMPLETE" → done, proceed to summary
3. If "FURTHER REVIEW NEEDED" → send a follow-up prompt asking pi to re-review only the remaining concerns
4. If pi crashed or timed out → restart from Phase 1 with a focused prompt on remaining issues

Send follow-up:

```bash
tmux send-keys -t pi-review "I've applied your suggested fixes. Please re-review the current state. Focus on any remaining issues you flagged as unresolved." Enter
```

### Phase 7: Summary

After the review cycle completes, produce a summary:

```
## Code Review Summary

### Issues Fixed
- [file:line] severity: description → fix applied

### Issues Intentionally Ignored
- [file:line] severity: description → reason for ignoring

### Review Cycles
- Cycle 1: X issues found, Y fixed, Z ignored
- Cycle 2: ...
- Final: REVIEW COMPLETE
```

## Important Rules

1. **Always run pi in tmux** — never run pi directly in a way that blocks the agent
2. **Be patient with pi** — it may take several turns to run git commands and analyze
3. **Critically evaluate pi's feedback** — pi can make mistakes, suggest non-issues, or hallucinate problems in unchanged code
4. **Verify before fixing** — always read the actual file before applying edits
5. **Don't fix blindly** — if a suggestion doesn't make sense, document why and skip it
6. **Keep the review focused** — if pi goes off-track, redirect with a focused prompt
7. **Stop when meaningful issues are exhausted** — don't chase nits indefinitely

## Scripts

Helper script to launch the review session:

```bash
# scripts/start-review.sh
#!/bin/bash
PROJECT_ROOT="${1:-$(pwd)}"
SESSION="pi-review"

# Kill existing session
tmux kill-session -t "$SESSION" 2>/dev/null
sleep 1

# Start pi in new session
tmux new-session -d -s "$SESSION" -c "$PROJECT_ROOT" 'pi'
echo "pi-review session started in $PROJECT_ROOT"
```
