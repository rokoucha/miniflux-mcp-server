# Miniflux MCP server

## 目的と構成

Minifluxの読書・購読管理をChatGPT等から使う。TypeScript / Node.js 24、MCP公式SDK、Express、Zod、joseを使用する。cosense-cli-mcpのOAuthとCIを流用し、CLI実行部分をMiniflux HTTP APIクライアントに置き換える。

- `/mcp`: リクエストごとにサーバーとTransportを閉じるstateless Streamable HTTP。
- `/authorize`, `/token`, `/register` とdiscovery: OAuth 2.1 / PKCE S256。認可画面でユーザーのMiniflux APIキーを受け取り、固定設定のMiniflux `/v1/me` で検証する。
- APIキーをJWEで暗号化したアクセストークン・リフレッシュトークンに格納する。read/writeスコープをツール実行時に検証する。任意の上流URLや生HTTP実行は公開しない。
- 認可コード・refresh tokenの再利用はSQLiteにハッシュだけを保存して拒否。PVCに永続化し、単一replica / Recreateで運用。OAuthトークンには一意のjtiを付与し、refresh後に権限を拡張しない。
- API通信はリダイレクト禁止、タイムアウト・レスポンスサイズ上限を設定。上流エラーボディや資格情報をログ・ツール結果に含めない。フィードや記事に埋め込まれるcookie/password等は返却せず、公開フィールドのみを投影する。
- 記事一覧は本文を既定で省き、ページングと上限を設定する。記事本文は信用できないコンテンツとして扱う。

## 初期ツール

記事の検索・絞り込み一覧、単一記事取得、既読/未読/削除状態更新、ブックマーク状態の設定、カウンター、フィード一覧/取得/追加/更新/削除/更新要求、カテゴリ一覧/作成/更新/削除。管理者API、APIキー管理、OPML一括操作は対象外。

## 配送

GitHub Actionsでlint/typecheck/test/build後にamd64/arm64イメージをGHCRへ公開。default branchだけ公開、PRでも検証。タイムスタンプとSHAタグを付ける。materiaでは固定タグを使用し、既存のRenovate / Argo CDで追従する。

materiaにDeployment、Service、Ingress、TLS reflector、OnePasswordItem、SQLite PVC、NetworkPolicy、Argo Applicationを追加。Miniflux側にもMCP namespace/podから8080への通信を許可する。Miniflux接続先は `http://service.miniflux.svc:8080`。公開名はユーザー確定済み: miniflux-mcp.ggrel.net。鍵は1Passwordに保存しGitには含めない。

## 検証と制約

OAuth discovery/DCR/認可/PKCE/リプレイ/refresh縮小/権限検証、HTTP APIマッピング/機密除外/エラー/リダイレクト/サイズ上限をテスト。MCP SDKクライアントで初期化とツール実行を統合検証。Docker buildとKustomize renderを検証する。

既存MinifluxのAPIキー発行とクライアントからの対話認証はユーザー操作が必要。実Minifluxの読み取りは資格情報が利用できれば確認し、変更APIを本番データに対して無断で試験しない。

## 信頼境界と運用

MCPクライアントを認可するユーザーを信頼し、readを既定とする。writeを明示的に認可したクライアントは購読・記事を削除できる。モデルのプロンプトインジェクション耐性をサーバーが保証するものではなく、クライアント側の操作確認も必要。ユーザー決定によりDCRと静的クライアントのコールバックはChatGPT・Claude・Museに限定する（localhostは許可しない）。認可画面には送信先ホストを表示する。

materiaのMinifluxは2.3.5であり、private networkへのfetchはMiniflux標準の接続時保護（DNS再解決とredirectも対象）を使用する。`FETCHER_ALLOW_PRIVATE_NETWORKS`は有効化しない。MCP側のURL事前DNS判定を重複実装せず、実際に接続するMinifluxを境界とする。既存のCilium default-denyとMinifluxのegress許可も維持する。

失効はMinifluxでこの連携用APIキーを削除する。侵害時は4種類のJWE鍵から旧鍵を外して再起動し、全トークンとDCR登録を破棄できる。通常ローテーションとSQLite復旧の手順はREADMEを参照。refresh token familyの連鎖失効は初期実装に含めず、再利用そのものを永続拒否する。
