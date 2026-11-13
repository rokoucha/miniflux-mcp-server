# materiaへのデプロイ

公開先: `https://miniflux-mcp.ggrel.net/mcp`。Minifluxにはクラスタ内の `http://service.miniflux.svc:8080` で接続します。

1. GitHub Actionsが成功してGHCRにイメージを公開したことを確認する。
2. materiaのDeploymentのイメージを成功した時刻タグに固定する。以後はRenovateが新しいタグを提案し、マージ後にArgo CDが反映する。
3. 1Passwordの `materia-applications` vaultに `miniflux-mcp-server-secrets` を作成し、4つのJWE環境変数をそれぞれ独立した鍵で登録する。MinifluxのAPIキーは保存しない。
4. materiaのシステム構成（namespace/AppProject、1Passwordのwatch/RBAC/Admission許可、HAProxyのegress）を先に同期する。
5. アプリ構成とMiniflux側のingress許可を同期する。SQLiteは1GiBのiSCSI PVCで保存し、単一replica/Recreateで動作する。GHCR認証とTLS証明書は既存Secretからreflectする。
6. Pod Ready、`/health`、OAuth discoveryと未認証 `/mcp` の401を確認する。
7. MCPクライアントにURLを登録し、Minifluxの専用APIキーを認可画面に入力する。まず読み取りスコープで記事一覧を確認する。

新規リポジトリとGHCRパッケージは非公開のまま使用します。既存の `ghcr-credentials` がこのパッケージを読み取れる必要があります。実際のイメージをpullするまで、その権限は未検証です。

本番の既存記事・購読を変更する試験は行いません。障害時はArgoの自動同期を止めるか、materiaの追加コミットをrevertしてください。PVCはPrune/Deleteから保護しています。OAuthのSQLiteを消す場合は暗号鍵も変更して、既存grantを無効化してください。
