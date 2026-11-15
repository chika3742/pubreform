# pubreform 基本設計: Flutter SDK の更新

> ステータス: 基本設計のみ（2026-11-15。未実装）。[基本設計](design.md) §14.4 の内容をこの文書に分けて書く。節の番号だけの参照（§n）はこの文書の節を指し、基本設計と詳細設計の節は「基本 §n」「詳細 §n」と書く。実装のための決定は、実装するときに[詳細設計](detailed-design.md)に書く。挙動を変えるときは、先にこの設計書を直す。

## 1. 概要

`.fvmrc` で固定している Flutter SDK のバージョンを、最新の安定版に上げる PR を作成・保守する。PR では `.fvmrc` のほかに、バージョンを上げると一緒に直す必要のあるファイル（`pubspec.yaml`、`pubspec.lock`、`.vscode/settings.json`、更新後のコマンドで変わるファイル）も更新する。

方針:

- **`.fvmrc` だけを見る**: 今のバージョンは `.fvmrc` の `flutter` から読む。`.fvmrc` がなければ更新しない。ほかの場所（ワークフローのファイル、`pubspec.yaml` の `environment`）からは読まない
- **今の仕組みに合わせる**: 待機期間、PR の識別、調整、エラー処理は、パッケージの更新と同じ規則を使う。違うところだけをこの文書に書く
- **依存解決は pub に任せる**: 新しい SDK での lockfile の更新と、一緒に上げる必要のある依存の判定は、新しい SDK の `pub` の実行結果を使う

## 2. スコープ

対象:

- リポジトリのルートの `.fvmrc` の `flutter` が、安定版のバージョン番号（`x.y.z`）であるプロジェクト。Flutter のプロジェクトでも、`.fvmrc` を置いた Dart だけのプロジェクトでも同じ
- 更新先は、Flutter の安定版（stable チャンネル）のリリース

対象外:

- `.fvmrc` がないプロジェクト。`flutter` がチャンネル名（`stable` など）、コミット、フォーク（`<fork>/<version>`）、プレリリース版（`3.51.0-0.1.pre` など）のプロジェクト。どれも更新しない（エラーにもしない）
- `.fvmrc` の `flavors` のバージョン。書き換えない
- `.fvmrc` を使わずに入れた SDK（`dart-lang/setup-dart` など）のバージョン
- ワークフローのファイルなど、ほかの場所に書かれた Flutter のバージョン（§10）

## 3. 更新先のバージョン

### 3.1 リリース一覧

Flutter 公式のリリース一覧 `https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json` から読む。`releases[]` の各要素の `channel`、`version`、`release_date`、`dart_sdk_version`（同梱の Dart のバージョン）を使う。ランナーの OS にかかわらず Linux の一覧を使う。

### 3.2 選び方

更新先 `T` は、一覧のうち次をすべて満たすバージョンで、最も新しいもの（バージョンの順序で最も大きいもの。公開日時の順ではない）。

- `channel` が `stable`
- `.fvmrc` のバージョンより新しい
- `release_date` が `cutoff` 以前（基本 §4.1。パッケージと同じ slot と `min_release_age_days` を使う）

`T` がなければ、Flutter の更新単位は作らない。

- 更新単位は 1 つだけで、常に最新の安定版へ上げる。同じマイナーの中のホットフィックスと新しいマイナーを別の PR に分けることはしない
- 待機期間を同じにするので、Flutter の PR の内容が変わる時刻も slot になる（基本 §4.1）
- 新しい Flutter が固定・要求するパッケージのバージョン（`flutter_test` の固定など）は、その Flutter より前に公開されている。`T` が `cutoff` 以前なら、それらも `cutoff` 以前に公開されているので、中継サーバー（基本 §4.2）に隠されない想定である（未確認。§11）

例（2026-11-15 時点の一覧。`.fvmrc` は 3.47.7、`min_release_age_days: 3`、slot は毎週月曜 9:00 JST）:

