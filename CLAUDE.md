# pubreform

pub の依存を更新する PR を作成・保守する GitHub Action。TypeScript（Node 24）で書き、Bun でビルドとテストを行う。

## 仕様

- `docs/design.md`（基本設計）と `docs/detailed-design.md`（詳細設計）が仕様。挙動を変えるときは、先に設計書を直す
- モジュールの役割は詳細設計 §2。コードのコメントには設計書の節（`§n`）を書かない
- pub の挙動（解決、lockfile の書き方、コマンドのフラグ）に関わる判断は、推測せずに実際の `dart pub` / `fvm flutter pub` で確かめる。設計書に「確認済み」とある点は、すべて実際に動かして確かめたもの
- `pubreform.schema.json` と `src/config.ts` の判定は一致させる（`test/config-schema.test.ts` で確かめる）
- 設計書は日本語、コード・コメント・コミットメッセージ・PR の文面は英語

## コマンド

- `bun install --frozen-lockfile`
- `bun run typecheck`、`bun test`、`bun run build`
- 結合テスト: `PUBREFORM_IT=1 bun test test/integration.test.ts`。pub.dev への接続と、PATH 上の `dart`（Dart 3 の stable）と `fvm`（Flutter 3.47.7 を入れられること）が必要
- ローカル E2E: `bun run build && PUBREFORM_E2E=1 bun test test/e2e`。PATH 上の `dart`（Dart 3 の stable）が必要。外部には接続しない（フィクスチャー用サーバー、偽の GitHub API、bare リポジトリを使う。詳細 §17.1）。更新後のコマンドの場面（`test/e2e/post-update.test.ts`）は、`sudo -n true` が通る環境だけで動く。`unshare`、`runuser`、`setfacl` も要る
- GitHub E2E: `chika3742/pubreform-e2e` の E2E ワークフローを `workflow_dispatch` で実行する（入力 `ref` に pubreform のブランチ。詳細 §17.2）
- `dist/` はコミットしない。`v*` タグを main の先頭のコミットに付けて push すると、`.github/workflows/build.yml` が CI と同じ検査を通してから生成してコミットし、タグとメジャータグを付け直す（詳細 §18）

## 開発環境（クラウドのセッション）

- Bun: `curl -fsSL https://bun.sh/install | bash`
- Dart SDK: `https://storage.googleapis.com/dart-archive/channels/stable/release/<version>/sdk/dartsdk-linux-x64-release.zip`（同じ場所の `.sha256sum` で検証する）
- fvm: `curl -fsSL https://fvm.app/install.sh | bash -s -- 4.3.2`。バージョンを省くと、最新版を api.github.com に問い合わせるところで 403 になることがある
- Flutter: `.fvmrc` のあるディレクトリで `CI=true fvm install`（`CI=true` だと git cache を使わずに直接 clone する）
- setfacl: `apt-get install -y acl`（更新後のコマンドのローカル E2E で使う）
- dart.dev と docs.github.com には接続できない。GitHub Docs は `github/docs` を sparse clone して読み、pub の挙動は `dart-lang/pub` のソースで確かめる

## 未確認のこと

- README のワークフロー例（トリガーと `if` の条件）と、setup-fvm と組み合わせた Flutter プロジェクトでの実行は、実際の GitHub ではまだ確かめていない。GitHub E2E は Dart だけで、ビルドした `dist/main.js` を直接実行している（`action.yml` も確かめていない）
- 更新後のコマンド（`post_update`。詳細 §19）は、GitHub E2E をまだ実行していない。GitHub のランナーで `sudo` などが使えるか、`actions/checkout` の認証情報が読めないかは未確認。Flutter のプロジェクトでは使えない（`flutter` が SDK に書き込むため。詳細 §19.9）
