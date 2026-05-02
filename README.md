# Chrome DevTools Runner

Chrome DevTools Runner は、[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) を通して実際の Chrome ブラウザを操作し、Web アプリケーションを検証するための Codex skill 兼コマンドラインランナーです。

用途は、ユーザーに見えるブラウザ動作の確認です。ログイン、画面遷移、ボタンクリック、フォーム入力、フォーム送信、ブラウザ履歴の移動、再読み込み、画面幅の切り替え、非同期 UI の待機、現在ページの読み取り、URL や表示テキストの検証を行い、ユーザーが実際に認識できる内容を根拠付きで報告できます。

## このツールの目的

LLM を使った開発では、「コード上は正しそう」に留まらず、ブラウザ上で何が見えているかを確認したい場面が多くあります。このプロジェクトは、Codex から呼び出せる小さなランナーとして、Chrome を MCP 経由で操作し、観測可能な証拠を返します。

- 現在の URL と title
- ページ上に表示されているテキスト
- アクセシビリティスナップショット上の要素
- ユーザー向けラベルを使ったフォーム入力やクリック、フォーム送信
- 非同期フローに対する wait / expect
- タブの作成、切り替え、一覧表示、クローズ
- ブラウザ履歴の移動と再読み込み
- モバイル幅やデスクトップ幅への切り替え

設計は実務寄りです。ラベル、role、表示テキスト、アクセシビリティ snapshot の UID といったブラウザ視点のターゲット解決を優先しつつ、難しいページでは DOM / evaluate のフォールバックも使えるようにしています。

## リポジトリ構成

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

- `SKILL.md`: Codex skill の定義とトリガー方針
- `agents/openai.yaml`: エージェント向けメタデータ
- `scripts/chrome-devtools-runner.js`: CLI ランナー本体
- `references/usage-notes.md`: 今後のメンテナ向け運用メモ

## 動作要件

- Node.js 18 以上
- `npx`
- Google Chrome
- 初回の `npx -y chrome-devtools-mcp@latest` 解決時にネットワークアクセス可能であること

このリポジトリ自体にインストール手順はまだありません。ランナーは必要時に `chrome-devtools-mcp` を自動で起動します。

## Codex skill としての配置

プロジェクトローカル skill として使う場合は、次の位置に配置します。

```text
.codex/skills/chrome-devtools-runner
```

この状態で Codex は、次のような曖昧な依頼も含めてブラウザ確認タスクにこの skill を使えます。通常フローでは、URL 直打ちよりも画面上のリンク、ボタン、フォーム、履歴操作を優先します。

- 「ブラウザで確認して」
- 「画面を確認して」
- 「実際に操作して」
- 「ユーザー目線で見て」
- `log in and try it`
- `check this in the browser`

ホストプロジェクト側から直接 runner を使いたい場合は、リポジトリルートに薄い shim を置けます。

```js
#!/usr/bin/env node

require('./.codex/skills/chrome-devtools-runner/scripts/chrome-devtools-runner.js');
```

これで次のように実行できます。

```sh
node chrome-devtools-runner.js --ensure-cdp "open http://localhost:3000 then read page"
```

## 基本的な使い方

Web アプリケーションを確認したいリポジトリのルートで実行します。

```sh
node .codex/skills/chrome-devtools-runner/scripts/chrome-devtools-runner.js \
  --ensure-cdp \
  "open http://localhost:3000/login then read page"
```

ルート shim がある場合:

```sh
node chrome-devtools-runner.js --ensure-cdp \
  "open http://localhost:3000/login then read page"
```

ログイン確認の例:

```sh
node chrome-devtools-runner.js --ensure-cdp \
  "open http://localhost:3000/login then type Email user@example.com then type Password secret123 then click Log in then wait url /dashboard then read page"
```

## ブラウザ起動モード

### MCP 管理 Chrome

```sh
node chrome-devtools-runner.js "open https://example.com then title"
```

このモードでは `chrome-devtools-mcp` が Chrome の起動と管理を行います。

### 管理付き CDP Chrome

```sh
node chrome-devtools-runner.js --ensure-cdp \
  "open http://localhost:3000 then read page"
```

`--ensure-cdp` は `http://127.0.0.1:9222/json/version` を確認し、そこに CDP が出ていなければ remote debugging 付きで Chrome を起動し、そのエンドポイントに `chrome-devtools-mcp` を接続します。

