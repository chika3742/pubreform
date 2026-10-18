# pubreform 基本設計

> ステータス: ドラフト（2026-10-18）。「13. 仮決めした点」は必要に応じて更新する。実装に必要な決定は[詳細設計](detailed-design.md)に書く。

## 1. 概要

pubreform は、Dart / Flutter プロジェクトの pub 依存を更新する PR を作成・保守する GitHub Action。

設計方針:

- **状態を持たない調整型**: 実行のたびに「あるべき PR の集合」を計算し、既存 PR との差分だけを反映する。必要な情報は、設定ファイル、ベースブランチ、pub.dev、既存 PR に埋め込んだメタデータから毎回復元する。状態保存用のブランチや Issue は持たない。
- **起動イベントに依存しない**: イベントのペイロードは使わない。どのイベントで起動されても、ベースブランチの最新状態を自分で取得して同じ処理を行う。
- **依存解決は pub に任せる**: バージョン選択はすべて `dart pub` / `flutter pub` の実行結果を使い、独自の解決器は作らない。

## 2. スコープ

対象:

- リポジトリのルートにある `pubspec.yaml` / `pubspec.lock`（`pubspec.lock` がコミットされていること）
- pub.dev から取得する `dependencies` / `dev_dependencies`。推移的依存は単独では更新せず、直接依存の PR の中で一緒に上がる分だけを扱う（PR には載せない）
- Dart と Flutter の両方。依存に `sdk: flutter` があれば `flutter pub`、なければ `dart pub` を使う

対象外（v1）:

- path / git / sdk 依存、pub.dev 以外のホストの依存
- `dependency_overrides` に書かれたパッケージ
- Dart / Flutter SDK 自体と `environment` の更新
- pub workspace、ルート以外のディレクトリ。ルートの pubspec に `workspace:` があれば、未対応として何も変更せずに失敗終了する（将来の対応は §14）
- `pubspec.lock` をコミットしないプロジェクト（ライブラリなど）
- プレリリース版（更新先は安定版のみ）

前提:

- PR の作成、コミット、コメントは GitHub App のインストールトークンで行う（§11）
- Dart / Flutter SDK はワークフロー側でセットアップする。解決結果はこの SDK のバージョンに依存し、より新しい SDK を要求するバージョンは「解決不能」として扱われる
- Flutter SDK は fvm で用意する。ワークフローで `chika3742/setup-fvm` を使う（§3.2）

## 3. 全体構成

TypeScript の JavaScript Action（`runs.using: node24`）として実装する。Node 20 はランナーからの削除が告知済みのため、Node 24 を使う。

| コンポーネント | 役割 |
|---|---|
| Config | 設定ファイルの読込・検証、ハッシュ計算 |
| Clock | cron とタイムゾーンから、直近のスケジュール時刻（slot）と公開日時の締切（cutoff）を求める |
| RegistryProxy | pub.dev API を中継し、cutoff より後に公開されたバージョンを隠すローカル HTTP サーバー |
| Planner | pub の解決結果から更新単位（= PR の単位）を決める |
| Applier | 更新単位をベースブランチの上に適用し、コミットを作る |
| Reconciler | 計画した更新単位と既存 PR を突き合わせ、作成・再生成・クローズを決める |
| Renderer | タイトル、本文、コミットメッセージ、コメントを生成する（CHANGELOG の抽出を含む） |
| GitHub | PR、コメント、ラベル、ブランチを操作する |

### 3.1 実行フロー

