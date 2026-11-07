const test = require("node:test");
const assert = require("node:assert/strict");
const { ChannelType, Collection, MessageFlags, PermissionsBitField } = require("discord.js");
const { zipSync, unzipSync, strToU8, strFromU8 } = require("fflate");
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

function fixture({ responses = [final()], settings = {}, downloads = new Map(), inputTokens = 100000 } = {}) {
  const payloads = [];
  const countPayloads = [];
  const fetchedIds = [];
  const members = { [USER]: { id: USER }, [BOT]: { id: BOT } };
  const channels = new Collection();
  const guild = { id: GUILD, roles: { everyone: { id: GUILD } },
    client: { rest: { get: async (route) => {
      const [, , channelId, , userId] = route.split("/");
      if (!channels.get(channelId)?.joined) throw Error("not a thread member");
      return { user_id: userId };
    } } },
    members: { me: members[BOT], fetch: async ({ user }) => members[user], fetchMe: async () => members[BOT] },
    channels: { cache: channels, fetchActiveThreads: async () => ({ threads: new Collection() }), fetch: async (id) => {
      if (!id) return channels;
      fetchedIds.push(id);
      return channels.get(id) || null;
    } },
  };
  function channel(id, { visible = true, type = ChannelType.GuildText, messages = [], joined = true } = {}) {
    const value = { id, guildId: GUILD, name: id === SECRET ? "secret-name" : `channel-${id}`,
      type, joined, parentId: null, isThread: () => [ChannelType.PublicThread, ChannelType.PrivateThread].includes(type),
      permissionsFor: (member) => member.id === USER && !visible ? NONE : ALL,
      permissionOverwrites: { cache: new Collection() },
      members: { fetch: async () => { if (!joined) throw Error("not a thread member"); return {}; } },
      messages: { fetch: async ({ limit, before, message: messageId }) => {
        value.readCount++;
        if (messageId) {
          const found = messages.find((m) => m.id === messageId);
          if (!found) throw Error("Unknown message");
          return found;
        }
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
  const fetchImpl = async (url, options) => {
    if (url.startsWith("https://cdn.discordapp.com/")) {
      const content = downloads.get(new URL(url).pathname);
      return content ? new Response(content) : new Response(null, { status: 404 });
    }
    const body = JSON.parse(options.body);
    if (url.endsWith("/input_tokens")) {
      countPayloads.push(body);
      return { ok: true, json: async () => ({ input_tokens: inputTokens }) };
    }
    payloads.push(body);
    const response = responses[index++];
    if (!response) throw Error("unexpected API call");
    return { ok: true, json: async () => typeof response === "function" ? response(body) : response };
  };
  const assistant = createAiAssistant({ config: config(settings), fetchImpl });
  const ask = (extra = {}) => assistant.answer({ guild, userId: USER, channelId: CURRENT, question: "決定事項は？", ...extra });
  return { guild, current, channel, channels, ask, assistant, payloads, countPayloads, fetchedIds, fetchImpl };
}

function message(id, content, attachments = []) {
  return { id, content, author: { username: "alice" }, createdTimestamp: 1794000000000, attachments: new Collection(attachments.map((a) => [a.id, a])) };
}

function incomingMessage(f, content, { reactionFails = false, attachments = [], reference } = {}) {
  const replies = [];
  const reactions = [];
  f.current.sendTyping = async () => {};
  const msg = { guild: f.guild, client: { user: { id: BOT } }, author: { id: USER, bot: false },
    channel: f.current, id: "300000000000000001", content,
    attachments: new Collection(attachments.map((a) => [a.id, a])), reference,
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

function wordFixture() {
  const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "word/document.xml": strToU8(`<w:document xmlns:w="${ns}"><w:body><w:p><w:r><w:t>概要：{{概要}}</w:t></w:r></w:p></w:body></w:document>`),
  }));
}
function attachedFile(id, name, bytes, channelId = CURRENT) {
  return { id, name, size: bytes.length, url: `https://cdn.discordapp.com/attachments/${channelId}/${id}/${encodeURIComponent(name)}` };
}

test("a Word request replying to an earlier txt post returns a filled Word attachment", async () => {
  const word = wordFixture();
  const txt = Buffer.from("山田が担当し、11月10日に公開することを決定した。");
  const wordAttachment = attachedFile("400000000000000001", "テンプレート.docx", word);
  const txtAttachment = attachedFile("400000000000000002", "議事録.txt", txt);
  const txtMessage = message("300000000000000000", "事前に置いた参考資料", [txtAttachment]);
  const downloads = new Map([[new URL(wordAttachment.url).pathname, word], [new URL(txtAttachment.url).pathname, txt]]);
  const f = fixture({ downloads, responses: [final("山田が11月10日に公開します。"), final(JSON.stringify({ fields: { field_1: "山田が担当。11月10日に公開。" }, summary: "会話とtxtの内容を反映しました。" }))] });
  f.current = f.channel(CURRENT, { messages: [txtMessage] });
  const { msg, replies, reactions } = incomingMessage(f, "@tti-intelligence この枠をチャットの内容で埋めて", {
    attachments: [wordAttachment], reference: { messageId: txtMessage.id, channelId: CURRENT },
  });
  await f.assistant.handleMessage(msg);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /入力欄を埋めました/);
  assert.equal(replies[0].files[0].name, "テンプレート_記入済み.docx");
  assert.match(strFromU8(unzipSync(replies[0].files[0].attachment)["word/document.xml"]), /山田が担当。11月10日に公開。/);
  assert.ok(JSON.stringify(f.payloads[0].input).includes("山田が担当し"));
  assert.equal(f.payloads[1].text.format.type, "json_schema");
  assert.equal(reactions.at(-1).action, "remove");
});

test("short follow-up requests still return the Word attached to the referenced request", async () => {
  for (const question of ["これできますか", "これやって", "お願いします", "Wordで返して", "ワードファイルを送って", "空欄に書いてください"]) {
    const word = wordFixture();
    const attachment = attachedFile("400000000000000001", "template.docx", word);
    const prior = message("300000000000000000", "この枠をチャットで埋めて", [attachment]);
    const f = fixture({ downloads: new Map([[new URL(attachment.url).pathname, word]]), responses: [final("調査済み"), final(JSON.stringify({ fields: { field_1: "完成した文章" }, summary: "" }))] });
    f.current = f.channel(CURRENT, { messages: [prior] });
    const { msg, replies } = incomingMessage(f, `@tti-intelligence ${question}`, { reference: { messageId: prior.id, channelId: CURRENT } });
    await f.assistant.handleMessage(msg);
    assert.ok(replies[0].files?.length, question);
    assert.match(strFromU8(unzipSync(replies[0].files[0].attachment)["word/document.xml"]), /完成した文章/);
  }
});

test("a Word found with the attachment tool is filled and returned as a file", async () => {
  const word = wordFixture();
  const attachment = attachedFile("400000000000000001", "template.docx", word);
  const prior = message("300000000000000000", "入力用の資料です", [attachment]);
  const f = fixture({ downloads: new Map([[new URL(attachment.url).pathname, word]]), responses: [
    { output: [call("read_message_attachments", { channel_id: CURRENT, message_id: prior.id })] },
    final("調査済み"), final(JSON.stringify({ fields: { field_1: "既存文章は保って記入" }, summary: "" })),
  ] });
  f.current = f.channel(CURRENT, { messages: [prior] });
  const { msg, replies } = incomingMessage(f, "@tti-intelligence 先ほどのWordの空欄を埋めて返して");
  await f.assistant.handleMessage(msg);
  assert.ok(replies[0].files?.length);
  const output = JSON.parse(f.payloads[1].input.find(i => i.type === "function_call_output").output);
  assert.equal(output.word_output_selected, true);
});

test("Word returned through /ask remains an ephemeral file response", async () => {
  const word = wordFixture();
  const attachment = attachedFile("400000000000000001", "template.docx", word);
  const prior = message("300000000000000000", "入力用", [attachment]);
  const f = fixture({ downloads: new Map([[new URL(attachment.url).pathname, word]]), responses: [
    { output: [call("read_message_attachments", { channel_id: CURRENT, message_id: prior.id })] }, final("調査済み"),
    final(JSON.stringify({ fields: { field_1: "非公開回答" }, summary: "" })),
  ] });
  f.current = f.channel(CURRENT, { messages: [prior] });
  let deferred, delivered;
  await f.assistant.handleInteraction({ guild: f.guild, user: { id: USER }, channel: f.current,
    options: { getChannel: () => null, getString: () => "先ほどのWordで返して" },
    deferReply: async value => { deferred = value; }, editReply: async value => { delivered = value; },
  });
  assert.equal(deferred.flags, MessageFlags.Ephemeral);
  assert.ok(delivered.files?.length);
  assert.equal(delivered.allowedMentions.repliedUser, false);
});

test("reading a Word does not fill it unless an output task was requested", async () => {
  const word = wordFixture();
  const attachment = attachedFile("400000000000000001", "template.docx", word);
  const f = fixture({ downloads: new Map([[new URL(attachment.url).pathname, word]]) });
  const { msg, replies } = incomingMessage(f, "@tti-intelligence このWordには何が書いてある？", { attachments: [attachment] });
  await f.assistant.handleMessage(msg);
  assert.equal(replies[0].files, undefined);
  assert.equal(f.payloads.length, 1);
});

test("Word discovered in history cannot bypass missing destination attachment permission", async (t) => {
  t.mock.method(console, "error", () => {});
  const word = wordFixture();
  const attachment = attachedFile("400000000000000001", "template.docx", word);
  const prior = message("300000000000000000", "入力用", [attachment]);
  const f = fixture({ downloads: new Map([[new URL(attachment.url).pathname, word]]), responses: [
    { output: [call("read_message_attachments", { channel_id: CURRENT, message_id: prior.id })] }, final("ファイルを添付する権限が必要です"),
  ] });
  f.current = f.channel(CURRENT, { messages: [prior] });
  f.current.permissionsFor = () => new PermissionsBitField(PermissionsBitField.All & ~PermissionsBitField.Flags.AttachFiles & ~PermissionsBitField.Flags.Administrator);
  const { msg, replies } = incomingMessage(f, "@tti-intelligence Wordで返して");
  await f.assistant.handleMessage(msg);
  assert.equal(replies[0].files, undefined);
  assert.match(f.payloads[1].input.find(i => i.type === "function_call_output").output, /ファイルを添付/);
});

test("the model can read a txt file found in recent history without a reply", async () => {
  const txt = Buffer.from("リリース日は11月10日です。");
  const attachment = attachedFile("400000000000000002", "先週の議事録.txt", txt);
  const prior = message("300000000000000000", "ここに資料を置きます", [attachment]);
  const f = fixture({ downloads: new Map([[new URL(attachment.url).pathname, txt]]), responses: [
    { output: [call("read_message_attachments", { channel_id: CURRENT, message_id: prior.id })] }, final("11月10日です。"),
  ] });
  f.current = f.channel(CURRENT, { messages: [prior] });
  assert.equal(await f.ask({ question: "先に置いたtxtを読んでリリース日を教えて" }), "11月10日です。");
  const toolResult = f.payloads[1].input.find((item) => item.type === "function_call_output");
  assert.ok(JSON.parse(toolResult.output).files[0].full_text_supplied);
  assert.ok(f.payloads[1].input.some(i => typeof i.content === "string" && i.content.includes("リリース日は11月10日")));
});

test("large txt is sent whole in one generation request including the final bytes", async () => {
  const text = "START-MARKER\n" + "ordinary row\n".repeat(30000) + "TAIL-MARKER-742";
  const txt = Buffer.from(text);
  assert.ok(txt.length > 256 * 1024);
  const attachment = attachedFile("400000000000000002", "large.txt", txt);
  const f = fixture({ downloads: new Map([[new URL(attachment.url).pathname, txt]]) });
  const { msg, replies } = incomingMessage(f, "@tti-intelligence このtxtの末尾のコードは？", { attachments: [attachment] });
  await f.assistant.handleMessage(msg);
  assert.equal(f.payloads.length, 1);
  assert.equal(f.countPayloads.length, 1);
  const full = f.payloads[0].input.find(i => i.content?.includes?.("---本文ここから---"));
  assert.ok(full.content.includes(text));
  assert.deepEqual(f.countPayloads[0].input, f.payloads[0].input);
  assert.equal(replies[0].content, "回答");
});

test("oversized token counts stop before generation instead of silently cutting the txt", async (t) => {
  t.mock.method(console, "error", () => {});
  const txt = Buffer.from("large input\n".repeat(30000));
  const attachment = attachedFile("400000000000000002", "large.txt", txt);
  const f = fixture({ inputTokens: 900001, downloads: new Map([[new URL(attachment.url).pathname, txt]]) });
  const { msg, replies } = incomingMessage(f, "@tti-intelligence txt全文を読んで", { attachments: [attachment] });
  await f.assistant.handleMessage(msg);
  assert.equal(f.payloads.length, 0);
  assert.equal(f.countPayloads.length, 1);
  assert.match(replies[0].content, /90万トークン/);
});

test("large txt discovered through a tool is also supplied whole in the next request", async () => {
  const text = "earlier notes\n".repeat(24000) + "END-OF-HISTORY-TXT";
  const txt = Buffer.from(text);
  const attachment = attachedFile("400000000000000002", "old-large.txt", txt);
  const prior = message("300000000000000000", "資料", [attachment]);
  const f = fixture({ downloads: new Map([[new URL(attachment.url).pathname, txt]]), responses: [
    { output: [call("read_message_attachments", { channel_id: CURRENT, message_id: prior.id })] }, final(),
  ] });
  f.current = f.channel(CURRENT, { messages: [prior] });
  await f.ask({ question: "前のtxtを全文読んで" });
  assert.equal(f.payloads.length, 2);
  assert.equal(f.countPayloads.length, 1);
  assert.ok(f.payloads[1].input.some(i => i.content?.includes?.(text)));
});

test("Word filling receives the entire large txt in both research and structured generation", async () => {
  const text = "memo\n".repeat(20000) + "末尾にある重要な決定事項";
  const txt = Buffer.from(text), word = wordFixture();
  const a = attachedFile("400000000000000002", "large.txt", txt);
  const b = attachedFile("400000000000000001", "template.docx", word);
  const f = fixture({ downloads: new Map([[new URL(a.url).pathname, txt], [new URL(b.url).pathname, word]]), responses: [
    final("調査済み"), final(JSON.stringify({ fields: { field_1: "末尾の決定事項を反映" }, summary: "" })),
  ] });
  const { msg, replies } = incomingMessage(f, "@tti-intelligence このWordをtxtで埋めて", { attachments: [a, b] });
  await f.assistant.handleMessage(msg);
  assert.equal(f.countPayloads.length, 2);
  assert.ok(f.payloads.every(body => body.input.some(i => i.content?.includes?.(text))));
  assert.ok(replies[0].files?.length);
});

test("token counting failures do not expose response bodies or fall through to generation", async () => {
  for (const status of [401, 429, 500]) {
    let calls = 0;
    await assert.rejects(requestResponse(config(), [{ role: "user", content: "large" }], {
      countFullTextTokens: true, fetchImpl: async url => {
        calls++;
        assert.ok(url.endsWith("input_tokens"));
        return { ok: false, status, json: async () => { throw Error("must not read provider error body"); } };
      },
    }), /入力サイズ確認/);
    assert.equal(calls, 1);
  }
});

test("attachment reads cannot bypass the public channel boundary", async () => {
  const f = fixture({ responses: [
    { output: [call("read_message_attachments", { channel_id: SECRET, message_id: "300000000000000000" })] }, final(),
  ] });
  await f.ask();
  assert.ok(!f.fetchedIds.includes(SECRET));
  assert.match(f.payloads[1].input.find((item) => item.type === "function_call_output").output, /指定チャンネルだけ/);
});

test("a Cerebras outage falls back to Terra and still produces an answer", async () => {
  const f = fixture({ responses: [final("Terraからの回答")] });
  let cerebrasCalls = 0;
  const assistant = createAiAssistant({ config: config({ cerebrasApiKey: "test-cerebras", cerebrasModel: "qwen-3.8-27b" }),
    fetchImpl: async (url, options) => {
      if (url.includes("api.cerebras.ai")) { cerebrasCalls++; return new Response(null, { status: 429 }); }
      return f.fetchImpl(url, options);
    },
  });
  assert.equal(await assistant.answer({ guild: f.guild, userId: USER, channelId: CURRENT, question: "こんにちは" }), "Terraからの回答");
  assert.equal(cerebrasCalls, 1);
  assert.equal(f.payloads[0].model, "gpt-6.1-terra");
});

test("a short greeting replying to a txt post stays on Terra and reads the attachment", async () => {
  const txt = Buffer.from("参照する資料です。");
  const attachment = attachedFile("400000000000000002", "notes.txt", txt);
  const prior = message("300000000000000000", "資料", [attachment]);
  const f = fixture({ downloads: new Map([[new URL(attachment.url).pathname, txt]]), responses: [final("資料を確認しました")] });
  f.current = f.channel(CURRENT, { messages: [prior] });
  const { msg } = incomingMessage(f, "@tti-intelligence こんにちは", { reference: { messageId: prior.id, channelId: CURRENT } });
  const assistant = createAiAssistant({ config: config({ cerebrasApiKey: "test-cerebras" }), fetchImpl: (url, options) => {
    assert.ok(!url.includes("api.cerebras.ai"));
    return f.fetchImpl(url, options);
  } });
  assert.equal(await assistant.answer({ guild: f.guild, userId: USER, channelId: CURRENT, question: "こんにちは", sourceMessage: msg }), "資料を確認しました");
  assert.ok(JSON.stringify(f.payloads[0].input).includes("参照する資料です"));
});

test("Word generation refuses incomplete JSON output rather than returning an unfilled file", async (t) => {
  t.mock.method(console, "error", () => {});
  const bytes = wordFixture();
  const attachment = attachedFile("400000000000000001", "template.docx", bytes);
  const f = fixture({ downloads: new Map([[new URL(attachment.url).pathname, bytes]]), responses: [
    final("調査済み"), { ...final('{"fields":'), status: "incomplete" },
  ] });
  const { msg, replies, reactions } = incomingMessage(f, "@tti-intelligence この枠を埋めて", { attachments: [attachment] });
  await f.assistant.handleMessage(msg);
  assert.match(replies[0].content, /出力上限/);
  assert.equal(replies[0].files, undefined);
  assert.equal(reactions.at(-1).action, "remove");
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

test("public mentions can research other public channels but never restricted history", async () => {
  const f = fixture({ responses: [
    { output: [call("list_channels", { after: null })] },
    { output: [call("read_channel_history", { channel_id: OTHER, before: null })] }, final(),
  ] });
  f.channels.get(SECRET).permissionsFor = (member) => member.id === GUILD ? NONE : ALL;
  const { msg, replies } = incomingMessage(f, "@tti-intelligence 全チャンネルの決定事項は？");
  await f.assistant.handleMessage(msg);
  const listed = JSON.parse(f.payloads[1].input.find(i => i.type === "function_call_output").output);
  assert.ok(listed.channels.some(c => c.id === OTHER));
  assert.ok(!listed.channels.some(c => c.id === SECRET));
  assert.ok(f.channels.get(OTHER).readCount > 0);
  assert.equal(replies[0].content, "回答");
});

test("public cross-channel reads fail closed for denied overwrites and private threads", async () => {
  for (const mode of ["overwrite", "thread", "unknown"]) {
    const f = fixture({ responses: [{ output: [call("read_channel_history", { channel_id: OTHER, before: null })] }, final()] });
    const other = f.channels.get(OTHER);
    if (mode === "overwrite") other.permissionOverwrites.cache.set(USER, { deny: new PermissionsBitField(PermissionsBitField.Flags.ReadMessageHistory) });
    if (mode === "thread") other.type = ChannelType.PrivateThread;
    if (mode === "unknown") delete f.guild.roles;
    await f.ask({ serverScope: true, publicReply: true });
    assert.equal(other.readCount, 0);
  }
});

test("server browsing includes voice text chats and uncached active forum threads", async () => {
  const f = fixture({ responses: [{ output: [call("list_channels", { after: null })] }, final()] });
  f.channel(OTHER, { type: ChannelType.GuildVoice });
  const thread = f.channel("100000000000000007", { type: ChannelType.PublicThread });
  f.channels.delete(thread.id);
  f.guild.channels.fetchActiveThreads = async () => ({ threads: new Collection([[thread.id, thread]]) });
  await f.ask({ serverScope: true });
  const listed = JSON.parse(f.payloads[1].input.find(i => i.type === "function_call_output").output);
  assert.ok(listed.channels.some(c => c.id === OTHER));
  assert.ok(listed.channels.some(c => c.id === thread.id));
});

test("replies to this bot continue without mentions and preserve the referenced context", async () => {
  const f = fixture({ responses: [final("続きの説明".repeat(500))] });
  const parent = { ...message("300000000000000000", "先ほどの結論は11月10日です。"), author: { id: BOT, username: "tti-intelligence", bot: true } };
  f.current = f.channel(CURRENT, { messages: [parent] });
  const { msg, replies, reactions } = incomingMessage(f, "それを詳しく教えて", { reference: { messageId: parent.id, channelId: CURRENT } });
  await f.assistant.handleMessage(msg);
  assert.ok(JSON.stringify(f.payloads[0].input).includes("先ほどの結論は11月10日"));
  assert.ok(replies.length > 1);
  assert.ok(replies.every(r => r.allowedMentions.repliedUser === false));
  assert.equal(reactions.at(-1).action, "remove");
});

test("replies to humans, other bots, webhooks and other channels do not trigger", async () => {
  for (const mode of ["human", "otherbot", "webhook", "otherchannel"]) {
    const f = fixture();
    const parent = { ...message("300000000000000000", "参考"), author: { id: mode === "human" ? USER : mode === "otherbot" ? SECRET : BOT }, ...(mode === "webhook" ? { webhookId: "fake" } : {}) };
    f.current = f.channel(CURRENT, { messages: [parent] });
    const { msg, replies, reactions } = incomingMessage(f, "詳しく", { reference: { messageId: parent.id, channelId: mode === "otherchannel" ? OTHER : CURRENT } });
    await f.assistant.handleMessage(msg);
    assert.equal(f.payloads.length, 0);
    assert.equal(replies.length, 0);
    assert.equal(reactions.length, 0);
  }
});

test("PDFs are supplied as native file inputs both directly and through history tools", async () => {
  for (const direct of [true, false]) {
    const bytes = Buffer.from("%PDF-1.7\nsynthetic fixture");
    const attachment = attachedFile("400000000000000009", "資料.pdf", bytes);
    const prior = message("300000000000000000", "資料", [attachment]);
    const f = fixture({ downloads: new Map([[new URL(attachment.url).pathname, bytes]]), responses: direct ? [final()] : [
      { output: [call("read_message_attachments", { channel_id: CURRENT, message_id: prior.id })] }, final(),
    ] });
    f.current = f.channel(CURRENT, { messages: direct ? [] : [prior] });
    const { msg } = incomingMessage(f, "@tti-intelligence このPDFを要約して", { attachments: direct ? [attachment] : [] });
    await f.assistant.handleMessage(msg);
    const payload = f.payloads.at(-1);
    const files = payload.input.flatMap(i => Array.isArray(i.content) ? i.content : []).filter(i => i.type === "input_file");
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, "資料.pdf");
    assert.equal(files[0].detail, "high");
    assert.equal(files[0].file_data, `data:application/pdf;base64,${bytes.toString("base64")}`);
    assert.ok(!payload.input.filter(i => i.type === "function_call_output").some(i => i.output.includes("base64")));
  }
});

test("PDF data survives reply continuation and structured Word filling", async () => {
  const pdf = Buffer.from("%PDF-1.7\nfixture"), word = wordFixture();
  const pdfAttachment = attachedFile("400000000000000009", "資料.pdf", pdf);
  const wordAttachment = attachedFile("400000000000000001", "template.docx", word);
  const original = message("300000000000000000", "元の依頼", [pdfAttachment]);
  const parent = { ...message("300000000000000002", "資料を要約しました"), author: { id: BOT }, reference: { messageId: original.id, channelId: CURRENT } };
  const f = fixture({ downloads: new Map([[new URL(pdfAttachment.url).pathname, pdf], [new URL(wordAttachment.url).pathname, word]]), responses: [final("調査済み"), final(JSON.stringify({ fields: { field_1: "確認済み" }, summary: "" }))] });
  f.current = f.channel(CURRENT, { messages: [parent, original] });
  const { msg, replies } = incomingMessage(f, "このWordの枠を埋めて", { reference: { messageId: parent.id, channelId: CURRENT }, attachments: [wordAttachment] });
  await f.assistant.handleMessage(msg);
  assert.ok(replies[0].files?.length);
  assert.ok(f.payloads[1].input.some(i => Array.isArray(i.content) && i.content.some(c => c.type === "input_file")));
});

test("invalid PDFs and PDF count limits fail before contacting the model", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const invalid of [true, false]) {
    const bytes = Buffer.from(invalid ? "not a pdf" : "%PDF-1.7\nfixture");
    const attachments = Array.from({ length: invalid ? 1 : 3 }, (_, i) => attachedFile(String(400000000000000001n + BigInt(i)), `file${i}.pdf`, bytes));
    const f = fixture({ downloads: new Map(attachments.map(a => [new URL(a.url).pathname, bytes])) });
    const { msg, replies } = incomingMessage(f, "@tti-intelligence 要約して", { attachments });
    await f.assistant.handleMessage(msg);
    assert.equal(f.payloads.length, 0);
    assert.match(replies[0].content, invalid ? /PDF形式/ : /2個まで/);
  }
});
