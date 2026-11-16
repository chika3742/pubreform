# pubreform 詳細設計: Flutter SDK の更新

> ステータス: 詳細設計のみ（2026-11-16。未実装）。[Flutter SDK の更新の基本設計](flutter-sdk-design.md)を前提に、実装に必要な決定を書く。節の番号だけの参照（§n）はこの文書の節を指す。ほかの設計書の節は、「基本 §n」（[基本設計](design.md)）、「詳細 §n」（[詳細設計](detailed-design.md)）、「F 基本 §n」（Flutter SDK の更新の基本設計）と書く。挙動を変えるときは、先に設計書を直す。実装したら、この文書の内容を詳細設計に移すかどうかを決める。

## 1. 方針

- Flutter の更新単位を、今の更新単位（`Unit` / `UnitResult`）の 1 種類として扱う。調整、コミット、PR 操作、エラー処理は今のコードをそのまま通し、違うところだけを足す
- pub の解決は、今と同じ `Pub`（詳細 §8）と中継サーバー（詳細 §9）を使う。違うのは、作業ディレクトリと、そこに置く `.fvmrc` だけ
- リリース一覧の解釈、更新先の選択、ファイルの書き換え、適用を省く判定は純粋関数にして、単体テストできる形にする

## 2. モジュールと変更点

| ファイル | 変更 |
|---|---|
| `src/flutter.ts`（新規） | リリース一覧の取得と解釈、更新先の選択（§5）。`.fvmrc`、`.vscode/settings.json`、`environment` の書き換え（§6）。Flutter の更新単位の計画（§7.3）。更新履歴の取得（§10） |
| `src/config.ts`、`pubreform.schema.json` | 設定 `flutter`（§4） |
| `src/planner.ts` | `UnitKind` に `flutter` を足す |
| `src/applier.ts` | `UnitResult.flutter`、`flutter` の単位のコマンド、結果を捨てない条件（§7.4） |
| `src/render.ts` | ブランチ名、タイトル、コミットメッセージ、本文、メタデータ、コメント（§9） |
| `src/github.ts` | コミットに `.fvmrc` と `.vscode/settings.json` を入れる（§11） |
| `src/reconciler.ts` | 適用を省く判定 `decideFlutter`（§8）、`decide` と `execute` の変更（§12） |
| `src/generate.ts` | Flutter の単位の生成用ディレクトリと SDK（§13） |
| `src/main.ts` | 全体の流れ（§3）、ジョブサマリー（§15） |
| `README.md` | 設定 `flutter`、PR の種類、更新されるファイルの説明 |
| `CLAUDE.md` | 結合テストに要る Flutter のバージョン（§16） |

## 3. 全体の流れ（main.ts）

詳細 §3 の流れを、次のように変える（**太字**が変更点）。

```
1〜4. 今と同じ
5. pubspec.yaml / pubspec.lock / .fvmrc を読む。**.vscode/settings.json も読む（なければなし）**
5a. **Flutter の更新が有効か（§5.1）を決める。有効なら、リリース一覧を取得し、更新先 T と待機中のバージョンを求める（§5）**
    **一覧を取得できなければ全体エラー**
6. slot と cutoff を求める（5a の T の選択より前に行う）
6a. **既存 PR を集める（今の手順 10 をここに移す）**
7〜9. 今と同じ（中継サーバー、アドバイザリ、パッケージの計画と適用）
9a. **T があれば、適用を省くかを決める（§8）。省かないなら、Flutter の更新単位を計画して適用する（§7）**
    **成功したら、更新履歴を取得する（§10）**
10. （6a に移した）
11. 操作を決める。**9a で省いた場合の操作を足す（§12）**
12〜13. 今と同じ。**ジョブサマリーに Flutter の節を足す（§15）**
```

- 6a に移すのは、適用を省く判定（§8）に既存 PR が要るため。PR の取得に失敗したら、今と同じく全体エラーになる（PR はまだ変更していない）
- 9a は中継サーバーが動いている間に行う。パッケージの単位の適用（手順 9）の後にする
- 9a の失敗は、Flutter の単位のエラーとして `unitErrors` に入れる（§14）。単位は `{ kind: 'flutter', members: [], targets: {} }`

## 4. 設定（config.ts）

詳細 §4.1 の表に、次を足す。

| キー | 型 | 既定値 | 検証 |
|---|---|---|---|
| `flutter` | map | `{}` | 知らないキーはエラー |
| `flutter.enabled` | boolean | `true` | 真偽値 |
| `flutter.versioning` | `increase` \| `lockfile-only` | トップレベルの `versioning` の値 | 列挙値 |
| `flutter.reapply` | `on-change` \| `always` | `on-change` | 列挙値 |

```ts
interface Config {
  // …
  flutter: { enabled: boolean; versioning: Versioning; reapply: 'on-change' | 'always' }
}
```

- `Config.flutter.versioning` には、省略時の値（トップレベルの `versioning`）を補って入れる。`configHash`（詳細 §4.3）は補った後の設定から計算するので、`flutter.versioning` を省略していても、トップレベルの `versioning` を変えるとハッシュが変わる
- `flutter` のどのキーを変えても `configHash` が変わり、すべての PR が作り直される（基本 §7.2）。`reapply` だけを変えた場合も同じ
- `Config` に `flutter` が増えるので、このバージョンに上げた最初の実行では、すべての PR が 1 回作り直される（詳細 §19.2 の `post_update` のときと同じ）
- `pubreform.schema.json` に同じ構造を足し、`test/config-schema.test.ts` に例を足す

## 5. リリース一覧と更新先（flutter.ts）

### 5.1 有効かどうか

次をすべて満たすとき、Flutter の更新が有効である。満たさなければ、一覧を取得せず、Flutter については何もしない（open の Flutter の PR があれば、§12 のとおり閉じる）。

- `config.flutter.enabled` が `true`
- ベースに `.fvmrc` があり、JSON として読め、`flutter` が文字列で、`^\d+\.\d+\.\d+$` に合う

```ts
pinnedFlutter(fvmrc: string | undefined): string | undefined
```

