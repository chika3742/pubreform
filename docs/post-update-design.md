# pubreform 詳細設計: 更新後のコマンド

> ステータス: 案（未実装、2026-10-19）。[基本設計](design.md) §14.3 の案を実装するための決定を書く。[詳細設計](detailed-design.md)を前提にし、「詳細 §n」はその節を指す。実装するときは、この内容を詳細設計に移す。

## 1. 概要

PR を作るときと作り直すときに、その更新単位のコミットを作る前に、設定した `post_update` のコマンドを実行し、変わったファイルも同じコミットに入れる。コマンドは依存パッケージのコード（build_runner の builder など）を実行するので、信頼できないコードとして扱い、次の 3 つを守る。

- App のトークン、ランナーのトークン、ランナーのユーザーのファイルを読ませない（別のユーザーで実行する）
- pubreform がこのあと実行するもの・信頼して読むもの（SDK、pub のキャッシュ、ベースの clone とその `.git`）を書き換えさせない
- 既定ではネットワークを使わせない

## 2. 前提

- Linux のランナーで、パスワードなしの `sudo`、`unshare`、`runuser`（util-linux）が使えること。GitHub のホストランナー（ubuntu）を想定する
- 条件を満たさない環境で `post_update` があれば、全体エラーにする（何も変更しない）。確認は実行の最初に 1 回だけ行う（`sudo -n true`、`command -v unshare runuser`）

## 3. 設定

```yaml
post_update:
  - run: dart run build_runner build --delete-conflicting-outputs
  - run: ./tool/generate_api.sh
    network: true
    env: [API_SPEC_URL]
```

| キー | 型 | 既定 | 内容 |
|---|---|---|---|
| `post_update` | 配列 | `[]` | 上から順に実行する |
| `post_update[].run` | 空でない文字列 | （必須） | `sh -c` で実行するコマンド |
| `post_update[].network` | 真偽値 | `false` | ネットワークを使えるようにする |
| `post_update[].env` | 文字列の配列（重複なし） | `[]` | 追加で渡す環境変数の名前。`^[A-Za-z_][A-Za-z0-9_]*$` に合うもの。値は pubreform のプロセスの環境から取り、なければ渡さない |

- `env` に `INPUT_` で始まる名前と `ACTIONS_` で始まる名前は書けない（設定エラー）。pubreform の入力（App のトークン）とランナーのトークンを、うっかり渡さないため
- `pubreform.schema.json` と `config.ts` に同じ判定を足す（`test/config-schema.test.ts` で確かめる）
- `configHash` は設定全体から計算するので、`post_update` を変えるとすべての PR が作り直される（詳細 §4）

## 4. 流れの変更

今の流れ（詳細 §3）では、計画と適用を終えると中継サーバーを止め、そのあとで PR を操作する。コマンドは PR の操作（`create` と `regenerate`）の中で、コミットを作る直前に実行する。中継サーバーは止まったままでよい（§5.3 で確認済み）。

```
execute
  create / regenerate のたびに:
    generated = post_update があれば generate(result)   ← 追加
    commit(result.files + generated)
    （以降は今と同じ）
```

- `post_update` が空なら、今とまったく同じ動きにする
- 実行のたびに行う適用のやり直しや、`none`（変化なし）の PR では実行しない。作り直すかどうかの判断に生成結果を使わないため
- 更新単位は 1 つずつ順に処理する（作業ディレクトリを使い回すため）

新しいモジュール `src/generate.ts` に、§5〜§7 の処理を置く。`execute` には `ExecuteContext` の関数（`generate?: (result) => Promise<TreeEntry[]>`）として渡し、テストでは差し替える。

## 5. 生成の手順

更新単位ごとに、次を行う。

### 5.1 生成用ディレクトリ

1. `/tmp` の下に新しいディレクトリを作る（`mkdtemp`）。`RUNNER_TEMP` は使わない。ランナーのホームの下にあり、別のユーザーがたどれないことがあるため
2. ベースの clone の作業ツリーを、`.git` を除いてコピーする。`.git` を渡さないのは、生成のコードが `.git/config`（`core.fsmonitor` など）やフックを書き換えると、あとで pubreform が実行する `git` がそのコマンドを実行してしまうため
3. その更新単位の `pubspec.yaml` と、URL を中継サーバーのものにした `pubspec.lock` を書く（`Pub.run` と同じ置き換え）

