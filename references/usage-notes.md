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
- CDP 接続失敗: 接続 URL とポート、Chrome 実行ファイル、指定した Chrome ログを確認。
- タブ違い: `list tabs` と `switch tab URL` で選択し直す。
- MCP 引数エラー: `--show-tool-schemas` でスキーマを確認。`pageId` は対応ツールにだけ付与される。
- 要素が見えない: 省略件数を確認し `--full` または `--filter` を使用。
- 操作失敗: 元のエラーと診断状態を確認。送信・更新を自動再試行しない。

報告には Node.js / Chrome / MCP のバージョン、実行モード、再現手順、期待値と実結果を記載します。認証情報を含む命令、未加工ページ本文、レポートを公開リポジトリへ添付しないでください。
