# Use Helper Backend For Cross-Origin Frame Automation

Brow will keep same-origin frame traversal in the MV3 **Browser Snapshot** path, but cross-origin frame understanding and automation require the local helper backend or an equivalent browser-level bridge. MV3 content scripts cannot safely inspect or control arbitrary cross-origin frame DOM, and treating those frames as permanently opaque would make **Full-Spectrum Browser Automation** fail on many embedded apps, payment flows, editors, and enterprise tools.

## Considered Options

- Skip cross-origin frames permanently.
- Use the helper backend or browser-level bridge.
- Ask the user to open the frame separately.

## Consequences

Cross-origin frames remain visible as bounded regions in the extension path, while deeper inspection or reliable interaction must report helper-required state and respect the user's helper trust boundary.
