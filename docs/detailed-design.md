# pubreform 詳細設計

> ステータス: ドラフト（2026-10-18）。[基本設計](design.md)を前提に、実装に必要な決定を書く。節番号の「基本 §n」は基本設計の節を指す。

## 1. 技術スタック

| 項目 | 採用 | 理由 |
|---|---|---|
| ランタイム | Node 24（`runs.using: node24`） | 基本 §3 |
| 言語 | TypeScript | 型検査は `tsc --noEmit`（TypeScript 7.0） |
| ビルド・テスト | Bun（`bun build --target=node`、`bun test`） | setup-fvm と同じ構成にそろえる |
| 依存パッケージ | `@actions/core` 3、`@actions/exec` 3、`@actions/github` 9、`yaml` 2、`cron-parser` 5 | 下記 |

依存パッケージを使う理由:

- `@actions/core` / `@actions/exec`: 入力、ログ、ジョブサマリー、外部コマンドの実行（出力の取得とログへの表示を同時に行える）
- `@actions/github`: 認証済みの Octokit（REST とページング）
- `yaml`: `pubspec.yaml`、`pubspec.lock`、設定ファイルの読み込みと、作業用の pubspec の書き換え
- `cron-parser`: cron とタイムゾーンから直前の発火時刻を求める（`prev()`）。動作を確認済み（§5）

semver のライブラリは使わない。pub の caret（`^0.0.1` = `<0.1.0`）は npm の semver と意味が違い、必要な処理（比較と制約の判定）は少ないため、自前で書く（§6）。

## 2. リポジトリ構成

```
action.yml
package.json / bun.lock / tsconfig.json
src/
  main.ts        エントリポイント。全体の流れとエラーの集約（§3）
  config.ts      設定の読み込み・検証・ハッシュ（§4）
  clock.ts       slot と cutoff（§5）
  version.ts     バージョンの比較と pub の制約（§6）
  pubspec.ts     pubspec / lockfile の読み取りと、作業用の書き換え（§7）
  pub.ts         pub コマンドの実行（§8）
  proxy.ts       中継サーバー（§9）
  planner.ts     更新単位の計画（§10）
  applier.ts     更新単位の適用（§11）
  render.ts      タイトル、本文、コミットメッセージ、コメント、メタデータ（§12）
  github.ts      GitHub API の操作（§13）
  reconciler.ts  計画と既存 PR の突き合わせと操作の決定（§14）
test/            bun test（§17）
pubreform.schema.json  設定ファイルの JSON スキーマ（§4.2）
dist/            ビルド結果（リリース時に生成してコミットする。§18）
```

`prototype/cooldown/` は `proxy.ts` と結合テストに置き換えたら削除する。

### action.yml

```yaml
name: pubreform
description: Keeps pub dependencies up to date with pull requests.
inputs:
  token:
    description: GitHub App installation token used for commits, pull requests and comments.
    required: true
  config:
    description: Path to the config file, read from the default branch.
    default: .github/pubreform.yaml
runs:
  using: node24
  main: dist/main.js
```

## 3. 全体の流れ（main.ts）

```
1. 入力を読む。core.setSecret(token)
2. GET /repos/{owner}/{repo} でデフォルトブランチ（= ベース）を得る
3. ベースを $RUNNER_TEMP/pubreform/base に浅く clone する（§8.1）。baseSha を得る
4. 設定を clone から読み、検証する（§4）。configHash を計算する
5. pubspec.yaml / pubspec.lock / .fvmrc を読む（§7）。baseHash を計算する
   ルートの pubspec に workspace: があれば全体エラー
6. slot と cutoff を求める（§5）
7. 中継サーバーを起動する（§9）
8. 計画する（§10）→ 更新単位と、計画に失敗したパッケージ（uncertain）
9. 各更新単位を適用する（§11）→ 結果、または単位ごとのエラー
10. 既存 PR を集める（open と、直近 100 件の closed）（§13）
11. 操作を決める（§14）。純粋関数で、テストできる形にする
12. 操作を 1 つずつ実行する。失敗はその操作のエラーとして記録し、次へ進む
13. ジョブサマリーを書く（§16）。エラーが 1 件でもあれば core.setFailed
（finally）中継サーバーを止める
```

エラーは 2 種類に分ける。

| 種類 | 例 | 扱い |
|---|---|---|
| 全体エラー | 設定の誤り、clone の失敗、U / R の解決の失敗、workspace | 手順 10 以降に進まず、PR を一切変更せずに失敗終了する |
| 単位のエラー | 1 つの更新単位の S の計算・適用・コミット・PR 操作の失敗 | その単位だけを止め、他は続ける（§15） |

## 4. 設定（config.ts）

### 4.1 スキーマ

| キー | 型 | 既定値 | 検証 |
|---|---|---|---|
| `schedule.cron` | string | （必須） | 5 フィールドの cron。`cron-parser` で解釈できること |
| `schedule.timezone` | string | `UTC` | `Intl.DateTimeFormat(undefined, { timeZone })` が例外を出さないこと |
| `min_release_age_days` | integer | `0` | 0 以上の整数 |
| `labels` | string[] | `[]` | 空文字列を含まず、重複しない |
| `versioning` | `increase` \| `lockfile-only` | `increase` | 列挙値 |
| `ignore` | `{ name, versions? }[]` | `[]` | `name` は必須。`versions` は pub の制約の書式（§6） |

- 知らないキーはエラーにする（綴りの誤りに気づけるようにする）。ただし最上位の `$schema`（エディタ用のスキーマの指定。§4.2）は受け付けて無視し、ハッシュにも含めない
- 設定ファイルがない、YAML として読めない、検証に失敗した場合は全体エラー。エラーメッセージにはキーのパスを含める（例: `schedule.timezone: unknown time zone "Asia/Tokio"`）

