# pubreform 基本設計: Flutter の更新

> ステータス: 実装済み（2026-11-02）。単体テストとローカル E2E（docker を使う場面を除く）で確かめた。結合テストと GitHub E2E は、まだ実行していない（[詳細設計](flutter-update-detailed.md) §12）。[基本設計](design.md)を前提に、Flutter SDK のバージョンを上げる PR を加える。挙動を変えるときは、先にこの設計書を直す。「10. 仮決めした点」は必要に応じて更新する。「基本 §n」は基本設計の節を指す。実装に必要な決定は[詳細設計](flutter-update-detailed.md)に書く。

## 1. 概要

`.fvmrc` で固定した Flutter SDK のバージョンを、新しい安定版に上げる PR を作る。パッケージの更新（基本 §5）とは独立に計画し、グループにはまとめない。

PR で変えるもの:

| ファイル | 変えるところ | 条件 |
|---|---|---|
| `.fvmrc` | `flutter` の値 | 常に |
| `.vscode/settings.json` | `dart.flutterSdkPath` の値のバージョンの部分 | ファイルとキーがあり、値に今のバージョンが含まれる（§5.3） |
| `pubspec.yaml` | `environment.flutter` の下限 | 下限のある制約が書かれている（§5.3） |
| `pubspec.lock` | `pub get` の結果 | `pub get` に成功した |
| `pub get` で変わったファイル | macOS、Linux、Windows のプラグインの登録ファイル（`macos/Flutter/GeneratedPluginRegistrant.swift` など。git で追跡される）など | `pub get` に成功した。`post_update` の有無は問わない |
| 更新後のコマンドで変わったファイル | （基本 §14.3） | `post_update` があり、`pub get` とコマンドに成功した |

## 2. 対象

- ルートの `.fvmrc` があり、その `flutter` の値が安定版のバージョン（`x.y.z`）のプロジェクト。Flutter のプロジェクトでなくても（fvm で Dart を用意する Dart だけのプロジェクト）対象にする
- 対象外:
  - `.fvmrc` がないプロジェクト（§10）。今のバージョンが分からず（PATH の SDK はワークフローが用意し、pubreform はワークフローを変えない）、新しい SDK で `pub get` もできない。`environment.flutter` の下限だけを上げると、ワークフローの古い SDK では `pub get` が失敗する（§8.3）
  - `flutter` の値がバージョンでないもの（チャンネル名、`@` 付き、コミット、フォーク）と、`.fvmrc` の `flavors`
  - Dart SDK と `environment.sdk`
  - ワークフローのファイル（`subosito/flutter-action` の `flutter-version` など）、IntelliJ の設定（`.idea/`）、`.code-workspace`
  - 安定版以外のチャンネル（基本 §2 のプレリリース版と同じ）

## 3. 更新先のバージョン

Flutter の公式のリリース一覧 `https://storage.googleapis.com/flutter_infra_release/releases/releases_<os>.json`（`<os>` はランナーの OS。`linux` など）を読む。`releases[]` の各項目に、`channel`、`version`、`release_date`、`dart_sdk_version` がある（§8.1）。

- **候補**: `channel` が `stable` で、`version` が `x.y.z` の形で、設定の `ignore` に該当しないバージョン
- **更新先 `t`**: 候補のうち、バージョンの順で最も新しいもの（公開日時の順ではない）。`t` が今のバージョン `c`（`.fvmrc` の値）より新しければ、Flutter の PR を計画する

待機期間（`min_release_age_days`）は、Flutter のリリースには当てはめない（利用者の決定）。`release_date` は使わない。そのため、基本 §4.1 の性質（次の slot まで、入力が同じなら計画も同じ）は Flutter の PR には成り立たない。新しい安定版が出ると、slot に関係なく、その後の最初の実行で Flutter の PR が作られたり作り直されたりする（基本 §4.1 のセキュリティアドバイザリと同じ）。

