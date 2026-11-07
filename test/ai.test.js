const test = require("node:test");
const assert = require("node:assert/strict");
const { ChannelType, Collection, MessageFlags, PermissionsBitField } = require("discord.js");
const { createAiAssistant, loadAiConfig, requestResponse, buildAskCommand } = require("../ai");

const GUILD = "100000000000000001";
const USER = "100000000000000002";
const BOT = "100000000000000003";
const CURRENT = "100000000000000004";
const OTHER = "100000000000000005";
const SECRET = "100000000000000006";
const ALL = new PermissionsBitField(PermissionsBitField.All);
const NONE = new PermissionsBitField();
const config = (extra = {}) => ({ ...loadAiConfig({ OPENAI_API_KEY: "test-key", GUILD_ID: GUILD }), ...extra });
const final = (text = "回答") => ({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] });
const call = (name, args, id = "call_1") => ({ type: "function_call", name, arguments: JSON.stringify(args), call_id: id });

function fixture({ responses = [final()], settings = {} } = {}) {
  const payloads = [];
  const fetchedIds = [];
  const members = { [USER]: { id: USER }, [BOT]: { id: BOT } };
  const channels = new Collection();
  const guild = { id: GUILD,
    client: { rest: { get: async (route) => {
      const [, , channelId, , userId] = route.split("/");
      if (!channels.get(channelId)?.joined) throw Error("not a thread member");
      return { user_id: userId };
    } } },
    members: { me: members[BOT], fetch: async ({ user }) => members[user], fetchMe: async () => members[BOT] },
    channels: { cache: channels, fetch: async (id) => {
      if (!id) return channels;
      fetchedIds.push(id);
      return channels.get(id) || null;
    } },
  };
  function channel(id, { visible = true, type = ChannelType.GuildText, messages = [], joined = true } = {}) {
    const value = { id, guildId: GUILD, name: id === SECRET ? "secret-name" : `channel-${id}`,
      type, joined, parentId: null, isThread: () => [ChannelType.PublicThread, ChannelType.PrivateThread].includes(type),
      permissionsFor: (member) => member.id === USER && !visible ? NONE : ALL,
      members: { fetch: async () => { if (!joined) throw Error("not a thread member"); return {}; } },
      messages: { fetch: async ({ limit, before }) => {
        value.readCount++;
        const page = messages.filter((m) => !before || BigInt(m.id) < BigInt(before))
          .sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, limit);
        return new Collection(page.map((m) => [m.id, m]));
      } }, readCount: 0,
    };
    channels.set(id, value);
    return value;
  }
  const current = channel(CURRENT);
  channel(OTHER);
  channel(SECRET, { visible: false });
  let index = 0;
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    payloads.push(body);
    const response = responses[index++];
    if (!response) throw Error("unexpected API call");
    return { ok: true, json: async () => typeof response === "function" ? response(body) : response };
  };
  const assistant = createAiAssistant({ config: config(settings), fetchImpl });
  const ask = (extra = {}) => assistant.answer({ guild, userId: USER, channelId: CURRENT, question: "決定事項は？", ...extra });
  return { guild, current, channel, channels, ask, assistant, payloads, fetchedIds, fetchImpl };
}

function message(id, content) {
  return { id, content, author: { username: "alice" }, createdTimestamp: 1794000000000, attachments: new Collection() };
}

function incomingMessage(f, content, { reactionFails = false } = {}) {
  const replies = [];
  const reactions = [];
  f.current.sendTyping = async () => {};
  const msg = { guild: f.guild, client: { user: { id: BOT } }, author: { id: USER, bot: false },
    channel: f.current, id: "300000000000000001", content,
    reply: async (value) => replies.push(value),
    react: async (emoji) => {
      if (reactionFails) throw Error("Missing AddReactions permission");
      reactions.push({ action: "add", emoji });
      return { users: { remove: async (id) => reactions.push({ action: "remove", userId: id }) } };
    },
  };
  return { msg, replies, reactions };
}

