---
name: chrome-devtools-runner
description: Use when Codex needs to validate a web application in a real browser through Chrome DevTools MCP. This applies even when the request is vague, such as "ブラウザで確認して", "画面を確認して", "実際に操作して", "ユーザー目線で見て", or "ログインして試して". Prefer this skill for login flows, UI regression checks, playback checks, browser-driven acceptance tests, and user-visible behavior verification on local or remote sites.
---

# Chrome DevTools Runner

Use the bundled runner script for browser-driven validation.

## Trigger guidance

- Use this skill proactively when the user asks for browser-based confirmation, UI checking, user-visible verification, or "actual" operation in Chrome.
- Do not wait for the user to mention MCP, CDP, or the runner by name.
- When the request is broad, start from visible outcomes: open the page, perform the flow, verify what a user can see, and then report any technical evidence that supports that observation.

## Workflow

1. Locate this skill directory and run its bundled script:
   `node <skill-directory>/scripts/chrome-devtools-runner.js ...`
   In this repository, `<skill-directory>` is `.codex/skills/chrome-devtools-runner`. Do not assume a root-level shim exists.
2. Default mode lets `chrome-devtools-mcp` manage Chrome.
3. Use `--browser-url http://127.0.0.1:9222` to connect to an existing CDP instance.
4. Use `--ensure-cdp` to start Chrome with CDP if it is not already running.
5. `--ensure-cdp` now uses an auto-created temporary Chrome profile by default, which is more stable than reusing a fixed profile directory.

## Preferred usage

- Use high-level actions such as `open`, `new tab`, `list tabs`, `switch tab`, `close tab`, `click`, `type`, `submit`, `back`, `forward`, `reload`, `set viewport`, `read viewport`, `wait`, `wait url`, `wait text gone`, `expect text`, `expect url`, `expect title`, `read page`, `snapshot`, `accept dialog`, and `dismiss dialog`.
- Prefer user-visible labels over CSS selectors where possible.
- For web-app checks, verify both action success and visible outcome.
- When a flow is asynchronous, add `wait` and `expect` steps instead of relying on timing assumptions.
- When a request only says "confirm in browser" or similar, default to `open`, `read page`, `click`, `type`, `submit`, `back`, `forward`, `reload`, `wait`, `expect`, and finish with a short user-visible summary.
- When verifying responsive layouts, use `set viewport` and `read viewport` to switch between desktop and mobile widths before checking the visible result.
- `set viewport` is session-level state: after switching or opening tabs, the runner reapplies the last viewport so mobile checks stay stable across navigation.
- When a destructive action opens a native browser confirmation dialog, use `accept dialog` or `dismiss dialog` explicitly instead of assuming the page will continue.
- When using `--ensure-cdp`, prefer the default temporary profile unless the task explicitly needs a persistent browser state. Use `--reuse-chrome-profile` only when persistence is intentional.
- Use `--show-tool-schemas` when MCP tool argument behavior changes or needs confirmation.
- Links may open a new tab. Use `list tabs`, then `switch tab <ID or URL>` before reading or asserting the destination. A successful click alone does not verify navigation.
- Tool errors must be reported as failures; an empty snapshot is not evidence that the page loaded successfully.
- Treat `open` as the entry point for initial pages and direct-link/deep-link checks. For normal in-app navigation, prefer clicking links/buttons, submitting forms, and using browser history actions.

## Examples

- `node <skill-directory>/scripts/chrome-devtools-runner.js --ensure-cdp "open http://localhost:3000/login then type Email user@example.com then type Password secret123 then click Log in then wait Dashboard then expect url /dashboard"`
- `node <skill-directory>/scripts/chrome-devtools-runner.js --browser-url http://127.0.0.1:9222 "open http://localhost:3000/admin then snapshot"`
- `node <skill-directory>/scripts/chrome-devtools-runner.js --ensure-cdp "new tab https://example.com then list tabs then switch tab 1 then read page"`
- `node <skill-directory>/scripts/chrome-devtools-runner.js --ensure-cdp "open http://localhost:3000 then 画面を確認して"`
- `node <skill-directory>/scripts/chrome-devtools-runner.js --ensure-cdp "open http://localhost:3000 then click Dashboard then back then forward then reload then read page"`
- `node <skill-directory>/scripts/chrome-devtools-runner.js --ensure-cdp "set viewport mobile then open http://localhost:3000 then read viewport then read page"`

## Resources

- Runner implementation: `scripts/chrome-devtools-runner.js`
- Notes for future extraction into a standalone repo can live in `references/` when needed.
