---
name: install-skill
description: >-
  Install an Agent skill into Nex. Use when the user wants to install, add,
  copy, import, or download a skill, or asks where NexAgent skills live.
---
# Install a skill into Nex

Nex discovers skills from two roots (project overrides the same name globally):

```
~/.nex/skills/<skill-name>/SKILL.md
<cwd>/.nex/skills/<skill-name>/SKILL.md
```

If you install anywhere else, the skill will **not** appear in NexAgent.

## Canonical install paths

| Scope | Root |
|-------|------|
| Global | `~/.nex/skills/` (user home + `.nex/skills`) |
| Project | `<cwd>/.nex/skills/` (open project + `.nex/skills`) |
| Layout | One folder per skill: `<skill-name>/SKILL.md` |
| Catalog key | **Folder name** (not the frontmatter `name` if they differ) |
| Cross-platform | Use native path separators |

Ask the user whether to install **globally** or **into this project**. Default to
the project when a repository is open and the user does not specify.

**Wrong locations** (do not use for Nex):

- `~/.claude/skills/`, `.claude/skills/`
- `~/.cursor/skills/`, `.cursor/skills/`

Claude-compatible skill folders work as-is **after** you place them under one of
the two Nex roots.

## Install workflows

Ask the user for the source (local folder, git URL, zip, or gist), the skill name
if unclear, and the destination scope. Prefer copying/cloning into the chosen
root rather than inventing a new format.

### From a local folder

1. Ensure the source contains a `SKILL.md` with YAML frontmatter.
2. Copy the folder to `~/.nex/skills/<skill-name>/` or `<cwd>/.nex/skills/<skill-name>/` (create the root if missing).
3. `<skill-name>` should be a stable slug; if the source folder is nested (`repo/skills/foo`), install the `foo` folder, not the whole repo root.

### From git

```bash
# Example: clone a single skill directory into the chosen root
git clone --depth 1 <repo-url> /tmp/skill-src
cp -R /tmp/skill-src/<path-to-skill> ~/.nex/skills/<skill-name>
# or: cp -R /tmp/skill-src/<path-to-skill> <cwd>/.nex/skills/<skill-name>
```

On Windows, use equivalent PowerShell/`Copy-Item` commands; still target
`%USERPROFILE%\.nex\skills\<skill-name>\` or `<cwd>\.nex\skills\<skill-name>\`.

### From a zip / archive

Extract so that `SKILL.md` ends up at `<root>/<skill-name>/SKILL.md` (not nested
an extra level like `.../skill-name/skill-name/SKILL.md` unless intentional).

### From Claude / Cursor skills the user already has

Copy the skill folder into the chosen Nex root — same `SKILL.md` layout. Do not
symlink into Claude/Cursor trees unless the user explicitly wants that; a normal
copy is clearer.

## Safety checks before installing

1. Open `SKILL.md` and confirm frontmatter + instructions look legitimate.
2. Be cautious with `scripts/` or other executables — summarize what they do; do not run untrusted installers blindly.
3. Refuse to overwrite an existing skill without the user's confirmation (especially bundled names: `git-commit`, `code-review`, `debug`, `refactor`, `create-skill`, `install-skill`).
4. Never install secrets or credentials into skill files.

## After install

1. Confirm `<root>/<skill-name>/SKILL.md` exists and parses.
2. Tell the user to refresh Skills in Settings → NexAgent → 技能, or start a new agent turn so the catalog picks it up.
3. The skill is invokable as `/<skill-name>` and via `load_skill` when the description matches.

## Quick diagnosis

| Symptom | Likely cause |
|---------|----------------|
| Skill missing from catalog | Wrong directory (not under `~/.nex/skills/` or `<cwd>/.nex/skills/`) |
| `load_skill` not found | Folder name mismatch / missing `SKILL.md` |
| Global skill ignored | Same-name project skill overrides it |
| Malformed / skipped | Missing or unclosed YAML frontmatter |
| Still old content | Existing file left in place; user needs overwrite confirmation |
