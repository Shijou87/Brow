# Use Region Snapshots As Interaction Maps

Brow's **Region Snapshot** will return an interaction map for surface-like controls instead of only raw bounds or a visual description. For canvas, SVG, map, board, video, and drawing surfaces, the agent needs coordinate spaces, target-relative pointer semantics, available SVG subtargets, canvas fallback metadata, and helper-backend likelihood to act repeatably.

## Considered Options

- Bounds only.
- Interaction map.
- Visual description only.

## Consequences

Region automation stays ref-backed and layout-aware, but Brow must distinguish perception questions from execution planning and report clearly when the MV3 backend is likely too weak for the interaction.