### 5.2 依存の準備

ランナーのユーザーのまま、生成用ディレクトリで `pub get --offline`（Flutter なら `flutter pub get --offline`、fvm なら `fvm flutter pub get --offline`）を `PUB_HOSTED_URL=<中継サーバーの URL>` で実行し、`.dart_tool/package_config.json` を作る。パッケージは適用のときにキャッシュに入っているので、中継サーバーもネットワークも要らない。

### 5.3 確認済みのこと

2026-10-19 に Dart 3.13.5 で確認した（フィクスチャー用サーバーを中継サーバーの代わりにし、コンテナの root から別のユーザーを作って実行）。GitHub のランナーと Flutter では未確認。

- 中継サーバーの URL の lockfile なら、サーバーを止めたあとでも `pub get --offline` が成功し、`package_config.json` ができる
- その後、ネットワークのない名前空間（`unshare -n`）で `dart run` が動く。暗黙の `pub get` は始まらない。`PUB_HOSTED_URL` を渡さなくても、lockfile を pub.dev の URL に戻した後でも同じ
- 別のユーザー（`runuser -u`）が、環境変数を `env -i` で絞り、ネットワークなしで `dart run` を実行し、生成用ディレクトリにファイルを書けた。SDK と pub のキャッシュは読み取りだけで足りた
- そのユーザーから、root のプロセスの `/proc/<pid>/environ` は読めず（`Permission denied`）、外部に接続できなかった（`curl` が名前解決できずに失敗）
- 同じユーザーのプロセスどうしでは、環境変数をすべて外したプロセスからでも、ほかのプロセスの `/proc/<pid>/environ` を読めた（環境変数を絞るだけでは足りない根拠）

### 5.4 別のユーザー

- 名前は `pubreform-run`。なければ `sudo -n useradd --system --no-create-home --shell /usr/sbin/nologin pubreform-run` で作る（実行ごとに 1 回）
- 生成用ディレクトリの持ち主をそのユーザーにする（`sudo -n chown -R pubreform-run: <dir>`）。HOME 用に空のディレクトリを `/tmp` に作り、同じく渡す
- SDK と pub のキャッシュには、書き込み権限を与えない。書き換えられると、あとで pubreform が実行する pub が改ざんされるため。読めない場合（ランナーのホームの下にある場合）は、ACL でそのユーザーに読み取りとたどる権限だけを与える（`setfacl -m u:pubreform-run:rX`。ホームのディレクトリ自体は `x` だけ）

### 5.5 コマンドの実行

コマンドごとに、生成用ディレクトリで次を実行する。

```
sudo -n [unshare --net --] runuser -u pubreform-run -- env -i <環境変数> sh -c <run>
```

- `network: false` なら `unshare --net` を付ける。`unshare` を root で実行してから `runuser` でユーザーを切り替える（利用者権限の名前空間は、ランナーの設定で禁止されていることがあるため）
- 渡す環境変数: `PATH`、`HOME`（§5.4 のディレクトリ）、`PUB_CACHE`（ランナーと同じ場所）、`LANG`、`LC_ALL`、`CI`、`FVM_CACHE_PATH`、`FLUTTER_ROOT`（それぞれ pubreform のプロセスにあるものだけ）と、`env` で指定したもの
- 出力はジョブのログにそのまま出す（`core.group` で「Post update: <run>」にまとめる）
- 終了コードが 0 でなければ、そこで止めて §8 の失敗にする

### 5.6 後片付け

- 持ち主をランナーのユーザーに戻す（`sudo -n chown -R <uid>:<gid> <dir>`）。変わったファイルを読むため
- 生成用ディレクトリと HOME 用のディレクトリは、更新単位ごとに消す（`sudo -n rm -rf`）

## 6. 変わったファイルの取り出し

生成用ディレクトリの中身は信頼できないデータとして扱う。

1. 変わったファイルは、ベースの clone の `.git`（信頼できる）を使って調べる。`.gitignore` に従い、追跡していないファイルも含める

   ```
   git --git-dir=<base>/.git --work-tree=<dir> -c core.fsmonitor=false status --porcelain=v1 -z --untracked-files=all
   ```

   インデックスは書き換えないよう、ベースのインデックスをコピーしたものを `GIT_INDEX_FILE` で使う。設定は信頼できる `.git` のものなので、作業ツリーの `.gitattributes` があっても、外部のフィルターは動かない