| バージョン | 公開日時（UTC） | slot 11-09 （cutoff 11-06） | slot 11-16 （cutoff 11-13） |
|---|---|---|---|
| 3.47.8 | 2026-10-23 | 候補 | 候補 |
| 3.47.9 | 2026-10-29 | 候補（`T`） | 候補 |
| 3.50.0 | 2026-11-11 | 待機中 | 候補（`T`） |

## 4. 更新するファイル

| ファイル | 更新の内容 |
|---|---|
| `.fvmrc` | `flutter` の値を `T` にする |
| `.vscode/settings.json` | `dart.flutterSdkPath` の値に入っているバージョンを `T` にする（§4.1） |
| `pubspec.yaml` | `environment` の `sdk` と `flutter` の制約（§4.2）。一緒に上げる直接依存の制約（§5） |
| `pubspec.lock` | 新しい SDK で解決し直した結果（§5） |
| 更新後のコマンドで変わったファイル | `post_update`（基本 §14.3）の結果（§6.3） |

変わったファイルだけをコミットに入れる。

### 4.1 `.fvmrc` と `.vscode/settings.json`

pubreform が自分で、値の文字列だけを置き換える。`fvm use` は使わない。

- `.fvmrc`: `flutter` の値だけを置き換える。ほかのキー（`flavors`、`updateVscodeSettings` など）と書式はそのまま残す
- `.vscode/settings.json`: `dart.flutterSdkPath` の値の最後のパス要素が更新前のバージョンと同じとき（fvm が書く `.fvm/versions/3.47.7` の形）だけ、その部分を `T` に置き換える。コメントと書式はそのまま残す（このファイルは JSONC）
- `.vscode/settings.json` がない、`dart.flutterSdkPath` がない、値にバージョンが入っていない（`.fvm/flutter_sdk` など）場合は、このファイルを変えない

`fvm use` を使わないのは、`fvm use` が `.vscode/settings.json` を読み込んで整形し直して書き出すため（コメントが消え、書式が変わる）。`.gitignore`、`*.code-workspace`、melos の設定も書き換えるので、PR で変わるファイルが決まらなくなる（§11 で確認）。

### 4.2 `pubspec.yaml` の `environment`

`environment` の `sdk`（Dart）と `flutter` の制約を、`T` と `T` に同梱の Dart のバージョン（一覧の `dart_sdk_version`）に合わせて書き換える。以下、合わせる先のバージョンを `v` と書く（`flutter` なら `T`、`sdk` なら同梱の Dart）。

ルートパッケージの言語バージョン（`sdk` の制約の下限で決まる）が 3.9 以上だと、pub は `flutter` の制約の上限を守る。`flutter: 3.47.7` のような固定や、上限のある範囲は、書き換えないと新しい SDK で `pub get` が失敗する。`sdk` の制約の上限は、言語バージョンにかかわらず守られる（§11 で確認）。

どこまで書き換えるかは、設定の `flutter.versioning`（§8）で決める。

| `flutter.versioning` | 書き換え |
|---|---|
| `increase` | 下限を常に `v` に上げる。上限は、`v` が外れるときだけ上げる |
| `lockfile-only` | `v` が今の制約から外れるときだけ書き換える。`v` を許す制約は変えない |

制約の書き方（固定、caret、範囲）は保つ。

| 今の制約 | `increase` | `lockfile-only` |
|---|---|---|
| 固定（`3.47.7`） | `v` | `v` |
| caret（`^3.47.7`） | `^v` | `v` を許せばそのまま。許さなければ `^v` |
| 下限だけ（`>=3.47.7`） | `>=v` | そのまま |
| 範囲（`>=3.47.0 <3.48.0`） | 下限を `>=v` に。上限は下の規則 | 下限はそのまま。上限は下の規則 |
| 制約がない（キーがない） | 追加しない | 追加しない |

範囲の上限は、`v` が外れるときだけ、上限の粒度を保って `v` を含む次の境界まで上げる。

