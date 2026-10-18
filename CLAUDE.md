# pubreform

pub の依存を更新する PR を作成・保守する GitHub Action。TypeScript（Node 24）で書き、Bun でビルドとテストを行う。

## 仕様

- `docs/design.md`（基本設計）と `docs/detailed-design.md`（詳細設計）が仕様。挙動を変えるときは、先に設計書を直す
- ソースのコメントにある `§n` は詳細設計の節。モジュールの役割は詳細設計 §2
- pub の挙動（解決、lockfile の書き方、コマンドのフラグ）に関わる判断は、推測せずに実際の `dart pub` / `fvm flutter pub` で確かめる。設計書に「確認済み」とある点は、すべて実際に動かして確かめたもの
- `pubreform.schema.json` と `src/config.ts` の判定は一致させる（`test/config-schema.test.ts` で確かめる）
- 設計書は日本語、コード・コメント・コミットメッセージ・PR の文面は英語

## コマンド

- `bun install --frozen-lockfile`
- `bun run typecheck`、`bun test`、`bun run build`
- 結合テスト: `PUBREFORM_IT=1 bun test test/integration.test.ts`。pub.dev への接続と、PATH 上の `dart`（3.13.5）と `fvm`（Flutter 3.47.7 を入れられること）が必要
- ローカル E2E: `bun run build && PUBREFORM_E2E=1 bun test test/e2e`。PATH 上の `dart`（3.13.5）が必要。外部には接続しない（フィクスチャー用サーバー、偽の GitHub API、bare リポジトリを使う。詳細 §17.1）
- `dist/` はコミットしない。`v*` タグを push すると `.github/workflows/build.yml` が生成してコミットし、タグとメジャータグを付け直す

## 開発環境（クラウドのセッション）

- Bun: `curl -fsSL https://bun.sh/install | bash`
- Dart SDK: `https://storage.googleapis.com/dart-archive/channels/stable/release/<version>/sdk/dartsdk-linux-x64-release.zip`（同じ場所の `.sha256sum` で検証する）
- fvm: `curl -fsSL https://fvm.app/install.sh | bash -s -- 4.3.2`。バージョンを省くと、最新版を api.github.com に問い合わせるところで 403 になることがある
- Flutter: `.fvmrc` のあるディレクトリで `CI=true fvm install`（`CI=true` だと git cache を使わずに直接 clone する）
- dart.dev と docs.github.com には接続できない。GitHub Docs は `github/docs` を sparse clone して読み、pub の挙動は `dart-lang/pub` のソースで確かめる

## 未確認のこと

- GitHub E2E（詳細 §17.2、テスト用リポジトリ `chika3742/pubreform-e2e` のワークフロー）はまだ実行していない。実際の GitHub での動作（コミットが Verified になるか、`mergeable_state`、App のトークンでのラベルの作成、`/` を含むブランチ名での ref の API）はこれで確かめる