Flutter の更新を止めるには、設定の `ignore` に `name: flutter` を書く。`versions` を書けば、その範囲（例: `">=4.0.0"`）への更新だけを止める。`flutter` は pub.dev のパッケージとしては扱わない名前（SDK の依存）なので、パッケージの `ignore` とぶつからない。設定のキーを増やさないので、今の設定の `configHash` は変わらず、この機能を入れたことでパッケージの PR が作り直されることもない。

## 4. PR

### 4.1 種類と識別

| 種類 | ブランチ | タイトル |
|---|---|---|
| Flutter | `pubreform/flutter` | `Update Flutter from <c> to <t>` |

- コミットメッセージはタイトルだけ
- メタデータ（基本 §6.1）: `kind` は `flutter`、`packages` は `{"flutter": [c, t]}`。ほかのキーはパッケージの PR と同じ。`packages` の形を変えないので、内容の変更の判定、内容の変更のコメント、利用者が閉じた PR との照合は、今の仕組みをそのまま使う
- 既存 PR とは、ブランチ名で対応させる（マイナー・パッチグループと同じ）
- 設定のラベルを付ける

### 4.2 調整

操作と再生成の条件は基本 §7.2 と同じにする。

- 計画にあり、PR がない: 作る。利用者がマージせずに閉じた、同じ `t` の Flutter の PR があれば作らない。より新しい `t` なら作る
- 計画になく、PR がある: 閉じてブランチを消す（例: main で `.fvmrc` を上げた、`ignore` に `flutter` を足した）。リリース一覧を取得できなかったときは閉じない（§5.2）
- 更新内容が変わった: `t` が変わった（新しい安定版が出た、など）
- `baseHash`（`pubspec.yaml`、`pubspec.lock`、`.fvmrc`）は変えない。`.vscode/settings.json` は入れない。入れると、エディタの設定を変えるたびにすべてのパッケージの PR が作り直されるため。`.vscode/settings.json` のコンフリクトは `mergeable_state`（基本 §7.2）で見つける

### 4.3 パッケージの PR との関係

- パッケージの PR は、今までどおりベースの Flutter で解決する。Flutter の PR は、ベースの lockfile と新しい Flutter で解決する。互いの結果は使わない
- Flutter の PR をマージすると、`.fvmrc` が変わって `baseHash` が変わるので、パッケージの PR はすべて新しい Flutter で作り直される（基本 §3.2）。パッケージの PR をマージすると、`pubspec.lock` が変わるので、Flutter の PR が作り直される
- 新しい Flutter のためにパッケージを上げる必要があっても、同じ PR にはまとめない。`pub get` が今の制約の中で動かせるものは動かし、動かせなければ失敗する（§5.2）

## 5. 生成

### 5.1 手順

PR を作るときと作り直すときだけ、次を行う。

1. ベースで追跡しているファイルを、ベースの作業用ディレクトリ（基本 §3.1）とは別のディレクトリに書き出す。ベースの作業用ディレクトリの `.fvmrc` は、計画とほかの更新単位の解決で使う SDK を決めるので、変えない
2. `.fvmrc`、`.vscode/settings.json`、`pubspec.yaml` を書き換える（§5.3）。ないファイルは作らない
3. `fvm install <t>` で新しいバージョンの SDK を入れてから、`pub get --no-example` を 1 回実行する（`fvm flutter pub get`、Flutter のプロジェクトでなければ `fvm dart pub get`）。中継サーバーは経由せず、pub.dev から直接取得する（利用者の決定）。lockfile の URL は pub.dev のままで、置き換えない（基本 §4.2）。`.fvmrc` を書き換えたディレクトリで pub を実行すれば fvm は自動で SDK を入れるが、ログを分けて失敗を見分けるために、明示して入れる（GitHub のランナーでは未確認。§9）
4. 成功し、`post_update` があれば、コマンドを実行する（基本 §14.3）。コンテナには新しいバージョンの SDK をマウントする
5. 変わったファイルをコミットする（基本 §6 と同じく、ベースの最新コミットの上に 1 つ）。`.gitignore` で除外したものは入れない。`pub get` で変わったファイル（プラグインの登録ファイルなど）も、`post_update` の有無にかかわらず入れる（利用者の決定）。手元で Flutter を上げて `pub get` したときと同じ差分にするため

