# Use MV3-First Helper-Backed Automation

Brow will keep MV3 DOM-derived **Browser Snapshot** refs as the default execution backbone, but will treat a local helper backend as a first-class fallback for native pointer fidelity, file selection, downloads, drawing/canvas reliability, native dialogs, and other interactions the extension sandbox cannot perform robustly. This preserves the low-friction extension path for ordinary browser work while giving **Full-Spectrum Browser Automation** a clear escalation route instead of stretching DOM event synthesis past its natural limits.

## Considered Options

- MV3-only automation.
- MV3-first automation with helper fallback.
- Helper-first automation.

## Consequences

The default path remains deployable as a normal Chrome extension, but the product must expose backend confidence, helper-required states, and user trust/installation boundaries clearly whenever a task needs the local helper.
