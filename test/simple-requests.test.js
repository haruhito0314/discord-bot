const test = require("node:test");
const assert = require("node:assert/strict");
const { isSimpleRequest, requestSimpleResponse } = require("../simple-requests");
const { createAiAssistant, loadAiConfig } = require("../ai");
const { PermissionsBitField, ChannelType, Collection } = require("discord.js");

test("routes only clear small self-contained tasks to Cerebras", () => {
  for (const question of ["こんにちは！", "ありがとう", "1+1は？", "計算：12 × 3", "英訳：明日会いましょう"]) assert.equal(isSimpleRequest(question), true, question);
  for (const question of ["担当は？", "この会話を要約して", "Wordを埋めて", "先に置いたtxtを読んで", "英訳：上記の文", "短".repeat(161)]) assert.equal(isSimpleRequest(question), false, question);
});

test("Cerebras receives only the current request, without Discord history or OpenAI credentials", async () => {
  const config = loadAiConfig({ GUILD_ID: "100000000000000001", OPENAI_API_KEY: "openai-test", CEREBRAS_API_KEY: "cerebras-test" });
  let historyReads = 0;
  const member = { id: "100000000000000002" };
  const bot = { id: "100000000000000003" };
  const channel = { id: "100000000000000004", guildId: config.guildId, type: ChannelType.GuildText,
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All), isThread: () => false,
    messages: { fetch: async () => { historyReads++; return new Collection(); } } };
  const guild = { id: config.guildId, members: { fetch: async () => member, fetchMe: async () => bot }, channels: { fetch: async () => channel } };
  const calls = [];
  const assistant = createAiAssistant({ config, fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), authorization: options.headers.Authorization });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "こんにちは！" } }] }));
  } });
  assert.equal(await assistant.answer({ guild, userId: member.id, channelId: channel.id, question: "こんにちは" }), "こんにちは！");
  assert.equal(historyReads, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.cerebras.ai/v1/chat/completions");
  assert.equal(calls[0].body.messages.length, 2);
  assert.equal(calls[0].body.messages[1].content, "こんにちは");
  assert.ok(!JSON.stringify(calls[0]).includes("openai-test"));
});

test("provider errors and truncated outputs allow fallback without exposing secrets", async () => {
  const config = { cerebrasApiKey: "never-show-this", cerebrasModel: "qwen-3.8-27b" };
  for (const response of [new Response("never-show-this", { status: 401 }), new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "途中" } }] }))]) {
    assert.equal(await requestSimpleResponse(config, "こんにちは", { fetchImpl: async () => response }), null);
  }
});
