# Use A Canonical Field Purpose Vocabulary

Brow will expose **Field Purpose** through a canonical Brow vocabulary plus raw page evidence, rather than using HTML autocomplete tokens directly or returning free-form purpose text. This gives the agent stable categories for planning while preserving labels, names, autocomplete values, and other evidence for ambiguity checks.

## Considered Options

- HTML autocomplete tokens only.
- Canonical Brow vocabulary plus raw evidence.
- Free-form purpose text.

## Consequences

The vocabulary must be curated and versioned as form support grows, and unknown or low-confidence fields should remain `unknown` instead of being forced into a nearby category.
