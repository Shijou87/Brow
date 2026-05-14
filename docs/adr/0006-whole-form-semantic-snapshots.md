# Use Whole-Form Semantic Snapshots

Brow's **Form Snapshot** will represent the whole form, including hidden and offscreen fields, rather than limiting itself to currently visible viewport fields. This differs from the generic visible-first **Browser Snapshot** because form automation needs submit semantics, validation cues, autocomplete hints, hidden platform fields, and offscreen multi-step context to decide safely what should and should not be filled.

## Considered Options

- Visible fields only.
- Whole form, including hidden and offscreen fields.
- Active viewport plus expansion hints.

## Consequences

Hidden and offscreen fields can inform planning, but they are metadata by default. Brow should only fill visible, enabled, user-meaningful, or explicitly safe fields unless a page tool or domain rule says otherwise.