2. `pubspec.yaml` と `pubspec.lock` は除く。この 2 つは適用の結果（`result.files`、pub.dev の URL）を使う
3. パスは作業ツリーの中に限る（`..` や絶対パスは捨てる）。ファイルは `lstat` で調べ、シンボリックリンクはたどらない。リンクはリンクとして（`mode: 120000`、内容はリンク先の文字列）コミットする。生成のコードが、ランナーのファイルを指すリンクを置いて、その内容をコミットさせることを防ぐため
4. tree の項目にする

| 状態 | 項目 |
|---|---|
| 変更・追加（UTF-8 として読め、NUL を含まない） | `content` に内容を入れる。実行権限があれば `mode: 100755`、なければ `100644` |
| 変更・追加（それ以外） | `POST /git/blobs`（`encoding: base64`）で blob を作り、その `sha` を入れる |
| 削除 | `sha: null` |

- 項目は `createCommit` に渡し、2 ファイルと一緒に 1 つの tree にする（`base_tree` はベースの tree）
- 変わったファイルがなければ、今と同じ 2 ファイルだけのコミットになる

## 7. PR の本文

`post_update` のコマンドで変わったファイルがあれば、表の下に 1 行入れる。

```
Files changed by the `post_update` commands: 12
```

ファイルの一覧は載せない（PR の差分で見られるため）。メタデータとコミットメッセージは変えない。

## 8. 失敗

コマンドが失敗した（終了コードが 0 でない）、または §5 の準備に失敗したら、その更新単位のエラーにする（詳細 §15 の更新単位のエラーと同じ）。

- `create` なら PR を作らない。ジョブのログとサマリーに残す
- `regenerate` なら PR を今のままにして、エラーをコメントする（同じ内容なら繰り返さない）
- ログには、失敗したコマンドと、その出力の末尾を入れる

生成なしで PR を作る方式は採らない。生成コードが古いまま CI で落ちる PR を作ることになるため。

## 9. テスト

- 単体テスト
  - 設定とスキーマ（`post_update` の形、`env` の名前、`INPUT_` / `ACTIONS_` の拒否）
  - `git status -z` の出力から tree の項目への変換（変更、追加、削除、リンク、実行権限、バイナリ、作業ツリーの外を指すパス）
  - 渡す環境変数の組み立て
  - `execute` が `create` と `regenerate` のときだけ `generate` を呼び、`none` では呼ばないこと
- ローカル E2E（`sudo -n true` が通る環境だけで動かす。GitHub Actions の CI では動く）
  - `post_update` のコマンドが生成用ディレクトリにファイルを書き、それが PR のコミットに入る
  - コマンドが、親のプロセスの環境変数、`INPUT_TOKEN`、外部への接続にアクセスを試み、どれも失敗する
  - コマンドが失敗すると、その PR にエラーがコメントされる
- GitHub E2E（pubreform-e2e）
  - 上と同じコマンドを本物のランナーで実行し、`sudo`、`unshare`、`runuser` が使えること、トークン（`INPUT_TOKEN`、`ACTIONS_RUNTIME_TOKEN`）と `actions/checkout` の認証情報を読めないことを確かめる

## 10. 決めること・確かめること

- 決めること（この設計では案のとおりにしている）
  - コミットに入れるファイル: 変わったものすべて（§6）。パターンで絞れるようにするか
  - コマンドが失敗したとき: その更新単位のエラー（§8）
- 確かめること
  - Flutter: 別のユーザーから、読み取りだけの Flutter SDK で `flutter` コマンド（`flutter pub get --offline`、`flutter gen-l10n`、`dart run build_runner`）が動くか。`flutter` は SDK の中（`bin/cache`）に書き込むことがある。書き込みが要るなら、SDK に書き込み権限は与えず（§5.4）、別の方法を考える
  - GitHub のランナーで、ランナーのホームのディレクトリの権限、`actions/checkout` が残す認証情報のファイルの権限、ACL（`setfacl`）が使えるか
  - コマンドの数と PR の数が多いときの実行時間。PR ごとに生成が走るので、作り直しが重なると長くなる
- README に書くこと
  - main の生成コードがすでに古いと、作り直した差分がすべての PR に混ざる。先に main で生成コードを最新にしておく
  - 使えるのは Linux のランナーだけ