1. ベースブランチ（リポジトリのデフォルトブランチ）を、作業用ディレクトリとして `RUNNER_TEMP` の下に浅く clone する（詳細 §8.1）。`GITHUB_WORKSPACE` の中に置くと、setup-fvm の post 処理が pub キャッシュのキー（`**/pubspec.lock` のハッシュ）を計算するときに作業用ディレクトリの lockfile まで含まれてキーが変わり、毎回キャッシュが保存されてしまう
2. 設定ファイルをベースブランチから読む（起動元の ref にある設定は使わない）
3. Clock で slot と cutoff を求める（§4）
4. RegistryProxy を起動する。以降の pub コマンドはすべてプロキシ経由で、作業用ディレクトリの中で実行する（§3.2）
5. Planner で更新単位の集合を求める（§5）
6. 各更新単位を Applier で適用し、変更内容（pubspec の差分とバージョン変更の一覧）を得る
7. Reconciler で既存 PR（open と closed）と突き合わせ、必要な操作を実行する（§7）
8. ジョブサマリーに slot、cutoff、各 PR への操作、解決不能だった更新、エラーを書く。エラーが 1 件でもあれば失敗終了する

### 3.2 Flutter SDK

- ワークフローで [`chika3742/setup-fvm`](https://github.com/chika3742/setup-fvm) を使い、FVM と Flutter SDK を入れる。Flutter SDK と pub のキャッシュの保存・復元も setup-fvm が行う（§10.3）
- Action は、ルートに `.fvmrc` があれば、§2 の pub コマンドの前に `fvm` を付けて実行する（`fvm flutter pub …` / `fvm dart pub …`）。fvm は実行したディレクトリの `.fvmrc` のバージョンを使う。Action は pub をベースの作業用ディレクトリの中で実行するので、使われるのはベースの `.fvmrc` のバージョンになる
- checkout した ref とベースで `.fvmrc` が違う場合は、fvm がベースのバージョンを自動でインストールしてから実行する。結果はベースのバージョンで解決したものになるが、SDK の取得に時間がかかる
- `.fvmrc` がなければ、PATH 上の `flutter` / `dart` をそのまま使う（Dart だけのプロジェクトなど。SDK は `dart-lang/setup-dart` などで用意する）
- `.fvmrc` はベースのハッシュ（§6.1）に含める。Flutter のバージョンが変わると、すべての PR を再生成する

## 4. スケジュールとリリース後の待機期間

### 4.1 スケジュールの解釈

設定の cron は「チェックを実行する時刻」ではなく、「**更新対象にするバージョンの範囲が切り替わる時刻**」として扱う。

- `slot` = 設定の cron（指定タイムゾーン）が最後に発火した時刻（現在時刻以前で直近のもの）
- `cutoff` = `slot − min_release_age_days`
- 計画では、`cutoff` 以前に公開されたバージョンだけを候補にする

この解釈で次の性質が得られる。

- 次の slot までのどの実行でも、入力（ベース、設定、pub.dev）が同じなら計画も同じになる。結果が起動のタイミングや回数に左右されない
- GitHub の schedule が遅延・欠落しても、その後の最初の実行で同じ結果が得られる。前回の実行時刻を保存する必要がない
- 新しいリリースが PR に入るのは、slot を過ぎた後の最初の実行。slot と slot の間に PR の内容が変わる（新規作成を含む）のは、ベースや設定が変わったときと導入直後だけ。新規作成する時刻は slot の直後に限らない。新規作成が起こる例:
  - 導入後の最初の実行
  - 設定の変更: `ignore` から外す、`min_release_age_days` を短くする、`schedule` を変える
  - main の変更: 古い制約で依存を追加する、lockfile で意図的にバージョンを下げる、マージ済みの bot の PR を revert する、`.fvmrc` で Flutter を上げる（新しい SDK を要求していた更新が解決できるようになる）
  - bot の PR をマージしただけでは、新しい PR はほぼ作られない（他の PR の再生成になる）
- PR に入るバージョンは、PR 作成時点で必ず `min_release_age_days` 日以上経過している

ワークフローの起動頻度は自由に決めてよい。slot の直後に PR が欲しい場合は、ワークフローの `schedule` を同じ cron とタイムゾーンにする（GitHub Actions の `schedule` は `timezone` を指定できる）。

### 4.2 待機期間の適用（RegistryProxy）

pub には公開日時で候補を絞る機能がない。クールダウン機能は [dart-lang/pub#4831](https://github.com/dart-lang/pub/pull/4831) でドラフトの段階で、2026-10-12 時点の master にも実装はない。そのため、pub が参照するパッケージリポジトリを差し替えて実現する。

- Action 内で `127.0.0.1` の HTTP サーバーを起動し、`PUB_HOSTED_URL` に指定して pub を実行する
- `GET /api/packages/<name>`: pub.dev の応答の `versions` から、`published` が `cutoff` より後のバージョンを除いて返す（pub は `versions` だけを読み、`latest` は使わない）。ただし、ベースの `pubspec.lock` でロックされているバージョンは必ず残す。ダウングレードを防ぐためと、Flutter SDK が要求するバージョン（下記）を隠さないためである
- `archive_url` は pub.dev の URL のまま返す。アーカイブは pub.dev から直接ダウンロードされ、`archive_sha256` で検証される
- その他のパスは pub.dev にそのまま中継する
- 取り下げ（retracted）されたバージョンは pub 自体が選ばないので、プロキシでは扱わない

pub は lockfile の各パッケージにホストの `url` を記録しており、`PUB_HOSTED_URL` と違う URL のエントリはロック済みとして扱わない。そのため、pub を実行する前に作業用コピーの lockfile の `url: "https://pub.dev"` をプロキシの URL（`url: "http://127.0.0.1:<port>"`。pub が書く形そのまま）に置き換え、実行後に元へ戻す。

pub はダウンロードしたパッケージを、ホストごとのディレクトリに保存する。プロキシ経由で取得したパッケージは `~/.pub-cache/hosted/localhost%58<port>/` に入り、setup-fvm が復元する `hosted/pub.dev/` とは別になる。ポートを実行ごとに変えると保存先も変わり、キャッシュが増え続けるため、プロキシのポートは固定にする。

> **検証結果**（2026-10-18。プロトタイプで確認し、その手順は結合テスト [`test/integration.test.ts`](../test/integration.test.ts) に移した）: Dart 3.13.5 の `dart pub` と、fvm 4.3.2 で入れた Flutter 3.47.7 の `fvm flutter pub` の両方で、次をすべて確認した。
> - 締切より後に公開されたバージョンは、直接依存（`http` / `dio`）でも推移的依存（`async` / `vector_math`）でも選ばれない（`pub get` / `pub upgrade` / `pub add`）
> - lockfile の URL を置き換えて実行すると、`pub get` はロックを維持する。元に戻した lockfile は、プロキシなしの pub が書くものとバイト単位で同じになる（`sha256` も同じ）
> - URL を置き換えないと、pub はロックを無視して解決し直し（`pub get` でも直接依存が上がる）、lockfile にプロキシの URL を書く
> - ロック済みのバージョンを残せば、締切より新しいバージョンがロックされていても、`pub get` / `pub upgrade` でダウングレードしない
> - pub は警告を出さない。プロキシ経由で取得したパッケージは `hosted/localhost%58<port>/` に保存される
> - pub の解決器はバージョン一覧を毎回サーバーから取得する。キャッシュ（最大 3 日）を使うのはロック済みのバージョンの情報を読むときだけで、ロック済みのバージョンは常に一覧に残すため、結果に影響しない
>
> Flutter SDK の要求: Flutter SDK のパッケージは、pub.dev のパッケージの最低バージョンを要求する（Flutter 3.47.7 の `flutter` は `meta ^1.18.3`（2026-06-04 公開）、`vector_math ^2.4.0`（2026-06-03 公開）など）。lockfile がなく、これらが締切より新しいと解決に失敗する。ベースの lockfile にはその SDK で解決したバージョンが入っているので、ロック済みのバージョンを残せば解決できる（締切を 2025-10-01 にして確認。残さないと `get` も `upgrade` も失敗する）。ただし、main で `.fvmrc` だけを上げて lockfile を更新していない場合は、新しい SDK が要求するバージョンが締切より新しいと解決に失敗する（全体エラーとしてジョブのログに出る）。
>
> pub にクールダウン機能が入ったら、この仕組みはそれに置き換える。

## 5. 更新単位の計画（Planner）

### 5.1 用語

- **直接依存**: `pubspec.yaml` の `dependencies` / `dev_dependencies` のうち、§2 の対象になるもの。`ignore` 設定に該当する範囲は、すべての解決で除外する（中継サーバーで該当バージョンを隠す。詳細 §9）
- **`c(d)`**: ベースの `pubspec.lock` での d のバージョン
- **メジャー更新**: `pubspec.yaml` の制約の範囲を超える更新。caret 制約（`^x.y.z`）なら semver の破壊的変更と一致し、`0.x` ではマイナー番号の変化もこれに当たる（`^0.3.1` = `>=0.3.1 <0.4.0`）

### 5.2 基準となる 2 つの解決

| 名前 | pubspec の一時的な書き換え | 解決方法 | 意味 |
|---|---|---|---|
| U（upgradable） | なし | `pub upgrade` | 今の制約の範囲での最新。マイナー・パッチグループの内容になる |
| R（resolvable） | すべての直接依存を `>=c(d)` に | lockfile なしで解決 | 全パッケージを最新安定版まで上げてよい場合の解決。`pub outdated` の Resolvable 列とほぼ同じ（下限を現在のバージョンにしてダウングレードを禁じる点が違う） |

一時的な書き換えは作業用コピーに対して行い、コミットには含めない。

pub の `get` / `upgrade` / `add` にはすべて `--no-example` を付ける（既定では `example/` も解決され、その lockfile も変わるため）。

### 5.3 分類

1. **マイナー・パッチグループ**: U でバージョンが変わる直接依存すべて。`pub upgrade` の結果そのものなので、同時に解決できることが保証される。推移的依存も `pub upgrade` で一緒に上がるが、PR の内容には含めない。直接依存が 1 つも変わらない（推移的依存だけが変わる）場合は PR を作らない。上限のない制約（`any`、`>=1.0.0` など）を持つ依存は、pub の挙動どおりメジャー更新もこのグループに入る
2. **グループ外の候補 X**: `R(d) > U(d)` となる直接依存。今の制約の範囲には収まらない更新
3. **解決不能**: 候補バージョンのうち `R(d)` より新しいもの。他のどのパッケージを最新安定版にしても選ばれないので、PR を作らない（ジョブサマリーにだけ記録する）

### 5.4 単独 PR と同時更新グループの判定

X の各 d について、一緒に上げる必要がある直接依存の集合 `S(d)` を求める。

```
S = {d}
繰り返し:
  S の要素を R のバージョンに固定し、それ以外の直接依存は >=c(e) に緩めて、
  ベースの lockfile を残したまま pub get する
  （pub はロック済みのバージョンをできるだけ維持するので、必要なものだけが動く）
  K = 元の制約の範囲から外れた、S 以外の直接依存
  K が空なら終了。空でなければ S ← S ∪ K
```

R 自体がこの条件を満たす解なので、この解決は失敗しない。

- 要素が重なる `S` 同士を 1 つにまとめ、まとめた集合で同じ反復をもう一度行って確定させる
- 要素が 1 つ: **単独 PR**
- 要素が 2 つ以上: **同時更新グループ PR**。単独で解決できるメジャー更新 B でも、他の更新 A が B を必要とするなら {A, B} の同時更新グループに入れ、B の単独 PR は作らない
- 同時更新グループに入ったパッケージでも、今の制約の範囲での更新はマイナー・パッチグループに残る。例: A の 1.2→1.4 はマイナー・パッチグループ、1.4→1.5（B 3.0 が必要）は同時更新グループに入る。マイナー・パッチグループがマージされると、同時更新グループは再生成され、内容が「A 1.4→1.5」になる

注: pub の解決器は、動かすパッケージの数を最小にするわけではない。そのため `S` は最小とは限らず、pub が選んだ結果に従う。

### 5.5 適用（Applier）

ベースの作業用ディレクトリで次を実行する。

| 更新単位 | 操作 |
|---|---|
| マイナー・パッチグループ | `pub upgrade`。`versioning: increase` なら `--tighten` を付けて下限も上げる |
| 単独 / 同時更新グループ | `pub add a:^R(a) dev:b:^R(b) …`。既存の依存の制約を書き換える。`pubspec.yaml` の書式は pub が維持する |

変更されるのは `pubspec.yaml` と `pubspec.lock` だけ。PR の内容（どの直接依存を何から何へ）は、計画値ではなく適用後の lockfile の差分から求める。推移的依存の変化は、どの更新単位でも lockfile にそのまま入れ、PR の内容（本文、表、コメント）では触れない。

## 6. PR の種類と識別

| 種類 | ブランチ | タイトル |
|---|---|---|
| 単独 | `pubreform/single/<package>` | `Update <package> from <前> to <後>` |
| マイナー・パッチグループ | `pubreform/minor-and-patch` | `Update <N> packages` |
| 同時更新グループ | `pubreform/group/<作成時の先頭パッケージ名>` | `Update <N> packages` |

- N はバージョンが変わる直接依存（`dependencies` / `dev_dependencies`）の数
- コミットはベースの最新コミットの上に 1 つだけ作る。コミットメッセージの 1 行目はタイトルと同じ。グループの場合は本文に、更新した直接依存の表を入れる

```
Update 2 packages

| Package | From | To | Type |
|---|---|---|---|
| http | 1.5.0 | 1.6.0 | direct |
| lints | 6.0.0 | 6.1.0 | dev |
```

### 6.1 PR メタデータ

本文の末尾に HTML コメントで埋め込む。

```html
<!-- pubreform:meta {"v":1,"kind":"group","packages":{"http":["1.5.0","1.6.0"]},"baseHash":"…","configHash":"…","commit":"…"} -->
```

| キー | 用途 |
|---|---|
| `kind`, `packages` | 計画との突き合わせ、内容の変更の検出、クローズ済み PR の再作成の抑止 |
| `baseHash` | 生成時のベースの `pubspec.yaml`、`pubspec.lock`、`.fvmrc` のハッシュ。ベースの更新と Flutter のバージョン変更を検出する |
| `configHash` | 設定の変更を検出する |
| `commit` | 生成したコミットの SHA。PR の head と違えば、人手のコミットがある |

PR の識別にはブランチ名の接頭辞とメタデータを使い、ラベルは使わない（ラベルは利用者が付け外しするため）。

## 7. 調整（Reconciler）

### 7.1 計画と既存 PR の突き合わせ

- 単独 PR とマイナー・パッチグループは、種類とブランチ名で対応させる
- 同時更新グループは、パッケージの集合が最も多く重なる既存のグループ PR と 1 対 1 で対応させる。メンバーが変わっても同じブランチを使い続ける

### 7.2 各 PR への操作

| 状況 | 操作 |
|---|---|
| 計画にあり、PR がない | PR を作成し、設定のラベルを付ける。ただし、同じ種類で同じ内容（パッケージと更新後のバージョン）の、マージされずにクローズされた PR があれば作らない（直近 100 件を確認） |
| 計画になく、PR がある | 理由をコメントしてクローズし、ブランチを削除する（例: ベースで更新済み、`ignore` に追加された、同時更新グループに統合された）。ただし、PR のパッケージの計画に失敗した場合は閉じない（詳細 §14.3） |
| 両方ある | 次の条件のどれかを満たせば再生成する |

再生成の条件:

| 条件 | 判定方法 |
|---|---|
| 本文のチェックボックスがチェックされた | 本文中のマーカー付きチェックボックスが `[x]` |
| ベースとコンフリクトしている | PR の `mergeable_state` が `dirty`。`mergeable` が未計算なら今回は判定しない |
| 更新内容が変わった | 適用結果の `packages` がメタデータと違う |
| ベースの `pubspec.yaml` / `pubspec.lock`（と `.fvmrc`）が更新された | ベースのハッシュがメタデータの `baseHash` と違う |
| 設定が変わった | 設定のハッシュがメタデータの `configHash` と違う |

PR が変更するのは pubspec の 2 ファイルだけなので、コンフリクトはほぼ `baseHash` の比較で検出できる。`mergeable_state` は念のために見る。

再生成の手順:

1. ベースの最新コミットを親にして、コミットを作り直す（1 コミットのまま。amend と同じ結果になる）
2. 同じブランチを新しいコミットへ強制的に更新する（force push に当たる。方法は §11）。直前にブランチの head が想定どおりかを確かめ、違えば更新しない
3. タイトル、本文、メタデータを更新し、チェックボックスを未チェックに戻す
4. **更新内容が変わった場合だけ**、変更点をコメントする（追加・削除・更新後のバージョンの変更を表にする）。更新前のバージョンだけが変わった場合（例: マイナー・パッチグループのマージで From が変わる）や、推移的依存だけが変わった場合は、内容の変更に含めない

人手のコミットがある PR（head がメタデータの `commit` と違う）は自動では再生成しない。最初に検出したときに 1 回だけその旨をコメントする。チェックボックスがチェックされた場合は、人手のコミットを破棄して再生成する。

### 7.3 同時実行

- ワークフローの `concurrency` で実行を直列にする（§10.3）
- ブランチを更新する直前に head を確認し、想定と違えば更新せずにエラーとして扱う（§9）。確認してから更新するまでの間に入った push は検出できないが、直列化していれば通常は起きない

## 8. PR 本文

本文とコメントの文言は、タイトルに合わせて英語にする。

````markdown
Updates the following packages.

| Package | From | To | Type |
|---|---|---|---|
| [http](https://pub.dev/packages/http) | 1.5.0 | 1.6.0 | direct |

### http 1.5.0 → 1.6.0

[pub.dev](https://pub.dev/packages/http/versions/1.6.0) · [Source](https://github.com/dart-lang/http/tree/master/pkgs/http)

<details>
<summary>Changelog</summary>

## 1.6.0
...

</details>

---

- [ ] Rebase this PR <!-- pubreform:rebase -->

<!-- pubreform:meta {...} -->
````

- 本文には直接依存だけを載せる。推移的依存は表にも載せない
- **ソースへのリンク**: 更新後のバージョンの pubspec の `repository`。なければ `homepage`。どちらもなければ省略する
- **更新履歴**: pub がキャッシュに展開した、更新後のバージョンの `CHANGELOG.md` から（詳細 §12.3）、「更新前 < v ≤ 更新後」に当たるバージョン見出しの節を抜き出す。見出しにバージョン文字列を含む行（`## 1.6.0`、`## [1.6.0] - 2025-11-10`、`# v1.6.0` など）を見出しとみなす
- 抜き出せない場合や取得できない場合は、`https://pub.dev/packages/<package>/changelog` へのリンクだけを載せる
- 本文の上限（65,536 文字）を超える場合は、パッケージごとの更新履歴を切り詰めてリンクを付ける

## 9. エラー処理

| 発生箇所 | 扱い |
|---|---|
| 既存 PR がある更新単位の処理中（適用、ブランチの更新、PR 操作） | その PR にエラーログをコメントする。ブランチは変更しない。他の更新単位の処理は続ける |
| まだ PR がない更新単位の処理中 | ジョブのログに出す |
| 全体（設定の誤り、pub.dev に到達できない、SDK がない） | 何も変更せずに失敗終了する |
| 更新履歴やソースリンクの取得 | エラーにしない。本文に取得できなかった旨と pub.dev へのリンクを載せる |

- 同じエラーを毎回コメントしないように、エラーログのハッシュをコメント内のマーカーに入れ、その PR の直近のエラーコメントと同じハッシュなら投稿しない
- コメントするログは末尾の一定量（例: 200 行）に切り詰める。API で投稿する文字列には Actions のシークレットのマスクが効かないので、入力のトークンと URL に含まれる認証情報を伏せ字にする
- エラーが 1 件でもあれば、最後に Action を失敗終了させる（ワークフローの失敗通知で気づけるようにする）

## 10. 設定

### 10.1 Action の入力

| 入力 | 既定値 | 説明 |
|---|---|---|
| `token` | （必須） | GitHub App のインストールトークン（§11） |
| `config` | `.github/pubreform.yaml` | 設定ファイルのパス。ベースブランチから読む |

### 10.2 設定ファイル

```yaml
# $schema: https://raw.githubusercontent.com/chika3742/pubreform/v1/pubreform.schema.json
schedule:
  cron: "0 9 * * 1"         # 必須
  timezone: Asia/Tokyo      # IANA のタイムゾーン名。既定は UTC
min_release_age_days: 3     # 既定は 0
labels: [dependencies]      # PR に付けるラベル
versioning: increase        # increase | lockfile-only（マイナー・パッチグループで pubspec の下限を上げるか）
ignore:
  - name: some_package      # 名前だけなら、すべての更新を対象外にする
  - name: other_package
    versions: ">=3.0.0"     # この範囲のバージョンへの更新を対象外にする
```

設定ファイルの置き場所は `.github/pubreform.yaml`（入力 `config` で変えられる）。先頭の行で JSON スキーマ（[`pubreform.schema.json`](../pubreform.schema.json)）を指定すると、エディタで補完と検証が効く（詳細 §4.2）。

`versioning` と `ignore` は要件にはない追加項目。不要なら削除する。

### 10.3 ワークフロー例

```yaml
name: pubreform

on:
  schedule:
    - cron: "0 9 * * 1"
      timezone: Asia/Tokyo
  push:
    branches: [main]
    paths: [pubspec.yaml, pubspec.lock, .fvmrc, .github/pubreform.yaml]
  pull_request:
    types: [edited]          # チェックボックスへの即時対応
  workflow_dispatch:

concurrency:
  group: pubreform
  cancel-in-progress: false

jobs:
  pubreform:
    # pull_request は bot の PR だけ。App 自身による本文の更新では起動しない
    if: >-
      github.event_name != 'pull_request' ||
      (startsWith(github.head_ref, 'pubreform/') && github.event.sender.type != 'Bot')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v3
        id: app-token
        with:
          client-id: ${{ vars.PUBREFORM_CLIENT_ID }}
          private-key: ${{ secrets.PUBREFORM_PRIVATE_KEY }}
      - uses: actions/checkout@v7
      - uses: chika3742/setup-fvm@v3        # Dart だけなら dart-lang/setup-dart@v1
      - uses: chika3742/pubreform@v1
        with:
          token: ${{ steps.app-token.outputs.token }}
```

## 11. トークンと権限

- PR の作成、コミット、コメント、ラベル付けは、`token` に渡した GitHub App のインストールトークンで行う。`GITHUB_TOKEN` は使わない（`GITHUB_TOKEN` で作った PR では、`pull_request` で起動する CI が承認待ちになるため）
- App に必要な権限（Repository permissions）: Contents（Read and write）、Pull requests（Read and write）。コメントとラベルの API は Pull requests の権限で使える
- コミットは git の push ではなく、GitHub API（blob → tree → commit → ref の更新）で作る。App として認証し author / committer を指定しなければ、コミットは App の bot ユーザーの名義になり、GitHub の署名で Verified と表示される。変更するのは 2 ファイルだけなので、API の呼び出しは数回で済む
- ref を更新する REST API には「head が想定どおりなら更新する」という条件を付けられないため、§7.3 のとおり直前に確認する
- App による push や PR の作成では、通常どおり CI などの他のワークフローが起動する。App 自身が本文を更新したときも `pull_request: edited` で起動するので、ワークフロー側で除外する（§10.3）

## 12. 要件との対応

| 要件 | 設計 |
|---|---|
| 更新ごとに PR を作成、タイトル、ラベルを設定可能、ソースへのリンクと更新履歴 | §6、§8、§10.2 |
| 同時に解決できるマイナー・パッチを 1 つのグループ PR に、タイトル、コミットに表 | §5.3、§6 |
| メジャーは独立した PR | §5.4 |
| 複数パッケージの同時更新が必要な更新をマイナーグループから切り離してグループ化 | §5.4 |
| 最新安定版まで上げても解決できない更新は PR を作らない | §5.3 |
| リリース後に指定日数が経過してから PR を作成 | §4 |
| リベースの 5 つの条件 | §7.2 |
| 内容が変わったら amend して force push し、変更内容をコメント | §7.2 |
| トリガーはワークフロー側で制御し、いつ起動されても同じように動作 | §1、§4.1 |
| 定期チェックの時刻を cron とタイムゾーンで設定 | §4.1、§10.2 |
| エラーが発生したら関連する PR にエラーログをコメント | §9 |

## 13. 仮決めした点

次の点は仮の方針で設計に反映している。必要なら変更する。

- マイナー・パッチグループでも pubspec の下限を上げる（`versioning: increase`、`pub upgrade --tighten`）（§5.5）
- 人手のコミットがある PR は自動で再生成しない（§7.2）
- マージせずにクローズされた PR と同じ内容の PR は再作成しない（§7.2）
- プレリリース版は対象外
- セキュリティアドバイザリがあっても待機期間は短縮しない（pub.dev の advisories API を使って後から対応できる）
- 本文とコメントは英語
- コミットは API で作る（Verified になり、git の認証設定も要らない。代わりに、head の確認から ref の更新までの間に入った push は検出できない）（§11）

## 14. 将来の拡張: pub workspace

v1 はルートの 1 パッケージだけを扱う。pub workspace では、lockfile はルートに 1 つで、制約は各メンバーの `pubspec.yaml` にある。同じパッケージを複数のメンバーが別々の制約で宣言することもある。後から対応しやすいように、v1 から次の形で実装しておく。

- 「`pubspec.yaml` の一覧」と「lockfile」を分けて扱う。v1 では一覧はルートの 1 つだけ
- 直接依存は「パッケージ名 → それを宣言している `pubspec.yaml` の一覧」で持つ。制約の書き換え（R の計算、`pub add`）は、宣言しているすべての `pubspec.yaml` に対して行う
- `baseHash` は、一覧のすべての `pubspec.yaml`、lockfile、`.fvmrc` から計算する

PR の単位とブランチ名は lockfile ごとに決まるので、workspace に対応しても変えなくてよい（workspace 全体で 1 組の PR になる）。lockfile が複数ある構成（独立したプロジェクトが並ぶリポジトリ）に広げる場合は、ブランチ名にディレクトリを入れる（例: `pubreform/<dir>/minor-and-patch`）。

## 参考

- [dart-lang/pub#4831 Dependency cooldown policy](https://github.com/dart-lang/pub/pull/4831)（ドラフト）
- [Hosted Pub Repository Specification Version 2](https://github.com/dart-lang/pub/blob/master/doc/repository-spec-v2.md)
- [Dart SDK CHANGELOG](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md)（`pub upgrade <package>@<version>` は未リリースの 3.14 で追加予定）
- [Triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)（`GITHUB_TOKEN` によるイベント）
- [Workflow syntax: on.schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onschedule)（`timezone`）
- [Deprecation of Node 20 on GitHub Actions runners](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)
- [About commit signature verification: Signature verification for bots](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification#signature-verification-for-bots)
- [chika3742/setup-fvm](https://github.com/chika3742/setup-fvm)
- [FVM Configuration](https://fvm.app/documentation/getting-started/configuration)
