# MVP: CLI中心のResearch Memoryワークフローを実装する

GitHub Issue: https://github.com/akihirookuda95/personal-research-memory-agent/issues/1

## 背景

Personal Research Memory Agent の最初のMVPとして、Web UIではなくCLI中心の最小ワークフローを実装する。

目的は、論文・技術ブログ・メモを投入したときに、Agentが claim / evidence / caveat / counterargument を抽出し、既存仮説への関連付けと更新案を提示できるかを検証すること。

このMVPではプロダクト完成度よりも、以下の設計原則を小さく検証する。

- Agent proposes, human approves
- Source first
- Trace everything
- Build repo-compatible memory

## MVPで作るユーザー体験

1. ユーザーが `research-memory/sources/inbox/` にURL情報またはメモMarkdownを置く
2. CLIコマンドを実行する
3. 既存の仮説Markdownを読み込む
4. LLMが以下を抽出・生成する
   - summary
   - claims
   - evidence
   - caveats
   - counterarguments
   - related hypotheses
   - proposed memory updates
5. 結果を `research-memory/reviews/` にMarkdownとして保存する
6. ユーザーがレビューMarkdown上で、Agentが提案したMemory追加・更新案を approve / reject する
7. 承認された内容だけを `claims/`, `hypotheses/`, `traces/` に反映する

## 作るもの

### ディレクトリ構成

```text
research-memory/
  sources/
    inbox/
    processed/
  claims/
  hypotheses/
  decisions/
  reviews/
  traces/
  prompts/
  exports/
```

### 初期仮説ファイル

```text
research-memory/hypotheses/rag-still-matters.md
research-memory/hypotheses/navigation-vs-retrieval.md
research-memory/hypotheses/agent-boundary.md
research-memory/hypotheses/beyond-chat-ui.md
```

### CLI

最小コマンド例:

```bash
npm run ingest -- research-memory/sources/inbox/example.md
npm run apply-review -- research-memory/reviews/example.review.md
```

## 用語

### summary

資料全体の短い要約。

### claims

資料に含まれる主張。個人の感想ではなく、「この資料は何を言っているか」を主張単位で切り出す。

### evidence

claimを支える根拠。資料中の引用、該当セクション、URL、メモ内の該当箇所など。

### caveats

注意点・制約・そのclaimをそのまま一般化できない理由。

### counterarguments

反論・逆の見方。資料自体に書かれている反論、または既存仮説と照らして生成される反論。

### related hypotheses

既存のどの仮説に関係するか。

### proposed memory updates

Agentが提案するMemory更新案。「この資料を読んだ結果、自分の研究Memoryをこう更新してはどうか」という提案。

## approve / reject の対象

review Markdownで approve / reject する対象は、Agentが提案した「この資料からMemoryに追加・更新してよい内容」。

主に以下を確認する。

- この `claim` をMemoryに保存してよいか
- この `claim` は本当にこの `hypothesis` に関連するか
- この `evidence` は根拠として十分か
- この `caveat` / `counterargument` は残す価値があるか
- この `hypothesis update` を反映してよいか
- この `open question` や `next action` を追加してよいか

## 保存先の意味

### claims

資料から抽出して承認した主張の保存場所。「どの資料が、どんな主張をしていたか」を蓄積する。

### hypotheses

自分が検証中の仮説の保存場所。資料を読むたびに、支持claim、反対claim、未検証点、状態変化を追記する。

### traces

Agentが何をしたかの記録。Memoryに採用されなかった出力も含めて、実行ログとして残す。

## 完成条件

- [ ] inbox内のMarkdown sourceを1件処理できる
- [ ] 既存仮説4件を読み込める
- [ ] claim / evidence / caveat / counterargument を抽出できる
- [ ] 関連する仮説候補を提示できる
- [ ] 仮説更新案をreview Markdownとして保存できる
- [ ] approveされた更新だけMemoryに反映できる
- [ ] rejected updateはMemoryに反映せずtraceに残せる
- [ ] LLM入力、LLM出力、実行時刻、対象source、処理結果をtraceに保存できる
- [ ] OpenAI APIキー未設定時にわかりやすいエラーを出せる
- [ ] READMEまたはdocsにMVPの使い方を記載する

## MVPで作らないもの

- Web UI
- SQLite
- ベクトル検索
- PDF対応
- Slack / Google Drive連携
- 複雑なマルチAgent
- 完全自律の調査Agent
- RAG / Wiki / Agent比較ビュー
- 認証や設定画面

## 技術方針

- CLI中心
- Markdown + JSON保存
- TypeScript / Node.jsを基本候補にする
- LLM処理はOpenAI APIを利用する
- 重要な研究資産はrepo-compatibleなMarkdownとして残す
- Memory更新は必ず人間承認を挟む

## MVP完成後のステップ

1. 1週間、5〜10件の資料で手動運用する
2. approve / reject判断が妥当か確認する
3. Markdownレビューが面倒か確認する
4. approve / reject をボタン操作できる Review updates UI の必要性を確認する
5. traceが後から見返せるか確認する
6. 不便だった箇所だけUI化する
7. データ構造が固まってからSQLite化を検討する
8. claims / hypotheses が蓄積してからRAG比較を追加する

## MVP後に検討する拡張

MVP完成後すぐに実装するのではなく、1週間の手動運用で必要性を確認してから優先順位を決める。

候補:

- PDFテキスト化対応
- Review updates の簡易Web UI
  - review Markdownを直接編集せず、claim / hypothesis update ごとに Approve / Reject ボタンで判定できるようにする
  - 承認済み更新をまとめてMemoryへ反映する Apply approved updates ボタンを用意する
- SQLite / FTS5による構造化保存と検索
- RAG / Wiki / Agent 比較ビュー
- Agent traceの可視化
- 必要性が明確になった場合のみマルチAgent化
