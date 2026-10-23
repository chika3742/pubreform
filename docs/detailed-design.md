# pubreform 詳細設計

> ステータス: 実装済み（2026-10-18。v1 は未リリース）。ローカル E2E と GitHub E2E で確かめた（§17）。更新後のコマンド（§19）は 2026-10-19 に Docker のコンテナで実行する方式で実装し、ローカル E2E と GitHub E2E（[run #6](https://github.com/chika3742/pubreform-e2e/actions/runs/39206665275)）で確かめた。セキュリティアドバイザリによる更新（基本 §14.2、§20）は 2026-10-20 に実装し、単体テストとローカル E2E（§17.1 の場面 12、13）で確かめた。固定したバージョンの分類（基本 §5.1、§10.1、§11）は 2026-10-23 に変更し、単体テストとローカル E2E（§17.1 の場面 1）で確かめた。挙動を変えるときは、先にこの設計書を直す。[基本設計](design.md)を前提に、実装に必要な決定を書く。節番号の「基本 §n」は基本設計の節を指す。

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
  advisories.ts  セキュリティアドバイザリの読み取り、要修正のパッケージと修正版の判定（§20）
  planner.ts     更新単位の計画（§10）
  applier.ts     更新単位の適用（§11）
  render.ts      タイトル、本文、コミットメッセージ、コメント、メタデータ（§12）
  github.ts      GitHub API の操作（§13）
  reconciler.ts  計画と既存 PR の突き合わせと操作の決定（§14）
  generate.ts    更新後のコマンドの実行と、変わったファイルの取り出し（§19）
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
branding:
  icon: package
  color: blue
```

`branding` は Marketplace のバッジ。アイコンは依存のパッケージを表す Feather の `package`、色は setup-fvm（`blue`、`arrow-down-circle`）とそろえて `blue` にする。

## 3. 全体の流れ（main.ts）

```
1. 入力を読む。core.setSecret(token)
2. GET /repos/{owner}/{repo} でデフォルトブランチ（= ベース）を得る
3. ベースを $RUNNER_TEMP/pubreform/base に浅く clone する（§8.1）。baseSha を得る
4. 設定を clone から読み、検証する（§4）。configHash を計算する
5. pubspec.yaml / pubspec.lock / .fvmrc を読む（§7）。baseHash を計算する
   ルートの pubspec に workspace: があれば全体エラー
   post_update があれば、実行できる環境か（Linux で docker が使えるか）を確かめる（§19.1）
6. slot と cutoff を求める（§5）
7. 中継サーバーを起動する（§9）
7a. 要修正のパッケージを求める（§20）。fixes: Map<name, Fix>
    失敗したら全体エラー（PR はまだ変更していない）
7b. proxy.setFixes(fixes)（§9）
8. 計画する（§10）→ 更新単位と、計画に失敗したパッケージ（uncertain）
9. 各更新単位を適用する（§11）→ 結果、または単位ごとのエラー
10. 既存 PR を集める（open と、直近 100 件の closed）（§13）
11. 操作を決める（§14）。純粋関数で、テストできる形にする
    post_update があれば、イメージを作り、SDK を探す（§19.1）。どちらかに失敗したら全体エラー（PR はまだ変更していない）
12. 操作を 1 つずつ実行する。create と regenerate では、コミットの前に post_update のコマンドを実行する（§19）。失敗はその操作のエラーとして記録し、次へ進む（ジョブのログでは `Pull requests` のグループにまとめる。post_update があるときはまとめない）
13. ジョブサマリーを書く（§16）。エラーが 1 件でもあれば core.setFailed
（finally）中継サーバーを止める。post_update のイメージを消す
```

- 7a の後でなければ計画を始めない。計画のどの解決にも、同じ見せ方を使うため
- 手順 8 の `plan()` と手順 9 の `applyUnit()` に `fixes` を渡す（§10、§11）

エラーは 2 種類に分ける。

| 種類 | 例 | 扱い |
|---|---|---|
| 全体エラー | 設定の誤り、clone の失敗、セキュリティアドバイザリの取得の失敗（§20）、U / R の解決の失敗、workspace、post_update を実行できない環境、post_update のイメージの作成や SDK の特定の失敗 | PR を一切変更せずに失敗終了する。手順 5 までの失敗なら手順 6 以降に、post_update のイメージと SDK の失敗なら手順 12 に進まない |
| 単位のエラー | 1 つの更新単位の S の計算・適用・post_update のコマンド・コミット・PR 操作の失敗 | その単位だけを止め、他は続ける（§15） |

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
| `post_update` | `{ run, network?, env? }[]` | `[]` | 上から順に実行するコマンド（§19） |
| `post_update[].run` | string | （必須） | 空でないこと。`sh -c` で実行する |
| `post_update[].network` | boolean | `false` | ネットワークを使えるようにする |
| `post_update[].env` | string[] | `[]` | 追加で渡す環境変数の名前。`^[A-Za-z_][A-Za-z0-9_]*$` に合い、重複せず、`INPUT_` と `ACTIONS_` で始まらないこと（§19.2） |

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
- 取得した一覧は、実行中はメモリに保持して再利用する。1 回の実行の中で、どの解決にも同じ一覧を見せるためである。取得に失敗したとき（接続できない、打ち切った、成功以外の応答）は保持せず、次の要求で取り直す
- pub.dev への取得は 30 秒で打ち切る。失敗したら 502 を返す（pub が失敗し、その解決のエラーになる）
- テストのために、環境変数 `PUBREFORM_UPSTREAM` があれば、pub.dev の代わりにその URL から取得する（E2E でフィクスチャー用サーバーに向けるため。利用者向けの設定ではないので、README には書かない）
- 計画のために `visibleVersions(name)`（絞り込み後のバージョン一覧）を公開する
- ジョブサマリーのために `waitingVersion(name)` を公開する。cutoff より後に公開されたことだけが理由で隠した安定版のうち最新のもの（バージョンと公開日時）を返す。見せている安定版のどれよりも新しいときだけ返し、`ignore` に該当するものは含めない。一覧を取得できなければ返さない。要修正のパッケージの `affected` のバージョン（下記）も候補から除く（隠す理由が cutoff ではないため）。見せた修正版は隠していないので、待機中の表には出ない
- セキュリティアドバイザリ（§20）のために、次を公開する
  - `upstreamListing(name)`: 保持している pub.dev の一覧をそのまま返す。取得に失敗したら例外を投げる。§20 と計画の解決が、同じ一覧を見るため
  - `setFixes(fixes)`: 要修正のパッケージを渡す。計画の前に 1 回だけ呼ぶ

隠す判定は、次の表の上から順に、最初に当てはまるもので決める。

| 条件 | 結果 |
|---|---|
| ロック済みのバージョン | 見せる |
| 要修正のパッケージで、`affected` に入っている | 隠す |
| 要修正のパッケージで、`fix.version` と同じ | 見せる（`fix` は `ignore` に該当しないバージョンから選んでいる。§20.4） |
| cutoff より後の公開、または `ignore` に該当 | 隠す |
| それ以外 | 見せる |

`ignore` は、制約を書き換えるのではなく、ここで隠すことで実現する。U / R / S / 適用のすべての解決に同じように効き、制約の補集合を計算する必要がない。名前だけを指定したパッケージは、ロック済みのバージョンしか見えなくなるので、現在のバージョンに留まる。

## 10. 計画（planner.ts）

pub の解決は、引数で受け取る関数 `resolve` を通して行う。テストでは偽の `resolve` を渡す（§17）。

```ts
type Resolve = (args: string[], pubspec: string) => Promise<Map<string, string>> // name -> version（lockfile）
```

### 10.1 手順

```
deps = 直接依存（§7.1）
範囲(d) = 元の制約(d) がバージョンそのもの（固定）なら '^' + c(d)、そうでなければ元の制約(d)   // 分類用の制約（基本 §5.1）

U = resolve(['upgrade'], withConstraints(ベース, { d: '^' + c(d) for d in deps : d は固定 }))
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
    K = { e in deps − S : !allows(範囲(e), L(e)) }
    if K が空: return S
    S = S ∪ K
```

### 10.2 出力

```ts
type UnitKind = 'single' | 'minor' | 'group'
interface Unit {
  kind: UnitKind
  members: string[]               // minor: U で変わる直接依存、single / group: S
  targets: Record<string, string> // single / group: R のバージョン、minor: members のうち固定したものの U のバージョン
}
interface Plan {
  units: Unit[]
  uncertain: Set<string>                                         // 計画に失敗したパッケージ
  unresolvable: { name: string; section: Section; current: string; resolvable: string; latest: string }[]
}
```

- `minor` が空で、`fixedTransitive` も空なら、minor の単位は作らない（推移的依存だけの変化は無視する。基本 §5.3）。`fixedTransitive` は、U で要修正の推移的依存が修正されるもの（下記）
- `PlanInput` に `fixes: Map<string, Fix>`（§20）を渡す
- `Unit.members` は今までどおり、U で変わる直接依存だけにする（`fixedTransitive` だけのときは空）

```
fixedTransitive = { t in fixes : t は直接依存でない, U(t) != c(t), U(t) が fixes[t].affected に入っていない }
```
- `unresolvable`: 直接依存ごとに、`visibleVersions` の安定版の最大値が `R(d)` より新しければ記録する（ジョブサマリー用）

## 11. 適用（applier.ts）

| 単位 | 実行するコマンド |
|---|---|
| minor | `pub upgrade`（`versioning: increase` なら `--tighten` も付ける）。`targets` が空でなければ、その前に `pub add <spec>…` を実行する。spec は `name:U(name)`（固定のまま。dev_dependencies なら `dev:` を前に付ける） |
| single / group | `pub add <spec>…`。spec は `name:^R(name)`。元の制約がバージョンそのもの（`1.2.3` のように 1 つに固定したもの）なら、固定のまま `name:R(name)` にする（`dart pub add path:1.9.0` で `path: 1.9.0` と書かれ、コメントも残ることを Dart 3.13.5 で確認済み）。dev_dependencies なら `dev:` を前に付ける。複数の spec を 1 回で渡す（Flutter 3.47.7 で、dev_dependencies のままで制約が書き換わり、pubspec のコメントも残ることを確認済み） |

minor の 2 つのコマンドは、前のコマンドの結果の 2 ファイルの上で次のコマンドを実行する。`pub add` で固定した依存を U のバージョンにしてから、`pub upgrade` で残りを上げる。逆の順にすると、`pub upgrade` が古い固定を前提に選んだバージョンを、`pub add` が動かし直すことになる。Dart 3.13.7 で、固定した `path: 1.9.0` と `dev_dependencies` の `args: 2.6.0` に対し、`^` に緩めた `pub upgrade`（U）と、`pub add path:1.9.1 dev:args:2.7.0` → `pub upgrade --tighten` の結果の lockfile が同じになり、固定の形とコメントが残ることを確認済み。build メタデータ付きの `^1.9.0+1` も制約として受け付け、1.9.1 に解決することを確認済み（`flutter_hooks: 0.21.3+1` のような固定があるため）。

```ts
interface Change { from: string; to: string; section: Section }
interface UnitResult {
  unit: Unit
  files: { pubspec: string; lock: string }
  changes: Record<string, Change>   // バージョンが変わった直接依存だけ
  transitiveFixes: Record<string, { from: string; to: string }>  // 直した推移的依存
  advisories: FixedAdvisory[]       // この結果で直るアドバイザリ
}
interface FixedAdvisory {
  package: string
  advisory: Advisory  // §20
  from: string
  to: string
  early?: Date   // to が待機期間の中で、修正版として見せたものなら、その公開日時
}
```

- `applyUnit()` には `fixes`（§20）と `cutoff` も渡す
- `changes` は、ベースと結果の lockfile を比べて求める。推移的依存は含めない
- 直したパッケージ: 結果の lockfile で、`fixes` のパッケージ p のバージョンが `c(p)` と違い、`affected` に入っていないもの
  - 直接依存なら `changes` に入っている。推移的依存なら `transitiveFixes` に入れる
  - 直したパッケージの `fixes[p].advisories` をすべて `advisories` に入れる（パッケージ名、`id` の順）
  - `early`: `to` が `fixes[p].fix.version` と同じで、その `published` が cutoff より後なら、`published`
- 要修正の推移的依存が、単独 PR や同時更新グループの適用でも直ることがある（`pub add` が必要に応じて動かした場合）。そのときも同じように数える。同じパッケージを複数の PR が直すことがある
- `changes` と `transitiveFixes` がどちらも空なら、その単位は捨てる（例: 他の単位とまったく同じ変化になった）
- `--tighten` は、バージョンが変わっていない直接依存の下限も上げることがある。`pubspec.yaml` の差分には出るが、`changes` には含めない

## 12. 文面とメタデータ（render.ts）

### 12.1 ブランチ名とタイトル

| 種類 | ブランチ | タイトル |
|---|---|---|
| single | `pubreform/single/<name>` | `Update <name> from <from> to <to>` |
| minor | `pubreform/minor-and-patch` | `Update minor and patch (<N> packages)` |
| group | `pubreform/group/<作成時の members を並べ替えた先頭>` | `Update <name> to <to>, <name 2> to <to>, ...`（members を名前の順に並べる） |

- N は `changes` と `transitiveFixes` の数の和
- N = 1 のときは、minor / group でもタイトルを single と同じ `Update <name> from <from> to <to>` にする（ユーザーの決定）。その 1 つが推移的依存でも同じ。ブランチ名と種類（`kind`）は変えない
- `advisories` が空でなければ、タイトルの前に `[Security] ` を付ける（基本 §14.2）
- single と group の `changes` に、メンバー以外の直接依存（制約の範囲内で動いたもの）が含まれることがある。タイトルはメンバーだけで書き、表にはすべて載せる
- group のタイトルの長さは制限しない。GitHub は 257 文字のタイトルへの変更も拒否しなかった（2026-10-18 に pubreform-e2e の PR で確認。保存時に切り詰められるかは確かめていない）

### 12.2 コミットメッセージ

single と、N = 1 の minor / group はタイトルだけ。それ以外の minor / group は、タイトル、空行、表。1 行目は、`[Security] ` を含めてタイトルと同じ。

```
Update minor and patch (2 packages)

| Package | From | To | Type |
|---|---|---|---|
| http | 1.5.0 | 1.6.0 | direct |
| lints | 6.0.0 | 6.1.0 | dev |
```

表の行はパッケージ名の順。Type は `dependencies` なら `direct`、`dev_dependencies` なら `dev`。`transitiveFixes` の行も入れ、Type は `transitive`（本文の表も同じ）。

### 12.3 本文

基本 §8 のテンプレートに従う。各パッケージの節に使う情報は、適用時に pub がキャッシュに展開したパッケージから読む。各パッケージの節は、`transitiveFixes` のパッケージにも作る。

`advisories` が空でなければ、本文の先頭（`Updates the following packages.` の前）に次を置く。

```markdown
Fixes the following security advisories.

| Package | Advisory | Severity | From | To |
|---|---|---|---|---|
| [archive](https://pub.dev/packages/archive) | [GHSA-9v85-q87q-g4vg](https://github.com/advisories/GHSA-9v85-q87q-g4vg) Path traversal in Archive | high | 3.3.7 | 3.3.8 (released 2026-10-18) |

Versions with a release date are used before `min_release_age_days` has passed, to fix the advisory.

```

- 行は `advisories` の順（パッケージ名、`id` の順）
- Advisory の列: `url` があれば `[<id>](<url>)`、なければ `<id>`。続けて空白と `summary`
- `summary` はアドバイザリのデータベースから来る外部の文字列なので、更新履歴と同じ置き換え（`withoutBacklinks()`。ソースは渡さない）をしたうえで、改行を空白にし、`|` を `\|` にする。200 文字を超えたら切って `…` を付ける
- Severity の列: `severity`。なければ空
- To の列: `early` があれば `<to> (released <YYYY-MM-DD>)`。日付は設定のタイムゾーンで書く（ジョブサマリーと同じ）
- 表の下の 1 文は、`early` のある行が 1 つでもあるときだけ入れる
- 本文の上限（下記）の計算には、アドバイザリの表も含める。表は省かない

- 場所: `$PUB_CACHE/hosted/localhost%588471/<name>-<to>/`（`PUB_CACHE` がなければ `~/.pub-cache`）
- ソースへのリンク: その `pubspec.yaml` の `repository`、なければ `homepage`。`http://` か `https://` で始まり、空白、括弧（`()[]`）、`<>` を含まないものだけを使い、そうでなければソースへのリンクを載せない。値はパッケージの作者が書くもので、`)` や改行で Markdown のリンクの外に文字を出せる（メンションで人に通知を送れる）ため
- 更新履歴: その `CHANGELOG.md`

この方法では、更新履歴のために別途ダウンロードする必要がない（キャッシュに展開されることは確認済み）。読めなければ、`<details>` の代わりに `[Changelog](https://pub.dev/packages/<name>/changelog)` の 1 行だけを載せる。

更新履歴の抜き出し:

- 次の正規表現に合う行を、バージョンの見出しとみなす
  `^#{1,4}\s*\[?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)\]?`
  （`## 1.6.0`、`## [1.6.0] - 2025-11-10`、`# v1.6.0` などに合う）
- 見出しから次のバージョンの見出しの直前までを、その版の節とする
- `from < v ≤ to` の節を、ファイル内の順に連結する。1 つもなければ、抜き出せなかった扱いにする
- 抜き出した更新履歴は、PR の本文に載せるとバックリンクや通知が生まれる書き方を、次のように置き換える。そのまま載せると、リンク先の Issue などに更新のたびに PR からの参照が付き、メンションされた人には通知が届くため（Dependabot と同じ考え方）
  - GitHub の Issue、PR、Discussion への URL（`https://github.com/<owner>/<repo>/(issues|pull|discussions)/<n>`）: ホストを `redirect.github.com` にする
  - `<owner>/<repo>#<n>`: `[<owner>/<repo>#<n>](https://redirect.github.com/<owner>/<repo>/issues/<n>)` にする
  - `#<n>`: 利用者のリポジトリの Issue として解釈されてしまうため、ソースへのリンクが `https://github.com/<owner>/<repo>` で始まるなら `[#<n>](https://redirect.github.com/<owner>/<repo>/issues/<n>)` にする。そうでなければ `#` の後ろにゼロ幅スペース（U+200B）を入れて、リンクにならないようにする
  - `@<name>`: `@` の後ろにゼロ幅スペースを入れて、メンションにならないようにする
  - `<!--`: `&lt;!--` にする。HTML のコメントが閉じていないと、その後ろの本文（チェックボックスを含む）がすべて表示されなくなるため。閉じているコメントも、中身が文字として表示されるだけなので区別しない
  - コード（`` ` `` で囲んだ部分と ```` ``` ```` のブロック）は変えない。GitHub がリンクにもメンションにもしないため。既にあるリンク `[...](...)` は、URL だけを上のように置き換え、文字列は `@<name>` だけを置き換える（リンクの中をリンクにすると Markdown が崩れるため）
- 長さの上限: 更新履歴全体で 50,000 文字とし、パッケージ数で等分する。超えた節は行の境界で切り、`…` の行と `[Full changelog](https://pub.dev/packages/<name>/changelog)` の行を付ける
- 抜き出した更新履歴（切り詰めたものを含む）の最後でフェンス（```` ``` ```` か `~~~`）のコードブロックが閉じていなければ、開いたフェンスと同じ字下げと文字列で閉じる。行の境界で切ると、コードブロックの途中で切れることがある。閉じていないコードブロックは本文の最後まで続き、`</details>` とチェックボックスもコードとして表示されるため。字下げをそろえるのは、リストの項目の中（1〜3 文字の字下げ）のブロックを項目の中で閉じるためで、字下げなしで閉じると、項目を終わらせたうえでトップレベルに新しいブロックを開いてしまう
  - フェンスとみなすのは、CommonMark と同じく、3 文字までの字下げの後に 3 つ以上の `` ` `` か `~` が続く行。`` ` `` のフェンスは、後ろに `` ` `` を含まないものだけ（`` ```foo``` `` で始まる行はインラインコード）
  - 扱わないもの: 4 文字以上字下げしたフェンス（入れ子のリストの中など）と、リストの項目が終わったことで閉じるフェンスのないブロック（例: リストの項目の中で開いたブロックが、閉じるフェンスのないまま、字下げのない次の段落で終わっている場合。開いたままとみなして閉じるフェンスを付ける）。どちらもまれなため
- post_update のコマンドで変わったファイルがあれば、表の下に `` Files changed by the `post_update` commands: <n> `` の 1 行を入れる。ファイルの一覧は載せない（PR の差分で見られるため）。メタデータとコミットメッセージは変えない
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
  advisories?: string[]   // 直すアドバイザリの id（重複なし、順に並べる）。なければ空とみなす。空なら書かない
}
```

- `packages` には、`changes` に加えて `transitiveFixes` も入れる。内容の変更の判定（§14.3）、閉じた PR との照合、内容の変更のコメント（§12.6）は、推移的依存も含めて今までどおり行う

- 読み取りは、本文から `<!-- pubreform:meta (.+?) -->` を探し、最後に現れたものを JSON として解釈する（更新履歴の中に似た文字列があっても、末尾のメタデータを優先するため）。見つからない、解釈できない、`v` が違う場合は「メタデータなし」とする
- パッケージ名とバージョンには `-->` が現れないので、エスケープは不要

### 12.5 マーカー

| マーカー | 用途 |
|---|---|
| `- [ ] Rebase this PR <!-- pubreform:rebase -->` | 再生成のチェックボックス。マーカーを含む最後の行が `- [x] ` か `- [X] ` で始まればチェック済み。最後の行だけを見るのは、それより前にある更新履歴やソースの URL はパッケージの作者が書くもので、同じ行を入れてチェック済みに見せかけられるため（メタデータを最後のものから読むのと同じ） |
| `<!-- pubreform:error <hash> -->` | エラーコメント。`hash` はログの SHA-256 の先頭 12 文字。更新後のコマンドの失敗では、ログの代わりに失敗したコマンドと終了コードから計算する（§19.7） |
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
| open の PR | `GET /repos/{owner}/{repo}/pulls?state=open&base=<base>&per_page=100`（全ページ）。`head.ref` が `pubreform/` で始まり、`head.repo.full_name` が同じリポジトリで、`user.type` が `Bot` のもの（closed の PR も同じ） |
| mergeable | `GET /repos/{owner}/{repo}/pulls/{n}`（`mergeable`、`mergeable_state`）。対象の PR ごとに 1 回 |
| PR の head | `GET /git/ref/heads/<branch>`。対象の PR ごとに 1 回。PR の `head.sha` は使わない。ref を更新した直後は、ref はすでに新しいコミットを返すが、PR の `head.sha` は数秒のあいだ前のコミットを返すため（§17.2 で確認済み）。前の実行が PR を作り直した直後に次の実行が読むと、前の head を見て、作り直しが途中で止まったと誤って判断する |
| closed の PR | `GET /repos/{owner}/{repo}/pulls?state=closed&base=<base>&sort=updated&direction=desc&per_page=100`（1 ページだけ）。`merged_at` が null のもの |
| コミットの作成 | `POST /git/trees`（`base_tree` = ベースの tree、`pubspec.yaml` と `pubspec.lock` を `content` で直接渡す。post_update のコマンドで変わったファイルも同じ tree に入れる。§19.6）→ `POST /git/commits`（`parents` = [baseSha]。author / committer は指定しない）。UTF-8 でないファイルは、その前に `POST /git/blobs` で blob を作る |
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
  | { op: 'notifyManual'; pr: PrState; result: UnitResult }   // result: 対応した単位の結果（ジョブサマリー用）
  | { op: 'commentError'; pr: PrState; log: string }
  | { op: 'close'; pr: PrState; supersededBy?: string } // supersededBy: 引き継ぐ単位のブランチ
  | { op: 'refresh'; pr: PrState; result: UnitResult }   // コミットは作り直さず、タイトル、本文、メタデータだけを更新する
  | { op: 'none'; pr: PrState; result?: UnitResult }     // result: 対応した単位の結果（ジョブサマリー用）
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
| メタデータの `advisories` と、結果の `advisories` の id の集合が違う | `refresh` |
| どれでもない | `none` |

`mergeable == null`（GitHub が未計算）のときは、コンフリクトの条件だけを判定しない。

再生成の条件のどれかに当てはまれば、`regenerate` が新しい `advisories` を書くので、`refresh` は要らない。人手のコミットがある PR は、今までどおり `notifyManual` が先に決まり、`refresh` しない。

`contentChanged` は、どの条件で再生成する場合も、メタデータがあれば `packages`（名前と `to`）の比較で決める。チェックボックスやコンフリクトが理由の再生成でも、内容が変わっていればコメントする（基本 §7.2）。メタデータがなければ `false` にする。

### 14.4 実行

- `decide` はコメントを読まない。コメントの重複の確認は実行時に行う
  - `notifyManual`: PR のコメントを取得し、同じ head の `pubreform:manual` マーカーがあれば何もしない
  - `commentError`: PR のコメントを取得し、最新の bot のエラーコメントと同じハッシュなら何もしない（§15）
- `create`: post_update のコマンドを実行する（§19。なければ飛ばす）→ コミットを作る → ブランチを作る → PR を作る → ラベルを付ける。メタデータの `commit` には作ったコミットを入れる
- `regenerate`: post_update のコマンドを実行する → コミットを作る → タイトルと本文を更新する（メタデータの `commit` は新しいコミット、`previous` は今の head。チェックボックスは未チェックに戻る）→ ブランチを強制更新する → ラベルを付ける → `contentChanged` ならコメントする
  - 本文を先に更新するのは、途中で失敗しても次の実行が状態を判別できるようにするためである。本文の更新で失敗すれば何も変わらない。ブランチの更新で失敗すれば head は `previous` のままなので、次の実行で再生成する。逆の順序だと、本文の更新だけが失敗したときに head がメタデータの `commit` と違ってしまい、人手のコミットと誤って判定する
- `refresh`: タイトルと本文を `PATCH /pulls/{n}` で更新する。メタデータは、`advisories` だけを新しくし、ほかの項目（`commit`、`previous`、`baseHash`、`configHash`、`packages`）は今のメタデータのまま書く。post_update のコマンドは実行しない。本文の `` Files changed by the `post_update` commands: <n> `` の行（§12.3）は、今の本文から `<n>` を読み取って同じ値で書く（今の本文になければ入れない）。コメントはしない。ラベルも付け直さない。チェックボックスの状態は変えない（チェックされていれば `regenerate` が先に決まるので、ここでは常に未チェック）。ジョブのログには `Refresh #<n> (<branch>): security advisories changed` を出す。ジョブサマリーの操作は `refreshed`
- 操作の順序: `create` / `regenerate` などを先に行い、`close` を最後に行う。統合先の PR の番号を `Closing: superseded by #<n>.` に書くためである。統合先の操作が失敗して番号がなければ、`Closing: this update is no longer needed.` にする。新しく作るブランチが閉じる PR のブランチと重なることは、対応付け（§14.2）で通常は起きない。起きた場合は、ブランチの作成（§13）がその単位のエラーになり、次の実行で直る
- 1 つの操作が途中で失敗したら、そこで止めて単位のエラーとする（§15）
- 各操作は、実行する前に何をするか（作成するブランチ、対象の PR の番号、統合先の PR の番号など）を 1 行ずつジョブのログに出す。`create` は PR を作った後に、その番号も出す。エラーは §15 のとおり別に出す

## 15. エラー処理

- 単位のエラーは、`{ unit または pr, log }` として集める。PR があれば、その PR へのエラーコメントを投稿する（`commentError`）。PR がなければ、ジョブのログに出すだけにする
- エラーコメントは、その PR の bot のエラーコメントのうち最新のもののハッシュと同じなら投稿しない
- ログの整形:
  1. pub の標準エラー出力と例外のメッセージを連結する
  2. 末尾の 200 行に切り詰め、さらに 60,000 文字に切り詰める
  3. `token` の値と、`://<user>:<password>@` の形の認証情報を `***` に置き換える
- 最後に、全体エラーか単位のエラーが 1 件でもあれば `core.setFailed` で失敗終了する

## 16. ジョブサマリー

`core.summary` に次を書く。全体エラーのときはサマリーを書かず、`core.setFailed` だけを行う。時刻はすべて設定のタイムゾーンで書く。

- slot と cutoff
- 更新単位ごとの行: 種類、パッケージ、操作（作成 / 再生成 / 変更なし / クローズ / エラー）、PR のリンク
- 待機期間で待っている更新（Waiting for the release age）: 直接依存ごとに `waitingVersion` があれば、パッケージ、種類（direct / dev）、今のバージョン、待っているバージョン、公開日時、使われ始める時刻。使われ始める時刻は、公開日時に `min_release_age_days` を足した時刻以降で、最初に cron が発火する時刻（その slot の cutoff で初めて見えるようになる）
- 最新版に上げられない直接依存（Cannot update to the latest version）: `unresolvable` の、パッケージ、種類、今のバージョン、解決できるバージョン、最新の対象バージョン。最新の対象バージョンは待機期間を過ぎたものの中で決める（待機期間中のバージョンは、待っている更新の表に出る）
- セキュリティアドバイザリ（Security advisories）: 要修正のパッケージ（`fixes`）があれば、下記の表
- 計画に失敗したパッケージ（uncertain）
- エラーの一覧

Security advisories の表:

| Package | Locked | Advisories | Status |
|---|---|---|---|

- 行は `fixes` のパッケージ名の順。Advisories は `id` を `, ` でつなぐ
- Status は次の順に決める。結果と操作の対応は、各操作の結果（`Outcome`）に、その結果で直るパッケージを持たせて求める

| 状況 | Status |
|---|---|
| `fix` がない | `No fixed version` |
| このパッケージを直す結果があり、その PR の操作が `create`、`regenerate`、`refresh`、`none` のどれか（成功したもの） | `Fixed in #<n>`（複数なら `, ` でつなぐ。番号の順。成功した PR だけを並べる） |
| このパッケージを直す結果があり、その PR の操作が `notifyManual`（人手のコミットがあるので更新しない） | `Not updated in #<n> (manual commits)` |
| このパッケージを直す結果があり、その操作が `skip`（利用者が閉じた同じ内容の PR がある） | `Closed in #<n>` |
| このパッケージを直す結果があり、その操作がエラーになった | `Error` |
| 直接依存で、適用に失敗した単位（`commentError` / `error`）のメンバーか、`uncertain` に入っている。推移的依存で、マイナー・パッチグループの適用に失敗した（推移的依存の修正はふつうそこで入るため） | `Error` |
| それ以外 | `Cannot be fixed with the current constraints` |

## 17. テスト

| 種類 | 対象 | 方法 |
|---|---|---|
| 単体 | version、clock、config、changelog の抜き出し、render（メタデータの往復、本文の長さの上限）、reconciler の `decide` と `execute`（`generate` を呼ぶのが `create` と `regenerate` だけであること、失敗の扱い）、planner（`closure` と併合）、generate（`git status -z` の解釈、tree の項目への変換、渡す環境変数、`docker run` の引数）、セキュリティアドバイザリ（下記） | `bun test`。planner は偽の `resolve` を渡す。ネットワークは使わない |
| 結合 | 中継サーバーと pub | プロトタイプの検証（基本 §4.2）を `bun test` に移す。pub.dev へのネットワークと Dart / fvm が必要なので、環境変数 `PUBREFORM_IT=1` のときだけ動かす |
| 設定のスキーマ | `pubreform.schema.json` と config.ts | 同じ設定例を両方で判定し、結果が一致することを確かめる（§4.2） |
| ローカル E2E | Action 全体（ビルドした `dist/main.js`） | フィクスチャー用サーバー、偽の GitHub API、bare リポジトリで、場面ごとに動かす（§17.1） |
| GitHub E2E | 本物の GitHub でしか分からない挙動 | テスト用リポジトリで、本物の GitHub に対して動かす（§17.2） |

セキュリティアドバイザリ（§20）の単体テスト:

| 対象 | 確かめること |
|---|---|
| `parseAdvisories` | `withdrawn` の除外、`ecosystem` の大文字小文字、別のパッケージの `affected` の除外、形の誤りで例外、`url` の検証 |
| `validAdvisories` | `id` と `aliases` による `ignored_advisories` の照合 |
| `findFix` | バックポート（基本 §14.2 の例）、`retracted` の除外、プレリリースの除外、`ignore` に該当する版の除外（最も古い修正版が `ignore` に該当すれば、次に古い修正版）、影響を受けないロック済みのバージョン（`undefined`）、修正版がない |
| `collectFixes` | `advisoriesUpdated` がなければアドバイザリを取りに行かない、取得の失敗で例外、pub.dev 以外のホストの項目を見ない |
| `RegistryProxy` の隠す判定 | §9 の表の各行 |
| `plan` | 要修正の推移的依存だけが U で変わるとき、`members` が空のマイナー・パッチグループができる（偽の `resolve`） |
| `applyUnit` | `transitiveFixes`、`advisories`、`early`、結果を捨てる条件 |
| render | 接頭辞、N、`transitive` の行、アドバイザリの表（`summary` の置き換えと切り詰め）、`early` の 1 文、メタデータの往復 |
| `decide` | `refresh` の条件と、`regenerate` と `notifyManual` が先に決まること |
| `execute` | `refresh` がコミットを作らず、post_update を実行せず、メタデータの `commit` と `previous` を保つこと |
| `advisoryStatus` | ジョブサマリーの Status の順序（§16） |

pubreform 自身の CI では、main への push と pull request のたびに（PR のブランチへの push では動かさない。pull request と 2 回動くため） `tsc --noEmit`、単体テスト、ローカル E2E を動かす。

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
| `fx_patch`、`fx_minor` | 1.0.1、1.2.0（30 日前） | マイナー・パッチグループ（`fx_pinned` と合わせて N = 3、表あり） |
| `fx_major` | 2.0.0（30 日前） | 単独 PR |
| `fx_pinned`（pubspec で `1.0.0` に固定） | 1.1.0、2.0.0（30 日前） | 1.1.0 はマイナー・パッチグループに、2.0.0 は単独 PR に入る。どちらも固定のまま（`fx_pinned: 1.1.0`、`fx_pinned: 2.0.0`）書き換わる |
| `fx_needs_b`、`fx_b` | `fx_needs_b` 1.1.0 は `fx_b ^2.0.0` を要求。`fx_b` 2.0.0（どちらも 30 日前） | 同時更新グループ {fx_b, fx_needs_b} |
| `fx_sdk` | 2.0.0 は Dart SDK `^99.0.0` を要求 | 解決不能（PR なし、サマリーに記録） |
| `fx_fresh` | 1.1.0（1 日前。`min_release_age_days: 3`） | 待機中なので PR なし |
| `fx_ignored` | 1.1.0（30 日前）。設定の `ignore` に名前を入れる | PR なし |
| `fx_vuln`、`fx_parent`、`fx_late` | 1.0.0 だけ。`fx_parent` 1.0.0 は `fx_child ^1.0.0` を要求する | 場面 12、13 まで変化なし |
| `fx_child`（推移的依存） | 1.0.0 だけ | 同上 |

フィクスチャー用サーバーは、セキュリティアドバイザリも配る。`startFixtureServer()` の `advisories`（パッケージごとの OSV の配列）か、実行中の `addAdvisory(name, advisory)` で渡す。アドバイザリのあるパッケージだけ、一覧に `advisoriesUpdated` を入れ、`/api/packages/<name>/advisories` でそれを返す。版には `retracted` を付けられる（一覧の `versions[]` に `retracted: true` が出る）。

場面（前の場面の状態を引き継ぎ、順に実行する）:

1. 作成: 上の表の PR がそれぞれ作られる。タイトル、本文（表、更新履歴、メタデータ、チェックボックス）、コミットメッセージ、ラベル（ないラベルは作られる）、ジョブサマリー（解決不能）を確かめる
2. 何も変わらない: もう一度実行し、どの PR の head も変わらず、コメントも増えない
3. チェックボックス: 単独 PR のチェックボックスにチェックを入れて実行すると、再生成され、チェックが外れる。内容は同じなのでコメントは出ない。その直後に、PR の `head.sha` が前の head のまま（偽の API で、本物の GitHub の反映の遅れを再現する）でもう一度実行しても、何も変わらない（§13）
4. 新しいリリース: `fx_major` に 2.1.0（30 日前）を追加して実行すると、単独 PR が再生成され、内容の変更のコメントが出る
5. ベースの更新: マイナー・パッチグループの PR をマージしたことにする（PR のブランチの内容をベースに反映し、PR を閉じる）。実行すると、ほかの PR は再生成されるが、内容の変更のコメントは出ない。`fx_pinned` の単独 PR は、タイトルが `Update fx_pinned from 1.1.0 to 2.0.0` になる
6. 人手のコミット: 同時更新グループの PR のブランチにコミットを追加して実行すると、通知のコメントが 1 回だけ出て、再生成されない。もう一度実行しても、通知は増えない
7. 設定の変更: `ignore` に `fx_major` を足して実行すると、単独 PR が「no longer needed」でクローズされ、ブランチが消える。閉じた PR のメタデータに `closed: true` が入る
8. 設定を戻す: `ignore` から `fx_major` を外して実行すると、単独 PR が作り直される（pubreform が閉じた PR は、作り直しを止めない）
9. 利用者がクローズ: 8 の単独 PR を、利用者の操作として（メタデータを変えずに）マージせずに閉じて実行すると、同じ内容の PR は作られない
10. 途中の失敗: 偽の API でブランチの更新を 1 回だけ失敗させると、その PR にエラーコメントが出て、ジョブは失敗する。次の実行で再生成され、成功する
11. 人の PR: 人が `pubreform/` で始まるブランチから作った PR（作成者が bot でない）は、計画と対応しなくても閉じず、ブランチも消さず、コメントもしない
12. アドバイザリ: `fx_vuln` に 1.1.0（30 日前）と 1.0.1（1 日前）、`fx_child` に 1.0.1（1 日前）、`fx_late` に 2.0.0（30 日前）を足す。`fx_vuln` に 1.0.0 と 1.1.0 が影響を受けるアドバイザリ、`fx_child` に 1.0.0 が影響を受けるアドバイザリを足して実行すると、次のようになる
    - マイナー・パッチグループの PR が作られ、タイトルは `[Security] Update minor and patch (2 packages)`、表は `fx_vuln` 1.0.0 → 1.0.1（direct）と `fx_child` 1.0.0 → 1.0.1（transitive）。本文の先頭にアドバイザリの表があり、To の列に公開日が入る。影響を受ける `fx_vuln` 1.1.0 は選ばれない
    - `fx_late` の単独 PR（`Update fx_late from 1.0.0 to 2.0.0`）が作られる。接頭辞はない
    - ジョブサマリーのアドバイザリの表で、2 つとも `Fixed in #<マイナー・パッチグループの番号>`。待機中の表に `fx_vuln` は出ない
13. あとから出たアドバイザリ: `fx_late` に 1.0.0 だけが影響を受けるアドバイザリを足して実行すると、`fx_late` の単独 PR のタイトルが `[Security] Update fx_late from 1.0.0 to 2.0.0` になり、本文にアドバイザリの表が入り、メタデータの `advisories` が増える。head は変わらず、内容の変更のコメントも出ない

GitHub E2E（§17.2）はセキュリティアドバイザリのために変えていない。本物の GitHub でしか分からない新しい挙動はないため（テスト用プロジェクトには、場面 12、13 のパッケージが 1.0.0 のまま入る）。

更新後のコマンド（§19）は、別のテスト（`test/e2e/post-update.test.ts`）で、同じ構成の別のリポジトリに対して動かす。`docker version` が通る環境だけで動かす（GitHub Actions の CI では動く見込み）。テスト用プロジェクトは `makeProject({ postUpdate: true })` で作り、設定に次のコマンドを入れる（`make-project.ts` の `POST_UPDATE_CONFIG` と `POST_UPDATE_FILES`）。

| コマンド | 内容 |
|---|---|
| `dart run tool/gen.dart` | lockfile のバージョンを `lib/versions.g.dart` に書く（ネットワークなしで `dart run` が動き、PR ごとの内容になることを見る） |
| `sh tool/probe.sh` | できてはいけないことを試し、結果を `probe.txt` に書く: `INPUT_TOKEN` の値、読める `/proc/*/environ` に `INPUT_TOKEN`・`ACTIONS_RUNTIME_TOKEN`・`GH_TOKEN` があるか、pubreform のプロセス（`dist/main.js`）が見えるか、接続、`.git` があるか、`RUNNER_TEMP` と `GITHUB_WORKSPACE` があるか、ランナーのホームに置いたファイル（`PROBE_HOME/pubreform-probe-secret`）が見えるか、pub のキャッシュと SDK に書き込めるか。あわせて、バイナリのファイル、実行権限のあるファイル、リンク、追跡しているファイルの削除、`.gitignore` で除外したファイル、`pubspec.yaml` の変更を作り、`sleep` を後ろに残す |
| `sh tool/network.sh`（`network: true`） | 同じ接続がネットワークありでは成功することを `network-on.txt` に書く（`probe.txt` の失敗が接続の誤りでないことの確認） |

接続先は `PROBE_URL`（なければ `GITHUB_API_URL`）。ローカル E2E では、偽の API をすべてのインターフェースで待ち受け、`PROBE_URL` を Docker の既定のネットワークのゲートウェイ（コンテナから見たホスト）にする。コンテナの中の `127.0.0.1` はコンテナ自身を指すため。テストは、ランナーのホーム（`HOME`）を一時ディレクトリにして `pubreform-probe-secret` を置き、`PROBE_HOME` で渡す

場面:

1. 作成: 4 つの PR のコミットに、`lib/versions.g.dart`（その PR のバージョン）、`probe.txt`（どれも読めない・書けない・接続できない）、`network-on.txt`（`ok`）、`run.sh`（`100755`）、リンク（`120000`、リンク先の文字列）、バイナリ、削除が入る。`.gitignore` で除外したもの、`.dart_tool/`、コマンドが書いた `pubspec.yaml` は入らない。本文に `` Files changed by the `post_update` commands: 7 `` が入る。`sleep` がホストに残っていない（コンテナと一緒に止まる）。`pubreform-` のコンテナと `pubreform-run` のイメージが残っていない
2. 何も変わらない: もう一度実行すると、コマンドは実行されず、どの PR の head も変わらない
3. 失敗: ベースの設定を、終了コード 3 で失敗し、実行のたびに違う出力を出すコマンドに変えて実行すると、ジョブは失敗し、どの PR の head も変わらず、各 PR に失敗したコマンドと出力を含むエラーコメントが出る。もう一度実行しても、コメントは増えない（§19.7）

### 17.2 GitHub E2E

本物の GitHub でしか分からない次の 4 点を、テスト用リポジトリ [`chika3742/pubreform-e2e`](https://github.com/chika3742/pubreform-e2e)（非公開）で確かめる。pub.dev の代わりに、17.1 と同じフィクスチャー用サーバーを使う。

- API で作ったコミットが Verified になる
- `mergeable_state` が取得できる（GitHub の計算を待つため、null でなくなるまで数回取り直す）
- App のトークンで、ないラベルを作れる
- `/` を含むブランチ名で、ref の取得と更新ができる

あわせて、更新後のコマンド（§19）を本物のランナーで確かめる。テスト用プロジェクトにはローカル E2E と同じコマンド（§17.1）を入れ、1 回目の実行の後に、各 PR のコミットについて次を確かめる。

- `probe.txt` がローカル E2E と同じ内容になる（`docker` が使え、§19.1 のイメージを作れ、トークンと `actions/checkout` の認証情報を読めず、ネットワークに接続できず、SDK・pub のキャッシュに書き込めず、ベースの `.git` が見えない）。`network-on.txt` は `ok`
- 本物の API で、`mode: 100755` と `120000`、`POST /git/blobs` の blob、`sha: null` の削除が tree に入る
- 本文の行と `lib/versions.g.dart` の内容

ワークフローの `run:` のステップに `ACTIONS_RUNTIME_TOKEN` がなければ、`probe.txt` のその確認は意味を持たない。スクリプトは、自分の環境にあるかをログに出す。

ワークフロー（下記）は変えなくてよい見込み。pubreform-e2e の checkout は、main への push のために認証情報を残す（`persist-credentials` の既定）ので、認証情報の確認の対象になる。

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
2. テスト用プロジェクト（`pubspec.yaml`、`pubspec.lock`、`.github/pubreform.yaml` と、更新後のコマンドが使うファイル）を `make-project.ts` の `makeProject({ postUpdate: true })` で生成し、内容が変わっていれば main に push する（コミットの作成者は `pubreform-e2e`）。main のこれらのファイルはこのワークフローが管理する（`.github/workflows/` には触れない）。main にブランチ保護を設定すると、この push が失敗する
3. 前回の実行の後片付け: `pubreform/` で始まるブランチの open の PR を閉じ、`pubreform/` で始まる ref をすべて（open の PR がないものも）消し、設定のラベルを消す。PR は、pubreform が閉じるときと同じく、本文のメタデータに `closed: true` を入れて閉じる（入れないと利用者が閉じた PR として扱われ、フィクスチャーが毎回同じなので、次の実行で同じ内容の PR が作られなくなる）。`closed: true` を入れる処理には、本体と同じ `markClosed`（src/render.ts）を使う
4. 1 回目: ビルドした `dist/main.js` を `node` で実行し、上の 4 点のうち、Verified、`mergeable_state`、ラベルと、更新後のコマンドの結果を確かめる。入力はローカル E2E と同じく環境変数（`INPUT_TOKEN`、`INPUT_CONFIG`）で渡し、`PUBREFORM_UPSTREAM` を付ける。ランナーの環境変数（`GITHUB_REPOSITORY`、`RUNNER_TEMP` など）はそのまま渡す
5. 2 回目: 単独 PR のチェックボックスにチェックを入れてから実行し、その PR が作り直されたこと（`/` を含むブランチ名での ref の取得と更新）を確かめる。実行の直後に待たずに ref を読み、PR のメタデータの `commit` と一致することを確かめる（ref が更新の直後から新しいコミットを返すかを見るため）。PR の `head.sha` は、変わるまで数回取り直す

`uses:` でアクションを呼ぶと、その前後の操作や確認がワークフローのステップに分かれるため、`dist/main.js` を直接実行して 1 つのスクリプトにまとめる。このため `action.yml`（`main` のパスと入力の既定値）は確かめない。`action.yml` は短く、誤っていれば実際に使った最初の実行で失敗して分かるためである。失敗したときは、失敗した手順の名前をエラーの注釈（`::error::`）に出す。

## 18. ビルドとリリース

- `package.json` のスクリプト
  - `build`: `bun build --target=node --outdir=dist --minify ./src/main.ts`
  - `test`: `bun test`
  - `typecheck`: `tsc --noEmit`
- リリースは setup-fvm と同じにする。`v*` のタグを push すると、ワークフロー（`.github/workflows/build.yml`）が次を行う
  1. CI（`.github/workflows/ci.yml`）と同じ検査（`tsc --noEmit`、単体テスト、ローカル E2E）を、タグのコミットで動かす。失敗したらリリースしない
  2. タグのコミットが main の先頭でなければ失敗する。ビルド結果は main の先頭にコミットするので、それ以外のコミットにタグを付けると、タグの指すソースと検査したソースが違ってしまうため
  3. ビルドし、`dist/` に差分があれば main にコミットする
  4. 差分の有無にかかわらず、タグとメジャータグ（`v1` など）を main の先頭に付け直す。`dist/` が変わらないリリース（`action.yml` や README だけの変更）も `@v1` に届けるため
- ワークフローで使うアクションは、コミットの SHA で固定する（バージョンはコメントに書く）。ビルドしたものは利用者の App のトークンで動くので、タグの付け替えでアクションが差し替えられても影響を受けないようにする。更新は Dependabot が行う

## 19. 更新後のコマンド（generate.ts）

PR を作るときと作り直すときに、その更新単位のコミットを作る前に、設定した `post_update` のコマンド（基本 §14.3）を実行し、変わったファイルも同じコミットに入れる。コマンドは依存パッケージのコード（build_runner の builder など）を実行するので、信頼できないコードとして扱う。コマンドは Docker のコンテナの中で実行し、次の 3 つを守る。コンテナのイメージは、レジストリから取得せず、実行のたびにランナーのファイルから作る（§19.1）。

- App のトークン、ランナーのトークン、ランナーのユーザーのファイルを読ませない（コンテナには、決めたものだけをマウントする。ランナーのプロセスはコンテナから見えない）
- pubreform がこのあと実行するもの・信頼して読むもの（SDK、pub のキャッシュ、ベースの clone とその `.git`）を書き換えさせない（読み取り専用でマウントするか、マウントしない）
- 既定ではネットワークを使わせない（`--network none`）

別のユーザー、`sudo`、ACL は使わない。

### 19.1 前提

- Linux のランナーで、ランナーのユーザーが `docker` を使えること。GitHub のホストランナー（ubuntu）を想定する
- `/bin` などが `/usr` の下へのリンクになっている（merged `/usr`）こと。イメージにはそのリンクだけを置き、`/usr` を重ねるので、そうでないランナーではコンテナに `/bin/sh` がなく、すべてのコマンドが失敗する。確かめはしない（GitHub のホストランナーは満たす）
- 条件を満たさない環境で `post_update` があれば、全体エラーにする（何も変更しない）。確認は設定を読んだ直後に 1 回だけ行う（`process.platform` と `docker version`）
- イメージは、最初の更新単位の前に 1 回だけ、ランナーのファイルから作る（`docker import`）。中身は次だけで、ランナーの `/usr` は実行のときに重ねる（§19.5）。作れなければ全体エラーにする
- SDK（§19.5）も同じときに 1 回だけ探す。見つからなければ（`flutter --version --machine` の失敗など）全体エラーにする
  - ディレクトリ: `etc`、`usr`（重ねる場所）、`tmp`（`1777`）、`proc`、`sys`、`dev`
  - リンク: ランナーの `/bin`、`/sbin`、`/lib`、`/lib64` のうちリンクになっているものを同じ先に（Ubuntu では `usr/bin` など）
  - `/etc` から: `passwd`、`group`、`nsswitch.conf`、`ld.so.cache`、`ld.so.conf`、`ld.so.conf.d`、`alternatives`（`awk` などのリンク先）、`ssl/certs`（証明書）、`ssl/openssl.cnf`、`ca-certificates.conf`。どれもランナーのユーザーが読めるもので、秘密は含まない。`/etc/ssl` を丸ごと写さないのは、root だけが読める秘密鍵の置き場所（`/etc/ssl/private`）が含まれるため（GitHub のランナーでは読めずに失敗し、root で動かすと秘密鍵がイメージに入ってしまう）
- レジストリから取得しないのは、Docker Hub などの取得回数の制限を避けるため（§19.8）。ランナーの `/usr` を重ねるので、イメージから使うのは骨組みと `/etc` の一部だけで、ランナーのものを使えば `/usr` と版がずれることもない。イメージの名前は `pubreform-run:<ランダム>` とし、実行の最後に消す（`docker rmi`）

### 19.2 設定

キーと検証は §4.1 のとおり。

- `env` に `INPUT_` で始まる名前と `ACTIONS_` で始まる名前は書けない（設定エラー）。pubreform の入力（App のトークン）とランナーのトークンを、うっかり渡さないため。スキーマでは先読み（`^(?!INPUT_|ACTIONS_)…`）で同じ判定にする
- `env` の値は pubreform のプロセスの環境から取り、なければ渡さない。既定で渡す `HOME`、`PUB_CACHE`、`PATH`、`FLUTTER_ROOT`（§19.5）は、`env` に書いても上書きしない
- `configHash` は既定値を補った設定全体から計算するので（§4.3）、`post_update` を変えるとすべての PR が作り直される。`post_update` のキーを足す前の設定とはハッシュが変わるので、このバージョンに上げた最初の実行では、すべての PR が 1 回作り直される

### 19.3 流れの変更

コマンドは PR の操作（§14.4 の `create` と `regenerate`）の中で、コミットを作る直前に実行する。中継サーバーは止まったままでよい（§19.8）。

```
execute
  create / regenerate のたびに:
    generated = post_update があれば generate(result)
    commit(result.files + generated)
    （以降は今と同じ）
```

- `post_update` が空なら、今とまったく同じ動きにする
- 実行のたびに行う適用のやり直しや、`none`（変化なし）の PR では実行しない。作り直すかどうかの判断に生成結果を使わないため
- 更新単位は 1 つずつ順に処理する
- `execute` には `ExecuteContext` の関数（`generate?: (result) => Promise<TreeEntry[]>`）として渡し、テストでは差し替える
- `post_update` があるときは、ジョブのログに `Pull requests` のグループを作らない。コマンドごとのグループ（§19.5）と入れ子にしないため

### 19.4 生成の手順

更新単位ごとに、次を行う。

1. `/tmp` の下に生成用ディレクトリを作る（`mkdtemp`）
2. ベースの clone の `.git`（信頼できる）から、追跡しているファイルを生成用ディレクトリに書き出す（`git --git-dir=<base>/.git --work-tree=<base> checkout-index --all --prefix=<dir>/`）。`.git` は渡さない。生成のコードが `.git/config`（`core.fsmonitor` など）やフックを書き換えると、あとで pubreform が実行する `git` がそのコマンドを実行してしまうため。作業ツリーをコピーしないのは、解決で残ったもの（`.dart_tool/` など）を持ち込まないため
3. ランナーのユーザーのまま、`Pub.run`（§8.2）で、その更新単位の `pubspec.yaml` と、URL を中継サーバーのものにした `pubspec.lock` を書き、`pub get --offline --no-example` を実行する（Flutter なら `flutter pub get`、fvm なら `fvm flutter pub get`）。`.dart_tool/package_config.json` ができる。パッケージは適用のときにキャッシュに入っているので、中継サーバーもネットワークも要らない。これはコンテナの外で、SDK に書き込めるランナーのユーザーが行うので、Flutter のプロジェクトでも動く
4. コマンドを順に、コンテナの中で実行する（§19.5）
5. 変わったファイルを取り出す（§19.6）
6. 生成用ディレクトリを消す

### 19.5 コマンドの実行

コマンドごとに、新しいコンテナで次を実行する。

```
docker run --rm --name pubreform-<ランダム> \
  --user <ランナーの uid>:<gid> --cap-drop ALL --security-opt no-new-privileges \
  [--network none] \
  -v /usr:/usr:ro \
  -v <SDK>:<SDK>:ro -v <pub のキャッシュ>:<pub のキャッシュ>:ro \
  -v <生成用ディレクトリ>:<生成用ディレクトリ> -w <生成用ディレクトリ> \
  -e PATH -e HOME -e PUB_CACHE … \
  <§19.1 のイメージ> sh -c <run>
```

- マウントするのは、上の 4 つだけ。ランナーのホーム、`RUNNER_TEMP`、ワークスペース、Docker のソケットはマウントしない。`actions/checkout` が `RUNNER_TEMP` に残す認証情報（§19.8）は、コンテナからは存在しない
- パスは、ランナー上と同じパスにマウントする。`package_config.json` に書かれる SDK と pub のキャッシュの絶対パスが、そのまま使えるようにするため
- `/usr` は、ランナーのものを読み取り専用で重ねる。利用者がワークフローで入れたツール（`apt-get install` したもの）を、コンテナの中でも使えるようにするため
- SDK: PATH 上の `dart` の実体の 2 つ上のディレクトリ（`<sdk>/bin/dart` の `<sdk>`）。Flutter のプロジェクトと、`.fvmrc` のあるプロジェクト（fvm が入れるのは Flutter SDK なので、Dart だけのプロジェクトでも Flutter SDK の Dart を使う）では、Flutter SDK のルート（§19.9）。ルートは、ランナーのユーザーがベースの clone で `flutter --version --machine`（fvm なら `fvm flutter --version --machine`）を実行し、その `flutterRoot` から得る
- pub のキャッシュ: `PUB_CACHE`、なければ `~/.pub-cache` を展開したもの
- ユーザーはランナーと同じ uid と gid にする。生成用ディレクトリに書かれたファイルの持ち主がランナーのユーザーになり、持ち主を戻す手間がない。同じ uid でも、コンテナの中からはランナーのプロセスは見えず（PID の名前空間が別）、マウントしていないファイルは読めない。SDK と pub のキャッシュは読み取り専用のマウントなので、持ち主の uid でも書き込めない
- `network: false` なら `--network none` を付ける。`true` なら Docker の既定のネットワークにする
- 渡す環境変数: `PATH`（Flutter SDK を使うプロジェクトでは同梱の Dart の `bin` を先頭にする。§19.9）、`HOME`（`/tmp`。コンテナの中の書き込める場所で、コンテナと一緒に消える）、`PUB_CACHE`、`LANG`、`LC_ALL`、`CI`、`FLUTTER_ROOT`（Flutter SDK を使うプロジェクトだけ）と、`env` で指定したもの。値はコマンド行に書かず、`-e <名前>` で docker のプロセスの環境から渡す（値がプロセスの一覧やログに出ないようにするため）
- ただし `HOME` だけは、値をコマンド行に書く（`-e HOME=/tmp`）。docker の CLI は、自分の設定（`~/.docker/config.json`）を探すのに `HOME` を、接続先などに `DOCKER_HOST` などの `DOCKER_*` を、自分の環境から読む。docker のプロセスにはランナーの環境（`HOME` と `DOCKER_*` を含む）をそのまま渡し、その上にコンテナに渡す値を重ねる。コンテナに届くのは `-e` で指定した名前だけである。`HOME` の値は決まっていて秘密ではないので、コマンド行に出てもよい
- コマンドの実行中は、docker のプロセスの環境に `env` の値がある。ランナーのユーザーからは `/proc/<pid>/environ` で読めるが、ランナーのユーザーはもともと App のトークンを持っていて、コンテナの中からはこのプロセスが見えないので、問題にしない
- 出力はジョブのログにそのまま出す（`core.group` で「Post update: <run>」にまとめる）
- コマンドが終わるとコンテナが止まり、コマンドが後ろで動かし続けたプロセスも一緒に止まる。pubreform が異常終了したときに残らないよう、実行のあとに `docker rm -f <名前>` を行う（`--rm` で消えていれば何もしない）
- 終了コードが 0 でなければ、そこで止めて §19.7 の失敗にする

### 19.6 変わったファイルの取り出し

生成用ディレクトリの中身は信頼できないデータとして扱う。

1. 変わったファイルは、ベースの clone の `.git` を使って調べる。`.gitignore` に従い、追跡していないファイルも含める

   ```
   git -c core.fsmonitor=false -c core.untrackedCache=false -c status.relativePaths=false \
     --git-dir=<base>/.git --work-tree=<dir> status --porcelain=v1 -z --untracked-files=all --no-renames --ignore-submodules=all
   ```

   インデックスは書き換えないよう、ベースのインデックスをコピーしたものを `GIT_INDEX_FILE` で使う。設定は信頼できる `.git` のものなので、作業ツリーの `.gitattributes` があっても、ベースで設定していない外部のフィルターは動かない
2. `pubspec.yaml` と `pubspec.lock` は除く。この 2 つは適用の結果（`result.files`、pub.dev の URL）を使う
3. パスは作業ツリーの中に限る（空の要素、`.`、`..`、絶対パスを含むものは捨てる）。途中のディレクトリがシンボリックリンクなら捨てる。ファイルは `lstat` で調べ、シンボリックリンクはたどらない。リンクはリンクとして（`mode: 120000`、内容はリンク先の文字列）コミットする。生成のコードが、ランナーのファイルを指すリンクを置いて、その内容をコミットさせることを防ぐため。通常のファイルでもリンクでもないもの（git がまとめて表示した入れ子のリポジトリなど）は捨てる
4. tree の項目にする

| 状態 | 項目 |
|---|---|
| 変更・追加（UTF-8 として読め、NUL を含まない） | `content` に内容を入れる（BOM と改行はそのまま）。所有者の実行権限があれば `mode: 100755`、なければ `100644` |
| 変更・追加（それ以外） | `POST /git/blobs`（`encoding: base64`）で blob を作り、その `sha` を入れる |
| 削除 | `sha: null` |

- 項目は `createCommit` に渡し、2 ファイルと一緒に 1 つの tree にする（`base_tree` はベースの tree。§13）
- 変わったファイルがなければ、今と同じ 2 ファイルだけのコミットになる

### 19.7 失敗

コマンドが失敗した（終了コードが 0 でない）、または §19.4 の準備に失敗したら、その更新単位のエラーにする（§15 の単位のエラーと同じ）。

- `create` なら PR を作らない。ジョブのログとサマリーに残す
- `regenerate` なら PR を今のままにして、エラーをコメントする（同じ内容なら繰り返さない）
- ログには、失敗したコマンドと、その出力の末尾（100 行）を入れる（`post_update command failed with exit code <n>: <run>`）
- コメントの重複の確認（§15）に使うハッシュは、失敗したコマンド（`run`）と終了コードだけから計算する（`<run>` NUL `<終了コード>`）。出力は含めない。所要時間などを出力するツールでは、失敗のたびに出力が変わり、同じ失敗を毎回コメントしてしまうため。コメントには今までどおり出力を載せる。§19.4 の準備の失敗は、ほかの単位のエラーと同じくログから計算する

生成なしで PR を作る方式は採らない。生成コードが古いまま CI で落ちる PR を作ることになるため。

### 19.8 確認済みのこと

2026-10-19 に、Dart 3.13.5 で確認した（フィクスチャー用サーバーを中継サーバーの代わりにし、Docker 29.8.2 のコンテナで実行。GitHub のランナーでは未確認）。

2026-10-19 に GitHub のホストランナー（ubuntu-latest）で、GitHub E2E（[run #6](https://github.com/chika3742/pubreform-e2e/actions/runs/39206665275)）により次を確かめた。

- ランナーのユーザーが `docker` を使え、§19.1 の作り方でイメージを作って、コマンドを実行できた
- コンテナから、`INPUT_TOKEN`、トークンを含む環境変数、pubreform のプロセス、`.git`、`RUNNER_TEMP`（`actions/checkout` の認証情報の置き場所）、`GITHUB_WORKSPACE`、ランナーのホームが見えなかった。`--network none` では外部に接続できず、pub のキャッシュと SDK には書き込めなかった
- `network: true` のコマンドは、HTTPS で GitHub の API に接続できた（§19.1 で写した証明書が使えた）
- 生成したファイル、実行権限、リンク、バイナリ、削除、`.gitignore` の除外が、本物の API で作ったコミットに入った

- 中継サーバーの URL の lockfile なら、サーバーを止めたあとでも `pub get --offline` が成功し、`package_config.json` ができる
- その後、ネットワークなしで `dart run` が動く。暗黙の `pub get` は始まらない。`PUB_HOSTED_URL` を渡さなくても、lockfile を pub.dev の URL に戻した後でも同じ
- §19.1 の作り方で、ランナー（ここでは Ubuntu 24.04 のコンテナ）のファイルからイメージを作れた（0.1 秒、1.25 MB）
- そのイメージのコンテナに、ランナーの `/usr`、SDK、pub のキャッシュを読み取り専用で、生成用ディレクトリを書き込める形で、同じパスにマウントし、uid 1001 で `dart run` を実行できた。書いたファイルの持ち主は、ランナー上でも uid 1001 だった。`awk`（`/etc/alternatives` のリンク）、`git`、証明書の束も使えた。ランナーの `/home` と `/root` は存在しなかった
- コンテナの中からは、ランナーのプロセスが見えず（見えたのはコンテナの中のプロセスだけ）、ランナーで動かしたプロセスの環境変数（`SECRET_TOKEN`）は読めなかった。外部には接続できず（`--network none`、`curl` が名前解決できずに失敗）、SDK と pub のキャッシュには書き込めなかった（`Read-only file system`）。ランナーのホームは見えなかった
- コマンドが `&` で後ろに残したプロセスは、コンテナが止まると一緒に止まった
- 同じユーザーのプロセスどうしでは、環境変数をすべて外したプロセスからでも、ほかのプロセスの `/proc/<pid>/environ` を読めた（環境変数を絞るだけでは足りない根拠）
- `actions/checkout`（2026-07-20 時点のソース）は、`persist-credentials: true` のとき、トークンを `$RUNNER_TEMP/git-credentials-<uuid>.config` に書く。ファイルは権限を指定せずに作るので、ほかのユーザーにも読める権限（0644）になると考えられる。コンテナにはマウントしないので読まれない
- このコンテナ環境では、Docker Hub からの `docker pull ubuntu:latest` が `429 Too Many Requests`、Amazon ECR Public からの取得が `toomanyrequests: Data limit exceeded`（どちらも取得回数・量の制限）で失敗した。ghcr.io には Canonical の公式のイメージがない。§19.1 でイメージを自分で作る理由

### 19.9 Flutter

Flutter のプロジェクトでも `post_update` を使える。ただし、コンテナの中で使えるのは SDK に同梱の Dart だけで、`flutter` コマンドは使えない。

- 2026-10-19 に、別のユーザーから読み取りだけの Flutter 3.47.7 の SDK で試したところ、`flutter` コマンド（`flutter gen-l10n` など）と、SDK の `bin/dart`（起動スクリプト）は、起動のたびに SDK の中（`bin/cache/engine.stamp` など）に書き込もうとして失敗した。同梱の Dart（`<SDK>/bin/cache/dart-sdk/bin/dart`）での `dart run build_runner build` は成功した
- そこで、Flutter のプロジェクトと `.fvmrc` のあるプロジェクトでは、Flutter SDK のルートを読み取り専用でマウントし、PATH の先頭に `<SDK>/bin/cache/dart-sdk/bin` を置く。`FLUTTER_ROOT` に SDK のルートを渡す。build_runner や Pigeon（`dart run pigeon`）は、この Dart で動く。build_runner は解析のために SDK の中の `flutter` パッケージを読むが、SDK 全体をマウントしているので読める
- `flutter` コマンドを使うもの（`flutter gen-l10n` など）は失敗し、§19.7 のとおりその更新単位のエラーになる。SDK に書き込めるようにはしない。書き換えられると、あとで pubreform が実行する pub が改ざんされるため
- 2026-10-19 に、コンテナの中で確かめた（Flutter 3.47.7。§19.1 の作り方のイメージ、SDK のルートと pub のキャッシュを読み取り専用で同じパスにマウント、`--network none`、`--cap-drop ALL`、uid 1001、PATH の先頭に同梱の Dart、`FLUTTER_ROOT` あり、`pub get --offline` はコンテナの外で済ませたもの）
  - `dart run build_runner build`（json_serializable）は成功した（終了コード 0。`model.g.dart` を uid 1001 の持ち主で書いた）。モデルは `package:flutter/foundation.dart` を import し、`@immutable` と `ValueNotifier` を使うので、解析で読み取り専用の SDK の中の `flutter` パッケージを読んでいる
  - `flutter gen-l10n` は `flutter: not found` で失敗した（`<SDK>/bin` は PATH にない）
  - 起動スクリプト `$FLUTTER_ROOT/bin/dart` は、SDK の git の `safe.directory` と `bin/cache` への書き込みで失敗した
  - SDK と pub のキャッシュへの書き込みは `Read-only file system` で失敗した
  - Pigeon は試していない

## 20. セキュリティアドバイザリ（advisories.ts）

基本 §14.2 の用語（有効なアドバイザリ、影響を受けるバージョン、要修正のパッケージ、修正版 `f(p)`）をそのまま使う。設定（`config.ts`、`pubreform.schema.json`）は変えない。この機能は常に有効である。

### 20.1 対象

- ベースの lockfile の項目のうち、`source` が `hosted` で `description.url` が `https://pub.dev` のもの（`parseLock()` の `url`）。直接依存か推移的依存かは問わない
- `ignored_advisories` は、ベースの `pubspec.yaml` のトップレベルの `ignored_advisories` を読む（`pubspec.ts` の `ignoredAdvisories(pubspecText): Set<string>`）。文字列の配列でなければ空とみなす（pub はこの場合に解決を失敗させるが、pubreform は pub の解決で同じエラーに気づくので、ここでは止めない）

### 20.2 取得

1. 対象のパッケージごとに、中継サーバーが保持する一覧（`proxy.upstreamListing(name)`。§9）を読む。一覧に `advisoriesUpdated` がなければ、アドバイザリはないものとする（pub と同じ）
2. `advisoriesUpdated` があれば、`GET <upstream>/api/packages/<name>/advisories`（`accept: application/vnd.pub.v2+json`、30 秒で打ち切る）を取得する。`<upstream>` は中継サーバーの取得元（pub.dev、テストでは `PUBREFORM_UPSTREAM`）
3. 同時に取得するのは 8 件まで

次の場合は例外を投げる（全体エラー。基本 §14.2 のエラー処理）。

- 一覧かアドバイザリを取得できない（接続できない、打ち切った、成功以外の応答）
- 応答が次の形でない: `advisories` が配列で、各要素の `id` が文字列、`affected` が配列、`affected[].package.name` と `affected[].package.ecosystem` が文字列、`affected[].versions` が文字列の配列（pub が `FormatException` にするものと同じ）

### 20.3 読み取り

```ts
interface Advisory {
  id: string
  aliases: string[]
  summary?: string
  severity?: string   // database_specific.severity を小文字にしたもの
  url?: string        // database_specific.pub_display_url。http(s) で、空白、括弧（()[]）、<> を含まないものだけ（ソースへのリンクと同じ。§12.3）
  versions: Set<string>  // このパッケージの影響を受けるバージョン
}

function parseAdvisories(body: unknown, name: string): Advisory[]
```

- `withdrawn`（値は問わない）がある要素は捨てる
- `affected[]` のうち、`package.name` が `name` で、`package.ecosystem` を小文字にしたものが `pub` の要素の `versions` を合わせる。そのような要素がなければ、そのアドバイザリは捨てる
- `aliases` が文字列の配列でなければ空とみなす
- `ignored_advisories` に `id` か `aliases` のどれかが入っているものは捨てる（`validAdvisories(list, ignored)`）

### 20.4 修正版

```ts
interface Fix {
  name: string
  locked: string           // c(p)
  advisories: Advisory[]   // c(p) が影響を受ける有効なアドバイザリ（id の順）
  affected: Set<string>    // 有効なアドバイザリのどれかで影響を受けるバージョン
  fix?: { version: string; published?: Date }  // f(p)。なければ修正版がない
}

function findFix(name: string, locked: string, listing: Listing, advisories: Advisory[], ignore: IgnoreRule[]): Fix | undefined
```

- `c(p)` がどの有効なアドバイザリの影響も受けなければ `undefined`（要修正でない）
- `f(p)`: 一覧の `versions` のうち、安定版（`isStable`）で、`compareVersions(v, c(p)) > 0`、`retracted` が `true` でなく、`affected` に入っておらず、`ignore` に該当しないものの最小（`compareVersions` の順）。`ignore` の判定は、中継サーバーと同じ関数を使う（`name` が同じで、`versions` がないか `allows(versions, v)` のルール）
- バージョンの照合は文字列の一致で行う（pub は `canonicalizedVersion` で照合するが、pub.dev の一覧とアドバイザリはどちらも正規化された文字列を返す）

`collectFixes(opts): Promise<Map<string, Fix>>` が 20.1〜20.4 をまとめて行う。取得の関数と、設定の `ignore` を引数で受け取る。テストでは偽の取得の関数を渡す。

### 20.5 確認済みのこと

- 基本 §14.2 の「確かめたこと」（pub のソース、pub.dev の API の形、試作での解決の結果）
- 2026-10-20 に、Dart 3.13.5 で次を確かめた
  - ローカル E2E の場面 12、13（§17.1）: 要修正の直接依存と推移的依存を一緒に直すマイナー・パッチグループ、タイトル、本文、コミットメッセージ、メタデータ、`refresh`、ジョブサマリーの表
  - 要修正の推移的依存だけが変わるマイナー・パッチグループ: `fx_parent` 1.0.0（`fx_child ^1.0.0` を要求）だけに依存し、`fx_child` 1.0.0 が影響を受け、1.0.1（1 日前）が修正版の場合、`plan()` は `members` が空の minor の単位を作り、`applyUnit()` は `transitiveFixes` に `fx_child` 1.0.0 → 1.0.1、`early` 付きのアドバイザリを返し、タイトルは `[Security] Update fx_child from 1.0.0 to 1.0.1` になった（本物の `dart pub` で、その場限りのスクリプトで確認）
  - pub は、アドバイザリに `summary` がないときや `aliases` が配列でないときに `Failed to decode advisories for <name> …` と出すが、解決は続ける。pubreform は、これらを欠けていても受け付ける（§20.3）
  - 取り下げ（retracted）された版: フィクスチャー用サーバーと中継サーバーで、1.0.0 が影響を受け、1.0.1（30 日前、取り下げ）、1.0.2（1 日前）、1.0.3（30 日前、取り下げ）がある場合、`f(p)` は 1.0.2 になり、中継サーバーは 1.0.0〜1.0.3 を見せ、`dart pub upgrade` は取り下げた 1.0.3 ではなく 1.0.2 を選んだ（その場限りのスクリプトで確認。テストには入れていない）
  - 本物の pub.dev の `dio`、`http`、`archive` のアドバイザリを `collectFixes` と同じ関数（`parseAdvisories`、`validAdvisories`、`findFix`）で読み、`dio` の取り下げられたアドバイザリが除かれ、`severity`、`url`、修正版（`dio` 4.0.0 → 5.0.0、`http` 0.13.0 → 0.13.3、`archive` 3.3.7 → 3.3.8）が得られた
- 未確認: 表の表示（§21）

## 21. 未確認のこと

| 項目 | 内容 |
|---|---|
| README のワークフロー例 | トリガーと `if` の条件を、実際の GitHub で動かしていない |
| Flutter プロジェクト | setup-fvm と組み合わせた実行を、実際の GitHub で確かめていない。GitHub E2E は Dart だけ（§17.2） |
| `action.yml` | GitHub E2E は `dist/main.js` を直接実行するため、確かめていない（§17.2） |
| 長いタイトル | GitHub が保存時に切り詰めるか（§12.1） |
| 更新後のコマンドと `ACTIONS_RUNTIME_TOKEN` | GitHub E2E は pubreform を `run:` のステップから起動するので、そのプロセスに `ACTIONS_RUNTIME_TOKEN` がない。`uses:` で起動したときにコンテナから読めないことは、直接は確かめていない（コンテナからは pubreform のプロセスが見えないことは確かめた） |
| 更新後のコマンドと Flutter | Pigeon が動くか。GitHub のランナーで setup-fvm と組み合わせて動くか（build_runner はローカルのコンテナで確認済み。§19.9） |
| 更新後のコマンドの実行時間 | PR ごとに生成が走るので、コマンドと PR が多く、作り直しが重なると長くなる。測っていない |
| セキュリティアドバイザリの表示 | 本文のアドバイザリの表とジョブサマリーの表を、本物の GitHub で表示していない。ローカル E2E で文字列だけを確かめた（§20.5） |

## 22. 基本設計からの変更点

この詳細設計で、基本設計の次の点を具体化・変更した。どれも基本設計に反映済み。

| 項目 | 基本設計 | 詳細設計 |
|---|---|---|
| ベースの取得 | fetch して worktree を作る | トークンで浅く clone する（§8.1）。checkout の状態に依存しない |
| 解決の作業場所 | worktree の複製 | 1 つのディレクトリで、pub を実行する前に 2 ファイルを書き戻す（§8.1） |
| `ignore` | すべての解決で除外する | 中継サーバーで該当バージョンを隠す（§9） |
| 更新履歴とソースリンク | アーカイブから抜き出す | pub がキャッシュに展開したパッケージから読む（§12.3） |
| 計画に失敗したパッケージ | 記述なし | そのパッケージを含む PR は閉じない（§14.3） |
| 更新後のコマンドの作業場所 | 作業ディレクトリで実行し、次の更新単位の前にベースの状態に戻す | 更新単位ごとに、`.git` のない生成用ディレクトリを `/tmp` に作り、使い終わったら消す（§19.4） |
| 更新後のコマンドの実行場所 | 別のユーザーで、ネットワークのない名前空間で実行する | Docker のコンテナで実行する（§19.5）。イメージはランナーのファイルから作る（§19.1）。別のユーザー、`sudo`、ACL は使わない |
| 更新後のコマンドと Flutter | 記述なし | 使えるが、SDK に同梱の Dart だけで、`flutter` コマンドは使えない（§19.9） |