| 今の上限 | `v` = 3.50.0 のとき | `v` = 4.1.0 のとき |
|---|---|---|
| マイナーの境界（`<3.48.0`） | `<3.51.0` | `<4.2.0` |
| メジャーの境界（`<4.0.0`） | そのまま（外れない） | `<5.0.0` |

例（`T` = 3.50.0、同梱の Dart は 3.14.0）:

| 今の `environment` | `increase` | `lockfile-only` |
|---|---|---|
| `sdk: ^3.13.5` / `flutter: 3.47.7` | `sdk: ^3.14.0` / `flutter: 3.50.0` | `sdk: ^3.13.5` / `flutter: 3.50.0` |
| `sdk: ^3.9.0` / `flutter: ">=3.47.0 <3.48.0"` | `sdk: ^3.14.0` / `flutter: ">=3.50.0 <3.51.0"` | `sdk: ^3.9.0` / `flutter: ">=3.47.0 <3.51.0"` |

- 「制約から外れるか」は、`pubspec.yaml` に書かれたとおりの制約で判定する。言語バージョンが 3.9 未満で pub が `flutter` の上限を無視する場合も、同じように書き換える（あとで言語バージョンを上げたときに、古い上限で失敗しないようにするため）
- `increase` で `sdk` の下限のマイナーが上がると、言語バージョンも上がる。`dart format` の結果や lint が変わり、PR の CI が落ちることがある。避けたいときは `flutter.versioning: lockfile-only` にする
- pub には `environment` を書き換えるコマンドがないので、pubreform が値の文字列だけを置き換える。引用符とコメントはそのまま残す
- `environment` の制約は lockfile の `sdks` にも反映されるので、`pubspec.lock` も変わる（§11 で確認）

## 5. 新しい SDK での解決

作業用ディレクトリの `.fvmrc` を `T` にし、`environment` を書き換えた（§4.2）うえで、fvm で `T` の SDK を入れ、その SDK の pub（`fvm flutter pub …` / `fvm dart pub …`）で解決する。中継サーバーを通し、待機期間、`ignore`、セキュリティアドバイザリの見せ方は、ほかの更新単位と同じにする。

1. 直接依存の制約はそのままで、ベースの lockfile を残して `pub get` する。pub はロック済みのバージョンをできるだけ維持するので、新しい SDK が要求するものだけが動く。成功すれば、その結果を使う
2. 1 が失敗したら、直接依存をすべて `>=c(e)` に緩めて（基本 §5.4 と同じ）、ベースの lockfile を残して `pub get` する。分類用の制約（基本 §5.1）の範囲から外れて動いた直接依存を、**一緒に上げる直接依存**とする
3. 一緒に上げる直接依存を、2 で選ばれたバージョンで `pub add` する（`a:^<バージョン>`。固定した制約は固定のまま。基本 §5.5 の単独 / 同時更新グループと同じ）。範囲の中で動いた固定した依存も、同じく `pub add` に渡す（基本 §5.4）
4. 2 でも pub がバージョンを解決できなければ、Flutter の更新単位は作らない（**解決できない**）。エラーにはせず、ジョブサマリーに、上げられないことと pub のエラー（原因）を出す（§9）。パッケージの解決不能（基本 §5.3）と同じ扱い。解決の失敗と、それ以外の失敗（ネットワークなど。§9）を分ける方法は、詳細設計で決める

- 2 の結果は、3 のあとの `pubspec.yaml` の制約をすべて満たすので、3 の解決は失敗しない
- 2 が要るのは、たとえば `flutter_localizations` が固定する `intl` のバージョンが新しい Flutter で変わり、`pubspec.yaml` の `intl: ^0.20.0` と合わなくなる場合である。古い SDK では新しい `intl` は解決不能（基本 §5.3）で PR にならず、Flutter の PR も `intl` が原因で作れない、という状態を避けるために、同じ PR で一緒に上げる
- 最新の安定版で解決できないときに、より古い安定版を試すことはしない
- 推移的依存の変化は lockfile にそのまま入れ、PR の内容には載せない（基本 §5.5 と同じ）。例外はセキュリティアドバイザリを直す推移的依存（基本 §14.2）
- PR の内容（どの直接依存を何から何へ）は、適用後の lockfile の差分から求める（基本 §5.5 と同じ）