### 4.2 JSON スキーマ

リポジトリのルートに [`pubreform.schema.json`](../pubreform.schema.json)（JSON Schema 2020-12）を置く。エディタで補完と検証が効くように、利用者は設定ファイルの先頭に次の行を書く。

```yaml
# $schema: https://raw.githubusercontent.com/chika3742/pubreform/v1/pubreform.schema.json
```

スキーマの指定方法は 3 つあり、IntelliJ IDEA（2026-10-17 時点のソースで確認）と yaml-language-server（VS Code の YAML 拡張機能など。README で確認）のどちらもすべてに対応している。

| 書き方 | 扱い |
|---|---|
| コメント `# $schema: <URL>` | 推奨。設定の内容に影響しない |
| コメント `# yaml-language-server: $schema=<URL>` | 使える。IntelliJ IDEA は認識するが、補完の候補には出さない |
| 最上位のキー `$schema: <URL>` | 使える。設定のキーになるので、スキーマと config.ts で受け付けて無視する（§4.1） |

- 参照先はメジャータグ（`v1`）にする。同じメジャーの間はスキーマを後方互換に保つ
- yaml-language-server は 2020-12 に対応している
- スキーマが表すのは構造（キー、型、列挙値、書式）だけで、Action の実行時には使わない（ajv をバンドルに含めない）。cron として解釈できるか、タイムゾーンが存在するか、制約が正しいかは、config.ts が検証する
- スキーマと config.ts の判定がずれないように、同じ設定例をスキーマ（ajv、開発時の依存）と config.ts の両方で判定し、結果が一致することをテストする（§17）

### 4.3 ハッシュ

`configHash` = 既定値を補った設定を、キーを並べ替えた JSON にして SHA-256（16 進）。コメントや空白だけの変更では変わらない。ラベルの変更でも変わる（基本 §7.2 のとおり、設定の変更はすべて再生成の対象）。

## 5. slot と cutoff（clock.ts）

```ts
slot = CronExpressionParser.parse(cron, { tz, currentDate: 秒に切り捨てた now + 1秒 }).prev()
cutoff = slot − min_release_age_days × 24 時間
```

- `prev()` は `currentDate` ちょうどの発火時刻を含まない（cron-parser 5.10.2 で確認）。「現在時刻以前で直近」にするため、now を秒に切り捨ててから 1 秒足して呼ぶ（切り捨てないと、23:59:59.999 のときに直後の 00:00:00 を返してしまう）
- 夏時間の扱いは cron-parser に従う
- 日数の減算は絶対時間で行う（タイムゾーンに依存しない）

## 6. バージョンと制約（version.ts）

pub の書式のうち、必要な分だけを扱う。

| 関数 | 内容 |
|---|---|
| `parseVersion(s)` | `major.minor.patch[-pre][+build]` |
| `compareVersions(a, b)` | semver の順序。pub に合わせて、build 付きは build なしより後ろ |
| `parseConstraint(s)` | `any`、`^v`、`>=v`、`>v`、`<=v`、`<v`、`v`（完全一致）と、それらを並べた積（例: `>=1.0.0 <2.0.0`）。pub と同じく、演算子の後の空白（`>= 1.0.0`、`^ 1.0.0`）と、比較の間の空白なし（`>=1.0.0<2.0.0`）も受け付ける（Dart 3.13.5 の pub が受け付けることを確認済み）。設定の `ignore.versions` だけは、JSON スキーマと判定をそろえるため、config.ts で空白区切りの厳密な書式に限る |
| `allows(constraint, version)` | 制約を満たすか |

- `^v` は pub の規則で展開する。`major > 0` なら `<(major+1).0.0`、`major == 0` なら `<0.(minor+1).0`
- プレリリースの細かい規則（`<2.0.0` が `2.0.0-dev` を含むかなど）は扱わない。判定に使うのは、解決後の安定版が元の制約を満たすかと、`ignore.versions` だけのため

## 7. pubspec と lockfile（pubspec.ts）

### 7.1 直接依存の判定

`pubspec.yaml` の `dependencies` / `dev_dependencies` のうち、次をすべて満たすもの。

- 値が文字列、`null`、または `version` と pub.dev を指す `hosted` だけを持つ map
- `dependency_overrides` に名前がない
- lockfile のエントリが `source: hosted` で、`url` が `https://pub.dev`

```ts
type Section = 'dependencies' | 'dev_dependencies'
interface DirectDep {
  name: string
  section: Section
  constraint: string   // 元の制約。null は 'any'
  current: string      // c(d): ベースの lockfile のバージョン
}
```

Flutter のプロジェクトかどうかは、`dependencies` または `dev_dependencies` に `sdk: flutter` の依存があるかで決める。

### 7.2 作業用の書き換え

`yaml` の Document API で、該当する値だけを書き換える。値が文字列か `null` ならその値を、map なら `version` を置き換える。作業用の内容はコミットしないので、書式は気にしない。

```ts
withConstraints(pubspecText, Map<name, constraint>): string
```

### 7.3 ハッシュ

`baseHash` = SHA-256（16 進）。次を順に連結した入力から計算する。`.fvmrc` がなければ内容は空とする。

```
"pubspec.yaml" NUL <内容> NUL "pubspec.lock" NUL <内容> NUL ".fvmrc" NUL <内容>
```

## 8. pub の実行（pub.ts）

### 8.1 作業ディレクトリ