`.fvmrc` が JSON として読めない、`flutter` がない場合も `undefined` を返す（エラーにしない。壊れた `.fvmrc` は、今までどおりパッケージの解決のところで fvm が失敗して全体エラーになる）。`3.47.7@stable` のようにチャンネルを付けた書き方や、フォーク（`<fork>/<version>`）は、正規表現に合わないので対象外になる。

### 5.2 取得と解釈

- `GET https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json`。30 秒で打ち切る。再試行はしない
- 成功以外の応答、JSON として読めない、`releases` が配列でない場合は全体エラー（`cannot get the Flutter releases: …`）
- テストのために、環境変数 `PUBREFORM_FLUTTER_RELEASES` があれば、その URL から取得する（`PUBREFORM_UPSTREAM` と同じ扱いで、README には書かない）

```ts
interface FlutterRelease { version: string; dart: string; released: Date }
parseReleases(json: unknown): FlutterRelease[]
```

`releases[]` のうち、次をすべて満たす要素だけを使う。満たさない要素は読み飛ばす（エラーにしない）。

- `channel` が `stable`
- `version` が `^\d+\.\d+\.\d+$` に合う（古いリリースの `v1.12.13+hotfix.9` のような形を除く）
- `dart_sdk_version` が `^\d+\.\d+\.\d+$` に合う
- `release_date` が日時として読める

同じ `version` が複数あれば、最初のものを使う。

### 5.3 更新先

```ts
interface FlutterTarget { from: string; to: string; dartFrom?: string; dartTo: string; released: Date }
chooseTarget(releases: FlutterRelease[], current: string, cutoff: Date):
  { target?: FlutterTarget; waiting?: { version: string; released: Date } }
```

- 候補: `compareVersions(version, current) > 0` のもの
- `target`: 候補のうち `released <= cutoff` で、バージョンが最大のもの。なければ `undefined`
- `waiting`: 候補のうち `released > cutoff` で、バージョンが最大のもの。ただし、`target` より新しいときだけ返す（ジョブサマリー用。§15）
- `dartFrom`: 一覧にある `current` の `dart`。`current` が一覧になければ `undefined`（本文の Dart の行を省く。§9.3）

## 6. ファイルの書き換え（flutter.ts）

どれも文字列を受け取って文字列を返す純粋関数にする。変わらなかったファイルは、コミットに入れない。

### 6.1 `.fvmrc`

```ts
rewriteFvmrc(text: string, from: string, to: string): string
```

1. `"flutter"\s*:\s*"<from>"` に最初に合うところの `<from>` を `to` に置き換える
2. 置き換えた後の文字列を JSON として読み、`flutter` が `to` で、ほかのキーが置き換える前と同じ（`JSON.stringify` で比べる）であることを確かめる。違えば例外にする（単位のエラー）

2 は、`flavors` の中に `"flutter"` という名前のフレーバーが先に書かれている、といった場合に、誤った場所を書き換えたままコミットしないためである。

### 6.2 `.vscode/settings.json`

```ts
rewriteVscodeSettings(text: string, from: string, to: string): string
```

- `"dart.flutterSdkPath"\s*:\s*"<パス>"` に合うところのうち、パスが `/<from>` か `\\<from>`（JSON の中のバックスラッシュ）で終わるものすべてについて、その `<from>` を `to` に置き換える
- JSONC として解釈はしない。コメントの中に同じ形の行があれば、それも置き換える（コメントアウトした設定も同じバージョンに保たれるだけで、害はない）
- 合うところがなければ、入力をそのまま返す（このファイルは変えない）
- ファイルがなければ、何もしない。新しく作ることはしない

### 6.3 `environment`

```ts
rewriteSdkConstraint(constraint: string, v: string, versioning: Versioning): string
rewriteEnvironment(pubspec: string, v: { flutter: string; dart: string }, versioning: Versioning): string
```

`rewriteSdkConstraint` は、制約を `parseConstraint`（詳細 §6）と同じ字句で比較の並びに分け、次の表で書き換えて、空白 1 つでつないで返す（F 基本 §4.2 の表と同じ内容）。

| 字句 | `increase` | `lockfile-only` |
|---|---|---|
| `any` | そのまま | そのまま |
| `x.y.z`（固定） | `v` | `v` |
| `^a` | `^v` | `allows('^a', v)` ならそのまま。そうでなければ `^v` |
| `>=a`、`>a`（下限） | `>=v` | `v` を許せばそのまま。そうでなければ `>=v` |
| `<=b`（上限） | `v` を許せばそのまま。そうでなければ `<=v` | 同じ |
| `<b`（上限） | `v` を許せばそのまま。そうでなければ、下の粒度で決めた境界 | 同じ |

`<b` を上げるときの境界は、`b` の書き方の粒度で決める。

| `b` | 新しい上限 |
|---|---|
| `X.0.0` | `<(v.major + 1).0.0` |
| `X.Y.0`（`Y > 0`） | `<v.major.(v.minor + 1).0` |
| それ以外 | `<v.major.v.minor.(v.patch + 1)` |

- 下限を上げた結果が元と同じなら、何も変わらない（すでに `v` 以上の下限だった、など）。下限が `v` より大きい（ベースがもともと解決できない状態）場合も、表のとおり `v` に合わせる
- プレリリースやビルドメタデータの付いた上限（`<3.48.0-0` など）は、数字の部分だけで粒度を決め、付いていたものは落とす

`rewriteEnvironment` は、`yaml` の `parseDocument` で `environment.sdk` と `environment.flutter` のスカラーを探し、ノードの `range`（開始位置と値の終了位置）で元の文字列を切り出して、その部分だけを差し替える。`doc.toString()` は使わない（書式が変わるため）。

- 引用符は元のまま使う。元が `"` か `'` で始まっていれば同じ引用符で囲み、そうでなければ囲まない。制約の書き方（固定、caret、範囲）を保つので、新しい値の先頭の文字の種類は元と同じになり、元の引用符の有無で YAML として正しく書ける
- 値の後ろのコメントと空白は、差し替える範囲の外なので残る
- キーがない、値が `null`、スカラーの種類が plain / 一重引用符 / 二重引用符のどれでもない（ブロックスカラーなど）、制約として読めない場合は、そのキーを書き換えない
- `sdk` には `v.dart`、`flutter` には `v.flutter` を使う

## 7. 解決と適用