### 5.1 パッケージの PR との関係

- Flutter の更新単位は、パッケージの更新単位（マイナー・パッチグループ、単独、同時更新グループ）とは別に計画する。パッケージの計画は、今までどおりベースの `.fvmrc` の SDK で行う
- 一緒に上げる直接依存に、別の単独 PR やグループ PR があっても、それらはそのまま残す。どちらかがマージされると、もう一方は作り直される（Flutter の PR がマージされると `.fvmrc` が変わり、すべての PR が作り直される。基本 §3.2）
- 新しい SDK を要求するために解決不能だったパッケージの更新は、Flutter の PR には入れない。Flutter の PR がマージされたあとの実行で、PR が作られる

## 6. PR

### 6.1 識別と文面

| 項目 | 内容 |
|---|---|
| 種類（メタデータの `kind`） | `flutter` |
| ブランチ | `pubreform/flutter` |
| タイトル | `Update Flutter from <前> to <後>` |

- タイトルは、一緒に上げる直接依存があっても変えない。それらは本文とコミットメッセージの表に載せる
- セキュリティアドバイザリを直す場合は、ほかの PR と同じく `[Security] ` を付け、本文の先頭にアドバイザリの表を置く（基本 §14.2）
- コミットメッセージの 1 行目はタイトルと同じ。本文には、Flutter と Dart の表と、一緒に上げた直接依存の表を入れる
- メタデータ（基本 §6.1）に、Flutter の更新前後のバージョンを入れる。`packages` には一緒に上げる直接依存を入れる
- ラベルは、ほかの PR と同じ設定の `labels` を付ける

### 6.2 本文

````markdown
Updates Flutter.

| | From | To |
|---|---|---|
| Flutter | 3.47.7 | 3.50.0 |
| Dart | 3.13.5 | 3.14.0 |

Updates the following packages together, because the new Flutter requires them.