- ベースは `git clone --depth 1 --single-branch --branch <base>` で `$RUNNER_TEMP/pubreform/base` に取得する。認証は `-c http.extraheader=AUTHORIZATION: basic <base64(x-access-token:<token>)>` で渡し、URL にトークンを入れない。`@actions/exec` はコマンド行をログに出すので、base64 の値も `core.setSecret` でマスクする
- actions/checkout の状態（どの ref を checkout したか、認証情報を残したか）には依存しない
- すべての解決を、この 1 つのディレクトリで順に行う。各 pub コマンドの前に、`pubspec.yaml` と `pubspec.lock` をメモリ上のベースの内容（または作業用の書き換え）で上書きする。`.dart_tool/` などの残りものは結果に影響しないので消さない

### 8.2 コマンド

| 条件 | コマンド |
|---|---|
| `.fvmrc` あり、Flutter | `fvm flutter pub …` |
| `.fvmrc` あり、Dart | `fvm dart pub …` |
| `.fvmrc` なし | `flutter pub …` / `dart pub …` |

```ts
pub(args: string[], opts: { pubspec: string; lock: string }): Promise<{ pubspec: string; lock: string }>
```

1. `pubspec.yaml` を書き込む。`lock` の `url: "https://pub.dev"` を `url: "http://127.0.0.1:8471"` に置き換えて `pubspec.lock` に書き込む
2. 環境変数 `PUB_HOSTED_URL=http://127.0.0.1:8471` を付けて、`@actions/exec` の `getExecOutput` で実行する（出力はログにも出る）。`get` / `upgrade` / `add` には `--no-example` を付ける
3. 終了コードが 0 でなければ、標準エラー出力を含めて例外にする
4. 結果の lockfile の URL を元に戻し、両ファイルの内容を返す

`flutter pub upgrade --tighten` は `--no-example` を無視して `example/` も解決する（Flutter 3.47.7 で確認。`dart pub` では無視されない）。コミットするのはルートの 2 ファイルだけなので、結果には影響しない。

## 9. 中継サーバー（proxy.ts）

プロトタイプ（`prototype/cooldown/proxy.mjs`）を元にする。

- `127.0.0.1:8471` で待ち受ける。ポートは固定にする（基本 §4.2）。使用中なら全体エラー
- `GET /api/packages/<name>`: pub.dev の一覧を取得し、`versions` から次を除いて返す。ただし、ベースの lockfile でロックされているバージョンは必ず残す
  - `published` が cutoff より後のもの
  - `ignore` に該当するもの（`versions` がなければすべて、あれば `allows(versions, v)` のもの）
- それ以外のパスは pub.dev の応答をそのまま返す
- 取得した一覧は、実行中はメモリに保持して再利用する。1 回の実行の中で、どの解決にも同じ一覧を見せるためである
- pub.dev への取得は 30 秒で打ち切る。失敗したら 502 を返す（pub が失敗し、その解決のエラーになる）
- テストのために、環境変数 `PUBREFORM_UPSTREAM` があれば、pub.dev の代わりにその URL から取得する（E2E でフィクスチャー用サーバーに向けるため。利用者向けの設定ではないので、README には書かない）
- 計画のために `visibleVersions(name)`（絞り込み後のバージョン一覧）を公開する

`ignore` は、制約を書き換えるのではなく、ここで隠すことで実現する。U / R / S / 適用のすべての解決に同じように効き、制約の補集合を計算する必要がない。名前だけを指定したパッケージは、ロック済みのバージョンしか見えなくなるので、現在のバージョンに留まる。

## 10. 計画（planner.ts）

pub の解決は、引数で受け取る関数 `resolve` を通して行う。テストでは偽の `resolve` を渡す（§17）。

```ts
type Resolve = (args: string[], pubspec: string) => Promise<Map<string, string>> // name -> version（lockfile）
```

### 10.1 手順

```
deps = 直接依存（§7.1）

U = resolve(['upgrade'], ベースの pubspec)
R = resolve(['upgrade'], withConstraints(ベース, { d: '>=' + c(d) for d in deps }))
  （U / R の失敗は全体エラー）

minor = { d in deps : U(d) != c(d) }
X     = { d in deps : R(d) > U(d) }      // compareVersions

for d in X:
  try   S(d) = closure({d})
  catch uncertain に d を追加し、ログに出す

groups = 要素が重なる S を併合する。併合した集合ごとに closure をやり直し、重なりがなくなるまで繰り返す
  （併合した集合の closure が失敗したら、その集合のすべてのパッケージを uncertain に追加し、その単位は作らない）

closure(S):
  loop:
    pubspec = withConstraints(ベース, { m: R(m) for m in S } ∪ { e: '>=' + c(e) for e in deps − S })
    L = resolve(['get'], pubspec)       // ベースの lockfile を残すので、必要なものだけが動く
    K = { e in deps − S : !allows(元の制約(e), L(e)) }
    if K が空: return S
    S = S ∪ K
```

### 10.2 出力

```ts
type UnitKind = 'single' | 'minor' | 'group'
interface Unit {
  kind: UnitKind
  members: string[]               // minor: U で変わる直接依存、single / group: S
  targets: Record<string, string> // single / group: R のバージョン
}
interface Plan {
  units: Unit[]
  uncertain: Set<string>                                         // 計画に失敗したパッケージ
  unresolvable: { name: string; resolvable: string; latest: string }[]
}
```

- `minor` が空なら minor の単位は作らない（推移的依存だけの変化は無視する。基本 §5.3）
- `unresolvable`: 直接依存ごとに、`visibleVersions` の安定版の最大値が `R(d)` より新しければ記録する（ジョブサマリー用）

## 11. 適用（applier.ts）

