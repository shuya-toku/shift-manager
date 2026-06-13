# 過去シフト履歴（デフォルト取込データ）

SCOPE の分析に使う過去の「SQA Working Shift」CSV を置く場所。初回ロード（localStorageが空）時にここのCSVを自動取込してデフォルトデータにする。

## 使い方（CSVを追加するとき）
1. 月ごとのCSVをこのフォルダに置く（例: `SQA-2026-02.csv`）
2. `manifest.json` の `files` に追記
3. 文字コード修復＋整合性スキャン: `node data/history/_scan.mjs data/history/*.csv`
   - mojibake（UTF-8をLatin-1誤読）を検出したらバイト復元して上書き
   - 月/社員数/取込見込みシフトセル数/異常（$表記・全角化け・未知ステータス・列ズレ）を報告

## 文字コードについて
元ファイルが UTF-8 をLatin-1誤読した状態（mojibake）でも、`_scan.mjs` が `latin1→utf8` で復元する。
復元は**元ファイルの正確なバイト列**が前提なので、チャットへの貼り付けではなく**ファイルそのもの**を置くこと。
