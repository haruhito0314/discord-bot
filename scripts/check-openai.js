require("dotenv").config({ quiet: true });
const { loadAiConfig, requestResponse, AiError } = require("../ai");

async function main() {
  const config = loadAiConfig();
  if (!config.apiKey) throw new AiError("OPENAI_API_KEYが未設定です。");
  const testTools = process.argv.includes("--tools");
  const input = [
    { role: "user", content: "Reply with OK only." },
  ];
  const tools = testTools ? [{ type: "function", name: "confirm_connection", description: "Confirm this connection test.",
    strict: true, parameters: { type: "object", properties: {}, required: [], additionalProperties: false } }] : [];
  const options = { signal: AbortSignal.timeout(30000), tools,
    toolChoice: testTools ? { type: "function", name: "confirm_connection" } : "none" };
  let response = await requestResponse({ ...config, maxOutputTokens: 512 }, input, options);
  if (testTools) {
    const calls = response.output.filter((item) => item.type === "function_call");
    if (calls.length !== 1 || calls[0].name !== "confirm_connection") throw new AiError("ツール呼び出しを確認できませんでした。");
    input.push(...response.output, { type: "function_call_output", call_id: calls[0].call_id, output: "OK" });
    response = await requestResponse({ ...config, maxOutputTokens: 512 }, input, { ...options, toolChoice: "none" });
  }
  const text = response.output.filter((item) => item.type === "message")
    .flatMap((item) => item.content || []).some((item) => item.type === "output_text" && item.text?.trim());
  if (!text) throw new AiError("モデルからテキストを取得できませんでした。");
  console.log(JSON.stringify({ ok: true, model: response.model, status: response.status,
    tool_continuation: testTools,
    input_tokens: response.usage?.input_tokens, output_tokens: response.usage?.output_tokens }));
}

main().catch((error) => {
  console.error(error instanceof AiError ? error.message : "OpenAI接続確認に失敗しました。");
  process.exitCode = 1;
});