| 単位 | 実行するコマンド |
|---|---|
| minor | `pub upgrade`（`versioning: increase` なら `--tighten` も付ける） |
| single / group | `pub add <spec>…`。spec は `name:^R(name)`。dev_dependencies なら `dev:name:^R(name)`。複数の spec を 1 回で渡す（Flutter 3.47.7 で、dev_dependencies のままで制約が書き換わり、pubspec のコメントも残ることを確認済み） |

```ts
interface Change { from: string; to: string; section: Section }
interface UnitResult {
  unit: Unit
  files: { pubspec: string; lock: string }
  changes: Record<string, Change>   // バージョンが変わった直接依存だけ
}
```

- `changes` は、ベースと結果の lockfile を比べて求める。推移的依存は含めない
- `changes` が空なら、その単位は捨てる（例: 他の単位とまったく同じ変化になった）
- `--tighten` は、バージョンが変わっていない直接依存の下限も上げることがある。`pubspec.yaml` の差分には出るが、`changes` には含めない

## 12. 文面とメタデータ（render.ts）

### 12.1 ブランチ名とタイトル

| 種類 | ブランチ | タイトル |
|---|---|---|
| single | `pubreform/single/<name>` | `Update <name> from <from> to <to>` |
| minor | `pubreform/minor-and-patch` | `Update <N> packages` |
| group | `pubreform/group/<作成時の members を並べ替えた先頭>` | `Update <N> packages` |

- N は `changes` の数
- N = 1 のときは、minor / group でもタイトルを single と同じ `Update <name> from <from> to <to>` にする（ユーザーの決定）。ブランチ名と種類（`kind`）は変えない
- single の `changes` に、メンバー以外の直接依存（制約の範囲内で動いたもの）が含まれることがある。タイトルはメンバーだけで書き、表にはすべて載せる

### 12.2 コミットメッセージ

single と、N = 1 の minor / group はタイトルだけ。それ以外の minor / group は、タイトル、空行、表。

```
Update 2 packages

| Package | From | To | Type |
|---|---|---|---|
| http | 1.5.0 | 1.6.0 | direct |
| lints | 6.0.0 | 6.1.0 | dev |
```

表の行はパッケージ名の順。Type は `dependencies` なら `direct`、`dev_dependencies` なら `dev`。

### 12.3 本文

基本 §8 のテンプレートに従う。各パッケージの節に使う情報は、適用時に pub がキャッシュに展開したパッケージから読む。

- 場所: `$PUB_CACHE/hosted/localhost%588471/<name>-<to>/`（`PUB_CACHE` がなければ `~/.pub-cache`）
- ソースへのリンク: その `pubspec.yaml` の `repository`、なければ `homepage`
- 更新履歴: その `CHANGELOG.md`

この方法では、更新履歴のために別途ダウンロードする必要がない（キャッシュに展開されることは確認済み）。読めなければ、`<details>` の代わりに `[Changelog](https://pub.dev/packages/<name>/changelog)` の 1 行だけを載せる。

更新履歴の抜き出し:

- 次の正規表現に合う行を、バージョンの見出しとみなす
  `^#{1,4}\s*\[?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)\]?`
  （`## 1.6.0`、`## [1.6.0] - 2025-11-10`、`# v1.6.0` などに合う）
- 見出しから次のバージョンの見出しの直前までを、その版の節とする
- `from < v ≤ to` の節を、ファイル内の順に連結する。1 つもなければ、抜き出せなかった扱いにする
- 長さの上限: 更新履歴全体で 50,000 文字とし、パッケージ数で等分する。超えた節は行の境界で切り、`…` の行と `[Full changelog](https://pub.dev/packages/<name>/changelog)` の行を付ける
- 組み立てた本文が 65,000 文字を超えたら、更新履歴をすべて省き、各パッケージを読めなかったときと同じ `[Changelog](…)` の 1 行にする

### 12.4 メタデータ

```html
<!-- pubreform:meta {"v":1,"kind":"single","packages":{"http":["1.5.0","1.6.0"]},"baseHash":"…","configHash":"…","commit":"…"} -->
```

```ts
interface Meta {
  v: 1
  kind: UnitKind
  packages: Record<string, [from: string, to: string]>
  baseHash: string
  configHash: string
  commit: string
  previous?: string   // 再生成の直前のブランチの head（§14.4）
  closed?: true        // pubreform が閉じた PR（§14.3）
}
```

- 読み取りは、本文から `<!-- pubreform:meta (.+?) -->` を探し、最後に現れたものを JSON として解釈する（更新履歴の中に似た文字列があっても、末尾のメタデータを優先するため）。見つからない、解釈できない、`v` が違う場合は「メタデータなし」とする
- パッケージ名とバージョンには `-->` が現れないので、エスケープは不要

### 12.5 マーカー

| マーカー | 用途 |
|---|---|
| `- [ ] Rebase this PR <!-- pubreform:rebase -->` | 再生成のチェックボックス。`/^- \[[xX]\] .*<!-- pubreform:rebase -->/m` に合えばチェック済み |
| `<!-- pubreform:error <hash> -->` | エラーコメント。`hash` はログの SHA-256 の先頭 12 文字 |
| `<!-- pubreform:manual <headSha> -->` | 人手のコミットの通知。同じ head への通知は 1 回だけにする |

### 12.6 コメントの文面

内容が変わったとき:

```markdown
The update in this PR has changed.

| Package | Before | After |
|---|---|---|
| http | 1.5.0 → 1.6.0 | 1.5.0 → 1.6.1 |
| lints | – | 6.0.0 → 6.1.0 |
| meta | 1.16.0 → 1.17.0 | – |
```

クローズするとき:

- 他の PR に統合された: `Closing: superseded by #<n>.`
- それ以外: `Closing: this update is no longer needed.`

