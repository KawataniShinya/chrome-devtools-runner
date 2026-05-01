# Usage Notes

- Invoke the runner from the repository root so the compatibility shim resolves correctly.
- The skill keeps the runner implementation under `scripts/` so the folder can later be extracted into a standalone `chrome-devtools-runner` repository with minimal reshaping.
- Treat requests like `ブラウザで確認して`, `画面確認して`, `実際に操作して`, and `ユーザー目線で見て` as triggers to use this skill.
- Prefer reporting what was visible in the browser first, then attach technical evidence such as URL, title, snapshot, playback state, or cache state.
- Use `open` mainly for the initial page or direct-link / deep-link confirmation. For normal flows, prefer link clicks, button clicks, form submission, back/forward, and reload actions.
- Use `set viewport` and `read viewport` when checking responsive layouts or mobile behavior.
- For destructive actions that trigger `window.confirm()`, use `accept dialog` or `dismiss dialog` explicitly.
- `--ensure-cdp` should prefer a temporary Chrome profile by default. Reusing a fixed profile is more fragile because stale locks and prior browser state leak into the run.
- If CDP startup fails, inspect the configured Chrome log file before changing runner logic.
