# Local FZF

Raycast で `Local FZF` を開きます。検索欄右のメニュー（⌘P）で、場所と検索対象を選べます。Enter で項目を開き、アクションメニューから Finder で表示、パスをコピー、候補一覧を更新できます。

Raycast の **Settings → Extensions → Local FZF** で設定します。

| 設定 | 入力例と動作 |
| --- | --- |
| Custom Search Locations | `~/Workspace; ~/Documents/Work Files`。各パスが検索メニューに追加されます |
| Default Search Location | Home、最初のカスタム場所、すべてのカスタム場所、Entire Disk から選びます |
| Default Result Type | ファイルとフォルダ、ファイルのみ、フォルダのみから選びます |
| Include Globs | `*.ts; **/*.md`。一致した項目を検索候補に含めます |
| Exclude Globs | `node_modules; **/build; ~/Library`。一致したフォルダの中も探索対象から外れます |
| Exclude Regular Expression | `(^|/)(dist|coverage)(/|$)`。検索範囲からの相対パスに適用します |
| Hidden Files | ドットで始まるファイルとフォルダを検索対象に含めます |
| FZF Match Mode | ファジー検索と完全な部分文字列の一致を切り替えます |
| FZF Executable | 必要に応じて `~/.nix-profile/bin/fzf` のような実行ファイルのパスを指定します |

glob はセミコロンで区切ります。スラッシュを含まないパターンはファイル名・フォルダ名、相対パターンは検索範囲からのパス、絶対パターンは絶対パスに適用します。相対パスを扱う除外正規表現は JavaScript の構文で、前後の `/` を省きます。検索欄では `^/Users/`、`.md$`、`!draft` など、fzf のクエリ構文が使えます。検索対象のパスは絶対パスなので、`^` は絶対パスの先頭に一致します。

カスタム場所を複数登録すると、⌘P の **All Custom Locations** でまとめて検索できます。たとえば Workspace と Google Drive の作業フォルダを登録し、`コンパイラ` で検索して Workspace 側を開くと、次の同じ検索で Workspace 側が優先されます。開いた回数と最終利用時刻をパス・検索語ごとにローカル保存し、fzf が返した上位候補の中で順位を調整します。

初回は選んだ場所と種類の候補を作ります。以降は保存済みの候補で検索を開始し、30 秒以上前の一覧はバックグラウンドで更新します。入力ごとに候補一覧を実際の `fzf` に渡し、表示を 60 件に絞ります。固定の入力待ちはなく、入力が変わると進行中の検索を取り消します。シンボリックリンクの先は探索しません。

開発時は `npm install` と `npm run dev` で Raycast にローカル登録できます。Homebrew、Nix、PATH 上の `fzf` を自動検出します。