既定では、起動ごとに一時 Chrome profile を作成します。これにより、古い lock ファイルや過去セッションのブラウザ状態が現在の確認作業に混入するのを避けられます。
Chrome の起動は指定した実行ファイルを直接使います。macOS の `open -n -a` による救済起動は使わないため、`--chrome-path` は実際に実行できる Chrome バイナリを指すようにしてください。
`set viewport` で指定した画面幅は、タブ移動や新規タブ作成後にも再適用されます。モバイル確認では先に viewport を切り替え、そのまま画面操作を進めてください。

### 既存 CDP Chrome への接続

```sh
node chrome-devtools-runner.js \
  --browser-url http://127.0.0.1:9222 \
  "read page"
```

自分で Chrome を起動済みの場合はこちらを使います。例:

```sh
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug
```

## オプション

| オプション | 説明 |
| --- | --- |
| `--debug` | runner 側のデバッグログを出力します。 |
| `--show-tools` | 利用可能な MCP tool 名と説明を表示します。 |
| `--show-tool-schemas` | 利用可能な MCP tool schema を表示します。MCP 側の引数仕様確認に使います。 |
| `--timeout <ms>` | JSON-RPC リクエストのタイムアウト。既定値: `30000` |
| `--server-command <command>` | MCP サーバー起動コマンドを上書きします。 |
| `--browser-url <url>` | 既存の Chrome DevTools Protocol endpoint に接続します。 |
| `--ensure-cdp` | endpoint が存在しない場合に Chrome を CDP 付きで起動します。 |
| `--cdp-host <host>` | `--ensure-cdp` 用の CDP host。既定値: `127.0.0.1` |
| `--cdp-port <port>` | `--ensure-cdp` 用の CDP port。既定値: `9222` |
| `--cdp-startup-timeout <ms>` | CDP 起動待ち時間。既定値: `10000` |
| `--chrome-path <path>` | Chrome 実行ファイルのパス。既定ではプラットフォーム依存パスまたは `CHROME_PATH` |
| `--chrome-user-data-dir <path>` | 管理付き CDP モードで使う Chrome profile ディレクトリ。既定では自動作成の一時 profile |
| `--reuse-chrome-profile` | 指定した Chrome profile ディレクトリを意図的に再利用します。 |
| `--chrome-log-file <path>` | Chrome 起動ログの出力先。既定では OS の一時ディレクトリ |

環境変数:

- `MCP_SERVER_COMMAND`
- `CHROME_PATH`
- `CHROME_USER_DATA_DIR`
- `CHROME_LOG_FILE`

もし npm cache の権限が壊れている環境なら、書き込み可能な cache を明示します。

```sh
env npm_config_cache=/tmp/npm-cache node chrome-devtools-runner.js --ensure-cdp "open https://example.com then title"
```

## 命令構文

命令はプレーンテキストのステップ列です。`then`、`and`、改行、日本語句読点で区切れます。

```sh
node chrome-devtools-runner.js --ensure-cdp \
  "open http://localhost:3000 then click Login then wait Dashboard then read page"
```

### ページ・タブ操作

| 操作 | 例 |
| --- | --- |
| 現在タブで開く | `open http://localhost:3000` |
| 新しいタブで開く | `new tab http://localhost:3000/favorites` |
| タブ一覧表示 | `list tabs` |
| タブ切り替え | `switch tab last`, `switch tab 1`, `switch tab Dashboard` |
| タブを閉じる | `close tab current`, `close tab last` |
| 戻る / 進む / 再読み込み | `back`, `forward`, `reload` |
| フォーム送信 | `submit`, `submit #login-form` |
| 画面幅切り替え | `set viewport mobile`, `set viewport 390x844`, `read viewport` |
| 確認ダイアログ | `accept dialog`, `dismiss dialog` |
| 現在ページを読む | `read page` |
| title を取得 | `title` |
| インタラクティブ要素を snapshot | `snapshot` |

よく使う日本語エイリアスも入っています。

- `画面を確認して`
- `ページを確認して`
- `タブを確認して`
- `戻って`
- `進んで`
- `再読み込みして`
- `モバイル幅にして`
- `デスクトップ幅にして`
- `新しいタブで開いて`
- `切り替えて`
- `閉じて`

### 操作系アクション

| 操作 | 例 |
| --- | --- |
| クリック | `click Log in`, `click #submit` |
| 入力 | `type Email user@example.com` |
| クォート付き入力 | `type Search "mobile suit"` |
| アクティブ要素に入力 | `type hello` |
| キー入力 | `press Enter`, `press Meta+L` |

`click` と `type` は、まず MCP のアクセシビリティ snapshot からターゲット解決を試し、UID ベースで操作します。snapshot 解決だけでは不十分な場合に DOM ベースのフォールバックへ落ちます。

### wait / expect 系アクション

