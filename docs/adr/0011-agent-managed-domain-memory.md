# 0011. Agent-Managed Domain Memory

## Status

Accepted

## Context

Brow already has two reusable-knowledge mechanisms:

- **Brow Action Memory** replays successful action target resolutions from stable intents.
- **Domain Skills** are user-managed, reviewable site guidance that the agent can load on demand.

Browser work also produces smaller operational lessons that are too fluid for a polished Domain Skill and too semantic for Action Memory: site quirks, waits, selector traps, failure fixes, and safe API hints. Requiring every such lesson to become a pending Domain Skill proposal would make learning too heavy, while putting it into Action Memory would blur successful action replay with broader domain knowledge.

## Decision

Add **Domain Memory** as a local, agent-managed store of operational domain knowledge.

Domain Memory entries are structured cards scoped by domain, optional path patterns, and optional page keywords. Brow may create, merge, update, disable, or delete these cards through tools. Matched cards appear in request context only as a compact index; the agent must call `domain_memory_load` to inspect full details.

Domain Memory stores operational mechanics only. It must not store secrets, account content, private page data, or raw dynamic user values.

## Consequences

- Brow can learn lightweight site lessons without user review friction.
- Domain Skills remain the user-managed, polished guidance layer.
- Brow Action Memory remains focused on successful action replay.
- The feature is more autonomous than pending proposals, so the hidden Domain Memory UI provides edit, disable, and delete controls.
