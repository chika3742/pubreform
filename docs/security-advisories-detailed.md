# セキュリティアドバイザリによる更新 詳細設計

> ステータス: 設計済み・未実装（2026-10-19）。[基本設計](design.md) §14.2 を前提に、実装に必要な決定を書く。実装したら、この内容を[詳細設計](detailed-design.md)に取り込み（§13）、このファイルは消す。節番号の「基本 §n」は基本設計の、「詳細 §n」は詳細設計の節を指す。

## 1. 用語

基本 §14.2 の用語（有効なアドバイザリ、影響を受けるバージョン、要修正のパッケージ、修正版 `f(p)`）をそのまま使う。

## 2. モジュール

| モジュール | 変更 |
|---|---|
| `src/advisories.ts`（新規） | アドバイザリの読み取り、要修正のパッケージと修正版の判定（§4） |
| `src/pubspec.ts` | `ignored_advisories` の読み取り（§4.1） |
| `src/proxy.ts` | 要修正のパッケージの見せ方（§5） |
| `src/planner.ts` | 要修正の推移的依存だけが変わるマイナー・パッチグループ（§6） |
| `src/applier.ts` | `UnitResult` に、直した推移的依存とアドバイザリを足す（§7） |
| `src/render.ts` | タイトルの接頭辞、表、本文のアドバイザリの表、メタデータ（§8） |
| `src/reconciler.ts` | 新しい操作 `refresh`（§9） |
| `src/main.ts` | 流れ（§3）とジョブサマリー（§10） |

設定（`config.ts`、`pubreform.schema.json`）は変えない。この機能は常に有効である。

## 3. 流れの変更（main.ts）

詳細 §3 の手順 7（中継サーバーの起動）と 8（計画）の間に、次の手順を入れる。

```
7a. 要修正のパッケージを求める（§4）。fixes: Map<name, Fix>
    失敗したら全体エラー（PR はまだ変更していない）
7b. proxy.setFixes(fixes)（§5）
```

- 7a の後でなければ計画を始めない。計画のどの解決にも、同じ見せ方を使うため
- 手順 8 の `plan()` と手順 9 の `applyUnit()` に `fixes` を渡す（§6、§7）
- 手順 13 のジョブサマリーに、アドバイザリの表を足す（§10）

## 4. アドバイザリの取得と判定（advisories.ts）

### 4.1 対象

- ベースの lockfile の項目のうち、`source` が `hosted` で `description.url` が `https://pub.dev` のもの（`parseLock()` の `url`）。直接依存か推移的依存かは問わない
- `ignored_advisories` は、ベースの `pubspec.yaml` のトップレベルの `ignored_advisories` を読む。文字列の配列でなければ空とみなす（pub はこの場合に解決を失敗させるが、pubreform は pub の解決で同じエラーに気づくので、ここでは止めない）。`pubspec.ts` に `ignoredAdvisories(pubspecText): Set<string>` を足す

### 4.2 取得

1. 対象のパッケージごとに、中継サーバーが保持する一覧（`proxy.upstreamListing(name)`。§5）を読む。一覧に `advisoriesUpdated` がなければ、アドバイザリはないものとする（pub と同じ）
2. `advisoriesUpdated` があれば、`GET <upstream>/api/packages/<name>/advisories`（`accept: application/vnd.pub.v2+json`、30 秒で打ち切る）を取得する。`<upstream>` は中継サーバーの取得元（pub.dev、テストでは `PUBREFORM_UPSTREAM`）
3. 同時に取得するのは 8 件まで

次の場合は例外を投げる（全体エラー。基本 §14.2 のエラー処理）。

- 一覧かアドバイザリを取得できない（接続できない、打ち切った、成功以外の応答）
- 応答が次の形でない: `advisories` が配列で、各要素の `id` が文字列、`affected` が配列、`affected[].package.name` と `affected[].package.ecosystem` が文字列、`affected[].versions` が文字列の配列（pub が `FormatException` にするものと同じ）

### 4.3 読み取り

```ts
interface Advisory {
  id: string
  aliases: string[]
  summary?: string
  severity?: string   // database_specific.severity を小文字にしたもの
  url?: string        // database_specific.pub_display_url。http(s) で、空白、括弧（()[]）、<> を含まないものだけ（ソースへのリンクと同じ。詳細 §12.3）
  versions: Set<string>  // このパッケージの影響を受けるバージョン
}

function parseAdvisories(body: unknown, name: string): Advisory[]
```

- `withdrawn`（値は問わない）がある要素は捨てる
- `affected[]` のうち、`package.name` が `name` で、`package.ecosystem` を小文字にしたものが `pub` の要素の `versions` を合わせる。そのような要素がなければ、そのアドバイザリは捨てる
- `aliases` が文字列の配列でなければ空とみなす
- `ignored_advisories` に `id` か `aliases` のどれかが入っているものは捨てる（`validAdvisories(list, ignored)`）

