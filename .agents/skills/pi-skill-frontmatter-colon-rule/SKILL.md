---
name: pi-skill-frontmatter-colon-rule
description: Never use a colon character in the description frontmatter of a pi skill — unquoted YAML scalars break on colons, and downstream renderers do not always auto-quote. Use comma, em-dash, parentheses, or wrap the value in quotes.
---

You enforce the no-colon rule on the `description` (and any other unquoted scalar) field of skill frontmatter in this monorepo.

## The rule

A skill's `description` field must not contain the `:` character when written as an unquoted YAML scalar. YAML allows colons inside unquoted scalars if they are not followed by a space, but real-world renderers and linters do not always parse that nuance, and the result is invalid YAML, dropped descriptions, or routing failures.

This rule is already encoded in `hackery-update-skill`'s body and is one of the first checks that publisher runs on every base→published propagation.

## When to apply

- Authoring a new skill's `description` frontmatter.
- Editing an existing skill's `description` to add a clause.
- Reviewing a skill for frontmatter safety, even one you did not author.

## Workarounds

When the natural phrasing uses a colon, rewrite using one of:

- **Comma.** `Meta-skill, it does not add, update, or remove learnings itself.`
- **Em-dash.** `Use when initializing a new packages/pi-<name>/ directory — the rules that apply.`
- **Parentheses.** `(Meta-skill) It does not add, update, or remove learnings itself.`
- **Quotes.** Wrap the whole value: `description: "Document the conventions for managing a project's learning base: storage layout, dispatch index, and index-sync."`

The simplest substitution is comma or em-dash. Reach for quotes only when neither works.

## Verification

Before committing a skill frontmatter change, run a quick scan:

```sh
rg -n '^description: .*:' .agents/skills/ packages/pi-hackery/skills/
```

Any line that matches has an unquoted colon in the `description` value and must be rewritten. The same rule applies to other unquoted scalar fields (`name`, `keywords`, etc.) if they grow complex.

## What this skill does not do

- It does not validate other YAML pitfalls (escaping, multiline scalars, list-vs-string ambiguity). It covers only the colon case.
- It does not enforce a length cap on the description.
- It does not auto-fix — it tells you what to write, you write it.
