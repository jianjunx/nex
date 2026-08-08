---
name: git-commit
description: Create a clean Conventional Commits git commit from the current diff.
---
# Git commit

When asked to commit:

1. Run `git status` and inspect the relevant diff.
2. Stage only files that belong in the commit; never add secrets.
3. Write a Conventional Commits message focused on why.
4. Create the commit with a non-interactive git command.
5. Show the resulting commit summary to the user.