### 4.4 修正版

```ts
interface Fix {
  name: string
  locked: string           // c(p)
  advisories: Advisory[]   // c(p) が影響を受ける有効なアドバイザリ（id の順）
  affected: Set<string>    // 有効なアドバイザリのどれかで影響を受けるバージョン
  fix?: { version: string; published?: Date }  // f(p)。なければ修正版がない
}

function findFix(name: string, locked: string, listing: Listing, advisories: Advisory[]): Fix | undefined
```

- `c(p)` がどの有効なアドバイザリの影響も受けなければ `undefined`（要修正でない）
- `f(p)`: 一覧の `versions` のうち、安定版（`isStable`）で、`compareVersions(v, c(p)) > 0`、`retracted` が `true` でなく、`affected` に入っていないものの最小（`compareVersions` の順）
- バージョンの照合は文字列の一致で行う（pub は `canonicalizedVersion` で照合するが、pub.dev の一覧とアドバイザリはどちらも正規化された文字列を返す）

`collectFixes(opts): Promise<Map<string, Fix>>` が 4.1〜4.4 をまとめて行う。取得の関数を引数で受け取り、テストでは偽の関数を渡す。

## 5. 中継サーバー（proxy.ts）

- `upstreamListing(name): Promise<Listing>` を公開する。今の `listing(name)` の保持をそのまま使い、取得に失敗したら例外を投げる。§4 と計画の解決が、同じ一覧を見るため
- `setFixes(fixes: Map<string, Fix>)` を公開する。計画の前に 1 回だけ呼ぶ
- 隠す判定（`isHidden`）を次の順にする。最初に当てはまるもので決める

| 条件 | 結果 |
|---|---|
| ロック済みのバージョン | 見せる |
| 要修正のパッケージで、`affected` に入っている | 隠す |
| 要修正のパッケージで、`fix.version` と同じ | `ignore` に該当すれば隠す。該当しなければ見せる |
| （今までどおり）cutoff より後の公開、または `ignore` に該当 | 隠す |
| それ以外 | 見せる |

- `waitingVersion()` は変えない。見せた修正版は「隠した」に入らないので、待機中の表には出ない
- `fixes` の `fix.version` が `ignore` に該当するかを、`isIgnoredFix(name)` として公開する（ジョブサマリーの `No fixed version` の判定。§10）

## 6. 計画（planner.ts）

- `PlanInput` に `fixes: Map<string, Fix>` を足す
- マイナー・パッチグループの単位を作る条件を、「`minor` が空でない、または `fixedTransitive` が空でない」にする

```
fixedTransitive = { t in fixes : t は直接依存でない, U(t) != c(t), U(t) が fixes[t].affected に入っていない }
```

- `Unit.members` は今までどおり、U で変わる直接依存だけにする（空のこともある）

## 7. 適用（applier.ts）

```ts
interface UnitResult {
  unit: Unit
  files: PubFiles
  changes: Record<string, Change>                 // 今までどおり、直接依存だけ
  transitiveFixes: Record<string, { from: string; to: string }>  // 直した推移的依存
  advisories: FixedAdvisory[]                     // この結果で直るアドバイザリ
}

interface FixedAdvisory {
  package: string
  advisory: Advisory
  from: string
  to: string
  early?: Date   // to が待機期間の中で、修正版として見せたものなら、その公開日時
}
```

- `applyUnit()` に `fixes` と `cutoff` を渡す
- 直したパッケージ: 結果の lockfile で、`fixes` のパッケージ p のバージョンが `c(p)` と違い、`affected` に入っていないもの
  - 直接依存なら `changes` に入っている。推移的依存なら `transitiveFixes` に入れる
  - 直したパッケージの `fixes[p].advisories` をすべて `advisories` に入れる（パッケージ名、`id` の順）
  - `early`: `to` が `fixes[p].fix.version` と同じで、その `published` が cutoff より後なら、`published`
- 結果を捨てる条件を、「`changes` と `transitiveFixes` がどちらも空」にする
- 要修正の推移的依存が、単独 PR や同時更新グループの適用でも直ることがある（`pub add` が必要に応じて動かした場合）。そのときも同じように数える。同じパッケージを複数の PR が直すことがある

## 8. 文面とメタデータ（render.ts）

### 8.1 タイトルとコミットメッセージ