人手のコミットを検出したとき:

```markdown
This PR has commits that pubreform did not create, so pubreform will not update it automatically. Check "Rebase this PR" to discard those commits and regenerate it.
<!-- pubreform:manual <headSha> -->
```

エラー（ログに ``` が含まれても壊れないよう、コードブロックの区切りは、ログ中のバッククォートの最長の連続より 1 本長くする）:

````markdown
pubreform failed to update this PR.

<details>
<summary>Log</summary>

```
<ログ>
```

</details>
<!-- pubreform:error <hash> -->
````

## 13. GitHub の操作（github.ts）

`@actions/github` の `getOctokit(token)` を使う。リポジトリは `GITHUB_REPOSITORY` から得る（イベントのペイロードは使わない）。

| 操作 | API |
|---|---|
| ベースの取得 | `GET /repos/{owner}/{repo}`（`default_branch`） |
| open の PR | `GET /repos/{owner}/{repo}/pulls?state=open&base=<base>&per_page=100`（全ページ）。`head.ref` が `pubreform/` で始まり、`head.repo.full_name` が同じリポジトリのもの |
| mergeable | `GET /repos/{owner}/{repo}/pulls/{n}`（`mergeable`、`mergeable_state`）。対象の PR ごとに 1 回 |
| closed の PR | `GET /repos/{owner}/{repo}/pulls?state=closed&base=<base>&sort=updated&direction=desc&per_page=100`（1 ページだけ）。`merged_at` が null のもの |
| コミットの作成 | `POST /git/trees`（`base_tree` = ベースの tree、`pubspec.yaml` と `pubspec.lock` を `content` で直接渡す）→ `POST /git/commits`（`parents` = [baseSha]。author / committer は指定しない） |
| ブランチの作成 | `POST /git/refs`。既にあれば（422）、そのブランチを使う open の PR がないことを確かめてから強制更新する |
| ブランチの更新 | `GET /git/ref/heads/<branch>` で head が想定どおりかを確かめ、`PATCH /git/refs/heads/<branch>`（`force: true`） |
| ラベルの用意 | `GET /repos/{owner}/{repo}/labels`（全ページ）で既存のラベルを調べ、ないものを `POST /repos/{owner}/{repo}/labels`（`name`、`color: ededed`）で作る。実行ごとに 1 回、ラベルを付ける操作がある場合だけ行う。存在しないラベルは自動では作られないため |
| PR の作成 | `POST /pulls` → `POST /issues/{n}/labels`（設定のラベル。空なら呼ばない） |
| PR の更新 | `PATCH /pulls/{n}`（`title`、`body`）→ `POST /issues/{n}/labels` |
| コメント | `GET /issues/{n}/comments`（必要なときだけ、全ページ）、`POST /issues/{n}/comments` |
| クローズ | `POST /issues/{n}/comments` → `PATCH /pulls/{n}`（`state: closed` と、メタデータに `closed: true` を入れた `body` を 1 回で送る）→ `DELETE /git/refs/heads/<branch>` |

- tree の `content` を使うと blob を別に作らなくてよい
- ラベルの作成に失敗したら、エラーとして記録して（最後に失敗終了する）、そのラベルを付けずに続ける。ラベルの作成も Pull requests の権限で行える
- 既存のラベルとは大文字小文字を区別せずに比べる（GitHub のラベル名は大文字小文字を区別しないため）
- 再試行はしない。どの操作も次の実行でやり直されるため（状態を持たない設計なので、途中で失敗しても次の実行で正しい状態に戻る）
- bot のコメントは、マーカーを含み、`user.type` が `Bot` のものとして見分ける

## 14. 調整（reconciler.ts）

### 14.1 入力と出力

```ts
interface PrState {
  number: number
  branch: string
  headSha: string
  title: string
  body: string
  meta?: Meta
  mergeable?: boolean | null
  mergeableState?: string
}
type Op =
  | { op: 'create'; result: UnitResult; branch: string }
  | { op: 'regenerate'; pr: PrState; result: UnitResult; contentChanged: boolean }
  | { op: 'notifyManual'; pr: PrState }
  | { op: 'commentError'; pr: PrState; log: string }
  | { op: 'close'; pr: PrState; supersededBy?: string } // supersededBy: 引き継ぐ単位のブランチ
  | { op: 'none'; pr: PrState }
  | { op: 'skip'; result: UnitResult; closedPr: PrState } // 同じ内容のクローズ済み PR があるので作らない（サマリー用）
  | { op: 'error'; unit: Unit; log: string }              // PR がない単位の適用エラー（ログに出し、失敗の件数に数える）

