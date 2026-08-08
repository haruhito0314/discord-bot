# discord-bot

このボットは、Discord サーバーのチャンネル管理パネルと、メッセージ履歴を含むサーバーのバックアップ/復元機能を提供します。

## できること
- `/postpanel` でチャンネル操作パネルを投稿
- `/categorylock add/remove/list` でカテゴリロックを管理
- `/resetchannelquota [user]` でチャンネル作成回数をリセット
- `/backup` でサーバー情報とテキストチャンネルのメッセージ履歴を JSON 形式でバックアップ
- `/restorebackup` でバックアップJSONを読み込んで、チャンネルとメッセージ履歴を別サーバーに復元
- `/postvoicestats` で「誰がどれだけ通話に入っていたか」を社畜時間として記録するパネルを投稿し、更新ボタンで最新状態へ更新できます

## 使い方
1. `.env` に `DISCORD_TOKEN` と `GUILD_ID` を設定します。
2. 必要に応じて `BACKUP_CHANNEL_ID` を設定すると、バックアップファイルをそのチャンネルにも送信できます。
3. 必要に応じて `BACKUP_MAX_MESSAGES_PER_CHANNEL` を設定すると、1チャンネルあたりのバックアップメッセージ数を調整できます（既定値: 2000）。
4. `npm install`
5. `npm start`

## バックアップファイル
`/backups` ディレクトリに JSON ファイルとして保存されます。

## 復元について
`/restorebackup` はバックアップJSONファイルを添付して実行します。テキストチャンネルを再作成し、メッセージ履歴を時系列で再送信します。