中継サーバーを経由しないので、`pub get` が動かすパッケージには、待機期間、`ignore`、セキュリティアドバイザリの見せ方（基本 §4.2、§14.2）が効かない。`pub get` はロック済みのバージョンをできるだけ保つ（基本 §5.4）ので、動くのは新しい Flutter のために動かす必要のあるパッケージだけになる。PR をマージした後は、ほかのロック済みのバージョンと同じく扱う。

計画は、リリース一覧と `.fvmrc` だけで決める（§3）。実行のたびには `pub get` をせず、PR の内容の判定にも `pub get` の結果を使わない。実行のたびに `pub get` をすると、そのたびに新しい SDK の取得（Flutter SDK の clone）が要るため。更新後のコマンドを作るときと作り直すときだけ実行するのと、同じ考え方（基本 §14.3）。

### 5.2 失敗

| 失敗 | 扱い |
|---|---|
| `pub get`（新しい SDK の取得の失敗を含む） | PR を作る（作り直す）。`pubspec.lock` はベースのまま、更新後のコマンドは実行しない。本文に失敗したことを書き（§6）、ログを PR にコメントする。ジョブは失敗させない |
| 更新後のコマンド | `pub get` の失敗と同じく PR を作る。`pubspec.lock` は `pub get` の結果を入れ、コマンドで変わったファイルは入れない。本文に書き、ログをコメントする。ジョブは失敗させない |
| リリース一覧の取得 | Flutter の PR だけを止める。作らず、既存の PR は閉じも変えもしない。ジョブのログとサマリーに出し、ジョブを失敗させる。パッケージの PR の処理は続ける |
| ファイルの書き換え、コミット、ブランチと PR の操作 | パッケージの PR と同じ（基本 §9） |

- コメントは、パッケージの PR のエラーコメントと同じ仕組みで、同じログなら繰り返さない（基本 §9）
- 新しい Flutter では、依存の制約を直さないと `pub get` が通らないことがある。その作業の場所として PR を作る。作らないと、利用者は新しい Flutter が出たことにも気づけない
- 一時的な失敗（SDK の取得の失敗など）でも、`pubspec.lock` が古いままの PR ができる。チェックボックス（基本 §7.2）で作り直せる
- パッケージの PR では、更新後のコマンドが失敗したら PR を作らない（基本 §14.3）。Flutter の PR はもともと `pub get` の失敗でも作るので、コマンドの失敗でも作る（§10）

### 5.3 ファイルの書き換え

書式とコメントを保つため、どのファイルも値の文字列だけを置き換える。`fvm use` は使わない。`.vscode/settings.json` のコメントと末尾の改行を消し、キーがなくても `dart.flutterSdkPath` を足し、`.gitignore` も書き換えるため（§8.2）。

- `.fvmrc`: `flutter` の値を `c` から `t` にする。ほかのキーは変えない
- `.vscode/settings.json`: `dart.flutterSdkPath` の値にパスの要素として `c` が含まれていれば（fvm が書く `.fvm/versions/<c>` など）、その部分を `t` にする。次の場合は何もしない（ファイルもキーも作らない）
  - ファイルがない（VS Code を使わないプロジェクト、`.vscode/` をコミットしないプロジェクト）
  - `dart.flutterSdkPath` のキーがない
  - 値に `c` が含まれない（`.fvm/flutter_sdk` などのバージョンを含まないリンク、絶対パス）
- `pubspec.yaml` の `environment.flutter`: 下限を `t` に上げる。pub は、ルートの言語バージョン（`environment.sdk` の下限）が 3.9 より前なら Flutter の制約の下限だけを見て、3.9 以上なら上限も見る（§8.3）。次の表の上から順に、最初に当てはまるもので決める