decide(results, unitErrors, plan, openPrs, closedPrs, ctx): Op[]   // 純粋関数
```

### 14.2 対応付け

1. single と minor は、ブランチ名で既存の PR と対応させる
2. group は、パッケージの集合の重なり（メタデータの `packages` のキーと `members` の積集合の大きさ）が 1 以上の組を、重なりの大きい順、同じなら PR 番号の小さい順に貪欲に 1 対 1 で決める
3. メタデータのない PR は、ブランチ名で対応させる（group の場合は、ブランチ名の先頭パッケージが members に含まれるものと対応させる）

### 14.3 操作の決め方

| 状況 | 操作 |
|---|---|
| 単位があり、PR がない | 同じ種類で、内容が同じ未マージの closed PR があり、そのメタデータに `closed` がなければ（= 利用者が閉じた PR なら）何もしない。なければ `create`。内容が同じとは、パッケージ名の集合が同じで、それぞれの `to` も同じこと（片方にしかないパッケージがあれば違う）。pubreform が閉じた PR（`ignore` への追加や統合で閉じたもの）は対象にしない。対象にすると、`ignore` に一時的に入れて外しただけで、同じ PR が二度と作られなくなるため |
| 単位の適用に失敗し、PR がある | `commentError` |
| 単位の適用に失敗し、PR がない | なし（ログだけ） |
| PR があり、単位がない | PR のパッケージのどれかが `uncertain`、または適用に失敗した単位に含まれていれば `none`（計画や適用に失敗しただけかもしれないので閉じない）。そうでなければ `close`。PR のパッケージが別の単位に含まれていれば `supersededBy` を付ける |
| 両方ある | 下表 |

両方あるとき（上から順に、最初に当てはまるもの）:

| 条件 | 操作 |
|---|---|
| 人手のコミットがあり（`headSha` が `meta.commit` とも `meta.previous` とも違う）、チェックボックスが未チェック | `notifyManual` |
| `headSha == meta.previous`（前回の再生成がブランチの更新の前で止まった） | `regenerate` |
| チェックボックスがチェック済み | `regenerate` |
| `mergeable == false` かつ `mergeableState == 'dirty'` | `regenerate` |
| `packages` の `to` の集合がメタデータと違う | `regenerate` |
| `baseHash` または `configHash` がメタデータと違う | `regenerate` |
| メタデータがない | `regenerate`（人手のコミットは確認できないので確認しない） |
| どれでもない | `none` |

`mergeable == null`（GitHub が未計算）のときは、コンフリクトの条件だけを判定しない。

`contentChanged` は、どの条件で再生成する場合も、メタデータがあれば `packages`（名前と `to`）の比較で決める。チェックボックスやコンフリクトが理由の再生成でも、内容が変わっていればコメントする（基本 §7.2）。メタデータがなければ `false` にする。

### 14.4 実行

- `decide` はコメントを読まない。コメントの重複の確認は実行時に行う
  - `notifyManual`: PR のコメントを取得し、同じ head の `pubreform:manual` マーカーがあれば何もしない
  - `commentError`: PR のコメントを取得し、最新の bot のエラーコメントと同じハッシュなら何もしない（§15）
- `create`: コミットを作る → ブランチを作る → PR を作る → ラベルを付ける。メタデータの `commit` には作ったコミットを入れる
- `regenerate`: コミットを作る → タイトルと本文を更新する（メタデータの `commit` は新しいコミット、`previous` は今の head。チェックボックスは未チェックに戻る）→ ブランチを強制更新する → ラベルを付ける → `contentChanged` ならコメントする
  - 本文を先に更新するのは、途中で失敗しても次の実行が状態を判別できるようにするためである。本文の更新で失敗すれば何も変わらない。ブランチの更新で失敗すれば head は `previous` のままなので、次の実行で再生成する。逆の順序だと、本文の更新だけが失敗したときに head がメタデータの `commit` と違ってしまい、人手のコミットと誤って判定する
- 操作の順序: `create` / `regenerate` などを先に行い、`close` を最後に行う。統合先の PR の番号を `Closing: superseded by #<n>.` に書くためである。統合先の操作が失敗して番号がなければ、`Closing: this update is no longer needed.` にする。新しく作るブランチが閉じる PR のブランチと重なることは、対応付け（§14.2）で通常は起きない。起きた場合は、ブランチの作成（§13）がその単位のエラーになり、次の実行で直る
- 1 つの操作が途中で失敗したら、そこで止めて単位のエラーとする（§15）

## 15. エラー処理

- 単位のエラーは、`{ unit または pr, log }` として集める。PR があれば、その PR へのエラーコメントを投稿する（`commentError`）。PR がなければ、ジョブのログに出すだけにする
- エラーコメントは、その PR の bot のエラーコメントのうち最新のもののハッシュと同じなら投稿しない
- ログの整形:
  1. pub の標準エラー出力と例外のメッセージを連結する
  2. 末尾の 200 行に切り詰め、さらに 60,000 文字に切り詰める
  3. `token` の値と、`://<user>:<password>@` の形の認証情報を `***` に置き換える
- 最後に、全体エラーか単位のエラーが 1 件でもあれば `core.setFailed` で失敗終了する

## 16. ジョブサマリー

`core.summary` に次を書く。全体エラーのときはサマリーを書かず、`core.setFailed` だけを行う。

- slot と cutoff（タイムゾーン付き）
- 更新単位ごとの行: 種類、パッケージ、操作（作成 / 再生成 / 変更なし / クローズ / エラー）、PR のリンク
- 解決不能だった更新: パッケージ、解決できるバージョン、最新の対象バージョン
- 計画に失敗したパッケージ（uncertain）
- エラーの一覧

## 17. テスト

| 種類 | 対象 | 方法 |
|---|---|---|
| 単体 | version、clock、config、changelog の抜き出し、render（メタデータの往復、本文の長さの上限）、reconciler の `decide`、planner（`closure` と併合） | `bun test`。planner は偽の `resolve` を渡す。ネットワークは使わない |
| 結合 | 中継サーバーと pub | プロトタイプの検証（基本 §4.2）を `bun test` に移す。pub.dev へのネットワークと Dart / fvm が必要なので、環境変数 `PUBREFORM_IT=1` のときだけ動かす |
| 設定のスキーマ | `pubreform.schema.json` と config.ts | 同じ設定例を両方で判定し、結果が一致することを確かめる（§4.2） |
| ローカル E2E | Action 全体（ビルドした `dist/main.js`） | フィクスチャー用サーバー、偽の GitHub API、bare リポジトリで、場面ごとに動かす（§17.1） |
| GitHub E2E | 本物の GitHub でしか分からない挙動 | テスト用リポジトリで、本物の GitHub に対して動かす（§17.2） |

