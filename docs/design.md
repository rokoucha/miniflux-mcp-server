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

materiaにDeployment、Service、Ingress、TLS reflector、OnePasswordItem、SQLite PVC、NetworkPolicy、Argo Applicationを追加。Miniflux側にもMCP namespace/podから8080への通信を許可する。Miniflux接続先は `http://service.miniflux.svc:8080`。公開名はユーザー回答待ち（仮: miniflux-mcp.ggrel.net）。鍵は1Passwordに保存しGitには含めない。

## 検証と制約

OAuth discovery/DCR/認可/PKCE/リプレイ/refresh縮小/権限検証、HTTP APIマッピング/機密除外/エラー/リダイレクト/サイズ上限をテスト。MCP SDKクライアントで初期化とツール実行を統合検証。Docker buildとKustomize renderを検証する。

既存MinifluxのAPIキー発行とクライアントからの対話認証はユーザー操作が必要。実Minifluxの読み取りは資格情報が利用できれば確認し、変更APIを本番データに対して無断で試験しない。
