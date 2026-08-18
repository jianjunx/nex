---
name: code-review
description: Review diffs for correctness, security, and maintainability issues.
---
# Code review

Review changes with a bias toward finding real defects:

- Start with `code_graph` `action=impact` (git diff vs HEAD~1, or the paths in focus) to list changed symbols and their callers/importers, then `read_file` the high-risk spots.
- Call out bugs, race conditions, and missing error handling
- Flag security and data-loss risks
- Note missing tests where risk is high (`code_graph` `pattern=tests_for` on the changed symbol)
- Suggest concrete patches; avoid vague advice
