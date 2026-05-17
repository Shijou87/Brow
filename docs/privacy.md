# Privacy Policy for Brow

Last updated: 05/17/2026

This Privacy Policy explains how **Brow** handles information when you use the Brow Chrome extension.

## 1. What Brow Is

Brow is an AI browsing assistant for Chrome. It helps users understand visible web pages, complete browser tasks, and use connected tools directly from the Chrome side panel.

Brow works inside the user's live Chrome session. Depending on how you configure and use it, Brow may process page content, browser context, user-entered prompts, workflow recordings, and data sent to user-configured AI or MCP services.

## 2. Scope Of This Policy

This policy applies to the Brow Chrome extension as published by `[INSERT PUBLISHER NAME]`.

It covers:

- data Brow stores locally in the extension;
- data Brow processes from tabs and pages the user chooses to use with Brow;
- data Brow sends to third-party services explicitly configured or invoked by the user, such as LLM, VLM, or MCP endpoints.

This policy does **not** replace the privacy policies of third-party services you connect to Brow. If you configure Brow to use external AI providers, MCP servers, or other remote services, their policies also apply.

## 3. Information Brow May Process

Depending on which features you use, Brow may process the following categories of information:

### a. Configuration Data

- LLM endpoint URLs
- VLM endpoint URLs
- MCP server URLs
- API keys or bearer tokens entered by the user for configured services
- feature and runtime settings

### b. User Input And Conversation Data

- prompts and chat messages entered in Brow
- saved conversation history
- conversation summaries and related state used to keep context within model limits

### c. Browser Context And Page Data

- tab URLs and titles used as context
- visible page structure captured through Browser Snapshots
- form structure and safe field values captured through Form Snapshots
- visible website content from pages the user chooses to use with Brow
- screenshots or regional screenshots sent to a configured VLM for perception tasks

### d. Workflow And Automation Data

- workflow demonstrations recorded by the user
- replay evidence such as page context, targets, selectors, non-secret typed values, and pointer evidence
- action results, verification signals, and related automation state

### e. Browser Data Accessed On User Request

- bookmarks, if the user asks Brow to read or search bookmarks
- browser history, if the user asks Brow to search browsing history
- download state, when Brow verifies whether a requested download occurred or exports Brow-generated content

## 4. Information Brow Is Designed To Avoid Or Limit

Brow is designed to reduce unnecessary collection of sensitive data where possible.

Examples:

- password fields are omitted from workflow recording
- file inputs are omitted from workflow recording
- sensitive current field values are not intended to be exposed as safe field values
- Brow's local operational memory is intended for non-secret site knowledge, not user secrets or account content

However, because Brow operates on pages the user chooses, page content visible to Brow may still include sensitive information if the user uses Brow on such pages.

## 5. How Brow Uses Information

Brow uses information to provide its core functionality, including:

- answering user prompts in the side panel
- understanding visible web pages and forms
- carrying out browsing and automation tasks requested by the user
- saving conversations, workflow demonstrations, and preferences
- connecting to user-configured LLM, VLM, and MCP services
- rendering approved MCP Apps and Brow-generated HTML artifacts in a sandboxed environment
- improving task continuity through local memory, saved state, and reusable workflow context

Brow does not use user data for creditworthiness, lending, or unrelated advertising purposes.

## 6. Where Data Is Processed

### a. Local Processing And Storage

Brow stores a significant amount of state locally using Chrome extension storage, including configuration, saved conversations, workflow demonstrations, and local memory features.

### b. User-Configured Remote Services

If you configure Brow to use remote services, Brow may send relevant data to those services so the requested feature can work.

Examples include:

- prompts and assembled context sent to a configured LLM endpoint
- screenshots or cropped page regions sent to a configured VLM endpoint
- tool calls, resource reads, and app resources exchanged with configured MCP servers

You control whether Brow is connected to these services by configuring or removing them.

## 7. Remote HTML, MCP Apps, And Sandboxed Content

Brow can render interactive HTML provided by remote MCP servers or generated dynamically during use. This content may include JavaScript and is rendered in an isolated sandbox rather than inside Brow's privileged extension UI.

This is done to support MCP Apps and Brow-authored HTML artifacts while reducing risk to the extension's main interface. Even so, users should treat remote app content and generated HTML as active content and use Brow only with trusted workflows and services.

## 8. Data Sharing

Brow does not sell user data.

Brow may share or transmit data only in the following limited ways:

- to LLM, VLM, or MCP services that the user configures or invokes;
- to page-provided tools or remote resources needed to complete a user-requested action;
- when necessary to render approved sandboxed app content;
- when required by law or valid legal process.

Brow is not intended to transfer user data to third parties for unrelated commercial profiling or advertising.

## 9. Data Retention

Locally stored Brow data remains stored until:

- the user deletes conversations or stored data,
- the user changes or removes configuration,
- the user clears Chrome extension storage,
- or the extension is uninstalled.

Data sent to third-party endpoints is retained according to the policies and retention practices of those third parties, which are outside Brow's control.

## 10. User Choices And Controls

Users can control Brow by:

- choosing whether to install and use the extension
- choosing which tabs and pages to use with Brow
- choosing which prompts to send
- choosing whether to configure external LLM, VLM, or MCP services
- deleting saved conversations and related local state
- uninstalling the extension

If you want to stop all future local storage by Brow, uninstall the extension and clear any remaining extension data in Chrome.

## 11. Security

Brow uses Chrome extension storage and sandboxing features to reduce risk, and it separates privileged extension UI from sandboxed HTML app execution where applicable.

However, no software system can guarantee absolute security. Users should avoid sending highly sensitive information to external services unless they understand and accept the privacy and security practices of those services.

## 12. Children's Privacy

Brow is not directed to children and is not intended for use by children.

## 13. Changes To This Policy

This Privacy Policy may be updated from time to time. The latest version should be made available at:

`[INSERT PRIVACY POLICY URL OR REPOSITORY URL]`

The "Last updated" date at the top of this page will reflect the latest revision.

## 14. Contact

For privacy questions about Brow, contact:

- Publisher / company name: `Brow`
- Contact email: `valoriaapp@gmail.com`
- Repository URL: `https://github.com/Shijou87/Brow`