pubreform 自身の CI では、push と pull request のたびに `tsc --noEmit`、単体テスト、ローカル E2E を動かす。

### 17.1 ローカル E2E

ビルドした `dist/main.js` を、外部に一切接続しない環境で実行し、場面ごとの結果を確かめる。pub の解決は本物の `dart pub` が行う。環境変数 `PUBREFORM_E2E=1` のときだけ動かす（Dart が必要なため）。

構成:

| 置き換えるもの | 置き換え先 |
|---|---|
| pub.dev | フィクスチャー用サーバー。`PUBREFORM_UPSTREAM`（§9）で中継サーバーの取得元にする。パッケージ一覧（`/api/packages/<name>`）とアーカイブ（tar.gz）を配る |
| GitHub API | 偽の API。`GITHUB_API_URL` で向ける。§13 の API だけを実装し、コミットと ref は bare リポジトリに git のコマンドで書き込む |
| GitHub のリポジトリ | ローカルの bare リポジトリ。`GITHUB_SERVER_URL=file://…` で clone させる |

フィクスチャー:

- パッケージは pub.dev と名前が重ならないように `fx_` で始める。テスト用プロジェクトの依存はフィクスチャーだけにした Dart のプロジェクトとし、pub.dev には接続しない
- 公開日は、テストを始めた時刻からの相対で決める（例: 30 日前、1 日前）。Action の現在時刻は差し替えない。設定の cron は毎分（`* * * * *`）にして、slot が現在時刻とほぼ同じになるようにする
- アーカイブは同じ定義から毎回同じバイト列になるように作る（tar の更新時刻を固定し、gzip のヘッダーに時刻を入れない）。lockfile の `sha256` が変わらないようにするため。アーカイブには `pubspec.yaml` と、版ごとの節を持つ `CHANGELOG.md` を入れる
- 次の場面が起こるようにパッケージを組む（各パッケージはロック済みの 1.0.0 から始める）

| パッケージ | 用意する版 | 期待する結果 |
|---|---|---|
| `fx_patch`、`fx_minor` | 1.0.1、1.2.0（30 日前） | マイナー・パッチグループ（N = 2、表あり） |
| `fx_major` | 2.0.0（30 日前） | 単独 PR |
| `fx_needs_b`、`fx_b` | `fx_needs_b` 1.1.0 は `fx_b ^2.0.0` を要求。`fx_b` 2.0.0（どちらも 30 日前） | 同時更新グループ {fx_b, fx_needs_b} |
| `fx_sdk` | 2.0.0 は Dart SDK `^99.0.0` を要求 | 解決不能（PR なし、サマリーに記録） |
| `fx_fresh` | 1.1.0（1 日前。`min_release_age_days: 3`） | 待機中なので PR なし |
| `fx_ignored` | 1.1.0（30 日前）。設定の `ignore` に名前を入れる | PR なし |

場面（前の場面の状態を引き継ぎ、順に実行する）:

1. 作成: 上の表の PR がそれぞれ作られる。タイトル、本文（表、更新履歴、メタデータ、チェックボックス）、コミットメッセージ、ラベル（ないラベルは作られる）、ジョブサマリー（解決不能）を確かめる
2. 何も変わらない: もう一度実行し、どの PR の head も変わらず、コメントも増えない
3. チェックボックス: 単独 PR のチェックボックスにチェックを入れて実行すると、再生成され、チェックが外れる。内容は同じなのでコメントは出ない
4. 新しいリリース: `fx_major` に 2.1.0（30 日前）を追加して実行すると、単独 PR が再生成され、内容の変更のコメントが出る
5. ベースの更新: マイナー・パッチグループの PR をマージしたことにする（PR のブランチの内容をベースに反映し、PR を閉じる）。実行すると、ほかの PR は再生成されるが、内容の変更のコメントは出ない
6. 人手のコミット: 同時更新グループの PR のブランチにコミットを追加して実行すると、通知のコメントが 1 回だけ出て、再生成されない。もう一度実行しても、通知は増えない
7. 設定の変更: `ignore` に `fx_major` を足して実行すると、単独 PR が「no longer needed」でクローズされ、ブランチが消える。閉じた PR のメタデータに `closed: true` が入る
8. 設定を戻す: `ignore` から `fx_major` を外して実行すると、単独 PR が作り直される（pubreform が閉じた PR は、作り直しを止めない）
9. 利用者がクローズ: 8 の単独 PR を、利用者の操作として（メタデータを変えずに）マージせずに閉じて実行すると、同じ内容の PR は作られない
10. 途中の失敗: 偽の API でブランチの更新を 1 回だけ失敗させると、その PR にエラーコメントが出て、ジョブは失敗する。次の実行で再生成され、成功する

### 17.2 GitHub E2E

