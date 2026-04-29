# Chrome DevTools Runner

Chrome DevTools Runner is a Codex skill and command-line runner for validating web applications in a real Chrome browser through [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp).

It is designed for user-visible browser checks: logging in, clicking through flows, waiting for asynchronous UI changes, reading the current page, verifying URLs and text, and reporting what a user can actually see.

## Why This Exists

LLM-assisted development often needs browser confirmation that is more concrete than "the code looks right". This project provides a small runner that Codex can invoke from a repository to operate Chrome through MCP and produce observable evidence:

- the current URL and title
- visible text on the page
- accessibility snapshot elements
- form filling and button clicks through user-facing labels
- waits and expectations for asynchronous flows
- tab creation, switching, listing, and closing

The runner is intentionally pragmatic. It prefers browser-visible targets such as labels, roles, text, and accessibility snapshot UIDs, while still keeping DOM/evaluate fallbacks for difficult pages.

## Repository Layout

```text
.
├── SKILL.md
├── README.md
├── LICENSE
├── agents/
│   └── openai.yaml
├── references/
│   └── usage-notes.md
└── scripts/
    └── chrome-devtools-runner.js
```

- `SKILL.md` defines the Codex skill and trigger guidance.
- `agents/openai.yaml` provides agent-facing metadata.
- `scripts/chrome-devtools-runner.js` is the actual CLI runner.
- `references/usage-notes.md` contains operational notes for future maintainers.

## Requirements

- Node.js 18 or newer
- `npx`
- Google Chrome
- Network access the first time `npx -y chrome-devtools-mcp@latest` is resolved

The runner starts `chrome-devtools-mcp` automatically. There is no package install step for this repository yet.

## Installation As A Codex Skill

For a project-local skill, place this directory at:

```text
.codex/skills/chrome-devtools-runner
```

Codex can then use the skill when the user asks for browser-based verification, including vague requests such as:

- "ブラウザで確認して"
- "画面を確認して"
- "実際に操作して"
- "ユーザー目線で見て"
- "log in and try it"
- "check this in the browser"

When using the runner directly from a host project, keep a small repository-root shim if desired:

```js
#!/usr/bin/env node

require('./.codex/skills/chrome-devtools-runner/scripts/chrome-devtools-runner.js');
```

That allows commands such as:

```sh
node chrome-devtools-runner.js --ensure-cdp "open http://localhost:3000 then read page"
```

## Basic Usage

Run the script from the repository where the web application is being checked:

```sh
node .codex/skills/chrome-devtools-runner/scripts/chrome-devtools-runner.js \
  --ensure-cdp \
  "open http://localhost:3000/login then read page"
```

With a root shim:

```sh
node chrome-devtools-runner.js --ensure-cdp \
  "open http://localhost:3000/login then read page"
```

Login example:

```sh
node chrome-devtools-runner.js --ensure-cdp \
  "open http://localhost:3000/login then type Email user@example.com then type Password secret123 then click Log in then wait url /dashboard then read page"
```

## Browser Modes

### Default MCP-managed Chrome

```sh
node chrome-devtools-runner.js "open https://example.com then title"
```

In this mode, `chrome-devtools-mcp` manages Chrome itself.

### Managed CDP Chrome

```sh
node chrome-devtools-runner.js --ensure-cdp \
  "open http://localhost:3000 then read page"
```

`--ensure-cdp` checks `http://127.0.0.1:9222/json/version`. If Chrome is not exposing CDP there, the runner starts Chrome with remote debugging enabled and then connects `chrome-devtools-mcp` to that endpoint.

By default, this mode creates a temporary Chrome profile for each startup. This avoids stale profile locks and prior browser state leaking into the check.

### Existing CDP Chrome

```sh
node chrome-devtools-runner.js \
  --browser-url http://127.0.0.1:9222 \
  "read page"
```

Use this when you started Chrome yourself, for example:

```sh
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug
```

## Options

| Option | Description |
| --- | --- |
| `--debug` | Print debug logs from the runner. |
| `--show-tools` | Print available MCP tool names and descriptions. |
| `--show-tool-schemas` | Print available MCP tool schemas. Useful when MCP argument behavior changes. |
| `--timeout <ms>` | JSON-RPC request timeout. Default: `30000`. |
| `--server-command <command>` | Override the MCP server command. |
| `--browser-url <url>` | Connect to an existing Chrome DevTools Protocol endpoint. |
| `--ensure-cdp` | Start Chrome with CDP if the endpoint is not already available. |
| `--cdp-host <host>` | CDP host for `--ensure-cdp`. Default: `127.0.0.1`. |
| `--cdp-port <port>` | CDP port for `--ensure-cdp`. Default: `9222`. |
| `--cdp-startup-timeout <ms>` | How long to wait for CDP startup. Default: `10000`. |
| `--chrome-path <path>` | Chrome executable path. Defaults to a platform-specific path or `CHROME_PATH`. |
| `--chrome-user-data-dir <path>` | Chrome profile directory for managed CDP mode. Default: auto-created temporary profile. |
| `--reuse-chrome-profile` | Reuse the specified Chrome profile directory intentionally. |
| `--chrome-log-file <path>` | Chrome startup log path. Default: OS temp directory. |

Environment variables:

- `MCP_SERVER_COMMAND`
- `CHROME_PATH`
- `CHROME_USER_DATA_DIR`
- `CHROME_LOG_FILE`

If npm cache permissions are broken on the machine, run with a writable cache:

```sh
env npm_config_cache=/tmp/npm-cache node chrome-devtools-runner.js --ensure-cdp "open https://example.com then title"
```

## Instruction Syntax

Instructions are plain text steps separated by `then`, `and`, newlines, or Japanese punctuation.

