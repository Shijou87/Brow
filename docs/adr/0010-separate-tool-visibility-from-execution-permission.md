# Separate Tool Visibility From Execution Permission

Brow will let the model see automation tools for planning while requiring user approval, enablement, or trust state before executing them. Hiding automation tools from the model makes the agent worse at planning browser work, while always enabling them gives too much default power.

## Considered Options

- Hide disabled automation tools from the model.
- Show automation tools but gate execution.
- Always enable automation tools.

## Consequences

The tool manifest and agent graph need separate concepts for model visibility and execution permission. User-facing controls should make it clear whether a tool is unavailable, visible-but-approval-gated, or trusted for the session/domain.