- `advisories` が空でなければ、詳細 §12.1 のタイトルの前に `[Security] ` を付ける
- N は `changes` と `transitiveFixes` の数の和。N = 1 のときに single と同じ形にする規則（詳細 §12.1）は、その 1 つが推移的依存でも同じ
- 表（コミットメッセージと本文）に `transitiveFixes` の行も入れる。Type は `transitive`。行はパッケージ名の順
- コミットメッセージの 1 行目は、接頭辞を含めてタイトルと同じ

### 8.2 本文

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
- `summary` はアドバイザリのデータベースから来る外部の文字列なので、更新履歴と同じ置き換え（`withoutBacklinks()`。ソースは渡さない。詳細 §12.3）をしたうえで、改行を空白にし、`|` を `\|` にする。200 文字を超えたら切って `…` を付ける
- Severity の列: `severity`。なければ空
- To の列: `early` があれば `<to> (released <YYYY-MM-DD>)`。日付は設定のタイムゾーンで書く（ジョブサマリーと同じ）
- 表の下の 1 文は、`early` のある行が 1 つでもあるときだけ入れる
- 各パッケージの節（ソースへのリンクと更新履歴。詳細 §12.3）は、`transitiveFixes` のパッケージにも作る。キャッシュの場所は直接依存と同じ
- 本文の上限（詳細 §12.3）の計算には、アドバイザリの表も含める。表は省かない

### 8.3 メタデータ

```ts
interface Meta {
  // 詳細 §12.4 の項目に加えて
  advisories?: string[]   // 直すアドバイザリの id（重複なし、順に並べる）。なければ空とみなす
}
```

- `packages` には、`changes` に加えて `transitiveFixes` も入れる。内容の変更の判定（詳細 §14.3）、閉じた PR との照合、内容の変更のコメント（詳細 §12.6）は、推移的依存も含めて今までどおり行う

## 9. 調整（reconciler.ts）

### 9.1 新しい操作

```ts
type Op =
  // 詳細 §14.1 の操作に加えて
  | { op: 'refresh'; pr: PrState; result: UnitResult }   // コミットは作り直さず、タイトル、本文、メタデータだけを更新する
```

両方あるとき（詳細 §14.3 の表）の「どれでもない → `none`」の直前に、次の行を足す。

| 条件 | 操作 |
|---|---|
| メタデータの `advisories` と、結果の `advisories` の id の集合が違う | `refresh` |

- 再生成の条件のどれかに当てはまれば、`regenerate` が新しい `advisories` を書くので、`refresh` は要らない
- 人手のコミットがある PR は、今までどおり `notifyManual` が先に決まり、`refresh` しない

### 9.2 実行

- `refresh`: タイトルと本文を `PATCH /pulls/{n}` で更新する。メタデータは、`advisories` だけを新しくし、ほかの項目（`commit`、`previous`、`baseHash`、`configHash`、`packages`）は今のメタデータのまま書く。post_update のコマンドは実行しない。本文の `` Files changed by the `post_update` commands: <n> `` の行（詳細 §12.3）は、今の本文から `<n>` を読み取って同じ値で書く（今の本文になければ入れない）。コメントはしない。チェックボックスの状態は変えない（チェックされていれば `regenerate` が先に決まるので、ここでは常に未チェック）
- ジョブのログには `Refresh #<n> (<branch>): security advisories changed` を出す。ジョブサマリーの操作は `refreshed`

## 10. ジョブサマリー

`fixes` が空でなければ、詳細 §16 の「最新版に上げられない直接依存」の後に、表 `Security advisories` を足す。

| Package | Locked | Advisories | Status |
|---|---|---|---|

- 行は `fixes` のパッケージ名の順。Advisories は `id` を `, ` でつなぐ
- Status は次の順に決める

| 状況 | Status |
|---|---|
| `fix` がない、または `isIgnoredFix(name)` | `No fixed version` |
| このパッケージを直す結果があり、その PR の操作が `create`、`regenerate`、`refresh`、`none` のどれか（成功したもの） | `Fixed in #<n>`（複数なら `, ` でつなぐ。番号の順） |
| このパッケージを直す結果があり、その操作が `skip`（利用者が閉じた同じ内容の PR がある） | `Closed in #<n>` |
| このパッケージを直す結果があり、その操作がエラーになった | `Error` |
| それ以外 | `Cannot be fixed with the current constraints` |

## 11. テスト

### 11.1 単体

