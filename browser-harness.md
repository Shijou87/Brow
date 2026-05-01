Absolutely — here is an English doc focused on **what is worth borrowing from Browser Harness** for Brow.

# What We Should Reuse from Browser Harness

## Summary

Browser Harness is not the right blueprint for our entire execution layer, but it contains several strong ideas that are worth adopting. Its main value is not “better browser automation primitives”; its main value is the way it treats the browser agent as a system that **learns reusable domain knowledge over time**. The project is built around a thin CDP harness, editable helper code, and reusable site-specific skills stored in `agent-workspace/domain-skills/`. ([GitHub][1])

For Brow, the best path is to keep a more reliable execution core, but borrow Browser Harness ideas for **domain memory, reusable skills, pragmatic verification, and operational learning**. ([GitHub][1])

## 1. Reuse the “domain skills” model

The most valuable idea in Browser Harness is the explicit use of **site-specific reusable knowledge**. The repo tells the agent to search `agent-workspace/domain-skills/` first before inventing a new approach, and to contribute back anything non-obvious it learns about a site. ([GitHub][2])

This is important because browser agents fail when they have to rediscover the same facts every run. A strong agent should remember things such as:

* URL patterns and required query params
* private APIs the site calls
* stable selectors
* framework quirks
* waits that are required on that site
* traps and misleading selectors ([GitHub][2])

For Brow, we should implement a similar structure such as:

```text
skills/domains/github/
skills/domains/linkedin/
skills/domains/salesforce/
skills/domains/notion/
```

Each domain skill should capture the **durable shape of the site**, not a transcript of one run. Browser Harness is very explicit about this distinction. ([GitHub][2])

## 2. Reuse the “always contribute back” principle

Browser Harness has an excellent operating principle: if the agent learns something non-obvious, it should write it back so the next run does not pay the same discovery cost again. The repo even says that the harness gets better only because agents file what they learn. ([GitHub][2])

This is one of the most important ideas for Brow. It turns the system from “an agent that performs tasks” into “an agent platform that compounds knowledge.”

For Brow, every successful run should be able to produce structured learnings such as:

* new stable locator candidates
* validated waits
* alternate flows that work
* API shortcuts that bypass fragile DOM interaction
* known failure modes for a site ([GitHub][2])

That learning loop is worth copying almost directly.

## 3. Reuse the split between core helpers and editable workspace

Browser Harness separates a protected core from an editable workspace. The repo highlights `src/browser_harness/` as the protected core package, while `agent-workspace/agent_helpers.py` and `agent-workspace/domain-skills/` are the places the agent can extend and improve behavior. ([GitHub][1])

This separation is a good design pattern for Brow because it avoids mixing:

* trusted execution infrastructure
* agent-generated helper logic
* domain-specific learnings

A similar Brow structure could be:

```text
core/
  browser_runtime/
  tool_execution/
  permissions/
workspace/
  agent_helpers/
  domain_skills/
  generated_strategies/
```

This makes the platform safer, easier to debug, and easier to evolve. The repo’s structure strongly suggests this separation is intentional and central to the design. ([GitHub][1])

## 4. Reuse the idea that screenshots are excellent for fast understanding and verification

Browser Harness strongly recommends a “screenshots first” workflow for understanding the current page quickly, finding visible targets, and deciding whether the next step should use clicking, selectors, or more navigation. It also recommends screenshots as the default way to verify whether a visible action actually worked. ([GitHub][2])

This is a very good idea for Brow.

Not because screenshots should replace DOM-first execution, but because they are very useful for:

* fast situational awareness
* visual verification after an action
* diagnosing layout issues, overlays, popups, and wrong-page states
* handling cases where the visible UI is more informative than the raw DOM ([GitHub][2])

So Brow should absolutely keep a screenshot-first **analysis and verification layer**, even if execution itself remains more structured.

## 5. Reuse the pragmatic use of non-DOM shortcuts