### 7.1 作業ディレクトリ

Flutter の解決は、ベースの clone とは別のディレクトリ `$RUNNER_TEMP/pubreform/flutter` で行う。

1. ディレクトリを消してから、ベースの clone の `.git` から追跡しているファイルを書き出す（`git --git-dir=<base>/.git --work-tree=<base> checkout-index --all --prefix=<dir>/`。詳細 §19.4 の 2 と同じ）
2. `.fvmrc` を、書き換えた内容（§6.1）で上書きする
3. `new Pub({ dir, flutter, fvm: true, hostedUrl })` を作る（`flutter` は今と同じ `isFlutter(pubspec)`）

ベースの clone の `.fvmrc` を書き換えて使い回す方式は採らない。ベースの clone は、Flutter の解決の後にも SDK の特定（詳細 §19.5）などで使うので、`.fvmrc` を戻し忘れると、ほかの処理が新しい SDK で動いてしまうため。ディレクトリを分ければ、戻す処理が要らない。リポジトリの中の path 依存は、追跡しているファイルを書き出すので解決できる。

### 7.2 SDK の取得

`fvm flutter --version --machine` を、§7.1 のディレクトリで実行する（Dart だけのプロジェクトでも同じ。fvm が入れるのは Flutter SDK のため）。

- fvm は、`.fvmrc` のバージョンが入っていなければ自動で入れてから実行する（§17 で確認）。`fvm use` や、引数なしの `fvm install` は使わない。どちらもプロジェクトのディレクトリに `.fvm/` と `.gitignore` を書くため
- 出力の JSON の `frameworkVersion` が `T` と違えば、単位のエラーにする（fvm が別のバージョンを使っていないかの確認）
- ジョブのログでは、`Install Flutter <T>` のグループにする
- 失敗（終了コードが 0 でない、JSON として読めない）は、単位のエラー

pub の最初の実行に取得を任せる（`fvm flutter pub get` も自動で入れる）こともできるが、分けておく。取得の失敗と解決の失敗がログとエラーで区別でき、取得にかかった時間がログで分かるため。

### 7.3 計画（planFlutter）

```ts
planFlutter(input: {
  deps: DirectDep[]
  pubspec: string     // environment を書き換えた後のベースの pubspec（§6.3）
  resolve: Resolve    // §7.1 の Pub で解決する。lockfile はベースのもの
}): Promise<{ unit: Unit } | { unresolvable: string }>
```

```
範囲(d) = 詳細 §10.1 と同じ（固定なら '^' + c(d)）

try   resolve(['get'], pubspec)                       // 手順 1
      return { unit: { kind: 'flutter', members: [], targets: {} } }
catch 解決の失敗でなければ、そのまま投げる

try   L = resolve(['get'], withConstraints(pubspec, { d: '>=' + c(d) for d in deps }))   // 手順 2
catch 解決の失敗なら return { unresolvable: solveFailure(メッセージ) }。そうでなければ投げる

K     = { d in deps : !allows(範囲(d), L(d)) }
moved = { d in deps − K : d は固定, L(d) != c(d) }
return { unit: { kind: 'flutter', members: K を名前の順に, targets: { d: L(d) for d in K ∪ moved } } }
```

- **解決の失敗**: 例外のメッセージに `version solving failed.` を含むもの（詳細 §10.2 の `reason` と同じ見分け方）。`environment` の制約が合わないときの失敗も、この文を含む（§17 で確認）。それ以外の失敗（ネットワーク、fvm の失敗など）は単位のエラーにする
- `unresolvable` の文は、`solveFailure()`（詳細 §10.2）で作る。手順 2 の失敗の説明を使う。手順 2 は直接依存をすべて緩めているので、その説明に出るのは、制約を緩めても解決できない原因である
- 詳細 §10.1 の `closure` のような反復はしない。手順 2 の解 `L` は、`K` を `L` のバージョンにした後の `pubspec.yaml` の制約をすべて満たすので、1 回で決まる
- `deps` が空（pub.dev の直接依存がない）なら、手順 2 の書き換えは何も変えない。手順 1 と同じ解決をもう 1 回行うことになるが、結果は同じ失敗になり、`unresolvable` を返す
- 手順 1 が成功したときも、直接依存が範囲の中で動いていることがある（caret 制約の依存を、新しい SDK が要求するバージョンに pub が上げた場合）。これは適用後の lockfile の差分で `changes` に入る（§7.4）

### 7.4 適用（applier.ts）

`planFlutter` が返した単位を、今の `applyUnit` で適用する。

```ts
interface FlutterChange {
  from: string
  to: string
  dartFrom?: string
  dartTo: string
  /** .fvmrc と、変わった場合の .vscode/settings.json。 */
  files: { path: string; content: string }[]
  /** 抜き出した更新履歴（§10）。取得できなければなし。 */
  changelog?: string
}
interface UnitResult {
  // …
  flutter?: FlutterChange
}
```

| 変更 | 内容 |
|---|---|
| `applyArgs` | `flutter` の単位は、`targets` が空なら `[['get']]`、空でなければ `[['add', ...specs]]`（spec の作り方は single / group と同じ） |
| `applyUnit` の引数 | `base` には `{ pubspec: environment を書き換えた pubspec, lock: ベースの lockfile }` を、`pub` には §7.1 の `Pub` を渡す。`flutter: FlutterChange` を渡すと、結果にそのまま入れる |
| 結果を捨てる条件 | `flutter` の単位は、`changes` と `transitiveFixes` が空でも捨てない（Flutter の更新そのものが内容のため） |

- `targets` が空のときに `pub get` をもう 1 回実行するのは、手順 1 の結果をそのまま使う経路を別に作らないためである。同じ入力なので同じ結果になり、1 秒ほどで終わる（§17）
- `changes` は、今までどおりベースと結果の lockfile の差分で求める。一緒に上げた直接依存（`K`）と、範囲の中で動いた直接依存の両方が入る
- 範囲の中で動いた caret 制約の依存の `pubspec.yaml` は書き換えない（`flutter.versioning: increase` でも下限を上げない）。`increase` が効くのは `environment` だけである
- セキュリティアドバイザリの判定（`transitiveFixes`、`advisories`）は、今のまま働く

