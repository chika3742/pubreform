# pubreform 詳細設計: Flutter の更新

> ステータス: 実装済み（2026-11-02）。単体テストとローカル E2E の場面 1〜6（§10.3）で確かめた。ローカル E2E は、実行した環境が `/tmp` に書き込めないため、生成用ディレクトリの場所（`/tmp`）だけを `TMPDIR` に変えたビルドで動かした。docker を使う場面 7、8 は docker に接続できない環境だったので実行しておらず、CI で動く。結合テスト（§10.2）と GitHub E2E（§10.4）は、まだ実行していない。挙動を変えるときは、先にこの設計書を直す。[Flutter の更新の基本設計](flutter-update.md)を前提に、実装に必要な決定を書く。「F 基本 §n」はその基本設計、「基本 §n」は[基本設計](design.md)、「詳細 §n」は[詳細設計](detailed-design.md)の節を指す。

## 1. 変更するもの

| 場所 | 変更 |
|---|---|
| `src/flutter.ts`（新規） | リリース一覧の取得と読み取り、今のバージョンと更新先の決定、3 つのファイルの書き換え（§3） |
| `src/planner.ts` | `UnitKind` に `flutter` を足す（§4） |
| `src/applier.ts` | `UnitResult` に `flutter` を足す（§4） |
| `src/render.ts` | ブランチ名、タイトル、コミットメッセージ、本文、メタデータ、エラーコメントの見出し（§5） |
| `src/reconciler.ts` | Flutter の単位の対応付けと実行（§6） |
| `src/generate.ts` | `post_update` がなくても `Generator` を作れるようにし、Flutter の生成を足す（§7） |
| `src/main.ts` | 全体の流れ（§2）、ジョブサマリー（§8） |
| `pubreform.schema.json` | `min_release_age_days`、`ignore[].name`、`ignore[].versions` の説明（§9）。構造は変えない |
| `README.md` | Flutter の更新の説明（§9） |
| テスト | 単体、結合、ローカル E2E、GitHub E2E（§10） |

設定のキー、`action.yml`、App の権限は変えない。

## 2. 全体の流れ（main.ts）

詳細 §3 の手順に、次を足す。

```
5a. .fvmrc があれば、今のバージョン c = currentFlutter(.fvmrc)（§3.2）。undefined なら Flutter の更新はしない（理由をログに出す）
    ベースの .vscode/settings.json を読む（なければ undefined）
6a. c があり、ignore が flutter のすべてのバージョンを除外していなければ（name が flutter で versions のないルール）、
    リリース一覧を取得する（§3.1）。失敗したら flutterError に記録して続ける（全体エラーにしない）
9a. 更新先 t = flutterTarget(...)（§3.2）。t があれば、Flutter の単位を適用する（§4）
    適用（ファイルの書き換え）に失敗したら、unitErrors に入れる（パッケージの単位と同じ）
11. decide には、flutterError があれば plan.uncertain に flutter を足した集合を渡す（§6.1）
    Generator は、post_update があるか、Flutter の単位があるときに作る。イメージと SDK は post_update があるときだけ用意する（§7）
12. execute の create / regenerate で、Flutter の単位は ctx.updateFlutter を使う（§6.2）
12a. flutterError があれば、エラーの Outcome を足す（ジョブは失敗する。§8）
```

- 手順 6a は中継サーバーを使わない。リリース一覧は pub.dev とは別のホストにある
- 手順 9a は手順 9 の後に行う。パッケージの単位の適用とは関係がない
- Flutter の `pub get` は手順 12 の中で行う。中継サーバーはそれより前に止まっている（詳細 §3）が、Flutter の `pub get` は中継サーバーを経由しない（F 基本 §5.1）ので、影響はない

## 3. flutter.ts

### 3.1 リリース一覧

```ts
interface FlutterRelease {
  version: string   // x.y.z
  dart?: string     // dart_sdk_version
}
function releasesUrl(platform = process.platform): string
function parseReleases(body: unknown): FlutterRelease[]
function fetchReleases(url: string): Promise<FlutterRelease[]>
```

- URL: `https://storage.googleapis.com/flutter_infra_release/releases/releases_<os>.json`。`<os>` は `process.platform` が `linux` なら `linux`、`darwin` なら `macos`、`win32` なら `windows`。ほかの OS では例外を投げる（§2 の `flutterError` になる）
- テストのために、環境変数 `PUBREFORM_FLUTTER_RELEASES` があれば、その URL から取得する（`PUBREFORM_UPSTREAM` と同じく、README には書かない）
- 取得は 30 秒で打ち切る。接続できない、打ち切った、成功以外の応答のときは例外を投げる
- `parseReleases`: `releases` が配列で、各要素の `channel` と `version` が文字列でなければ、例外を投げる。`channel` が `stable` で、`version` が `^\d+\.\d+\.\d+$` に合うものだけを残す。`dart_sdk_version` は、文字列のときだけ `dart` に入れる。同じ `version` が複数あれば、最初のものを残す（`3.13.3` が 2 件ある。§11.1）。macOS の一覧はアーキテクチャごとに項目が分かれている見込みで、これも同じ扱いになる
- `release_date`、`hash`、`archive` は使わない

### 3.2 今のバージョンと更新先

```ts
function currentFlutter(fvmrc: string): string | undefined
function flutterTarget(current: string, releases: FlutterRelease[], ignore: IgnoreRule[]): string | undefined
```

