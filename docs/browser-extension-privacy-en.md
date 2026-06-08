# Agent Memory Lab Browser Extension Privacy Policy Draft

Last updated: 2026-06-08

Agent Memory Lab is a local-first browser extension that helps users capture webpage context, review memory candidates, and reuse local memories while working with AI assistants.

This draft is prepared for external testing and future Chrome Web Store submission. Before public release, publish this policy at a stable URL and update any contact or legal details.

## Data We Process

When you use the extension, it may process information from the active browser tab, including:

- Page title, URL, host, and page type.
- Meta description and visible headings.
- Text you selected on the page.
- Visible snippets from supported AI conversation pages.
- Current prompt draft text on supported AI pages.
- Candidate memories, candidate lessons, and privacy hints generated from the page.
- AI page diagnostics, including detected provider, whether an input editor was found, matched selector, prompt length, and recent turn count.

The extension does not intentionally collect:

- Browser history unrelated to the active tab.
- Cookies.
- Passwords.
- Payment details.
- Hidden form fields.
- Content from pages that are not open.

## How Data Is Used

The extension uses active-page context to:

- Generate memory and lesson candidates.
- Send candidates to the local Agent Memory Lab review queue.
- Search local memories relevant to the current prompt.
- Show memory suggestions near supported AI input boxes.
- Help users validate site support through AI diagnostics.

Long-term memory is not created silently by the extension. Candidates are reviewed in the local Agent Memory Lab workbench before they are saved.

## Where Data Goes

By default, the extension connects to local services:

- Local API: `http://localhost:3111`
- Local viewer: `http://localhost:3113`

Captured content is sent to your local Agent Memory Lab instance for review. The extension does not send captured content to a third-party cloud service by default.

If you configure a different API URL, data will be sent to the URL you configured. You are responsible for understanding and trusting that endpoint.

## Storage

The extension may store the following in browser storage:

- Local API URL.
- Local viewer URL.
- Optional access secret.
- Recent capture records used for extension UI history.

Long-term memories are stored by the local Agent Memory Lab workbench, not by the browser extension itself.

## AI Diagnostics

The side panel can copy diagnostic JSON for supported AI pages. Diagnostics are meant to help validate and repair site-specific input-box selectors. The copied JSON also includes a manual validation template for insert/copy/site-input checks; users must fill those fields themselves before treating evidence as passed.

Diagnostic JSON may include page title, URL, host, detected provider, editor-found state, matched selector, prompt length, and recent turn count. It does not intentionally include cookies, passwords, access tokens, or full hidden page source.

External testers may redact private prompt text, conversation snippets, sensitive page titles, and account-related details before submitting diagnostics. For site-adapter validation, keep the non-sensitive structural fields under `ai`, especially `provider`, `editorFound`, `anchorFound`, `memoryWidgetVisible`, `placement`, and `matchedSelectors.editor/anchor/send/turn`, plus the `manualValidation` result. These fields help reproduce selector issues without sharing cookies, tokens, passwords, or full chat content.

## User Control

Users control what becomes durable memory:

- Saving a page requires user action through the popup, side panel, or context menu.
- Long-term memory requires review and approval in the local workbench.
- Candidates can be edited or dismissed before saving.
- Local settings can be changed from the extension options page.

## Data Sharing

Agent Memory Lab does not sell user data. The browser extension does not share captured page content with third-party services by default.

## Security Notes

Because Agent Memory Lab is local-first, users should protect their local machine, local API endpoint, and any configured access secret. Do not expose the local API to untrusted networks.

## Changes to This Policy

This policy may change as the extension evolves. Material changes should be reflected in this file, the store listing, and the public privacy URL before release.