| 操作 | 例 |
| --- | --- |
| テキスト表示待ち | `wait Dashboard` |
| URL 部分一致待ち | `wait url /dashboard` |
| テキスト消滅待ち | `wait text gone Loading...` |
| テキスト期待値 | `expect text You're logged in!` |
| URL 期待値 | `expect url /dashboard` |
| title 期待値 | `expect title Dashboard` |

日本語エイリアス:

- `url /dashboard になるまで待って`
- `Loading... が消えるまで待って`

### JavaScript 評価

```sh
node chrome-devtools-runner.js --ensure-cdp \
  "open http://localhost:3000 then eval () => location.href"
```

`eval` は補助用途に留めるのが前提です。ブラウザ確認では、なるべくユーザーに見えるアクションと期待値で組み立ててください。技術的根拠として、動画再生状態、キャッシュ状態、アプリ固有の診断値を取りたいときに有効です。

## 出力

runner はアクションごとに 1 行または 1 ブロックを出力します。例:

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

入力対象が password、passcode、secret、token らしい場合は、値をマスクして出力します。

## 推奨する検証パターン

Web アプリ確認では、次の流れが扱いやすいです。

1. `open` で対象ページを開く
2. `read page` または `snapshot` でブラウザ視点の状態を観察する
3. `type Email ...`、`click Log in` のようにユーザー向けラベルで操作する
4. 非同期変化に対して `wait url`、`wait`、`wait text gone` を入れる
5. 最後に `expect text`、`expect url`、`expect title` で確認する
6. レポートでは、まずブラウザ上で見えた結果を書き、その後に技術的根拠を添える

例:

```sh
node chrome-devtools-runner.js --ensure-cdp \
  "open http://localhost:3000/login then type Email user@example.com then type Password secret123 then click Log in then wait url /dashboard then expect text You're logged in! then read page"
```

## トラブルシューティング

### `--ensure-cdp` で Chrome が起動しない

runner は Chrome プロセス状態とログファイルの場所を表示します。

```text
[cdp] starting Chrome pid=12345 port=9222 userDataDir=/tmp/chrome-devtools-runner-abc123
[error] Chrome exited before CDP became available ... See /tmp/chrome-devtools-runner.chrome.log
```

まずログファイルを確認してください。よくある原因:

- 現在の sandbox やデスクトップセッションでは Chrome を起動できない
- 指定した CDP port が既に使われている
- 再利用した profile ディレクトリが他の Chrome に lock されている
- Chrome のパス指定が誤っている

基本は一時 profile のまま使う方が安定します。永続 profile が必要なのは、ログイン状態やブラウザデータを意図的に引き継ぎたい場合だけです。

```sh
node chrome-devtools-runner.js \
  --ensure-cdp \
  --chrome-user-data-dir /tmp/chrome-debug \
  --reuse-chrome-profile \
  "open http://localhost:3000"
```

### MCP tool の仕様が変わった

```sh
node chrome-devtools-runner.js --ensure-cdp --show-tool-schemas
```

これで現在の `chrome-devtools-mcp` が公開している tool schema を確認できます。MCP 側の引数仕様が変わったときに、runner 側の追従に使います。

### 別タブが意図せず操作される

```sh
node chrome-devtools-runner.js --ensure-cdp "list tabs"
```

選択中タブは `*` で表示されます。runner は MCP が selected として返すページを優先して以後の操作対象を追跡します。

### npm cache の権限エラーが出る

```sh
env npm_config_cache=/tmp/npm-cache node chrome-devtools-runner.js --ensure-cdp "open https://example.com"
```

## セキュリティ注意点

Chrome DevTools MCP はブラウザ状態を参照・変更できます。機密データを含む常用 profile に接続するのは、意図した場合だけにしてください。

より安全に使うには:

- `--ensure-cdp` の既定である一時 profile を使う
- 永続 profile の利用は必要時だけに限定する
- 実運用の認証情報は避ける
- 広い `eval` 使用を避ける
- ログやレポートに secrets を出さない

## 開発時の確認

構文チェック:

```sh
node --check scripts/chrome-devtools-runner.js
```

MCP tool 一覧:

```sh
node scripts/chrome-devtools-runner.js --ensure-cdp --show-tools
```

スモークテスト:

```sh
node scripts/chrome-devtools-runner.js --ensure-cdp \
  "open https://example.com then wait Example Domain then read page"
```

タブ関連を変更したときの確認:

```sh
node scripts/chrome-devtools-runner.js --ensure-cdp \
  "new tab https://example.com then new tab https://example.org then list tabs then switch tab last then read page then close tab current then list tabs"
```

## ライセンス

MIT。詳細は [LICENSE](LICENSE) を参照してください。