test("Terra is the default and /ask has a required question", () => {
  assert.equal(loadAiConfig({}).model, "gpt-6.1-terra");
  const command = buildAskCommand().toJSON();
  assert.equal(command.name, "ask");
  assert.equal(command.options[0].required, true);
});

test("public conversation cannot escape its channel through a model tool call", async () => {
  const f = fixture({ responses: [
    { output: [call("read_channel_history", { channel_id: SECRET, before: null })] },
    final("このチャンネルのみ確認しました"),
  ] });
  await f.ask();
  assert.ok(!f.fetchedIds.includes(SECRET));
  const output = f.payloads[1].input.find((item) => item.type === "function_call_output");
  assert.match(output.output, /指定チャンネルだけ/);
  assert.equal(f.channels.get(SECRET).readCount, 0);
});

test("server browsing hides channels that only the bot can read", async () => {
  const f = fixture({ responses: [
    { output: [call("list_channels", { after: null })] },
    { output: [call("read_channel_history", { channel_id: SECRET, before: null }, "call_2")] },
    final(),
  ] });
  await f.ask({ serverScope: true });
  assert.ok(!JSON.stringify(f.payloads).includes("secret-name"));
  assert.equal(f.channels.get(SECRET).readCount, 0);
  const denied = f.payloads[2].input.filter((item) => item.type === "function_call_output").at(-1);
  assert.match(denied.output, /許可されていません/);
});

test("read and history permissions are required for both user and bot", async () => {
  for (const deniedMember of [USER, BOT]) {
    const f = fixture();
    f.current.permissionsFor = (member) => member.id === deniedMember
      ? new PermissionsBitField(PermissionsBitField.Flags.ViewChannel) : ALL;
    await assert.rejects(f.ask(), /許可されていません/);
    assert.equal(f.current.readCount, 0);
    assert.equal(f.payloads.length, 0);
  }
});

test("private thread parent permissions do not bypass membership", async () => {
  const f = fixture();
  const thread = f.channel(OTHER, { type: ChannelType.PrivateThread, joined: false });
  thread.permissionsFor = () => new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory,
  ]);
  await assert.rejects(f.ask({ channelId: OTHER }), /許可されていません/);
  assert.equal(thread.readCount, 0);
});

test("private threads work for confirmed members without relying on the thread cache", async () => {
  const f = fixture();
  const thread = f.channel(OTHER, { type: ChannelType.PrivateThread, joined: true });
  thread.permissionsFor = () => new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory,
  ]);
  thread.members.fetch = async () => { throw Error("manager cache is unavailable"); };
  assert.equal(await f.ask({ channelId: OTHER }), "回答");
  assert.equal(thread.readCount, 1);
});

test("allowlist applies to guessed channel IDs even during server browsing", async () => {
  const f = fixture({ settings: { allowedChannels: new Set([CURRENT]) }, responses: [
    { output: [call("read_channel_history", { channel_id: OTHER, before: null })] }, final(),
  ] });
  await f.ask({ serverScope: true });
  assert.equal(f.channels.get(OTHER).readCount, 0);
});

test("a channel from a different guild is rejected", async () => {
  const f = fixture();
  f.current.guildId = "200000000000000001";
  await assert.rejects(f.ask(), /許可されていません/);
  assert.equal(f.payloads.length, 0);
});

test("history paginates past 100 messages and excludes the triggering message", async () => {
  const f = fixture({ settings: { historyLimit: 150 } });
  const messages = Array.from({ length: 151 }, (_, i) => message(String(300000000000000000n + BigInt(i)), `発言${i}`));
  const current = f.channel(CURRENT, { messages });
  await f.ask({ excludeMessageId: messages.at(-1).id });
  const initial = JSON.parse(f.payloads[0].input[0].content.split("\n").slice(1).join("\n"));
  assert.equal(current.readCount, 2);
  assert.equal(initial.scanned, 150);
  assert.equal(initial.messages.length, 149);
  assert.equal(initial.messages[0].content, "発言1");
  assert.ok(initial.messages.every((m) => m.id !== messages.at(-1).id && m.url.startsWith(`https://discord.com/channels/${GUILD}/${CURRENT}/`)));
});