| Package | From | To | Type |
|---|---|---|---|
| [intl](https://pub.dev/packages/intl) | 0.20.2 | 0.21.0 | direct |

### Flutter 3.47.7 → 3.50.0

[Release](https://github.com/flutter/flutter/releases/tag/3.50.0)

<details>
<summary>Changelog</summary>

### [3.50.0](https://github.com/flutter/flutter/releases/tag/3.50.0)
...

</details>

### intl 0.20.2 → 0.21.0

...

---

- [ ] Rebase this PR <!-- pubreform:rebase -->

<!-- pubreform:meta {...} -->
````

- Dart の行は、一覧の `dart_sdk_version` から書く
- パッケージの表と節は、一緒に上げる直接依存があるときだけ載せる。書き方はほかの PR と同じ（基本 §8）
- **更新履歴**: `flutter/flutter` の `CHANGELOG.md` から、「更新前 < v ≤ 更新後」に当たるバージョンの節を抜き出す。見出しの判定と抜き出し方は、パッケージの更新履歴（基本 §8）と同じ
  - タグや `stable` ブランチではなく、リリースブランチ `flutter-<major>.<minor>-candidate.0` の `CHANGELOG.md` を読む。ホットフィックスの節は、そのマイナーのリリースブランチにしか載らないことがあるため（§11 で確認）
  - 一覧から、更新前より新しく更新後以下の安定版を求め、それらのマイナーのリリースブランチをすべて読む。各バージョンの節は、そのバージョンのマイナーのブランチから取る。例: 3.47.7 → 3.50.0 では、3.47.8 と 3.47.9 の節を `flutter-3.47-candidate.0` から、3.50.0 の節を `flutter-3.50-candidate.0` から取る
  - 取得できない、抜き出せない場合は、エラーにせず、リリースへのリンクだけを載せる（基本 §9 の更新履歴と同じ）

### 6.3 更新後のコマンド

`post_update` があれば、ほかの更新単位と同じく、PR を作るときと作り直すときに、コミットを作る前に実行する（基本 §14.3）。違いは次の 2 点。

- 生成用ディレクトリには、更新後の `.fvmrc`、`.vscode/settings.json`、`pubspec.yaml`、`pubspec.lock` を書く
- コンテナには、ベースの SDK ではなく `T` の SDK をマウントする。コマンドは新しい SDK に同梱の Dart で動く

## 7. 調整

Flutter の PR は、種類とブランチ名で計画と対応させる（基本 §7.1 の単独 PR と同じ）。操作と再生成の条件は基本 §7.2 のとおりで、違いは次の点。

- **更新内容が変わった**: Flutter の更新先か、一緒に上げる直接依存（パッケージと更新後のバージョン）が変わった場合。変更点のコメントには Flutter の行も入れる
- **利用者がマージせずに閉じた PR**: 同じ内容かどうかは、Flutter の更新先のバージョンだけで判定する。3.50.0 への PR を閉じたら、一緒に上げる依存が変わっても 3.50.0 への PR は作らない。次のバージョンが出れば、また作る
- **計画になく、PR がある**: 更新単位がなくなった（ベースで更新済み、`flutter.enabled: false` にした、`.fvmrc` がなくなった、新しい SDK で解決できなくなった（§5 の 4）など）場合は、理由をコメントして閉じる。ただし、更新単位の計画や適用がエラーになった場合（§9）は閉じない（詳細 §14.3 の「計画に失敗した場合」と同じ）

ベースのハッシュ（`baseHash`。基本 §6.1）に入れるファイルは変えない（`pubspec.yaml`、`pubspec.lock`、`.fvmrc`）。`.vscode/settings.json` は入れない。開発者がよく書き換えるファイルなので、入れると関係のない変更ですべての PR が作り直されるため。ベースで `dart.flutterSdkPath` の行が変わった場合は、Flutter の PR がコンフリクトするので、コンフリクトの条件で作り直される。

### 7.1 適用の省略（`flutter.reapply`）

今の仕組みは、実行のたびにすべての更新単位を適用し直す（基本 §3.1）。Flutter の更新単位の適用には、新しい SDK の取得が要る。setup-fvm がキャッシュするのは、ベースのバージョンの SDK と fvm の git ミラーだけなので、新しい SDK は実行のたびに取得し直しになる。そこで、適用を省くかどうかを設定 `flutter.reapply`（§8）で選べるようにする。

| `flutter.reapply` | 動作 |
|---|---|
| `on-change`（既定） | 下の条件をすべて満たせば、SDK を入れず、適用もせず、その PR を変化なしとして扱う |
| `always` | 実行のたびに SDK を入れて適用し直す（ほかの更新単位と同じ） |

`on-change` で適用を省く条件:

- open の Flutter の PR があり、メタデータの Flutter の更新先が `T` と同じ
- メタデータの `baseHash` と `configHash` が、今回の値と同じ
- ほかの再生成の条件（チェックボックス、コンフリクト）に当てはまらない

どちらの設定でも、同じ更新先の、利用者がマージせずに閉じた PR があれば、適用しない（PR を作らないことが、適用しなくても決まるため）。

- `on-change` では、一緒に上げる直接依存の更新先が slot の切り替わりで新しくなっても、ベースか設定が変わるまで PR に反映されない。セキュリティアドバイザリが新しく公開された場合も同じ
- 人手のコミットがある PR は、`on-change` の条件を満たせば適用せず、満たさなければ今までどおり適用したうえで更新しない（基本 §7.2）
- PR がまだなく、新しい SDK で解決できない（§5 の 4）間は、`on-change` でも実行のたびに SDK を入れて試す。状態を持たないので、前回失敗したことを覚えていないため

## 8. 設定

```yaml
flutter:
  enabled: true          # 既定は true。false にすると Flutter の更新をしない
  versioning: increase   # increase | lockfile-only。省略するとトップレベルの versioning に従う
  reapply: on-change     # on-change | always。既定は on-change
```

| キー | 既定値 | 説明 |
|---|---|---|
| `flutter.enabled` | `true` | Flutter の更新をするか。`true` でも、`.fvmrc` がなければ何もしない |
| `flutter.versioning` | トップレベルの `versioning` の値 | `environment` の書き換え方（§4.2） |
| `flutter.reapply` | `on-change` | 変化がないときに適用を省くか（§7.1） |

- 更新先のバージョンを範囲で絞る設定（`ignore` に当たるもの）は作らない。特定のバージョンを避けたいときは、その PR をマージせずに閉じる（§7）
- `min_release_age_days`、`schedule`、`labels` はパッケージと共通で、Flutter 専用の値は作らない
- `configHash` は既定値を補った設定全体から計算するので（詳細 §4.3）、この機能を入れたバージョンに上げた最初の実行では、すべての PR が 1 回作り直される

## 9. エラー処理とジョブサマリー

| 発生箇所 | 扱い |
|---|---|
| リリース一覧を取得できない（`.fvmrc` があり、`flutter.enabled` が `true` で、バージョンが `x.y.z` のとき） | 全体のエラー。何も変更せずに失敗終了する（pub.dev に到達できないときと同じ。取得できた実行とできなかった実行で結果が変わらないようにするため） |
| 新しい SDK の取得、pub の実行（解決できない場合を除く）、適用、更新後のコマンド、コミット、PR 操作の失敗 | Flutter の更新単位のエラー。PR があればエラーをコメントし、なければジョブのログに出す。ほかの更新単位は続ける（基本 §9） |
| 新しい SDK で解決できない（§5 の 4） | エラーにしない。PR を作らず、ジョブサマリーに原因を出す。PR があれば理由をコメントして閉じる（§7） |
| 更新履歴の取得 | エラーにしない（§6.2） |

ジョブサマリーに、Flutter の行を追加する。

| 状況 | 表示 |
|---|---|
| PR を作った・更新した・変化なし | 今のバージョン、更新先、PR への操作 |
| 待機期間のために使わなかった新しい安定版がある | 待機中のバージョンと公開日（パッケージの待機中の表と同じ扱い） |
| 新しい SDK で解決できない | 更新先と、pub のエラー（原因） |
| 利用者が閉じた PR と同じ更新先 | 更新先と、閉じた PR の番号 |

`.fvmrc` がない、`flutter.enabled` が `false`、バージョンが `x.y.z` でない場合は、Flutter の行を出さない。

## 10. 範囲外

- 同じマイナーの中の更新と、マイナー・メジャーの更新を別の PR に分けること
- 最新の安定版で解決できないときに、解決できる古い安定版へ上げること
- 更新先のバージョンを設定で絞ること、Flutter 専用の待機期間
- `.fvmrc` の `flavors`、`.fvm/fvm_config.json`（fvm の古い形式の設定）、`*.code-workspace`、melos の設定の更新
- ワークフローのファイルに書かれた Flutter のバージョン（`subosito/flutter-action` の `flutter-version` など）。App のトークンではワークフローのファイルを変更できない
- `.fvmrc` を使わないプロジェクトの `environment` の更新
- beta チャンネルなど、安定版以外への更新
- 新しい SDK を要求するパッケージの更新を、Flutter の PR にまとめること（§5.1）

## 11. 確かめたこと・未確認のこと

2026-11-15 に確かめたこと:

- **`flutter` 制約の上限**: pub のソース（`dart-lang/pub`、2026-11-04 のコミット fe19066）の `lib/src/pubspec.dart`（`SdkConstraint.interpretFlutterSdkConstraint`）と `lib/src/language_version.dart` で、ルートパッケージで言語バージョンが 3.9 以上のときだけ `flutter` の制約の上限を使うことを確かめた。固定（`3.47.7`）も範囲として扱われ、3.9 未満では下限だけになる
- **本物の `dart pub get`**: Dart 3.14.0 で、`FLUTTER_ROOT` を「バージョンが 3.50.0 だと書いたファイル（`bin/cache/flutter.version.json`）だけを置いたディレクトリ」に向けて実行した。本物の Flutter SDK ではない

| `sdk` | `flutter` | 結果 |
|---|---|---|
| `^3.9.0` | `3.47.7` | 失敗（The current Flutter SDK version is 3.50.0） |
| `^3.8.0` | `3.47.7` | 成功 |
| `^3.9.0` | `>=3.47.0 <3.48.0` | 失敗 |
| `^3.8.0` | `>=3.47.0 <3.48.0` | 成功 |
| `^3.9.0` | `^3.47.7` | 成功 |
| `^3.9.0` | `>=3.47.7` | 成功 |
| `^3.9.0` | `3.50.0` | 成功。lockfile の `sdks` は `flutter: "3.50.0"` になった |
| `>=3.9.0 <3.14.0` | `>=3.47.7` | 失敗（The current Dart SDK version is 3.14.0） |
| `3.13.5` | `>=3.47.7` | 失敗 |

- **リリース一覧**: `releases_linux.json` を取得でき、安定版の各リリースに `version`、`release_date`、`dart_sdk_version`、`channel` がある。安定版は 3.47.7（2026-10-08、Dart 3.13.5）、3.47.8（10-23）、3.47.9（10-29、Dart 3.13.7）、3.50.0（11-11、Dart 3.14.0）と並ぶ。beta のリリースでは `dart_sdk_version` が `3.15.0 (build 3.15.0-118.1.beta)` の形になる
- **`fvm use`**: fvm のソース（`leoafarias/fvm`、2026-11-12 のコミット d3cdc1f）の `lib/src/workflows/` で、`fvm use` が `.vscode/settings.json` を JSONC として読み、`dart.flutterSdkPath` にプロジェクトからの相対パス `.fvm/versions/<バージョン>` を入れ、整形し直して書き出すことを確かめた。同じ処理で `.gitignore`、`*.code-workspace`、melos の設定も書き換える。`.fvmrc` と `.fvm/fvm_config.json` の両方を書く
- **setup-fvm のキャッシュ**: `chika3742/setup-fvm`（2026-10-20 のコミット f45cb0a）の `src/utils/cache-options.ts` で、キャッシュするパスが `~/fvm/versions/<.fvmrc のバージョン>` と `~/fvm/cache.git` であることを確かめた
- **Flutter の `CHANGELOG.md`**: 見出しは `### [3.47.7](https://github.com/flutter/flutter/releases/tag/3.47.7)` の形。3.47.8 と 3.47.9 の節は、`flutter-3.47-candidate.0` ブランチ、タグ 3.47.9、`master` にあり、`flutter-3.50-candidate.0` ブランチ、タグ 3.50.0、`stable` ブランチにはなかった。`raw.githubusercontent.com` から認証なしで取得できた。リリースブランチの名前を確かめたのは 3.47 と 3.50 だけ

未確認のこと（詳細設計と実装のときに、本物の `fvm flutter pub` で確かめる）:

- 本物の Flutter SDK を 2 つのバージョンで使った解決（§5）。ベースの lockfile を残した `pub get` が、新しい SDK の要求するパッケージだけを動かすこと。`intl` のような例で、§5 の 2 と 3 が期待どおりに動くこと
- 新しい Flutter が固定・要求するパッケージが、待機期間で隠されないこと（§3.2）
- 作業用ディレクトリの `.fvmrc` を書き換えたときの、fvm による新しい SDK の取得（方法、所要時間、ディスクの使用量）。GitHub のランナーでの動作
- 更新後のコマンドを、新しい SDK をマウントしたコンテナで実行すること（§6.3）
- リリースブランチの名前が、ほかのマイナーでも `flutter-<major>.<minor>-candidate.0` であること。ホットフィックスの節が、タグより後にリリースブランチに足されることがあるか（利用者からの指摘。上で確かめた 3.47.9 では、タグにも節があった）
- GitHub のランナーから、リリース一覧と `raw.githubusercontent.com` を取得できること
- `sdk` の制約を書き換えるときの、`pubspec.yaml` の書式の保ち方（引用符、コメント）

## 12. 決めたこと

2026-11-15 に、次のとおり決めた。

| 項目 | 決定 | 採らなかった案 |
|---|---|---|
| 今のバージョンの出どころ | `.fvmrc` だけ。なければ更新しない | — |
| PR の単位 | 最新の安定版への PR を 1 つ | パッチとマイナー以上で 2 つ。メジャーだけ別 |
| 待機期間 | パッケージと同じ `min_release_age_days` と slot | Flutter 専用の日数。適用しない |
| 新しい SDK で解決できないとき | 必要な直接依存を同じ PR で上げる。それでも解決できなければ PR を作らない | PR を作らずサマリーに出すだけ。解決できる古い版まで下げる |
| `environment` | `flutter.versioning` に従う（省略時はトップレベルの `versioning`）。上限は、外れるときだけ同じ粒度の次の境界まで上げる | 範囲外のときだけ書き換える（固定）。`flutter` だけ常に上げる。caret に置き換える。上限を尊重して更新先を範囲内に限る |
| `.fvmrc` と `.vscode/settings.json` | pubreform が値だけを置き換える | `fvm use` に任せる |
| 設定 | 専用のキー `flutter`（`enabled`、`versioning`、`reapply`）。バージョンの範囲で絞る設定は作らない | `ignore` に `name: flutter` と書く。設定を追加しない |
| 適用の省略 | `flutter.reapply` で選ぶ。既定は `on-change` | 常に適用し直す。常に省く |
| 更新履歴 | リリースブランチの `CHANGELOG.md` から、範囲内のすべてのマイナーを読む | SDK の中の `CHANGELOG.md`。更新先のブランチだけ。リンクだけ |
| 対象にする `.fvmrc` の値 | 安定版の `x.y.z` だけ。`flavors` は書き換えない | — |
| パッケージの PR との関係 | 別に計画し、重なる PR があってもそのまま残す | — |

次の点は、上の決定と今の仕組みから導いて書いた。必要なら変更する。

- タイトルは、一緒に上げる直接依存があっても `Update Flutter from <前> to <後>` のままにする（§6.1）
- 利用者が閉じた PR と同じ内容かどうかは、Flutter の更新先のバージョンだけで判定する（§7）
- `.vscode/settings.json` は `baseHash` に入れない（§7）
- 「制約から外れるか」は、言語バージョンにかかわらず、書かれたとおりの制約で判定する（§4.2）
- リリース一覧を取得できないときは、全体のエラーにする（§9）
- 新しい SDK で解決できないことは、エラーにしない。既存の Flutter の PR があれば、理由をコメントして閉じる（§5、§7）

## 参考

- [Flutter SDK archive](https://docs.flutter.dev/install/archive)（リリース一覧の出どころ）
- [flutter/flutter の CHANGELOG.md](https://github.com/flutter/flutter/blob/master/CHANGELOG.md)
- [dart-lang/pub の `lib/src/pubspec.dart`](https://github.com/dart-lang/pub/blob/master/lib/src/pubspec.dart)（`interpretFlutterSdkConstraint`）
- [FVM Configuration](https://fvm.app/documentation/getting-started/configuration)
- [chika3742/setup-fvm](https://github.com/chika3742/setup-fvm)