Browser Harness encourages using faster paths when available, including direct HTTP for static pages, and it explicitly notes that private APIs are often much faster than DOM scraping. ([GitHub][2])

This is a strong product lesson: a browser agent should not be ideologically attached to “everything must happen through the visible DOM.” A good system should opportunistically use:

* network/API shortcuts
* structured page data
* browser automation
* screenshots/vision
* DOM inspection

For Brow, this means the agent planner should be able to choose among multiple execution modes depending on the task. Browser Harness is valuable here because it treats the browser as one tool among several, not as the only path. ([GitHub][2])

## 6. Reuse the explicit catalog of interaction skills

Browser Harness includes reusable interaction skills for common hard UI mechanics such as dialogs, downloads, drag-and-drop, dropdowns, iframes, shadow DOM, tabs, uploads, screenshots, scrolling, and network requests. ([GitHub][2])

That is a very good organizational model.

For Brow, we should define a similar capability library, for example:

* `iframes`
* `shadow-dom`
* `uploads`
* `dialogs`
* `tabs`
* `scrolling`
* `network-capture`
* `screenshot-analysis`

This matters because many browser failures are not domain-specific; they are recurring UI mechanics. Browser Harness’s separation between interaction skills and domain skills is worth preserving. ([GitHub][2])

## 7. Reuse the idea of connecting to the user’s real browser context

Browser Harness is built around connecting directly to the user’s real browser via CDP rather than always launching an isolated automation browser. Its README frames the product as “one websocket to Chrome, nothing between,” and its design constraints explicitly say to connect to the user’s running Chrome. ([GitHub][1])

This is important because real-browser context can provide:

* logged-in sessions
* existing cookies
* the tabs the user is already working in
* less friction for day-to-day assistance

For Brow, this is already directionally aligned with a browser extension. The Browser Harness lesson is that this should be treated as a first-class design choice, not just an implementation detail. ([GitHub][1])

## What we should *not* copy as-is

We should not copy Browser Harness’s default philosophy of coordinate-clicking as the primary execution model. The repo explicitly recommends screenshot → pixel read → `click_at_xy(x, y)` and even says to suppress the “locate first, then click” reflex. ([GitHub][2])

That approach is clever and useful in difficult cases, especially because it can pass through iframes and shadow DOM, but Browser Harness also warns against saving raw pixel coordinates in domain skills because they break with viewport, zoom, and layout changes. ([GitHub][2])

So for Brow, coordinate clicking should be a **fallback**, not the default. The Browser Harness insight to keep is not “pixels first forever”; it is “visible-state reasoning is useful, and visual verification matters.” ([GitHub][2])

## Recommended Brow adaptation

The best adaptation is:

* keep a more reliable structured execution layer for actions
* add Browser Harness-style domain skills
* add Browser Harness-style contribution back after successful runs
* keep screenshots as a default perception and verification tool
* build a library of reusable interaction skills
* allow helper generation in a controlled workspace
* use API/network shortcuts when they are more reliable than DOM interaction ([GitHub][1])

In other words, we should copy the **learning architecture** of Browser Harness much more than its raw click strategy.

## Conclusion

What Browser Harness gets very right is the idea that a browser agent should **accumulate reusable operational knowledge**: domain skills, helper code, interaction patterns, site quirks, and verification habits. Its strongest contribution is not a perfect execution model, but a system design that lets the agent improve itself across runs. ([GitHub][1])

For Brow, the key takeaway is:

**Borrow the memory, the skill structure, the contribution loop, and the pragmatic verification model. Do not blindly copy the coordinate-click-first execution philosophy.** ([GitHub][2])


[1]: https://github.com/browser-use/browser-harness/blob/main/README.md "browser-harness/README.md at main · browser-use/browser-harness · GitHub"
[2]: https://github.com/browser-use/browser-harness/blob/main/SKILL.md "browser-harness/SKILL.md at main · browser-use/browser-harness · GitHub"
