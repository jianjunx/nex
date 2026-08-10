---
name: create-skill
description: >-
  Create a Nex Agent skill (SKILL.md). Use when the user wants to author a new
  skill, scaffold skill structure, or asks how to write a skill for NexAgent.
---
# Create a Nex skill

Nex skills are Claude-compatible folders discovered from **`~/.nex/skills/`** only.

## Destination (required)

```
~/.nex/skills/<skill-name>/SKILL.md
```

- Expand `~` to the user home directory (macOS/Linux: `$HOME`, Windows: user profile).
- `<skill-name>`: lowercase letters, digits, hyphens; folder name is the catalog / `load_skill` key.
- Do **not** write to `~/.claude/skills`, `.claude/skills`, `~/.cursor/skills`, or project `.nex/skills` — Nex will not discover those.

## Workflow

1. Confirm purpose, trigger scenarios, and any verbatim wording the user wants preserved.
2. Pick a short, unique `<skill-name>` that does not collide with existing skills under `~/.nex/skills/`.
3. Create the directory and write `SKILL.md` with YAML frontmatter + markdown body.
4. Optionally add supporting files (`references/`, `scripts/`, templates) next to `SKILL.md`; mention them in the body so the model can `load_skill` with `file`.
5. Tell the user the skill appears in Settings → NexAgent → 技能, and as `/<skill-name>` after refresh / a new turn.

## SKILL.md template

```markdown
---
name: skill-name
description: What it does and when to use it (triggers auto-selection).
---
# Skill title

## Instructions
Step-by-step guidance the agent must follow.

## Examples
Concrete inputs/outputs when helpful.
```

### Frontmatter rules

| Field | Rules |
|-------|--------|
| `name` | Prefer match folder name; max ~64 chars; `[a-z0-9-]` |
| `description` | Non-empty; include **what** + **when** so the catalog can match tasks |

Unknown frontmatter fields (e.g. `allowed-tools`) are tolerated for Claude compatibility but are not required.

## Writing tips

- Keep the body actionable and scoped; put long reference material in supporting files.
- Descriptions should mention trigger phrases the user would say.
- Prefer small skills over mega-docs.
- Never put secrets in skill files.

## Verify

- `SKILL.md` parses (leading `---` frontmatter closed by a second `---`).
- Path is exactly under `~/.nex/skills/<skill-name>/`.
- `load_skill` with `skill=<skill-name>` returns the body once the catalog refreshes.