## 8. 適用を省く判定（reconciler.ts）

```ts
decideFlutter(
  target: FlutterTarget,
  openPrs: PrState[],
  closedPrs: PrState[],
  ctx: DecideContext,
  reapply: 'on-change' | 'always',
): 'apply' | Op
```

上から順に、最初に当てはまるもので決める。`pr` は、ブランチが `pubreform/flutter` の open の PR。

| 条件 | 結果 |
|---|---|
| `pr` がなく、`kind` が `flutter` で、`meta.flutter[1]` が `target.to` と同じで、`meta.closed` がない、未マージの closed PR がある | `{ op: 'skip', closedPr }` |
| `pr` がない | `'apply'` |
| `reapply` が `always` | `'apply'` |
| `pr` にメタデータがない、または `meta.flutter?.[1]` が `target.to` と違う | `'apply'` |
| `meta.baseHash` か `meta.configHash` が今回の値と違う | `'apply'` |
| チェックボックスがチェック済み | `'apply'` |
| `mergeable == false` かつ `mergeableState == 'dirty'` | `'apply'` |
| `meta.previous` があり、`headSha` がそれと同じ（前回の再生成が途中で止まった） | `'apply'` |
| `headSha` が `meta.commit` と違う（人手のコミットがある） | `{ op: 'notifyManual', pr }` |
| どれでもない | `{ op: 'none', pr }` |

- `'apply'` 以外を返したら、SDK を入れず、§7 を行わない。返した操作を、`decide` の結果に足す。`decide` には、その PR を除いた `openPrs` を渡す（計画にない PR として閉じられないようにするため）
- `'apply'` を返したら、§7 の結果（成功なら `results`、失敗なら `unitErrors`）を今までどおり `decide` に渡す。`flutter` の単位は、ブランチ名で PR と対応する（詳細 §14.2 の 1）。`always` のときに人手のコミットがある PR は、今までどおり `decideBoth` が `notifyManual` に決める
- 1 行目（利用者が閉じた PR）は、`reapply` にかかわらず判定する。一緒に上げる直接依存は見ない（F 基本 §7）
- このために、`skip` と `notifyManual` の `result` を省略できるようにする（§12）

## 9. 文面とメタデータ（render.ts）

### 9.1 ブランチ名とタイトル

| 種類 | ブランチ | タイトル |
|---|---|---|
| flutter | `pubreform/flutter` | `Update Flutter from <from> to <to>` |

`advisories` が空でなければ、タイトルの前に `[Security] ` を付ける（今と同じ）。一緒に上げる直接依存があっても、タイトルは変えない。

### 9.2 コミットメッセージ

タイトル、空行、Flutter と Dart の表。`changes` か `transitiveFixes` があれば、空行をはさんで今と同じパッケージの表（詳細 §12.2）を続ける。

```
Update Flutter from 3.47.7 to 3.50.0

| | From | To |
|---|---|---|
| Flutter | 3.47.7 | 3.50.0 |
| Dart | 3.13.5 | 3.14.0 |

| Package | From | To | Type |
|---|---|---|---|
| test | 1.31.1 | 1.32.0 | dev |
```

`dartFrom` がなければ、Dart の行を省く（本文も同じ）。

### 9.3 本文

F 基本 §6.2 のテンプレートに従う。上から次の順に並べる。

1. アドバイザリの表（`advisories` があるとき。詳細 §12.3）
2. `Updates Flutter.` と、Flutter と Dart の表
3. `Updates the following packages together, because the new Flutter requires them.` と、パッケージの表（`changes` か `transitiveFixes` があるとき。表は今と同じ）
4. `` Files changed by the `post_update` commands: <n> ``（あるとき）
5. Flutter の節
6. パッケージごとの節（今と同じ）
7. `---`、チェックボックス、メタデータ

Flutter の節:

```markdown
### Flutter 3.47.7 → 3.50.0

[Release](https://github.com/flutter/flutter/releases/tag/3.50.0)

<details>
<summary>Changelog</summary>

…

</details>
```

- `flutter.changelog` がなければ、`<details>` の代わりに `[Changelog](https://github.com/flutter/flutter/blob/flutter-<major>.<minor>-candidate.0/CHANGELOG.md)` の 1 行を載せる（ブランチは `to` のもの）
- 更新履歴の長さの上限（詳細 §12.3 の 50,000 文字）は、Flutter を 1 つと数えて、パッケージと等分する。超えたときは、行の境界で切って `…` の行と、上の `[Changelog](…)` と同じ URL の `[Full changelog](…)` の行を付ける。フェンスを閉じる処理（`closeFence`）も同じように通す
- 本文が 65,000 文字を超えたら、Flutter の節も `[Changelog](…)` の 1 行にする（今の規則と同じ）

### 9.4 メタデータ

```ts
interface Meta {
  // …
  kind: UnitKind            // 'flutter' が増える
  flutter?: [from: string, to: string]
}
```

```html
<!-- pubreform:meta {"v":1,"kind":"flutter","flutter":["3.47.7","3.50.0"],"packages":{"test":["1.31.1","1.32.0"]},"baseHash":"…","configHash":"…","commit":"…"} -->
```

- `packages` には、今までどおり `changes` と `transitiveFixes` を入れる（Flutter だけなら `{}`）
- `flutter` は、パッケージ名と混ざらないように別のキーにする。`packages` に `flutter` という名前で入れる方式は採らない。`packages` のキーはパッケージ名として、計画に失敗したパッケージとの照合やジョブサマリーのリンクに使われるため

### 9.5 コメント

内容が変わったとき（詳細 §12.6）の表に、Flutter の行を先頭に足す。Flutter の更新先が変わっていなくても載せる。

```markdown
The update in this PR has changed.

| Package | Before | After |
|---|---|---|
| Flutter | 3.47.7 → 3.47.9 | 3.47.7 → 3.50.0 |
| test | – | 1.31.1 → 1.32.0 |
```

新しい SDK で解決できなくなって閉じるとき（§12）:

````markdown
Closing: Flutter <T> does not resolve with the dependencies of this project.

<details>
<summary>Reason</summary>

```
<unresolvable の文>
```

</details>
````

コードブロックの区切りは、エラーコメント（詳細 §12.6）と同じく、文中のバッククォートの最長の連続より 1 本長くする。