| 今の制約 | 書き換えた後 |
|---|---|
| キーがない、下限のないもの（`any`、`<b`） | 変えない |
| 下限が `t` 以上 | 変えない |
| `^a` | `^t` |
| `a`（固定） | `t`（言語バージョン 3.9 以上では、固定したバージョン以外の SDK で `pub get` が失敗するため） |
| `>=a`、`>a` | `>=t`（`>t` にすると `t` 自身を含まない） |
| 上限のある範囲（`>=a <b` など）で、`t` が上限を満たす | 下限だけを `>=t` にし、上限はそのまま |
| 上限のある範囲で、`t` が上限を満たさない | 変えない |

明示した上限は利用者が決めたものなので、`t` が上限を満たさなくても、pubreform は推測で上限を動かさない。言語バージョンが 3.9 以上なら、この PR の `pub get` は失敗し、§5.2 のとおり PR とコメントで知らせる。3.9 より前なら pub は上限を見ないので、`pub get` は通るが、下限は上がらない。上限を残したまま下限だけを上げると空の制約になり、言語バージョンにかかわらず `pub get` が失敗する（§8.3）。

## 6. PR 本文

本文は英語にする（基本 §8）。

````markdown
Updates Flutter.

| SDK | From | To |
|---|---|---|
| Flutter | 3.47.7 | 3.47.9 |
| Dart | 3.13.5 | 3.13.7 |

