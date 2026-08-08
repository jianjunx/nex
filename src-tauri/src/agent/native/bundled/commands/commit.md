---
description: Draft a conventional commit for the current git changes
argument-hint: optional focus or style notes
---
Create a git commit for the current changes.

Requirements:
- Inspect `git status` and the relevant diff before writing the message
- Use a Conventional Commits subject (feat/fix/refactor/docs/test/chore/…)
- Keep the subject concise; add a short body only when needed
- Do not commit secrets, `.env`, or unrelated files
- Prefer staging only the files that belong in this commit

$ARGUMENTS