## 10. 更新履歴の取得（flutter.ts）

```ts
fetchFlutterChangelog(releases: FlutterRelease[], from: string, to: string): Promise<string | undefined>
```

1. `releases` から、`from < v <= to` のバージョンを求め、そのマイナー（`major.minor`）の集合を作る
2. マイナーごとに、`https://raw.githubusercontent.com/flutter/flutter/flutter-<major>.<minor>-candidate.0/CHANGELOG.md` を取得する（認証なし。30 秒で打ち切る）
3. 各ファイルから、`extractChangelog`（詳細 §12.3）と同じ見出しの判定で、`from < v <= to` で、かつそのブランチのマイナーのバージョンの節だけを取る。ほかのマイナーの節は、そのマイナーのブランチから取るので捨てる
4. 節の末尾にある `## Flutter <x.y> Changes` の行（次のマイナーのまとまりの見出し）を除く。x.y.0 の節は、ファイルの中で次のマイナーの見出しの直前にあるため（§17 で確認）
5. マイナーの新しい順につなぐ（ファイルの中の順と同じ、新しい版が先）
6. `withoutBacklinks(text, 'https://github.com/flutter/flutter')`（詳細 §12.3）を通す。Flutter の更新履歴は Issue へのリンクを多く含むので、PR からの参照が付かないようにするため

- 取得できないブランチがあれば、そのマイナーの節を載せずに続ける。1 つも節を取れなければ `undefined` を返す（エラーにしない）
- テストのために、環境変数 `PUBREFORM_FLUTTER_CHANGELOG` があれば、`https://raw.githubusercontent.com/flutter/flutter` の代わりにその URL を使う（`<URL>/<ブランチ>/CHANGELOG.md`）
- 取得するのは、Flutter の単位の適用が成功したとき（手順 9a）。適用を省いた実行では取得しない。本文を書かない操作（`none`）になる実行でも取得するが、数回の取得で済むので分けない

## 11. コミット（github.ts）

`createCommit` に `extra?: { path: string; content: string }[]` を足し、tree に `mode: 100644` の項目として入れる。`execute` は `result.flutter?.files` を渡す。

- `.fvmrc` と `.vscode/settings.json` が、ベースで通常のファイル以外（シンボリックリンク、実行権限付き）だった場合は扱わない。通常のファイルとしてコミットする

## 12. 調整（reconciler.ts）

`Op` の変更:

```ts
| { op: 'notifyManual'; pr: PrState; result?: UnitResult }                  // result を省略できるようにする
| { op: 'skip'; result?: UnitResult; closedPr: PrState }                    // 同上
| { op: 'close'; pr: PrState; supersededBy?: string; unresolvable?: FlutterUnresolvable } // unresolvable: §9.5 のコメントにする

interface FlutterUnresolvable { version: string; reason: string } // version: T、reason: planFlutter の unresolvable
```

`decide` の変更（引数に `flutterUnresolvable?: FlutterUnresolvable` を足す。§9.5 のコメントに `T` を書くので、説明の文と一緒に `T` も渡す）:

| 箇所 | 変更 |
|---|---|
| 単位があり、PR がない | `flutter` の単位は、closed の PR との照合をしない（§8 で済んでいる）。今の照合は `packages` を比べるので、Flutter だけの PR どうしは `packages` が `{}` で同じになり、別の更新先の閉じた PR にも合ってしまう |
| `decideBoth` の `contentChanged` | `flutter` の単位は、`packages` の比較に加えて、`meta.flutter?.[1]` が `result.flutter.to` と違うときも真にする |
| PR があり、単位がない | ブランチが `pubreform/flutter` の PR は、パッケージの `uncertain` と `failed` を見ずに `close` にする（Flutter の単位が失敗した場合は、単位のエラーとして PR と対応しているので、ここには来ない）。`flutterUnresolvable` があれば、`close` に `unresolvable` を付ける |
| `supersededBy` | ブランチが `pubreform/flutter` の PR には付けない。`flutter` の単位は、ほかの PR の引き継ぎ先にもしない |

`execute` の変更:

- `commit`: `createCommit` に `extra: result.flutter?.files` を渡す
- `Outcome`: `kind` に `flutter` が増える。`result` のない `skip` と `notifyManual` では、`packages` を PR のメタデータから取る（`prPackages`）。`kind` は `flutter`
- `regenerate` のコメント: `flutter` の単位は §9.5 の表にする
- `close`: `unresolvable` があれば §9.5 のコメントにする
- ジョブのログ: `Create a pull request (flutter: 3.47.7 → 3.50.0) on pubreform/flutter` のように、パッケージの代わりにバージョンを書く

## 13. 更新後のコマンド（generate.ts）

`Generator.generate(result)` を、`result.flutter` があるときだけ次のように変える。

1. 追跡しているファイルを生成用ディレクトリに書き出した後、`pub get --offline` の前に、`result.flutter.files` を書く。ベースの `.fvmrc` のままだと、`fvm flutter pub get --offline` がベースの SDK で動き、書き換えた `environment` と合わずに失敗する（§17 で確認）
2. SDK は、生成用ディレクトリで `findSdk` を実行して求める（`.fvmrc` が `T` なので、`T` の SDK のルートが返る）。実行の最初に求めたベースの SDK（詳細 §19.5）は使わない
3. 変わったファイルの取り出し（詳細 §19.6 の 2）で、`pubspec.yaml` と `pubspec.lock` に加えて、`result.flutter.files` のパスも除く。これらは適用の結果を使う。コマンドが書き換えても反映しない

SDK は §7.2 で入れてあるので、ここで取得は起きない。

## 14. エラー処理

| 発生箇所 | 扱い |
|---|---|
| リリース一覧の取得と解釈（§5.2） | 全体エラー |
| `rewriteFvmrc` の確認の失敗（§6.1）、作業ディレクトリの用意、SDK の取得（§7.2）、`planFlutter` と `applyUnit` の解決以外の失敗 | Flutter の単位のエラー。`unitErrors` に入れ、PR があれば `commentError`、なければ `error`（詳細 §14.3） |
| 新しい SDK で解決できない（`planFlutter` が `unresolvable` を返す） | エラーにしない。単位を作らず、ジョブサマリーに出す（§15）。open の PR があれば、§9.5 のコメントを付けて閉じる |
| 更新履歴の取得（§10） | エラーにしない |
| 更新後のコマンド、コミット、PR 操作 | 今と同じ（詳細 §15、§19.7） |