[Release notes](https://docs.flutter.dev/release/release-notes) · [Changelog](https://github.com/flutter/flutter/blob/flutter-3.47-candidate.0/CHANGELOG.md)

---

- [ ] Rebase this PR <!-- pubreform:rebase -->

<!-- pubreform:meta {...} -->
````

- Dart の行は、リリース一覧の `dart_sdk_version`。一覧に `c` がない、または `dart_sdk_version` がない（古い項目にはない。§8.1）ときは、その欄を空にする
- 更新履歴は抜き出さず、リンクだけを載せる
- CHANGELOG のリンク先は、`t` のリリースの系列のブランチ `flutter-<major>.<minor>-candidate.0`（`t` のメジャーとマイナーから作る）の `CHANGELOG.md` にする。リリースのタグ（リリース一覧の `hash` のコミット）にはしない。その版の節は、タグを付けた後に系列のブランチに足されることがあり、タグの `CHANGELOG.md` には入っていないことがあるため（§8.4）。main もリリースの時点ではまだ節がないことがあるので使わない
- リリースノートのリンク先は、索引のページ `https://docs.flutter.dev/release/release-notes` にする（利用者の決定）。系列ごとのページ（`release-notes-<x.y>.0`）はあるが、ホットフィックスの版のページはない
- `pub get` が失敗したら、表の下に次の 1 行を入れる: `` `flutter pub get` failed with Flutter <t>, so `pubspec.lock` is not updated and the `post_update` commands did not run. The log is in a comment. ``（Dart だけのプロジェクトでは `dart pub get`。`post_update` がなければ後半を省く）
- 更新後のコマンドが失敗したら、同じ位置に失敗したことを書く。成功してファイルが変わったら、パッケージの PR と同じ `` Files changed by the `post_update` commands: <n> `` の行を入れる

## 7. ジョブサマリー

- 各 PR への操作の表に、Flutter の PR の行を加える（種類 `flutter`、パッケージの欄は `Flutter`）。`pub get` か更新後のコマンドが失敗したときは、操作の欄にそのことを書く
- リリース一覧を取得できなかったときは、エラーの一覧に出す

## 8. 確かめたこと

### 8.1 リリース一覧

2026-11-02 に `releases_linux.json` を取得した。

- 最上位のキーは `base_url`、`current_release`（チャンネルごとのコミットのハッシュ）、`releases`
- `releases` は 748 件で、`channel` が `stable` のものは 197 件。各項目に `hash`、`channel`、`version`、`dart_sdk_version`、`release_date`（例: `2026-10-29T19:22:44.517205Z`）、`archive`、`sha256` がある。最も古い `v1.0.0` には `dart_sdk_version` がない
- `stable` のうち `version` が `x.y.z` の形でないのは、古い 14 件（`v1.0.0`、`v1.12.13+hotfix.9`、`v1.5.4-hotfix.2` など）だけ
- `stable` の `3.13.3` は 2 件ある
- 最新の `stable` は 3.47.9（Dart 3.13.7、2026-10-29 公開）

### 8.2 `fvm use`

2026-11-02 に、macOS の fvm 4.3.2 で、`pubspec.yaml` と、コメントを含む `.vscode/settings.json`（`dart.flutterSdkPath` なし）だけの git リポジトリで `fvm use 3.47.9 --skip-pub-get --skip-setup --force` を実行した。

- `.fvmrc` は `{` / `  "flutter": "3.47.9"` / `}` の 3 行（2 文字の字下げ）で書かれた
- `.vscode/settings.json` に `"dart.flutterSdkPath": ".fvm/versions/3.47.9"` が足された。元のコメントは消え、末尾の改行もなくなった
- `.gitignore` に `.fvm/` が足され、`.fvm/` が作られた

### 8.3 `environment.flutter` の扱い

2026-11-02 に、Flutter 3.47.9 に同梱の Dart 3.13.7 で、`FLUTTER_ROOT` を Flutter 3.47.9 にして `dart pub get --offline` を実行した。`pubspec.yaml` は依存がなく、`environment.sdk` を `^3.8.0`（言語バージョン 3.8）、`^3.9.0`、`^3.13.0` にしたものを使った。`fvm flutter pub get` では確かめていない。どれも、実行した環境の都合でテレメトリーのファイルを書けずに終了コードは 1 になったが、解決の結果は次の出力と lockfile のとおり。

`^3.9.0` と `^3.13.0` の結果は同じだった。表の括弧の中は lockfile の `sdks.flutter`。

| `environment.flutter` | 言語バージョン 3.8 | 言語バージョン 3.9 以上 |
|---|---|---|
| `">=3.0.0 <3.10.0"` | 解決した（`">=3.0.0"`） | 失敗した（`Because app requires Flutter SDK version >=3.0.0 <3.10.0, version solving failed.`） |
| `">=3.0.0 <3.47.9"` | 解決した（`">=3.0.0"`） | 失敗した |
| `">=3.0.0 <=3.47.9"` | 解決した（`">=3.0.0"`） | 解決した（`">=3.0.0 <=3.47.9"`） |
| `^3.0.0` | 解決した（`">=3.0.0"`） | 解決した（`">=3.0.0 <4.0.0"`） |
| `"3.47.8"` | 解決した（`">=3.47.8"`） | 失敗した（`Because app requires Flutter SDK version 3.47.8, version solving failed.`） |
| `"3.47.9"` | 解決した（`">=3.47.9"`） | 解決した（`"3.47.9"`） |
| `">3.0.0"` | 解決した（`">3.0.0"`） | 同じ |
| `"<4.0.0"` | 解決した（`any`） | 解決した（`"<4.0.0"`） |
| `any` | 解決した（`any`） | 同じ |
| `">=3.50.0"` | 失敗した（`The current Flutter SDK version is 3.47.9.` / `Because app requires Flutter SDK version >=3.50.0, version solving failed.`） | 同じ |
| `">=3.47.0 <3.10.0"` | 失敗した（`Because app requires Flutter SDK version <empty>, version solving failed.`） | 同じ |

### 8.4 CHANGELOG

2026-11-02 に、`flutter/flutter` の ref と `CHANGELOG.md` を確かめた。

- タグ `3.47.9` とブランチ `flutter-3.47-candidate.0`、`stable` は、リリース一覧の 3.47.9 の `hash`（`c197ca5199e9ee5661e865596c9c07294dfab51c`）を指していた。タグ `3.47.8` も、一覧の 3.47.8 の `hash` と同じだった
- `CHANGELOG.md` には、系列ごとの `## Flutter 3.47 Changes` の下に、版ごとの `### [3.47.9](https://github.com/flutter/flutter/releases/tag/3.47.9)` の節がある
- タグ `3.47.0`〜`3.47.9` のそれぞれの `CHANGELOG.md` に、その版自身の節があるかを見た。`3.47.0`、`3.47.4`、`3.47.8` にはなく、ほかの 7 つにはあった
- `flutter-3.47-candidate.0` には `3.47.0`〜`3.47.9` のすべての節があった。`flutter-3.44-candidate.0`（`3.44.0`〜`3.44.9`）と `flutter-3.41-candidate.0`（`3.41.0`〜`3.41.9`）も、リリース一覧の安定版のすべての節があった
- リリース一覧の安定版の 3.x の系列（3.0〜3.47）には、どれも `flutter-<major>.<minor>-candidate.0` のブランチがある。3.24 より前の系列では `candidate.1` 以降のブランチもあるが、更新先は最新の系列なので問題にしない
- この日（3.47.9 のリリースの 4 日後）は main にもすべての節があった。リリースの時点で main やタグに節がなかったことは、利用者から得た情報による（上のタグの結果はそれと合う）

## 9. 未確認のこと

確かめる場所は詳細設計 §12 に書く。fvm が `CI=true` で確認を求めずにインストールを始めることなど、詳細設計で確かめたことは詳細設計 §11 に書く。

- GitHub のランナーで setup-fvm と組み合わせたとき、`fvm install` で新しいバージョンを入れて `pub get` できるか。かかる時間と、ディスクの使用量
- 新しいバージョンの SDK をマウントしたコンテナで、更新後のコマンドが動くか
- macOS と Windows のランナーのリリース一覧（`releases_macos.json` は、アーキテクチャごとに項目が分かれている見込み）

## 10. 仮決めした点

- `.fvmrc` があるプロジェクトだけを対象にする（§2）
- 既定で有効にする。止めるには `ignore` に `name: flutter` を書く（§3）。v1 を使っている `.fvmrc` のあるリポジトリでは、上げた後の最初の実行で Flutter の PR が作られる
- `environment.flutter` の下限を `t` に上げる。明示した上限は動かさず、`t` が上限を満たさなければ制約を変えない（§5.3）
- 更新後のコマンドが失敗しても PR を作る。パッケージの PR とは扱いが違う（§5.2）
- `pub get` と更新後のコマンドの失敗では、ジョブを失敗させない。PR とコメントで知らせる（§5.2）
- リリース一覧を取得できないときは、Flutter の PR だけを止める。全体のエラーにはしない（§5.2）。リリース一覧は pub.dev とは別のホストなので、その障害でパッケージの更新まで止めないため
- `.vscode/settings.json` を `baseHash` に入れない（§4.2）

## 11. 範囲外

- §2 の対象外のもの
- Flutter の CHANGELOG から更新履歴を抜き出すこと（§6）
- `pub get` で動いた依存を本文の表に載せること。lockfile の差分で見る

## 12. 要件との対応

| 要件 | 設計 |
|---|---|
| `.fvmrc` があれば更新する | §2、§5.3 |
| `.vscode/settings.json` の `dart.flutterSdkPath` があれば更新する | §5.3 |
| `pubspec.yaml` の `environment.flutter` を更新する | §5.3 |
| 更新後に `pub get` を 1 回実行する。失敗しても PR を作り、コメントでエラーを表示する | §5.1、§5.2 |
| `pub get` に成功したら、`post_update` のコマンドを同じように実行する | §5.1 |
| 更新した `pubspec.lock` と生成したファイルを一緒にコミットする | §1、§5.1 |
| パッケージの更新とは独立に作り、グループにしない | §4.3 |
| 待機期間（`min_release_age_days`）の対象外にする | §3 |
| `pub get` は中継サーバーを経由しない | §5.1 |
