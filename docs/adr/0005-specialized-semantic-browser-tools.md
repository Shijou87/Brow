# Use Specialized Semantic Browser Tools

Brow will improve page understanding with specialized semantic browser tools rather than making every **Browser Snapshot** larger or making VLM perception the primary automation planner. Compact snapshots remain the default orientation layer, while targeted tools such as target search, form snapshots, region snapshots, and frame snapshots provide the richer shape needed for specific interaction families.

## Considered Options

- Add more fields to every **Browser Snapshot**.
- Add specialized semantic browser tools.
- Use VLM perception as the primary page-understanding layer.

## Consequences

The agent gets clearer task-specific evidence without drowning every turn in page data, but Brow must maintain a small family of semantic tools and teach the planner which one to use for each interaction family.
