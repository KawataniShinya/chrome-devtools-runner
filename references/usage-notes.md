# 保守・回帰テスト手順

## 検証の順序

skill ディレクトリで以下を実行します。

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:browser
```

| テスト | 主な対象 |
|---|---|
| `tests/runner.test.js` | 命令解析、曖昧対象の拒否、誤送信防止、入力値・debug 出力のマスク、stdin |
| `tests/diagnostics.test.js` | 非同期エラー診断、診断タイムアウト、画面情報の省略・フィルタ、逐次結果、JSONレポート |
| `tests/connection.test.js` | 通常CDP・許可付きWebSocketの検出、モード競合、タブ明示選択、曖昧タブの拒否、遷移失敗時の再試行防止 |
| `tests/browser/connection.test.js` | 既存CDPへ再接続、未選択時の誤遷移防止、外部Chromeの維持、接続失敗案内 |
| `tests/version.test.js` | exact バージョンと lock の一致、未導入・不一致時の停止、明示サーバー、新旧 pageId スキーマ |
| `tests/browser/smoke.test.js` | 実 MCP 初期化・バージョン、画面取得、引用符付き入力、対象フォーム送信、曖昧クリック拒否、画面幅 |

ブラウザテストは `--headless --isolated` の Chrome とローカル fixture を使います。外部サイトの認証情報は不要です。終了時は MCP を閉じます。通常の Chrome 更新は固定していないため、MCP の固定だけで全実行環境の再現性を保証するものではありません。

CI は Node.js 20.19.0 / 22.12.0 / 24.15.0 で構文・Chrome不要テストを実行します。Chrome を使う確認はローカルの `test:browser` で別途実施してください。

## MCP バージョン更新

1. 更新対象の変更履歴と Node.js 要件を確認し、候補の exact バージョンを決める。
2. `npm install --save-exact --ignore-scripts chrome-devtools-mcp@X.Y.Z` で package と lock を一緒に更新する。
3. 上記の全テストを実行する。ブラウザテストの handshake で実際のサーバーバージョンも照合される。
4. 既存 CDP へ接続し、`list tabs` → 明示的な `switch tab` → `expect` → `read page` を確認する。
5. README の固定版・検証環境を更新し、package / lock / テスト変更を同じ PR に含める。

問題があれば package と lock を直前の組み合わせに戻し `npm ci --ignore-scripts` を実行します。`@latest` による回避はしません。

## 障害の切り分け

- 固定版が未導入・不一致: skill ディレクトリで `npm ci --ignore-scripts`。
- 既存Chromeの自動接続失敗: Chrome 144以降のstable版を起動し、`chrome://inspect/#remote-debugging` で設定を有効にして接続確認を許可する。設定変更はユーザーが行う。別Chromeへの自動フォールバックはしない。
- 設定画面で稼働中なのにHTTP 404: Chromeの許可付きモードの可能性がある。`--existing` または `--ws-endpoint ws://127.0.0.1:9222/devtools/browser` を使い、Chromeの接続確認を許可する。
- CDP 接続失敗: 接続 URL とポート、Chrome 実行ファイル、指定した Chrome ログを確認。
- タブ違い: `list tabs` と `switch tab URL` で選択し直す。
- MCP 引数エラー: `--show-tool-schemas` でスキーマを確認。`pageId` は対応ツールにだけ付与される。
- 要素が見えない: 省略件数を確認し `--full` または `--filter` を使用。
- 操作失敗: 元のエラーと診断状態を確認。送信・更新を自動再試行しない。

報告には Node.js / Chrome / MCP のバージョン、実行モード、再現手順、期待値と実結果を記載します。認証情報を含む命令、未加工ページ本文、レポートを公開リポジトリへ添付しないでください。

## 接続モードの手動確認

- 通常Chromeでリモートデバッグを有効にし、`--existing "list tabs"` で接続確認を許可する。
- URL/IDでタブ選択して `title` / `read page` を取得し、接続先と対象タブの表示が一致することを確認する。
- 再実行時に選択なしの `title` が拒否されることを確認する。
- 設定が無効な環境では、接続案内が表示され新しいChromeを起動しないことを確認する。
- 指定なし（既定）と `--isolated` では新規プロファイルを使い、普段のChromeのタブとログイン状態を引き継がないことを確認する。

ブラウザ自動テストは独立したテスト用ChromeのCDP接続を検証します。通常Chromeの接続許可ダイアログは自動テストで代行しないため、autoConnectの成功確認は上記の手動確認で補います。

既定の新規Chromeはrunner終了後も残ります。手動で閉じるまで表示を維持し、再接続には起動時に表示されたCDP URLを使用します。一時プロファイルは自動削除しません。テストが起動したChromeだけはテスト終了時に明示的に終了します。
