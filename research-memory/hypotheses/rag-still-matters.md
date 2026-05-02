# RAGは社内ナレッジ検索でまだ必要である

## Status

active

## Hypothesis

RAGは社内ナレッジ検索でまだ必要である。

## Supporting Claims

未登録。

## Opposing Claims

未登録。

## Open Questions

- どの種類の問いでは、構造化Memoryよりも局所的な検索が有効か？
- BM25、embedding、hybrid search、rerankのどこまでをMVP後に検証すべきか？

## Change Log

未登録。

## Approved Update

- approved_at: 2026-05-02T14:25:49.508Z
- review_block: update-rag-still-matters-contextual-retrieval
- action: add_supporting_claim
- rationale: 現仮説（RAGは必要）を、文脈喪失への具体的改善策（Contextual Retrieval）と定量的改善により補強できる。

Contextual Retrieval（Contextual Embeddings + Contextual BM25 + 必要に応じたreranking）は、従来RAGのチャンク文脈喪失問題を補い、top-20の検索失敗率を報告値として改善できる（例：49%〜67%削減）。

## Approved Update

- approved_at: 2026-05-02T14:25:49.509Z
- review_block: update-rag-still-matters-open-question-chunk-context-missing
- action: add_open_question
- rationale: 既存のOpen Questions（BM25/embedding/hybrid/rerankの検証範囲）に対し、“文脈喪失をどう扱うか”を追加の検討観点として提案する。

社内ナレッジ検索で“文脈喪失（チャンク単体では対象が特定できない）”が支配的な場合、ハイブリッド検索やチャンク設計だけでなく、Contextual Retrievalのような文脈付与前処理を入れるべきか？

## Approved Update

- approved_at: 2026-05-02T14:25:49.509Z
- review_block: update-rag-still-matters-evals-contextual-retrieval
- action: add_next_action
- rationale: ソースは評価指標（1 - recall@20）やtop-K条件を提示しているため、研究メモ側の次アクションとして“同指標で比較”を提案できる。

社内データで、Contextual Embeddings/BM25（必要ならreranking含む）と従来RAG（通常のembedding+BM25）を、1-recall@20（top-20投入）で比較する評価設計を作る。