本物の GitHub でしか分からない次の 4 点を、テスト用リポジトリ [`chika3742/pubreform-e2e`](https://github.com/chika3742/pubreform-e2e)（非公開）で確かめる。pub.dev の代わりに、17.1 と同じフィクスチャー用サーバーを使う。

- API で作ったコミットが Verified になる
- `mergeable_state` が取得できる（GitHub の計算を待つため、null でなくなるまで数回取り直す）
- App のトークンで、ないラベルを作れる
- `/` を含むブランチ名で、ref の取得と更新ができる

2026-10-18 に実行し、4 点とも確認済み（[run #2](https://github.com/chika3742/pubreform-e2e/actions/runs/39103097609)、1 つのスクリプトにした後の [run #3](https://github.com/chika3742/pubreform-e2e/actions/runs/39104022006)）。`mergeable_state` は `clean` と `unstable` が返った。ref を更新した直後は、`GET /git/ref` はすでに新しいコミットを返すが、PR の `head.sha` はまだ前の head を返す（GitHub が裏で反映する。最初の実行では、更新の 4 秒後に読んでも前の head が返った）。そのため 2 回目の確認では、`head.sha` が変わるまで数回取り直す。

前提（利用者が設定する）:

- GitHub App を pubreform-e2e と pubreform の両方にインストールする。pubreform-e2e には本番と同じ権限（Contents と Pull requests の Read and write）が要る。pubreform は非公開なので、E2E のワークフローがコードを取得するために Contents の読み取りが要る
- pubreform-e2e に、変数 `PUBREFORM_CLIENT_ID` とシークレット `PUBREFORM_PRIVATE_KEY` を設定する

ワークフロー（pubreform-e2e の `.github/workflows/e2e.yml`。`workflow_dispatch` で、入力 `ref` は pubreform の ref）:

1. `actions/create-github-app-token@v3` で、`repositories: pubreform-e2e,pubreform` としてトークンを発行する
2. pubreform-e2e を checkout し、pubreform の `ref` を `pubreform-src/` に checkout する（pubreform 側は push しないので `persist-credentials: false`）
3. setup-bun と、`actions/setup-node`（Node 24。`action.yml` の `runs.using` と同じ）を入れ、`pubreform-src/` で `bun install --frozen-lockfile` と `bun run build` を行う。`dart-lang/setup-dart`（Dart の stable）を入れる。pub の挙動の変化に早く気づけるよう、Dart は固定しない（ローカル E2E の CI も同じ）。setup-fvm は使わない（起動時の `pub get` がフィクスチャーを pub.dev から取ろうとして失敗するため）
4. pubreform-e2e の checkout で `bun pubreform-src/test/e2e/github-e2e.ts` を実行する。このスクリプトが次の手順を 1 つのプロセスで行う

`github-e2e.ts` の手順:

1. フィクスチャー用サーバーを同じプロセスで起動する
2. テスト用プロジェクト（`pubspec.yaml`、`pubspec.lock`、`.github/pubreform.yaml`）を `make-project.ts` の `makeProject` で生成し、内容が変わっていれば main に push する（コミットの作成者は `pubreform-e2e`）。main のこれらのファイルはこのワークフローが管理する（`.github/workflows/` には触れない）。main にブランチ保護を設定すると、この push が失敗する
3. 前回の実行の後片付け: `pubreform/` で始まるブランチの open の PR を閉じ、`pubreform/` で始まる ref をすべて（open の PR がないものも）消し、設定のラベルを消す。PR は、pubreform が閉じるときと同じく、本文のメタデータに `closed: true` を入れて閉じる（入れないと利用者が閉じた PR として扱われ、フィクスチャーが毎回同じなので、次の実行で同じ内容の PR が作られなくなる）。`closed: true` を入れる処理には、本体と同じ `markClosed`（src/render.ts）を使う
4. 1 回目: ビルドした `dist/main.js` を `node` で実行し、上の 4 点のうち、Verified、`mergeable_state`、ラベルを確かめる。入力はローカル E2E と同じく環境変数（`INPUT_TOKEN`、`INPUT_CONFIG`）で渡し、`PUBREFORM_UPSTREAM` を付ける。ランナーの環境変数（`GITHUB_REPOSITORY`、`RUNNER_TEMP` など）はそのまま渡す
5. 2 回目: 単独 PR のチェックボックスにチェックを入れてから実行し、その PR が作り直されたこと（`/` を含むブランチ名での ref の取得と更新）を確かめる。実行の直後に待たずに ref を読み、PR のメタデータの `commit` と一致することを確かめる（ref が更新の直後から新しいコミットを返すかを見るため）。PR の `head.sha` は、変わるまで数回取り直す

`uses:` でアクションを呼ぶと、その前後の操作や確認がワークフローのステップに分かれるため、`dist/main.js` を直接実行して 1 つのスクリプトにまとめる。このため `action.yml`（`main` のパスと入力の既定値）は確かめない。`action.yml` は短く、誤っていれば実際に使った最初の実行で失敗して分かるためである。失敗したときは、失敗した手順の名前をエラーの注釈（`::error::`）に出す。

## 18. ビルドとリリース

- `package.json` のスクリプト
  - `build`: `bun build --target=node --outdir=dist --minify ./src/main.ts`
  - `test`: `bun test`
  - `typecheck`: `tsc --noEmit`
- リリースは setup-fvm と同じにする。`v*` のタグを push すると、ワークフローがビルドして `dist/` をコミットし、タグとメジャータグ（`v1` など）を付け直す

## 19. 実装時に確認すること

| 項目 | 内容 |
|---|---|
| GitHub E2E の環境 | テスト用リポジトリは `chika3742/pubreform-e2e`。App のインストールと、変数・シークレットの設定は利用者が行う（§17.2） |

## 20. 基本設計からの変更点

この詳細設計で、基本設計の次の点を具体化・変更した。基本設計にも反映する。

| 項目 | 基本設計 | 詳細設計 |
|---|---|---|
| ベースの取得 | fetch して worktree を作る | トークンで浅く clone する（§8.1）。checkout の状態に依存しない |
| 解決の作業場所 | worktree の複製 | 1 つのディレクトリで、pub を実行する前に 2 ファイルを書き戻す（§8.1） |
| `ignore` | すべての解決で除外する | 中継サーバーで該当バージョンを隠す（§9） |
| 更新履歴とソースリンク | アーカイブから抜き出す | pub がキャッシュに展開したパッケージから読む（§12.3） |
| 計画に失敗したパッケージ | 記述なし | そのパッケージを含む PR は閉じない（§14.3） |