- `currentFlutter`: `.fvmrc` を JSON として読み、`flutter` が `^\d+\.\d+\.\d+$` に合う文字列ならそれを返す。読めない、または値がバージョンでない（`stable`、`3.47.9@beta`、コミット、`fork/3.47.9`）ときは `undefined` を返す
- `flutterTarget`: `releases` のうち、`isIgnored(ignore, 'flutter', v)`（config.ts。プロキシと同じ関数）に当てはまらないものの最大（`compareVersions`）を返す。それが `current` より新しくなければ `undefined` を返す
- `.fvmrc` を読めないときは、fvm 自身もそのプロジェクトで動かないので、パッケージの解決が全体エラーになる。ここで止める必要はない

### 3.3 ファイルの書き換え

```ts
function rewriteFvmrc(text: string, from: string, to: string): string
function rewriteVscodeSettings(text: string, from: string, to: string): string | undefined  // 変えなければ undefined
function flutterConstraint(constraint: string, to: string): string | undefined                // 変えなければ undefined
function rewriteEnvironmentFlutter(pubspec: string, to: string): string                       // 変えなければ同じ文字列
```

どれも、書式とコメントを保つため、元の文字列のうち値の部分だけを置き換える（F 基本 §5.3）。書き換えた結果は、もう一度読んで確かめる。確かめられなければ例外を投げ、Flutter の単位のエラーにする（§4）。

`.fvmrc`:

- 最上位の `"flutter"` の値の文字列を置き換える。`"flutter"\s*:\s*"<from>"` に合う最初の箇所を `<to>` にする
- 確かめ: 結果を JSON として読み、`flutter` が `to` で、ほかのキーが元と同じ（`JSON.stringify` で比べる）であること。`flavors` の中に同じ文字列があっても、最初の一致が最上位の `flutter` でなければ、ここで分かる

`.vscode/settings.json`（JSONC）:

- 文字列（`"…"`、`\` のエスケープ）、行コメント（`//`）、ブロックコメント（`/* */`）、`{` `}` `[` `]` の深さを読む小さな走査で、深さ 1 のキー `"dart.flutterSdkPath"` とその値の文字列の位置を探す。コメントの中の `"dart.flutterSdkPath"`（コメントアウトした行）は対象にしない
- 値（エスケープを解かない生の文字列）のうち、`(^|/|\\\\)<from>(?=$|/|\\\\)` に合う部分を `<to>` にする。`/` と、Windows のパスの `\\`（JSON の中のエスケープした `\`）を区切りとみなす
- ファイルがない、キーがない、値に `<from>` がない、走査が途中で失敗した（閉じていない文字列やコメント）ときは、変えない（`undefined`）。走査の失敗はログに出す
- 確かめ: 結果をもう一度走査し、値が置き換えた文字列になっていること

`environment.flutter`（`flutterConstraint`）。F 基本 §5.3 の表を、元の文字列の形で判定する。`parseConstraint`（version.ts）は `^` を 2 つの比較に展開してしまい、形が分からなくなるため。

| 元の文字列（前後の空白を除く） | 結果 |
|---|---|
| `any` | `undefined` |
| 比較の並びとして読めない | `undefined` |
| 下限（`^`、`>=`、`>`、固定）がない（`<b`、`<=b` だけ） | `undefined` |
| 下限が `t` 以上 | `undefined` |
| `^a` だけ | `^t` |
| `a` だけ（固定） | `t` |
| `>=a` か `>a` だけ | `>=t` |
| `>=a` か `>a` 1 つと、`<b` か `<=b` 1 つ以上（順は問わない） | 上限がすべて `t` を許せば `>=t <上限>`（上限は元の字句のまま、元の順で、空白 1 つで区切る）。許さなければ `undefined` |
| それ以外（`^` と比較の組み合わせ、下限が 2 つなど） | `undefined` |

- `rewriteEnvironmentFlutter`: `parseDocument`（yaml）で `environment.flutter` のノードを取り出す。スカラーの文字列でなければ、変えない。`flutterConstraint` の結果があれば、ノードの `range[0]` から `range[1]` の部分を、元と同じ書き方（`QUOTE_DOUBLE` なら `JSON.stringify` した値、`QUOTE_SINGLE` なら `'…'`、`PLAIN` ならそのまま）で置き換える。下限の演算子を `>` から `>=` に変える以外に、書き方が変わることはない（`>` で始まる値は YAML では引用符が要るので、元から引用符がある）
- 確かめ: 結果を `parse`（yaml）で読み、`environment.flutter` が新しい制約であること

## 4. 更新単位と結果

```ts
type UnitKind = 'single' | 'minor' | 'group' | 'flutter'

interface FlutterUpdate {
  from: string           // c
  to: string             // t
  fromDart?: string      // リリース一覧の c の dart_sdk_version
  toDart?: string
  tool: 'flutter' | 'dart'   // 本文の文言。isFlutter(pubspec) なら flutter
  /** 書き換えたファイル（.fvmrc と、変えたときの .vscode/settings.json）。pubspec.yaml は UnitResult.files に入れる */
  files: Record<string, string>
}