## 15. ジョブサマリー

- Pull requests の表: `flutter` の行は、Packages の列を `Flutter` と、一緒に上げる直接依存（リンク付き）にする
- Flutter の更新が有効（§5.1）で、`target`、`waiting`、解決できなかった記録のどれかがあれば、`Flutter SDK` の節を足す

| Current | Target | Status |
|---|---|---|
| 3.47.7 | 3.50.0 | Pull request #12 |

Status は、`kind` が `flutter` の `Outcome` から決める。

| 状況 | Status |
|---|---|
| `created`、`regenerated`、`refreshed`、`unchanged` | `Pull request #<n>` |
| `notified` | `Not updated in #<n> (manual commits)` |
| `skipped` | `Closed in #<n>` |
| `error` | `Error` |
| 解決できない | `Does not resolve`。表の下に、原因を整形済みテキスト（`<pre>`。エスケープする）で書く（最新版に上げられない直接依存と同じ形） |

- `target` がなく `waiting` だけがあるときは、表を出さない
- `waiting` があれば、`Waiting for the release age: Flutter <version> (published <日時>, used from <日時>)` の 1 行を足す。使われ始める時刻は、パッケージと同じ `firstSlotShowing` で求める

## 16. テスト

| 種類 | 対象 | 方法 |
|---|---|---|
| 単体 | `parseReleases`、`chooseTarget`、`pinnedFlutter`、`rewriteFvmrc`、`rewriteVscodeSettings`、`rewriteSdkConstraint`（§6.3 の表の各行と F 基本 §4.2 の例）、`rewriteEnvironment`（引用符とコメントが残ること）、`planFlutter`（偽の `resolve`）、更新履歴の統合（§10 の 3〜5）、render（タイトル、コミットメッセージ、本文、メタデータの往復、コメント）、`decideFlutter`（§8 の表の各行）、`decide`（§12 の表の各行）、設定とスキーマ | `bun test`。ネットワークは使わない |
| ローカル E2E | Action 全体 | 偽の fvm と偽の Flutter SDK で動かす（下記）。`test/e2e/flutter.test.ts` |
| 結合 | 本物の fvm と Flutter SDK での解決 | `PUBREFORM_IT=1` のときだけ。Flutter 3.47.7 と 3.50.0 を入れられることが要る |

### 16.1 ローカル E2E

今のローカル E2E（詳細 §17.1）は Dart だけで、外部に接続しない。Flutter SDK を 2 つ入れるとこの前提が崩れるので、fvm と Flutter SDK を偽物に置き換える。pub の解決は、今までどおり本物の `dart pub` が行う。

| 置き換えるもの | 置き換え先 |
|---|---|
| fvm | PATH の先頭に置くシェルスクリプト。カレントディレクトリの `.fvmrc` のバージョンを読み、`FLUTTER_ROOT` をそのバージョンの偽の SDK に向けて、PATH 上の `dart` を実行する（`fvm flutter pub …` と `fvm dart pub …` は `dart pub …` にする）。`fvm flutter --version --machine` には、`frameworkVersion`、`dartSdkVersion`、`flutterRoot` を持つ JSON を返す。呼ばれるたびに、バージョンと引数をログのファイルに追記する |
| Flutter SDK | バージョンごとのディレクトリ。`bin/cache/flutter.version.json`（`{"flutterVersion": "<バージョン>"}`）と、SDK のパッケージ `packages/fx_sdk_pkg/pubspec.yaml` を置く |
| リリース一覧、`CHANGELOG.md` | フィクスチャー用サーバーが配る。`PUBREFORM_FLUTTER_RELEASES` と `PUBREFORM_FLUTTER_CHANGELOG` で向ける |

- pub は、`FLUTTER_ROOT` の `bin/cache/flutter.version.json` を Flutter のバージョンとして読み、`environment.flutter` の判定に使う。`sdk: flutter` の依存は `FLUTTER_ROOT/packages/<名前>` から読む。偽の SDK のパッケージがフィクスチャーのパッケージを固定のバージョンで要求すれば、本物の Flutter と同じ「SDK が固定するバージョン」の状況を作れる（§17 で確認）
- 同梱の Dart のバージョンは偽れない（pub は実行中の Dart のバージョンを使う）。`environment.sdk` の書き換えは、PR の `pubspec.yaml` の文字列として確かめ、制約は実行中の Dart が満たすものにする（一覧の `dart_sdk_version` に、実行中の Dart 以下のバージョンを入れる）
- テスト用プロジェクト: `.fvmrc`（3.47.7。`flavors` を持つ）、`.vscode/settings.json`（コメント付きで `dart.flutterSdkPath` が `.fvm/versions/3.47.7`）、`environment` は `sdk: ^3.0.0`、`flutter: 3.47.7`。依存は `fx_sdk_pkg`（`sdk: flutter`）、`fx_user: 1.0.0`（固定）、`fx_range: ">=1.0.0 <1.1.0"`
- 偽の SDK: 3.47.7 の `fx_sdk_pkg` は `fx_pin: 1.0.0` と `fx_pin2: 1.0.0` を、3.50.0 のものは `fx_pin: 1.1.0` と `fx_pin2: 1.1.0` を要求する。`fx_user` 1.0.0 / 1.1.0 は `fx_pin` 1.0.0 / 1.1.0 を、`fx_range` 1.0.0 / 1.1.0 は `fx_pin2` 1.0.0 / 1.1.0 を要求する
- リリース一覧: 3.47.7（60 日前）、3.47.8、3.50.0（どちらも 30 日前）、3.51.0（1 日前。`min_release_age_days: 3`）、beta の 3.52.0-0.1.pre

場面（前の場面の状態を引き継ぎ、順に実行する）:

1. 作成: `pubreform/flutter` の PR が作られる。タイトルは `Update Flutter from 3.47.7 to 3.50.0`。コミットに、`.fvmrc`（`flavors` が残る）、`.vscode/settings.json`（コメントが残る）、`pubspec.yaml`（`flutter: 3.50.0`、`fx_user: 1.1.0`、`fx_range: ^1.1.0`）、`pubspec.lock` が入る。本文に Flutter と Dart の表、パッケージの表、2 つのブランチから取った更新履歴、メタデータの `flutter` がある。ジョブサマリーに 3.51.0 が待機中と出る
2. 何も変わらない（`on-change`）: もう一度実行すると、PR の head は変わらず、偽の fvm のログに 3.50.0 での呼び出しがない
3. `always`: 設定を `reapply: always` にして実行すると、PR が再生成される（設定の変更）。もう一度実行すると、偽の fvm が 3.50.0 で呼ばれ、PR は変わらない
4. `increase` と `lockfile-only`: `environment` を範囲（`flutter: ">=3.47.0 <3.48.0"`）にしたベースで、`flutter.versioning` ごとに `pubspec.yaml` の結果を確かめる
5. 人手のコミット（`on-change`）: PR のブランチにコミットを足して実行すると、通知のコメントが 1 回だけ出て、偽の fvm は 3.50.0 で呼ばれない
6. 利用者がクローズ: PR をマージせずに閉じて実行すると、PR は作られず、偽の fvm は 3.50.0 で呼ばれない。一覧に 3.50.1（30 日前）を足して実行すると、3.50.1 への PR が作られる
7. 解決できない: 3.50.2（30 日前）を足し、その偽の SDK が存在しない `fx_pin: 9.9.9` を要求するようにして実行すると、3.50.1 の PR が §9.5 のコメントで閉じられ、ジョブは成功し、ジョブサマリーに原因が出る
8. 無効: `flutter.enabled: false` にして実行すると、リリース一覧を取得しない（フィクスチャー用サーバーに要求が来ない）
9. 更新後のコマンド（`test/e2e/post-update.test.ts` に足す。Docker が要る）: Flutter の PR のコミットに、新しい SDK で動かした生成結果が入る。コンテナの `FLUTTER_ROOT` が 3.50.0 の偽の SDK を指す

今のローカル E2E（`.fvmrc` のないプロジェクト）は変えない。Flutter の更新が有効にならないので、リリース一覧を取得せず、外部に接続しないままである。

GitHub E2E（詳細 §17.2）は変えない。本物の GitHub でしか分からない新しい挙動はないため（コミットに入るファイルが増えるだけで、使う API は同じ）。

### 16.2 結合テスト

`test/integration.test.ts` に足す。本物の fvm、Flutter 3.47.7 と 3.50.0、pub.dev を使い、リリース一覧だけは固定のものを渡す（新しい安定版が出ても結果が変わらないようにするため）。§17 の 3 つの場合（`test` の制約が `^1.31.1`、`1.31.1`、`>=1.31.1 <1.32.0`）について、`planFlutter` と `applyUnit` の結果が §17 の表のとおりになることを確かめる。`test` 1.32.0 だけが `test_api` 0.7.14 を要求するので、pub.dev に新しい版が出ても結果は変わらない。

## 17. 確認済みのこと

2026-11-16 に、fvm 4.3.2、Flutter 3.47.7（Dart 3.13.5）と 3.50.0（Dart 3.14.0）、pub.dev で確かめた。`CI=true` で実行した（fvm は git のミラーを使わずに直接 clone する）。

**fvm**

- `.fvmrc` を 3.47.7 から 3.50.0 に書き換えたディレクトリで `fvm flutter pub get` を実行すると、fvm が 3.50.0 を自動で入れてから実行した。プロンプトは出なかった。取得と最初の実行の準備（Dart SDK などのダウンロード）を合わせて 86 秒、SDK は 1.6 GB だった（この環境での値。GitHub のランナーでは測っていない）
- `fvm flutter pub get` と `fvm flutter --version --machine` は、プロジェクトのディレクトリに `.fvm/` も `.gitignore` も書かなかった。引数なしの `fvm install` は、`.fvm/`（`flutter_sdk` へのリンク、`fvm_config.json` など）と `.gitignore` を書いた
- `fvm flutter --version --machine` の出力に、`frameworkVersion`（`3.50.0`）、`dartSdkVersion`（`3.14.0`）、`flutterRoot`（`~/fvm/versions/3.50.0`）があった

**新しい SDK での解決**（表の 3 つの場合と cutoff を変えた場合は、本物の `Pub` と `RegistryProxy` を通した。cutoff は 2026-11-13。その前の 2 点は、pub.dev に直接つないだ）

- `environment` を書き換えずに 3.50.0 で `pub get` すると、`Because app requires Flutter SDK version 3.47.7, version solving failed.` で失敗した（`version solving failed.` を含む）
- `flutter: 3.50.0` に書き換え、ベースの lockfile を残して `pub get` すると、動いたのは新しい SDK が要求するものだけだった（`test_api` 0.7.12 → 0.7.14、推移的依存 `listen` の追加、`sdks` の `flutter`）。所要時間は 1 秒だった
- Flutter 3.47.7 の `flutter_test` は `test_api: 0.7.12` を、3.50.0 のものは `0.7.14` を固定で要求する。`test` 1.31.1 は `test_api` 0.7.12 を、1.32.0 は 0.7.14 を固定で要求する。これを使い、`dev_dependencies` の `test` の制約を変えて §7.3 と §7.4 の手順を試した

| `test` の制約 | 手順 1 | 手順 2 | `pub add` に渡したもの | 結果の `pubspec.yaml` |
|---|---|---|---|---|
| `^1.31.1` | 成功。`test` が 1.32.0 に動いた | 行わない | なし（`pub get`） | `test: "^1.31.1"`（変わらない） |
| `1.31.1`（固定） | 解決の失敗 | 成功。`K` は空、`moved` は `test` | `dev:test:1.32.0` | `test: 1.32.0` |
| `>=1.31.1 <1.32.0` | 解決の失敗 | 成功。`K` は `test` | `dev:test:^1.32.0` | `test: ^1.32.0` |