```sh
node chrome-devtools-runner.js --ensure-cdp \
  "open http://localhost:3000 then click Login then wait Dashboard then read page"
```

### Page And Tab Actions

| Action | Example |
| --- | --- |
| Open in the current tab | `open http://localhost:3000` |
| Open a new tab | `new tab http://localhost:3000/favorites` |
| List tabs | `list tabs` |
| Switch tabs | `switch tab last`, `switch tab 1`, `switch tab Dashboard` |
| Close tabs | `close tab current`, `close tab last` |
| Read current page | `read page` |
| Get title | `title` |
| Snapshot interactive elements | `snapshot` |

Japanese aliases are also supported for common checks:

- `画面を確認して`
- `ページを確認して`
- `タブを確認して`
- `新しいタブで開いて`
- `切り替えて`
- `閉じて`

### Interaction Actions

| Action | Example |
| --- | --- |
| Click | `click Log in`, `click #submit` |
| Type/fill | `type Email user@example.com` |
| Type/fill quoted text | `type Search "mobile suit"` |
| Type into active element | `type hello` |
| Press a key | `press Enter`, `press Meta+L` |

For `click` and `type`, the runner first tries to resolve targets from the MCP accessibility snapshot and operate by UID. It falls back to DOM-based operations when snapshot resolution is not sufficient.

### Wait And Expect Actions

| Action | Example |
| --- | --- |
| Wait for visible text | `wait Dashboard` |
| Wait for URL substring | `wait url /dashboard` |
| Wait for text to disappear | `wait text gone Loading...` |
| Expect visible text | `expect text You're logged in!` |
| Expect URL substring | `expect url /dashboard` |
| Expect title substring | `expect title Dashboard` |

Japanese aliases:

- `url /dashboard になるまで待って`
- `Loading... が消えるまで待って`

### Evaluate JavaScript

```sh
node chrome-devtools-runner.js --ensure-cdp \
  "open http://localhost:3000 then eval () => location.href"
```

Use `eval` sparingly. Prefer user-visible actions and expectations for browser checks. Evaluation is useful for targeted technical evidence such as video playback state, cache state, or application-specific diagnostics.

## Output

The runner prints one line or block per action. Example:

```text
Opened http://localhost:3000/login
Filled textbox "Email" [uid=1_3]: user@example.com
Filled textbox "Password" [uid=1_5]: ***********
Clicked button "LOG IN" [uid=1_10]
Waited for URL: /dashboard
Page: Dashboard
URL: http://localhost:3000/dashboard
Text: dashboard user you're logged in!
Elements: 12
```

Sensitive values are masked when the target looks like a password, passcode, secret, or token field.

## Recommended Validation Pattern

For application checks, prefer this shape:

1. `open` the target page.
2. `read page` or `snapshot` to observe what the browser sees.
3. Operate with user-facing labels: `type Email ...`, `click Log in`.
4. Use `wait url`, `wait`, or `wait text gone` for asynchronous changes.
5. Use `expect text`, `expect url`, or `expect title` for final assertions.
6. Report the browser-visible result first, then any technical evidence.

Example:

```sh
node chrome-devtools-runner.js --ensure-cdp \
  "open http://localhost:3000/login then type Email user@example.com then type Password secret123 then click Log in then wait url /dashboard then expect text You're logged in! then read page"
```

## Troubleshooting

### Chrome does not start with `--ensure-cdp`

The runner prints the Chrome process status and log path:

```text
[cdp] starting Chrome pid=12345 port=9222 userDataDir=/tmp/chrome-devtools-runner-abc123
[error] Chrome exited before CDP became available ... See /tmp/chrome-devtools-runner.chrome.log
```

Inspect the log file first. Common causes are:

- Chrome cannot launch in the current sandbox or desktop session.
- The requested CDP port is already occupied.
- A reused profile directory is locked by another Chrome process.
- The Chrome path is incorrect.

Prefer the default temporary profile. Use a persistent profile only when the check explicitly needs prior login state or browser data:

```sh
node chrome-devtools-runner.js \
  --ensure-cdp \
  --chrome-user-data-dir /tmp/chrome-debug \
  --reuse-chrome-profile \
  "open http://localhost:3000"
```

### MCP tool behavior changes

Use:

```sh
node chrome-devtools-runner.js --ensure-cdp --show-tool-schemas
```

This prints the MCP tool schemas so the runner can be adjusted to the current `chrome-devtools-mcp` version.

### Page actions affect the wrong tab

Use:

```sh
node chrome-devtools-runner.js --ensure-cdp "list tabs"
```

The selected tab is marked with `*`. The runner tracks MCP's selected page and uses that for subsequent actions.

### npm cache permission errors

Use a writable npm cache:

```sh
env npm_config_cache=/tmp/npm-cache node chrome-devtools-runner.js --ensure-cdp "open https://example.com"
```

## Security Notes

Chrome DevTools MCP can inspect and modify browser state. Do not connect it to a browser profile containing sensitive data unless that is intentional.

For safer checks:

- prefer `--ensure-cdp` with the default temporary profile
- avoid persistent profiles unless required
- avoid entering real credentials
- avoid broad `eval` usage
- mask or omit secrets in logs and reports

## Development

Syntax check:

```sh
node --check scripts/chrome-devtools-runner.js
```

List MCP tools:

```sh
node scripts/chrome-devtools-runner.js --ensure-cdp --show-tools
```

Run a smoke test:

```sh
node scripts/chrome-devtools-runner.js --ensure-cdp \
  "open https://example.com then wait Example Domain then read page"
```

When changing tab behavior, verify:

```sh
node scripts/chrome-devtools-runner.js --ensure-cdp \
  "new tab https://example.com then new tab https://example.org then list tabs then switch tab last then read page then close tab current then list tabs"
```

## License

MIT. See [LICENSE](LICENSE).