interface UnitResult {
  // 今のフィールドに加えて
  flutter?: FlutterUpdate
}
```

- Flutter の単位は `{ kind: 'flutter', members: ['flutter'], targets: { flutter: t } }`
- 適用（`applyFlutter`。flutter.ts）は、ファイルの書き換え（§3.3）だけを行う。pub は実行しない（F 基本 §5.1）。結果は `{ unit, files: { pubspec: 書き換えた pubspec.yaml, lock: ベースの lockfile }, changes: {}, transitiveFixes: {}, advisories: [], flutter }`
- 書き換えのどれかが例外を投げたら、単位のエラー（`UnitError`）にする。PR があれば `commentError`、なければ `error`（詳細 §14.3）

## 5. 文面とメタデータ（render.ts）

| 関数 | Flutter の単位 |
|---|---|
| `branchName` | `pubreform/flutter` |
| `title` | `Update Flutter from <from> to <to>` |
| `commitMessage` | タイトルだけ |
| `metaOf` | `packages` に `flutter: [from, to]` を入れる。`kind` は `flutter` |
| `renderBody` | `result.flutter` があれば、下の本文 |

本文:

```markdown
Updates Flutter.

| SDK | From | To |
|---|---|---|
| Flutter | 3.47.8 | 3.47.9 |
| Dart | 3.13.7 | 3.13.7 |

<失敗の 1 行、または post_update の行>