| 対象 | 確かめること |
|---|---|
| `parseAdvisories` | `withdrawn` の除外、`ecosystem` の大文字小文字、別のパッケージの `affected` の除外、形の誤りで例外、`url` の検証 |
| `validAdvisories` | `id` と `aliases` による `ignored_advisories` の照合 |
| `findFix` | バックポート（基本 §14.2 の例）、`retracted` の除外、プレリリースの除外、影響を受けないロック済みのバージョン（`undefined`）、修正版がない |
| `collectFixes` | `advisoriesUpdated` がなければアドバイザリを取りに行かない、取得の失敗で例外、pub.dev 以外のホストの項目を見ない |
| `RegistryProxy` の隠す判定 | §5 の表の各行 |
| `plan` | 要修正の推移的依存だけが U で変わるとき、`members` が空のマイナー・パッチグループができる（偽の `resolve`） |
| `applyUnit` | `transitiveFixes`、`advisories`、`early`、結果を捨てる条件 |
| render | 接頭辞、N、`transitive` の行、アドバイザリの表（`summary` の置き換えと切り詰め）、`early` の 1 文、メタデータの往復 |
| `decide` | `refresh` の条件と、`regenerate` と `notifyManual` が先に決まること |
| `execute` | `refresh` がコミットを作らず、post_update を実行せず、メタデータの `commit` と `previous` を保つこと |

### 11.2 フィクスチャー用サーバー

`test/e2e/fixtures.ts` を次のように変える。

- `FixtureVersion` に `retracted?: boolean` を足し、一覧の `versions[]` に `retracted: true` を出す
- `startFixtureServer()` の引数に `advisories?: Record<string, object[]>`（OSV の配列）を足す。パッケージにアドバイザリがあれば、一覧に `advisoriesUpdated` を入れ、`/api/packages/<name>/advisories` でそれを返す。なければ `advisoriesUpdated` を入れない（今は常に空の配列を返している）
- 実行中にアドバイザリを足す `addAdvisory(name, advisory)` を足す（`addVersion` と同じ）

### 11.3 ローカル E2E

テスト用プロジェクトの直接依存に、次のパッケージを足す。どれも初めは 1.0.0 しかなく、アドバイザリもないので、場面 1〜11 の結果は変わらない。

| パッケージ | 初めの版 |
|---|---|
| `fx_vuln`（`^1.0.0`） | 1.0.0 |
| `fx_parent`（`^1.0.0`。1.0.0 は `fx_child ^1.0.0` を要求） | 1.0.0 |
| `fx_child`（推移的依存） | 1.0.0 |
| `fx_late`（`^1.0.0`） | 1.0.0 |

場面 11 の後に、次の場面を足す。

12. アドバイザリ: `fx_vuln` に 1.1.0（30 日前）と 1.0.1（1 日前）、`fx_child` に 1.0.1（1 日前）、`fx_late` に 2.0.0（30 日前）を足す。`fx_vuln` に 1.0.0 と 1.1.0 が影響を受けるアドバイザリ、`fx_child` に 1.0.0 が影響を受けるアドバイザリを足して実行すると、次のようになる
    - マイナー・パッチグループの PR が作られ、タイトルは `[Security] Update minor and patch (2 packages)`、表は `fx_vuln` 1.0.0 → 1.0.1（direct）と `fx_child` 1.0.0 → 1.0.1（transitive）。本文の先頭にアドバイザリの表があり、To の列に公開日が入る。影響を受ける `fx_vuln` 1.1.0 は選ばれない
    - `fx_late` の単独 PR（`Update fx_late from 1.0.0 to 2.0.0`）が作られる。接頭辞はない
    - ジョブサマリーのアドバイザリの表で、2 つとも `Fixed in #<マイナー・パッチグループの番号>`
13. あとから出たアドバイザリ: `fx_late` に 1.0.0 だけが影響を受けるアドバイザリを足して実行すると、`fx_late` の単独 PR のタイトルが `[Security] Update fx_late from 1.0.0 to 2.0.0` になり、本文にアドバイザリの表が入り、メタデータの `advisories` が増える。head は変わらず、内容の変更のコメントも出ない

GitHub E2E は変えない。本物の GitHub でしか分からない新しい挙動はないため。

## 12. 確認済みのこと・未確認のこと

- 確認済み: 基本 §14.2 の「確かめたこと」（pub のソース、pub.dev の API の形、試作での解決の結果）
- 未確認: `retracted` の修正版を飛ばしたときの pub の動き（pub は取り下げた版を選ばないので、見せても選ばれない見込み）、要修正の推移的依存だけのマイナー・パッチグループの適用（試作では `applyUnit()` が結果を捨てた）、本文とジョブサマリーの表示。どれもローカル E2E（§11.3）で確かめる

## 13. 詳細設計への取り込み

実装したら、詳細設計を次のように直し、このファイルを消す。

- §2: `advisories.ts` を足す
- §3: 手順 7a、7b（§3）
- §9: 隠す判定の表、`upstreamListing`、`setFixes`、`isIgnoredFix`（§5）
- §10、§11: §6、§7
- §12: §8
- §14: §9
- §16: §10
- §17: §11
- 新しい節「セキュリティアドバイザリ（advisories.ts）」: §4
