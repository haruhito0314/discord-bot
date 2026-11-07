// Only route self-contained, unmistakably small requests to the fast provider.
// Short questions about Discord history still need the main model and its tools.
function isSimpleRequest(question) {
  const text = question.trim();
  if (!text || text.length > 160) return false;
  if (/^(?:こんにちは|こんばんは|おはよう(?:ございます)?|ありがとう(?:ございます)?|やあ|hello|hi|thanks)[\s!！。〜～]*$/i.test(text)) return true;
  if (/^(?:計算[：:\s]*)?[\d\s+\-*/×÷().=]+(?:は[？?]?|を計算して[。！!]?|[？?])?$/.test(text)
    && /\d/.test(text) && /[+\-*/×÷]/.test(text)) return true;
  return /^(?:英訳|和訳|翻訳|敬語にして|誤字を直して)[：:]\s*\S[\s\S]*$/.test(text)
    && !/この会話|このチャンネル|履歴|添付|ファイル|前の|さっき|上の|上記|それ|これ/.test(text);
}

async function requestSimpleResponse(config, question, { fetchImpl = fetch, signal } = {}) {
  try {
    const response = await fetchImpl("https://api.cerebras.ai/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${config.cerebrasApiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)].filter(Boolean)),
      body: JSON.stringify({ model: config.cerebrasModel,
        messages: [
          { role: "system", content: "あなたはDiscord Bot tti-intelligenceです。現在の短い依頼だけに自然な日本語で簡潔に答えます。この応答では会話履歴・添付ファイルを読んでいません。読んだふりはしません。" },
          { role: "user", content: question },
        ], max_completion_tokens: 512,
        ...(config.cerebrasModel === "qwen-3.8-27b" ? { reasoning_effort: "none" } : {}),
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const choice = data.choices?.[0];
    if (choice?.finish_reason !== "stop" || choice.message?.tool_calls?.length) return null;
    const text = choice.message?.content;
    return typeof text === "string" && text.trim() && text.length <= 6000 ? text.trim() : null;
  } catch { return null; } // Provider failures fall back to the main model without exposing credentials.
}

module.exports = { isSimpleRequest, requestSimpleResponse };