[Release notes](https://docs.flutter.dev/release/release-notes) · [Changelog](https://github.com/flutter/flutter/blob/flutter-3.47-candidate.0/CHANGELOG.md)

---

- [ ] Rebase this PR <!-- pubreform:rebase -->

<!-- pubreform:meta {"v":1,"kind":"flutter","packages":{"flutter":["3.47.8","3.47.9"]},...} -->
```

- Dart の行の欄は、`fromDart` / `toDart` がなければ空にする
- CHANGELOG の URL のブランチ名は、`to` のメジャーとマイナーから作る（`flutter-<major>.<minor>-candidate.0`。F 基本 §6）
- `renderBody` の `opts` に `flutterFailure?: 'pub get' | 'post_update'` と `postUpdate: boolean`（`post_update` があるか）を足す。失敗の 1 行:
  - `pub get`: `` `<tool> pub get` failed with Flutter <to>, so `pubspec.lock` is not updated and the `post_update` commands did not run. The log is in a comment. ``。`postUpdate` が false なら `` and the `post_update` commands did not run `` を省く
  - `post_update`: `` A `post_update` command failed with Flutter <to>, so the files that the commands change are not included. The log is in a comment. ``
- 成功して、更新後のコマンドで変わったファイルがあれば、パッケージの PR と同じ `` Files changed by the `post_update` commands: <n> `` の行を入れる（`n` は §7.2）
- 本文の長さは上限（詳細 §12.3）に届かないので、切り詰めない
- `errorComment(log, hash, heading?)` に見出しの引数を足す。既定は今の `pubreform failed to update this PR.`。Flutter の失敗では `` pubreform updated this PR to Flutter <to>, but `<tool> pub get` failed. `` または `` pubreform updated this PR to Flutter <to>, but a `post_update` command failed. `` にする。PR は更新できているので、今の見出しは合わない
- 内容の変更のコメント（`contentChangedComment`）の関数はそのまま使う。ただし、呼び出し側（`execute` の `regenerate`）が「後」として渡す `{ ...result.changes, ...result.transitiveFixes }` には、`result.flutter` があれば `flutter: { from, to }` も入れる（§6.2）。入れないと、Flutter の単位では「後」が空になり、`| flutter | c → 前の t | – |`（削除）と書かれてしまう。行の名前は `flutter` になる

## 6. 調整（reconciler.ts）

### 6.1 対応付けと操作の決め方

今の仕組み（詳細 §14.2、§14.3）をそのまま使う。変えるのは次の関数だけ。

- `targets(result)`: `result.flutter` があれば `flutter → to` も入れる。内容の変更の判定と、利用者が閉じた PR との照合（同じ `kind` で同じ `to`）は、これでそのまま働く
- `unitPackages(result)`: `result.flutter` があれば `flutter` を入れる（ログとジョブサマリーのため）
- `changes` と `transitiveFixes` から「パッケージ → from / to」を作っているところ（`targets` と、内容の変更のコメントの「後」。§5）は、どれも `result.flutter` も加える。共通の関数（`updatedPackages(result)`）にまとめる
- `prPackages(pr)`: メタデータのない PR で、ブランチが `pubreform/flutter` なら `['flutter']`
- `match`: `kind` が `group` でない単位はブランチ名で対応させているので、変えなくてよい

リリース一覧を取得できなかったとき（§2 の手順 11）は、`uncertain` に `flutter` が入るので、`pubreform/flutter` の PR は `none` になる（閉じない。詳細 §14.3）。

### 6.2 実行

```ts
interface FlutterGenerated {
  lock: string            // pub get の結果。失敗したらベースの lockfile
  entries: TreeEntry[]    // pubspec.yaml と pubspec.lock 以外の変わったファイル（.fvmrc を含む）
  generated: number       // 更新後のコマンドで変わったファイルの数（§7.2）
  failure?: { stage: 'pub get' | 'post_update'; log: string; key: string }
}

interface ExecuteContext {
  // 今のフィールドに加えて
  updateFlutter?: (result: UnitResult) => Promise<FlutterGenerated>
}

interface Outcome {
  // 今のフィールドに加えて
  note?: string   // 'pub get failed' / 'post_update failed'（ジョブサマリー）
}
```

- `create` / `regenerate` のコミット（`commit(result)`）で、`result.flutter` があれば `ctx.generate` の代わりに `ctx.updateFlutter` を呼び、`files: { pubspec: result.files.pubspec, lock: g.lock }`、`generated: g.entries` でコミットを作る
- 本文は `flutterFailure: g.failure?.stage`、`generated: g.generated` で作る
- `g.failure` があれば、PR の作成または更新（とラベル付け、内容の変更のコメント）の後に、`commentError(pr, g.failure.log, g.failure.key)` を見出しを付けて行う（§5）。同じ `key` なら投稿しない（詳細 §15）。`commentError` の引数に見出しを足す
- `g.failure` があっても、`Outcome` の `action` は `created` / `regenerated` のままにし、`note` を付ける。`error` は付けないので、ジョブは失敗しない（F 基本 §5.2）。コメントの投稿そのものに失敗したら、今までどおり `error` にする
- `refresh` は Flutter の単位には起こらない（`advisories` が常に空）

## 7. 生成（generate.ts）

### 7.1 Generator

```ts
interface GeneratorOptions {
  baseDir: string
  commands: PostUpdate[]
  flutter: boolean
  fvm: boolean
  hostedUrl: string      // 中継サーバー（パッケージの単位の pub get --offline）
  upstreamUrl: string    // 追加。中継サーバーの取得元（pub.dev、テストでは PUBREFORM_UPSTREAM）
  image?: string         // post_update があるときだけ
  sdk?: Sdk              // post_update があるときだけ（ベースの SDK）
  pubCache: string
}
```

- `generate(result)`（パッケージの単位）は今のまま。`image` と `sdk` がなければ例外を投げる（呼ばれない）
- `updateFlutter(result)` を足す（§7.2）
- `runCommand(command, dir)` に、使う SDK を引数で渡すようにする。パッケージの単位ではベースの SDK、Flutter の単位では新しい SDK
- main.ts は、`post_update` があるときだけ `generate` を、Flutter の単位があるときだけ `updateFlutter` を `ExecuteContext` に渡す

### 7.2 updateFlutter の手順

1. 生成用ディレクトリを作り、ベースで追跡しているファイルを書き出す（詳細 §19.4 の 1、2 と同じ）。ベースの作業用ディレクトリは使わない（F 基本 §5.1）
2. `result.flutter.files`（`.fvmrc` と `.vscode/settings.json`）と、`result.files.pubspec` を書き込む
3. `S0` = 変わったファイル（`changedFiles` → `treeEntries`。詳細 §19.6）。書き換えた `.fvmrc` などが入る
4. `fvm install <to> --skip-pub-get` を、空の一時ディレクトリ（生成用ディレクトリの外）で実行する。`.fvmrc` を書き換えたディレクトリで pub を実行すれば fvm は自動で入れる（§11.2）が、ログを分け、失敗をここで見分けるために、明示して入れる。生成用ディレクトリで実行しないのは、`install` がプロジェクトのファイルに触れないかを確かめていないため。`fvm use` は `.vscode/settings.json` のコメントを消し、`.gitignore` を書き換えた（F 基本 §8.2）。`install --help` の `--skip-pub-get` の説明（「after switching Flutter SDK」）も、プロジェクトに働きかけることをうかがわせる。もし触れると、§3.3 で書式を保って書き換えた内容が、`S1` で fvm の書いたものに置き換わってしまう。バージョンを明示すれば、プロジェクトは要らない
5. `Pub`（詳細 §8.2）を `{ dir: 生成用ディレクトリ, flutter: isFlutter(pubspec), fvm: true, hostedUrl: upstreamUrl }` で作り、`run(['get'], { pubspec, lock: ベースの lockfile })` を実行する。`--no-example` は `Pub` が付ける。本番では `upstreamUrl` が pub.dev なので、lockfile の URL の置き換えは何もしない。テストでは、フィクスチャー用サーバーに向く
6. `S1` = 変わったファイル。`pub get` で変わったプラグインの登録ファイル（§11.4）などが加わる
7. `post_update` があれば、`findSdk({ flutter: true, fvm: true, cwd: 生成用ディレクトリ })` で新しい SDK を探し、その SDK でコマンドを順に実行する（詳細 §19.5）。`pub get --offline` は要らない（5 で `package_config.json` ができている）。詳細 §19.8 では、中継サーバーの URL の lockfile で `pub get --offline` をした後に lockfile を pub.dev の URL に戻しても、`dart run` が暗黙の `pub get` を始めないことを確かめた。pub.dev の URL のまま `pub get` をした場合も同じになる見込みで、GitHub E2E で確かめる（§12）
8. `S2` = 変わったファイル
9. 生成用ディレクトリを消す

返す値:

| 結果 | `lock` | `entries` | `generated` | `failure` |
|---|---|---|---|---|
| 成功 | 5 の結果 | `S2` | `S2` のうち、`S1` と違う項目（パスが同じで中身かモードが違う、`S1` にない）と、`S1` にあって `S2` にないものの数 | なし |
| 4 か 5 の失敗 | ベースの lockfile | `S0` | 0 | `pub get` |
| 7 の失敗（SDK を探せない、コマンドの失敗） | 5 の結果 | `S1` | 0 | `post_update` |

- 1〜3、6、8 の失敗（git の失敗など）は、例外のまま投げる（単位のエラー。PR は作らない、または変えない）
- `failure.log`: 4 の失敗は、実行したコマンドと出力の末尾。5 の失敗は `PubError` のメッセージ。7 の失敗は `PostUpdateError` のメッセージ
- `failure.key`（コメントの重複の確認。詳細 §15）: 4 の失敗は `fvm install` NUL `<to>`。fvm の出力には所要時間（`(0.2s)` など）が入り、毎回変わるため。5 の失敗はログそのもの（pub の解決の出力は同じ入力なら同じ）。7 の失敗は `PostUpdateError.key`（コマンドと終了コード。詳細 §19.7）。SDK を探せないときはログそのもの
- `S0`〜`S2` はどれも `treeEntries` を通すので、`pubspec.yaml` と `pubspec.lock` は入らない（`files` で別に渡す）。`.gitignore` で除外したもの（`.dart_tool/` など）も入らない
- ログ: `post_update` があるときは、4 と 5 を `Flutter <to>` のグループにまとめる。ないときは、操作の全体が `Pull requests` のグループの中なので（詳細 §3）、グループを作らない（入れ子にしない）

## 8. ジョブサマリー（main.ts）

- 各 PR への操作の表: 種類の欄は `flutter`。パッケージの欄は、`kind` が `flutter` なら pub.dev へのリンクにせず `Flutter` と書く。操作の欄は、`note` があれば `created (pub get failed)` のように後ろに付ける
- `flutterError` があれば、`{ kind: 'flutter', packages: ['flutter'], action: 'error', error: flutterError }` の `Outcome` を足す。エラーの一覧に出て、ジョブは失敗する（F 基本 §5.2）
- `.fvmrc` があるのに `currentFlutter` が `undefined` のときは、サマリーには書かず、ログに出すだけにする

## 9. 設定、スキーマ、README

- 設定とその検証（config.ts）は変えない。`ignore[].name` に `flutter` はもう書ける（`^[a-z_][a-z0-9_]*$`）
- `pubreform.schema.json` は、構造（キー、型、パターン、既定値）を変えず、次の説明だけを変える。`$id` は `v1` のまま（同じメジャーの間は後方互換に保つ。詳細 §4.2）

| キー | 今の説明 | 変えた後 |
|---|---|---|
| `min_release_age_days` | `Only versions published at least this many days before the schedule time are used.` | `Only versions published at least this many days before the schedule time are used. Not applied to the Flutter version in .fvmrc.` |
| `ignore[].name` | `Package name.` | `Package name, or flutter for the Flutter version in .fvmrc.` |
| `ignore[].versions` | `… If omitted, all updates of the package are skipped.` | `… If omitted, all updates of the package (or of Flutter) are skipped.` |

- `post_update` の説明（`Commands run, in order, before each pull request is created or regenerated. …`）は、Flutter の PR にも当てはまるので変えない
- `test/config-schema.test.ts` の `full` の例に、`- name: flutter` と `versions: ">=4.0.0"` のルールを足す。スキーマと config.ts のどちらでも受け付けることを、Flutter の使い方でも確かめておくため（判定は今も同じ）
- README:
  - Flutter の更新の節を足す。PR の内容、`.fvmrc` が要ること、待機期間を当てはめないこと、`pub get` は中継サーバーを経由しないこと、失敗しても PR を作ること、`ignore` での止め方
  - `ignore` の行に `flutter` を書ける旨を足す
  - 「Why pubreform」の Flutter の項目と、Limitations を見直す
- `CLAUDE.md` の結合テストの前提（入れられる Flutter のバージョン）と、未確認のことを直す（§10.2、§12）

## 10. テスト

### 10.1 単体テスト

| 対象 | 確かめること |
|---|---|
| `parseReleases` | `stable` だけ、`x.y.z` だけ（`v1.12.13+hotfix.9` を除く）、重複の除去、`dart_sdk_version` がない項目、形の誤りで例外 |
| `releasesUrl` | OS の対応、`PUBREFORM_FLUTTER_RELEASES` |
| `currentFlutter` | バージョン、`stable`、`3.47.9@beta`、コミット、読めない JSON |
| `flutterTarget` | 最大のバージョン（公開日時の順ではない）、`ignore`（名前だけ、`versions`）、`c` 以下なら `undefined` |
| `rewriteFvmrc` | ほかのキーと書式が残る、`flavors` に同じバージョンがあっても最上位だけ変わる、`flutter` が `from` でなければ例外 |
| `rewriteVscodeSettings` | コメントと末尾の改行が残る、コメントアウトした行は変えない、`.fvm/versions/<c>`、`.fvm/flutter_sdk` は変えない、Windows のパス、キーがない、閉じていないコメント |
| `flutterConstraint` | §3.3 の表の各行 |
| `rewriteEnvironmentFlutter` | 引用符の種類とコメントが残る、`environment` や `flutter` がない、値がスカラーでない |
| render | ブランチ名、タイトル、コミットメッセージ、本文（Dart の欄が空、失敗の 1 行の 3 通り、`post_update` の行、CHANGELOG の URL）、メタデータの往復、エラーコメントの見出し |
| `decide` | ブランチ名での対応付け、`to` が変わったら `contentChanged`、利用者が閉じた同じ `to` の PR で `skip`、`uncertain` の `flutter` で `none`、計画にない PR の `close`、メタデータのない `pubreform/flutter` の PR |
| `execute` | Flutter の単位では `generate` ではなく `updateFlutter` を呼ぶ、`failure` があれば PR を作ってからコメントする、`Outcome` に `note` が付き `error` は付かない、同じ `key` ならコメントしない、内容の変更のコメントが `\| flutter \| 3.47.8 → 3.47.9 \| 3.47.8 → 3.47.10 \|` になる |

`updateFlutter` そのものは外部のコマンド（git、fvm、pub、docker）を動かすので、結合テスト（§10.2）とローカル E2E（§10.3）で確かめる。

### 10.2 結合テスト（`PUBREFORM_IT=1`）

本物の fvm と pub.dev で、`test/integration.test.ts` に次を足す。前提に「Flutter 3.47.8 を入れられること」が加わる。

- Flutter 3.47.7 の Flutter のプロジェクト（`sdk: flutter` に依存し、`environment.flutter: ^3.47.7`、言語バージョン 3.9 以上、コメントを含む `.vscode/settings.json` あり）を git のリポジトリにして、ベースの lockfile を作る
- `applyFlutter`（§4）で 3.47.8 に書き換え、`Generator.updateFlutter`（§7.2。`post_update` なし、`upstreamUrl` は pub.dev）をそのリポジトリに対して直接呼ぶ
- 確かめること: `failure` がない、`lock` の `sdks.flutter` の下限が 3.47.8 になる、`entries` の `.vscode/settings.json` にコメントが残っている（`fvm install` がプロジェクトのファイルを書き換えていない）、`entries` に `.fvm/` で始まるものがない。あわせて、`.fvmrc` が 3.47.8 のディレクトリで `findSdk` が 3.47.8 の SDK を返す

### 10.3 ローカル E2E（`test/e2e/flutter.test.ts`）

外部に接続しない（詳細 §17.1）。本物の fvm と Flutter SDK の代わりに、次を使う。

| 置き換えるもの | 置き換え先 |
|---|---|
| fvm | テストが一時ディレクトリに書き、PATH の先頭に置くシェルスクリプト（下記） |
| Flutter SDK | バージョンごとのディレクトリ（`$FAKE_FLUTTER_SDKS/<version>/bin/cache/flutter.version.json` に `{"flutterVersion": "<version>"}` だけ）。pub はこれを Flutter SDK として読む（§11.3） |
| リリース一覧 | フィクスチャー用サーバーの `/flutter/releases.json`（`startFixtureServer` の `flutterReleases` で渡し、実行中に足せる）。`PUBREFORM_FLUTTER_RELEASES` で向ける |

偽の fvm:

- 呼ばれた引数を `$FAKE_FVM_LOG` に 1 行ずつ書く
- `install <v> …`: `$FAKE_FLUTTER_SDKS/<v>` があれば成功、なければ失敗する（SDK の取得の失敗の代わり）
- `dart …` / `flutter …`: カレントディレクトリの `.fvmrc` の `flutter` を読み、`FLUTTER_ROOT` をその SDK にして、PATH 上の本物の `dart` を実行する（`flutter pub …` は `dart pub …` にする。テスト用プロジェクトは Dart だけなので同じ）。`flutter --version --machine` は `{"frameworkVersion": …, "flutterRoot": …}` を出す

テスト用プロジェクト: `makeProject` に `flutter` のオプション（ベースのバージョン）と `dependencies` のオプションを足して作る。ここでは依存は `fx_patch` だけ、`.fvmrc` は 3.47.8、`environment.flutter: ^3.47.8`、`.vscode/settings.json` はコメントと `"dart.flutterSdkPath": ".fvm/versions/3.47.8"` を含む。`environment.flutter` があると、`FLUTTER_ROOT` のない `dart pub get` は `requires the Flutter SDK` で失敗する（§11.3）。そのため `makeProject` は、`flutter` のオプションがあれば、呼び出し元にかかわらず（GitHub E2E でも）一時ディレクトリに偽の SDK（`bin/cache/flutter.version.json` に `flutterVersion` だけ）を作り、それを `FLUTTER_ROOT` にして lockfile を作る。リリース一覧は 3.47.8 と 3.47.9 の安定版、ベータ版の `3.48.0-0.1.pre`、古い `v1.0.0`。

場面（順に実行する）:

1. 作成: `pubreform/flutter` に `Update Flutter from 3.47.8 to 3.47.9` の PR ができる。コミットの `.fvmrc`、`.vscode/settings.json`（コメントが残る）、`pubspec.yaml`（`^3.47.9`）、`pubspec.lock`（`sdks.flutter`）、本文（Dart の欄、リンク）、メタデータ。偽の fvm の記録に `install 3.47.9` がある
2. 何も変わらない: もう一度実行すると、head もコメントも変わらず、偽の fvm の記録に `install` が増えない（`pub get` は作るときと作り直すときだけ）
3. 新しいリリース: 一覧に 3.47.10 と、その SDK を足して実行すると、作り直されて、内容の変更のコメント（`| flutter | 3.47.8 → 3.47.9 | 3.47.8 → 3.47.10 |`）が出る
4. `pub get` の失敗: 一覧に 3.47.11 を足し、SDK は足さずに実行すると、`.fvmrc` が 3.47.11 になり、`pubspec.lock` はベースのまま作り直される。本文に失敗の 1 行が入り、見出し付きのエラーコメントが出て、ジョブは成功する。チェックボックスを入れてもう一度実行すると、作り直されるが、コメントは増えない
5. リリース一覧の失敗: フィクスチャー用サーバーが一覧に 500 を返すようにして実行すると、Flutter の PR は変わらず、ジョブは失敗し、サマリーのエラーに出る
6. `ignore`: 一覧は 500 を返すまま、設定の `ignore` に `name: flutter` を足して実行すると、ジョブは成功し（リリース一覧を取得しない）、Flutter の PR が「no longer needed」で閉じられる。その後、一覧を戻す

更新後のコマンドとの組み合わせ（`docker version` が通るときだけ。`post-update.test.ts` と同じ条件）:

7. 3.47.11 の SDK を足し、設定から `ignore` の `flutter` を外して、`$FLUTTER_ROOT/bin/cache/flutter.version.json` の内容と、`$FLUTTER_ROOT` に書き込めるかを `flutter.txt` に書く `sh` のコマンドを入れて実行する。Flutter の PR が作られ（pubreform が閉じた PR は作り直しを止めない）、コミットの `flutter.txt` に新しいバージョン（3.47.11）と `read-only` が入り、本文に `` Files changed by the `post_update` commands: 1 `` が入る。マイナー・パッチグループの PR の `flutter.txt` は、ベースのバージョン（3.47.8）になる
8. 設定に、ベースの SDK では通り、新しい SDK では終了コード 3 で失敗するコマンド（`flutter.version.json` に 3.47.8 があるかを `grep` する）を足して実行すると、Flutter の PR は作り直され、`flutter.txt` は入らず、本文に失敗の 1 行が入り、見出し付きのエラーコメントが出る。マイナー・パッチグループの PR は成功するので、ジョブも成功する

偽の SDK には同梱の Dart がないので、コンテナの中で `dart` は動かない。`dart run` を使うコマンドは GitHub E2E で確かめる。

### 10.4 GitHub E2E

本物の fvm、Flutter SDK、リリース一覧で確かめる（詳細 §17.2 に足す）。今の確認（Dart だけのプロジェクトで setup-dart の `dart` を使う。fvm を使わない流れを本物のランナーで確かめているのはここだけ）はそのまま残し、その後に Flutter の段を足す（利用者の決定）。

`github-e2e.ts` の手順の、今の「2 回目の確認」の後に足すもの:

1. Flutter の段の準備: `makeProject({ postUpdate: true, flutter: FLUTTER_BASE, dependencies: ['fx_patch'] })`（`FLUTTER_BASE` = 3.47.8）で作ったプロジェクトを main に push する。今の Dart だけのプロジェクトに、`.fvmrc`、`environment.flutter: ^3.47.8`、コメントを含む `.vscode/settings.json` を加え、依存を `fx_patch` だけにしたもの（PR の数と更新後のコマンドの実行を減らすため）。Dart だけのプロジェクトのままにするのは、Flutter SDK が要求するパッケージ（`meta` など）がフィクスチャー用サーバーにないため（Flutter のプロジェクトの解決は結合テストで確かめる）
2. 後片付け（今の手順 3 と同じ）。1 段目の PR を閉じる
3. 3 回目: pubreform を実行する。パッケージの解決と更新後のコマンドも fvm（Flutter SDK に同梱の Dart）を通る
4. 3 回目の確認:
   - `pubreform/flutter` の PR があり、タイトルが `Update Flutter from 3.47.8 to <t>`。`t` は、スクリプトが同じリリース一覧を `parseReleases` で読んで求めた最大の安定版
   - コミットが Verified で、`.fvmrc`、`.vscode/settings.json`（コメントが残る）、`pubspec.yaml`、`pubspec.lock` が書き換わり、`.fvm/` で始まるファイルがない
   - `lib/versions.g.dart`（`dart run` が新しい SDK で動いた）と `probe.txt`（新しい SDK も読み取り専用。トークンが読めない）が入る
   - マイナー・パッチグループの PR の `probe.txt` と `lib/versions.g.dart` も、1 段目と同じになる（fvm を使うプロジェクトでの更新後のコマンド。詳細 §21 の未確認のことの一部）

次の実行の手順 1（テスト用プロジェクトの更新）は、今までどおり Dart だけのプロジェクトを push するので、main は毎回 1 段目のプロジェクトから始まる。

ワークフロー（pubreform-e2e の `e2e.yml`）の変更:

- setup-fvm（`chika3742/setup-fvm@v3`）を足す。setup-fvm は起動のときに `fvm flutter pub get --enforce-lockfile` を実行するので、フィクスチャーに依存するテスト用プロジェクトには使えない（詳細 §17.2）。そこで、その前の `run:` のステップで、`bun pubreform-src/test/e2e/make-project.ts --fvm-setup "$RUNNER_TEMP/fvm-setup"` により、`.fvmrc`（`FLUTTER_BASE`）、依存のない `pubspec.yaml`、固定の文字列の `pubspec.lock`（§11.6）だけを書き、`project-dir` にそれを渡す。`FLUTTER_BASE` は `make-project.ts` にだけ書く
- setup-dart は、setup-fvm の後に置く。どちらも PATH の先頭に足すので、1 段目で PATH の `dart` が setup-dart のものになるようにするため。`github-e2e.ts` の最初に、PATH の `dart` の実体が fvm のキャッシュの中でないことを確かめる

更新先は、そのときの最新の安定版になる。テスト用プロジェクトは `environment.sdk: ^3.0.0` のままなので、Dart 4 を同梱する Flutter が出ると、Flutter の PR の `pub get` が失敗して確認が通らなくなる。そのときに直す。

## 11. 確認済みのこと

### 11.1 リリース一覧と CHANGELOG

F 基本 §8.1、§8.4 のとおり。

### 11.2 fvm

2026-11-02 に、macOS の fvm 4.3.2 で確かめた。

- `fvm install --help`: `fvm install {version}` で入れる。`--[no-]setup`（既定は on。SDK の依存も取得する）と `--skip-pub-get` がある
- `CI=true` で、入っていないバージョン（3.47.9）を書いた `.fvmrc` のディレクトリで `fvm flutter pub get` を実行すると、`Flutter SDK: SDK Version : 3.47.9 is not installed.` / `Installing Flutter SDK automatically...` と出て、確認を求めずにインストールを始めた。実行したのは `git clone --progress -c advice.detachedHead=false -b stable https://github.com/flutter/flutter.git <cache>/versions/3.47.9`（浅くない clone）
- この clone は、実行した環境のプロキシで切られて失敗し、インストールの最後までは確かめられなかった。同じ git コマンドを直接実行すると、25 秒で 400 MiB を超える量を受け取ったところまで進んだ
- インストール済みのバージョンを書いた `.fvmrc` のディレクトリで `fvm flutter --version --machine` を実行しても、プロジェクトに `.fvm/` はできなかった（Flutter 自体は、実行した環境の都合で SDK に書き込めずに途中で止まった）

### 11.3 Flutter SDK の読み取り

2026-11-02 に、Flutter 3.47.9 と、同梱の Dart 3.13.7 で確かめた。

- Flutter SDK の `bin/dart`（起動スクリプト）は、`bin/internal/shared.sh` で `FLUTTER_ROOT` を export する。`fvm dart pub` でも、pub は `environment.flutter` を見る
- 3.47.9 の SDK には `version` のファイルがなく、`bin/cache/flutter.version.json` に `frameworkVersion` と `flutterVersion`（どちらも `3.47.9`）などがある
- `bin/cache/flutter.version.json` に `{"flutterVersion": "3.50.0"}` だけを置いたディレクトリを `FLUTTER_ROOT` にすると、pub はこれを Flutter 3.50.0 として扱った（`>=3.50.0` で解決し、`>=3.51.0` で `The current Flutter SDK version is 3.50.0.` と出て失敗）。`{"frameworkVersion": "3.50.0"}` だけ、または `version` のファイルだけでは、`Because app requires the Flutter SDK, version solving failed.` になった

### 11.4 プラグインの登録ファイル

2026-11-02 に、Flutter 3.47.9 の `flutter_tools` で確かめた。

- アプリのテンプレートの `.gitignore` は、iOS の `Runner/GeneratedPluginRegistrant.*` と Android の `GeneratedPluginRegistrant.java` を無視する
- macOS の `macos/Flutter/GeneratedPluginRegistrant.swift`（`managedDirectory` = `macos/Flutter`）と、Linux・Windows の `flutter/generated_plugins.cmake`、`flutter/generated_plugin_registrant.cc` / `.h`（`managedDirectory` = `<platform>/flutter`）は無視しない（無視するのは `Flutter/ephemeral/`、`flutter/ephemeral/` だけ）。これらは git で追跡され、`pub get` で書き直されることがある

### 11.5 リリースノート

2026-11-02 に、`https://docs.flutter.dev/release/release-notes` は 200 を返した。系列ごとのページ（`release-notes-3.47.0`、`release-notes-3.44.0`）はあり、`release-notes-3.46.0`（安定版の系列でない）と `release-notes-3.47.9`（ホットフィックス）は 404 だった。本文には索引のページを載せる（利用者の決定）。

### 11.6 setup-fvm に渡すプロジェクト

2026-11-02 に、Dart 3.13.7 で、`pubspec.yaml`（`name` と `environment.sdk: ^3.0.0` だけ）と、次の固定の文字列の `pubspec.lock` だけのディレクトリで `dart pub get --enforce-lockfile` を実行した。`Got dependencies!` と出て、lockfile は変わらなかった（終了コードは、実行した環境の都合でテレメトリーのファイルを書けずに 1）。setup-fvm が実行する `fvm flutter pub get --enforce-lockfile` では確かめていない。

```yaml
# Generated by pub
# See https://dart.dev/tools/pub/glossary#lockfile
packages: {}
sdks:
  dart: ">=3.0.0 <4.0.0"
```

## 12. 未確認のこと

| 項目 | 確かめる場所 |
|---|---|
| `fvm install` が GitHub のランナーで最後まで動くか。かかる時間とディスク | GitHub E2E |
| setup-fvm と組み合わせた実行（`project-dir` に別のディレクトリを渡す使い方を含む） | GitHub E2E |
| 新しい SDK をマウントしたコンテナで、`dart run` が暗黙の `pub get` を始めずに動くか（lockfile の URL が pub.dev のまま `pub get` した場合。§7.2） | GitHub E2E |
| Flutter のプロジェクトで、中継サーバーを経由しない `fvm flutter pub get` が新しい Flutter で通るか | 結合テスト |
| macOS と Windows のリリース一覧の形 | 確かめない（GitHub のホストランナーの Linux を想定） |

## 13. 基本設計からの変更点

この詳細設計で、F 基本の次の点を具体化・変更した。どれも F 基本に反映済み。

| 項目 | F 基本（最初） | 詳細設計 |
|---|---|---|
| コミットするファイル | `.fvmrc`、`.vscode/settings.json`、`pubspec.yaml`、`pubspec.lock`、更新後のコマンドで変わったファイル | `pub get` で変わったファイル（プラグインの登録ファイルなど）も、`post_update` の有無にかかわらず入れる（利用者の決定。§7.2、§11.4） |
| SDK の取得 | `fvm flutter pub get` が自動で入れる | `fvm install <t> --skip-pub-get` で明示して入れる（§7.2） |
| リリースノートのリンク | 詳細設計で決める | 索引のページ（利用者の決定。§11.5） |
| `pub get` の取得先 | pub.dev | 中継サーバーの取得元（pub.dev。テストでは `PUBREFORM_UPSTREAM`）（§7.2） |