- どの場合も、lockfile の変化は `test` 1.31.1 → 1.32.0、`test_api` 0.7.12 → 0.7.14、`test_core` 0.6.18 → 0.6.20 だった。下の 2 つでは、`pub add` の結果が手順 2 の解と同じだった。`pubspec.yaml` のコメントと、ほかの依存の書き方は残った
- cutoff を 2026-08-01 にして `test_api` 0.7.14（2026-09-02 公開）を隠すと、手順 1 も手順 2 も `Because every version of flutter_test from sdk depends on test_api 0.7.14 which doesn't match any versions, flutter_test from sdk is forbidden.` で失敗した（`version solving failed.` を含む）。新しい SDK が要求するバージョンが待機期間で隠れると、解決できない扱いになる。更新先を cutoff 以前のリリースに限るので、通常は起きない（Flutter 3.50.0 が要求する `test_api` 0.7.14 は、3.50.0 の 2 か月前に公開されている）

**更新後のコマンド**（Docker 29.9.2）

- 生成用ディレクトリの `.fvmrc` がベースのままだと、`fvm flutter pub get --offline` は 3.47.7 で動き、`Because app requires Flutter SDK version 3.50.0, version solving failed.` で失敗した
- `.fvmrc` を 3.50.0 にすると `pub get --offline` は成功し、生成用ディレクトリでの `findSdk` は 3.50.0 のルートを返した。そのルートをマウントしたコンテナ（詳細 §19.5 の引数。`--network none`）で `dart run` が Dart 3.14.0 で動き、`FLUTTER_ROOT` は 3.50.0 のルートで、SDK には書き込めなかった

**偽の SDK**（Dart 3.14.0、フィクスチャー用サーバー）

- `FLUTTER_ROOT` を、`bin/cache/flutter.version.json` と `packages/fx_sdk_pkg/pubspec.yaml` だけを置いたディレクトリに向けると、`dart pub get` は `sdk: flutter` の依存 `fx_sdk_pkg` をそこから解決し、lockfile に `source: sdk` で書いた。lockfile の `sdks` には `flutter` の制約が入った
- 偽の SDK のパッケージが `fx_pin: 1.1.0` を要求し、固定した直接依存 `fx_user: 1.0.0` が `fx_pin: 1.0.0` を要求する状態では、本物の Flutter と同じ文面（`fx_pin is pinned to version 1.1.0 by fx_sdk_pkg from the flutter SDK.` と `version solving failed.`）で失敗し、`fx_user` を `>=1.0.0` に緩めると `fx_user` 1.1.0 と `fx_pin` 1.1.0 に解決した
- `.fvmrc` を読んで `FLUTTER_ROOT` を切り替えるシェルスクリプトを `fvm` として PATH に置くと、`fvm flutter pub get` がそのまま動いた

**書き換えと更新履歴**

- `yaml` 2 の `parseDocument` で、`environment` のスカラーの `range` と種類（`PLAIN`、`QUOTE_DOUBLE`、`QUOTE_SINGLE`）が取れ、その範囲だけを差し替えると、引用符、後ろのコメント、空白が残った
- 今の `extractChangelog` は、Flutter の `CHANGELOG.md` の見出し（`### [3.47.9](…)`）をバージョンの見出しとして読めた。`flutter-3.50-candidate.0` からは 3.50.0 の節（末尾に `## Flutter 3.47 Changes` の行が付く）が、`flutter-3.47-candidate.0` からは 3.47.9 と 3.47.8 の節が取れた。`withoutBacklinks` は Issue へのリンクを `redirect.github.com` に置き換えた

## 18. 未確認のこと

| 項目 | 内容 |
|---|---|
| GitHub のランナー | fvm による新しい SDK の取得にかかる時間とディスクの使用量。setup-fvm と組み合わせた実行。リリース一覧と `raw.githubusercontent.com` の取得 |
| `flutter.versioning: increase` | `sdk` の下限を上げた `pubspec.yaml` での本物の解決（`sdk: ^3.14.0` は、制約の判定を偽の `FLUTTER_ROOT` と Dart 3.14.0 で確かめただけ。F 基本 §11） |
| Dart だけのプロジェクト | `.fvmrc` のある Dart だけのプロジェクト（`fvm dart pub`）での解決。fvm のソースでは `fvm flutter` と同じ経路だが、動かしていない |
| リリースブランチの名前 | `flutter-<major>.<minor>-candidate.0` であることを確かめたのは 3.47 と 3.50 だけ。違うマイナーでは、更新履歴が取得できずリンクだけになる |
| 本文とジョブサマリーの表示 | 本物の GitHub での表示 |
| `.vscode/settings.json` の正規表現 | エスケープを含むパスなど、まれな書き方 |

## 19. 基本設計からの変更点

この詳細設計で、Flutter SDK の更新の基本設計の次の点を具体化・変更した。どれも基本設計に反映済み。

| 項目 | 基本設計 | 詳細設計 |
|---|---|---|
| 作業の場所 | 作業用ディレクトリの `.fvmrc` を `T` にする | ベースの clone とは別のディレクトリに追跡ファイルを書き出して使う（§7.1） |
| SDK の取得 | fvm で `T` の SDK を入れる | `fvm flutter --version --machine` を実行して、fvm の自動の取得に任せる。`fvm use` と `fvm install` は使わない（§7.2） |
| 適用 | 一緒に上げる直接依存を `pub add` する | 計画が返した単位を今の `applyUnit` で適用する。一緒に上げるものがなければ `pub get` をもう 1 回実行する（§7.4） |
| 解決の失敗の見分け方 | 詳細設計で決める | メッセージに `version solving failed.` を含むかで見分ける（§7.3） |
| `.vscode/settings.json` | 値の最後のパス要素が更新前のバージョンのときに置き換える | 合うところをすべて置き換える。コメントの中も置き換える（§6.2） |
| Dart の行 | 一覧の `dart_sdk_version` から書く | 更新前のバージョンが一覧になければ、Dart の行を省く（§9.2） |
| 解決できなくなった PR | 理由をコメントして閉じる | 専用のコメントに、pub の説明を載せる（§9.5） |
| 人手のコミットと `on-change` | 条件を満たせば適用しない | 適用せずに、通知のコメントだけを行う（§8） |
| 範囲の中で動いた直接依存 | 記述なし | `pubspec.yaml` は書き換えない。`increase` が効くのは `environment` だけ（§7.4） |