test("search performs a bounded literal match and preserves reasoning items", async () => {
  const reasoning = { type: "reasoning", encrypted_content: "opaque", summary: [] };
  const f = fixture({ responses: [
    { output: [reasoning, call("search_messages", { channel_ids: [OTHER], query: "a.b" })] }, final(),
  ] });
  f.channel(OTHER, { messages: [message("300000000000000001", "a.b was approved"), message("300000000000000002", "axb was rejected")] });
  await f.ask({ serverScope: true });
  assert.ok(f.payloads[1].input.some((item) => item.encrypted_content === "opaque"));
  const result = JSON.parse(f.payloads[1].input.find((item) => item.type === "function_call_output").output);
  assert.deepEqual(result.results[0].messages.map((m) => m.content), ["a.b was approved"]);
  assert.match(result.results[0].note, /全履歴の検索ではありません/);
  assert.equal(f.payloads[0].store, false);
});

test("tool loops stop after the configured fixed budget", async () => {
  const f = fixture({ responses: [
    ...Array.from({ length: 6 }, (_, i) => ({ output: [call("list_channels", { after: null }, `call_${i}`)] })), final("取得範囲での回答"),
  ] });
  assert.equal(await f.ask(), "取得範囲での回答");
  assert.equal(f.payloads.length, 7);
  assert.equal(f.payloads.at(-1).tool_choice, "none");
});

test("access revoked while the model works prevents delivery", async () => {
  const f = fixture({ responses: [() => {
    f.current.permissionsFor = (member) => member.id === USER ? NONE : ALL;
    return final("must not be delivered");
  }] });
  await assert.rejects(f.ask(), /許可されていません/);
});

test("cooldown and in-flight requests prevent duplicate paid calls", async () => {
  let unblock;
  const f = fixture({ responses: [() => new Promise((resolve) => { unblock = resolve; })] });
  const pending = f.ask();
  while (!unblock) await new Promise(setImmediate);
  await assert.rejects(f.ask(), /処理中/);
  unblock(final());
  await pending;
  await assert.rejects(f.ask(), /少し待って/);
  assert.equal(f.payloads.length, 1);
});

test("failed requests release concurrency slots", async () => {
  const f = fixture({ settings: { cooldownMs: 0, maxConcurrent: 1 }, responses: [
    { status: "failed", output: [] }, final("再試行できた"),
  ] });
  await assert.rejects(f.ask(), /正常な回答/);
  assert.equal(await f.ask(), "再試行できた");
});

test("slash answers and all continuation chunks stay ephemeral with mentions disabled", async () => {
  const f = fixture({ responses: [final("@everyone\n" + "あ".repeat(4200))] });
  const replies = [];
  let deferred;
  const interaction = { guild: f.guild, channel: f.current, user: { id: USER },
    options: { getChannel: () => null, getString: () => "要約して" },
    deferReply: async (value) => { deferred = value; }, editReply: async (value) => replies.push(value),
    followUp: async (value) => replies.push(value),
  };
  await f.assistant.handleInteraction(interaction);
  assert.equal(deferred.flags, MessageFlags.Ephemeral);
  assert.ok(replies.length > 1);
  assert.ok(replies.every((r) => r.content.length <= 2000 && r.allowedMentions.parse.length === 0));
  assert.ok(replies.slice(1).every((r) => r.flags === MessageFlags.Ephemeral));
});

