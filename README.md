# miniflux-mcp-server

MinifluxをChatGPT等から使うためのStreamable HTTP MCPサーバー。記事検索・本文取得、既読状態・ブックマーク、フィード・カテゴリの管理に対応します。

## 起動

Node.js 24以上とpnpmを使用します。

```sh
pnpm install --frozen-lockfile
MINIFLUX_URL=https://miniflux.example.com pnpm dev
```

接続先は `http://localhost:3000/mcp`。開発時の暗号鍵は使い捨てです。

MinifluxはAPIアクセス用のOAuth認可サーバーを提供しないため、本サーバーがOAuth（PKCE S256、ChatGPT・Claude・Museに限定した動的クライアント登録、refresh）を提供します。認可画面で **Minifluxの設定 → APIキー** から作成した専用キーを入力します。キーは `/v1/me` で検証し、暗号化したトークンに格納します。APIキーをGitやサーバー環境変数に保存する必要はありません。

スコープは `miniflux:read`、`miniflux:write`、`offline_access`。省略時は読み取りのみです。書き込み権限を追加する場合は再接続して認可してください。Miniflux側のAPIキーを削除すると、以後の上流API呼び出しは拒否されます。

## 本番設定

| 環境変数                      | 内容                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| `MINIFLUX_URL`                | MinifluxのHTTP(S) origin（`/v1`を含めない）                                |
| `ISSUER`                      | MCP公開origin。productionではHTTPS必須                                     |
| `PORT`                        | HTTPポート、既定3000                                                       |
| `DATABASE_PATH`               | リプレイ防止SQLite、既定 `./oauth.sqlite`。コンテナは `/data/oauth.sqlite` |
| `JWE_KEYS_AUTHORIZE_REQUEST`  | 認可リクエストの暗号鍵                                                     |
| `JWE_KEYS_AUTHORIZATION_CODE` | 認可コードの暗号鍵                                                         |
| `JWE_KEYS_ACCESS_TOKEN`       | アクセストークンの暗号鍵                                                   |
| `JWE_KEYS_REFRESH_TOKEN`      | refreshと動的登録の暗号鍵                                                  |
| `OAUTH_CLIENTS_JSON`          | 任意の事前登録クライアント。既定 `[]`。同じコールバック制限を適用          |
| `UPSTREAM_TIMEOUT_MS`         | 上流HTTPタイムアウト、既定15000ms                                          |
| `MAX_RESPONSE_BYTES`          | 上流レスポンスの上限、既定4MiB                                             |

鍵はそれぞれ異なる32byteを生成し、`k1:<base64url>` 形式で設定します。

```sh
node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64url'))"
```

ローテーション時は `k2:<new>,k1:<old>` の順で指定します。先頭の鍵で発行し、残りで過去のトークンを検証します。refresh用の旧鍵を削除するとその鍵で登録されたクライアントも無効になるため、クライアント再登録が必要です。

```sh
docker run --rm -p 3000:3000 --env-file .env \
  --mount type=volume,source=miniflux-mcp-data,target=/data \
  ghcr.io/rokoucha/miniflux-mcp-server:latest
```

`NODE_ENV=production`、`ISSUER`、`MINIFLUX_URL`、4種の鍵を `.env` に設定してください。コンテナは非rootで動作します。`/data` はUID/GID 1000が書き込める必要があります。

認可コードとrefreshは一度だけ使用でき、その消費記録をSQLiteに保存します。SQLiteは単一replica、ローカル/block storageで運用し、NFS上で共有しないでください。DBを削除・古いバックアップに戻すと未期限切れgrantの再使用防止を失います。その場合は暗号鍵も更新してください。

## ツール

- 読み取り: `list_entries`, `get_entry`, `get_counters`, `list_feeds`, `get_feed`, `list_categories`
- 書き込み: `update_entries`, `create_feed`, `update_feed`, `delete_feed`, `refresh_feed`, `create_category`, `update_category`, `delete_category`

`list_entries` は本文を省き、既定20件・最大100件のページングを返します。全文は `get_entry` で取得します。取得だけで既読にはしません。記事やタイトルは信用できない外部データです。フィード設定に含まれるパスワード・cookie・非公開feed URLは返しません。`update_entries` は状態とスターを指定値に設定します。Miniflux 2.3.2以降が必要です。

## CIとmateria

GitHub Actionsでlint・型検査・テスト・ビルドを実行し、linux/amd64・linux/arm64のイメージを検証します。default branchへのpushまたは手動実行だけがGHCRへ `latest`・JST時刻タグ・SHAタグを公開します。

materiaのGitOps構成は [デプロイ手順](docs/deployment.md) を参照してください。設計は [docs/design.md](docs/design.md)。

```sh
pnpm run lint
pnpm run type-check
pnpm test
pnpm run build
```

## 参照

- [Miniflux API](https://miniflux.app/docs/api.html)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [cosense-cli-mcp](https://github.com/rokoucha/cosense-cli-mcp) のOAuth/CIをベースに実装（MIT）

MIT License © 2026 Rokoucha
