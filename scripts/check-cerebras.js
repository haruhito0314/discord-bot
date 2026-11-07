require("dotenv").config({ quiet: true });
const { loadAiConfig } = require("../ai");
const { requestSimpleResponse } = require("../simple-requests");

async function main() {
  const config = loadAiConfig();
  if (!config.cerebrasApiKey) throw new Error("CEREBRAS_API_KEYが未設定です。");
  const response = await fetch("https://api.cerebras.ai/v1/models", {
    headers: { Authorization: `Bearer ${config.cerebrasApiKey}` }, signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Cerebrasの認証・モデル確認に失敗しました（HTTP ${response.status}）。`);
  const models = await response.json();
  if (!models.data?.some((model) => model.id === config.cerebrasModel)) throw new Error("設定したCerebrasモデルがこのキーでは利用できません。");
  const text = await requestSimpleResponse(config, "こんにちは", { signal: AbortSignal.timeout(15000) });
  if (!text) throw new Error("Cerebrasから回答を取得できませんでした。");
  console.log(JSON.stringify({ ok: true, provider: "cerebras", model: config.cerebrasModel }));
}

main().catch((error) => {
  console.error(error.message?.startsWith("Cerebras") || error.message?.startsWith("設定した") || error.message?.startsWith("CEREBRAS_") ? error.message : "Cerebrasの接続確認に失敗しました。");
  process.exitCode = 1;
});