test("mention reads only its own channel and ignores bots and ordinary messages", async () => {
  const f = fixture();
  const { msg, replies } = incomingMessage(f, "普通の会話");
  await f.assistant.handleMessage(msg);
  await f.assistant.handleMessage({ ...msg, content: `<@${BOT}> botの投稿`, author: { bot: true } });
  assert.equal(f.payloads.length, 0);
  await f.assistant.handleMessage({ ...msg, content: `<@${BOT}> 決定事項は？` });
  assert.equal(f.payloads.length, 1);
  assert.equal(replies[0].content, "回答");
  assert.deepEqual(replies[0].allowedMentions, { parse: [], repliedUser: false });
});

test("typed hyphenated and legacy names work without a Discord mention token", async () => {
  for (const content of ["@tti-intelligence 決定事項は？", "@tti intelligence 決定事項は？", " @TTI-INTELLIGENCE：決定事項は？"]) {
    const f = fixture();
    const { msg, replies } = incomingMessage(f, content);
    await f.assistant.handleMessage(msg);
    assert.equal(replies[0].content, "回答");
    assert.equal(f.payloads[0].input[1].content, "決定事項は？");
    assert.ok(f.fetchedIds.every((id) => id === CURRENT));
  }
});

test("ordinary text, emails, and similarly named addresses do not trigger AI", async () => {
  const f = fixture();
  for (const content of ["今日は @tti-intelligence について話そう", "support@tti-intelligence.com", "@tti-intelligence-other 質問", "@tti-intelligence2 質問"]) {
    const { msg, reactions, replies } = incomingMessage(f, content);
    await f.assistant.handleMessage(msg);
    assert.equal(replies.length, 0);
    assert.equal(reactions.length, 0);
  }
  assert.equal(f.payloads.length, 0);
});

test("thinking reaction stays on the source while processing and removes only the bot afterward", async () => {
  let unblock;
  const f = fixture({ responses: [() => new Promise((resolve) => { unblock = resolve; })] });
  const { msg, reactions, replies } = incomingMessage(f, "@tti-intelligence 要約して");
  const pending = f.assistant.handleMessage(msg);
  while (!unblock) await new Promise(setImmediate);
  assert.deepEqual(reactions, [{ action: "add", emoji: "🤔" }]);
  assert.equal(replies.length, 0);
  unblock(final());
  await pending;
  assert.equal(replies[0].content, "回答");
  assert.deepEqual(reactions, [{ action: "add", emoji: "🤔" }, { action: "remove", userId: BOT }]);
});

test("thinking reaction is removed even when generation fails", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = fixture({ responses: [{ status: "failed", output: [] }] });
  const { msg, reactions, replies } = incomingMessage(f, `<@${BOT}> 要約して`);
  await f.assistant.handleMessage(msg);
  assert.match(replies[0].content, /正常な回答/);
  assert.equal(reactions.at(-1).action, "remove");
  assert.equal(reactions.at(-1).userId, BOT);
});

test("missing reaction permission does not block the answer", async () => {
  const f = fixture();
  const { msg, replies } = incomingMessage(f, "@tti-intelligence 要約して", { reactionFails: true });
  await f.assistant.handleMessage(msg);
  assert.equal(replies[0].content, "回答");
});

test("missing credentials fail without making any request", async () => {
  const f = fixture({ settings: { apiKey: "" } });
  await assert.rejects(f.ask(), /OPENAI_API_KEY/);
  assert.equal(f.payloads.length, 0);
});

test("HTTP and network errors never expose API response bodies or credentials", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    let readBody = false;
    await assert.rejects(requestResponse(config(), [], { fetchImpl: async () => ({ ok: false, status,
      json: async () => { readBody = true; return { error: "test-key" }; },
    }) }), (error) => !error.message.includes("test-key"));
    assert.equal(readBody, false);
  }
  await assert.rejects(requestResponse(config(), [], { fetchImpl: async () => { throw Error("test-key"); } }), /接続できません/);
});
