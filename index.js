require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelSelectMenuBuilder,
} = require("discord.js");

/* =========================
   Render用の簡易Webサーバー
   ========================= */
http
  .createServer((req, res) => {
    res.write("Bot is running!");
    res.end();
  })
  .listen(process.env.PORT || 8080);

/* =========================
   環境変数
   ========================= */
const { DISCORD_TOKEN, GUILD_ID, BACKUP_CHANNEL_ID, BACKUP_MAX_MESSAGES_PER_CHANNEL } = process.env;
const MAX_BACKUP_MESSAGES_PER_CHANNEL = Number(BACKUP_MAX_MESSAGES_PER_CHANNEL || 2000);

function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "0分";

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}時間`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}分`);
  if (hours === 0 && minutes < 5 && seconds > 0) parts.push(`${seconds}秒`);
  return parts.join("");
}

if (!DISCORD_TOKEN || !GUILD_ID) {
  console.error("Missing env vars. Check DISCORD_TOKEN and GUILD_ID");
  process.exit(1);
}

/* =========================
   Client（GuildMembers intent なしでOK）
   ========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

/* =========================
   保存（JSON）
   - ユーザーごとのチャンネル作成回数（最大10）
   - 移動禁止カテゴリ（lockedCategories）
   ========================= */
const MAX_CREATE_PER_USER = 10;

const DATA_DIR = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const BACKUPS_DIR = path.join(__dirname, "backups");

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    return { guilds: {} };
  }
}
function saveStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}
function ensureGuild(store, guildId) {
  store.guilds[guildId] ??= {
    users: {},            // { [userId]: { count: number } }
    lockedCategories: [], // [categoryId, ...]
    voiceStats: { users: {} },
    voiceSessions: {},
    voiceStatsPanelMessages: {},
  };
}
function getUserCount(store, guildId, userId) {
  ensureGuild(store, guildId);
  return store.guilds[guildId].users?.[userId]?.count ?? 0;
}
function setUserCount(store, guildId, userId, count) {
  ensureGuild(store, guildId);
  store.guilds[guildId].users[userId] ??= { count: 0 };
  store.guilds[guildId].users[userId].count = count;
}
function resetAllCounts(store, guildId) {
  ensureGuild(store, guildId);
  store.guilds[guildId].users = {};
}
function isLockedCategory(store, guildId, categoryId) {
  ensureGuild(store, guildId);
  return store.guilds[guildId].lockedCategories.includes(categoryId);
}
function addLockedCategory(store, guildId, categoryId) {
  ensureGuild(store, guildId);
  const arr = store.guilds[guildId].lockedCategories;
  if (!arr.includes(categoryId)) arr.push(categoryId);
}
function removeLockedCategory(store, guildId, categoryId) {
  ensureGuild(store, guildId);
  store.guilds[guildId].lockedCategories = store.guilds[guildId].lockedCategories.filter((id) => id !== categoryId);
}

function ensureVoiceStats(store, guildId) {
  ensureGuild(store, guildId);
  store.guilds[guildId].voiceStats ??= { users: {} };
  store.guilds[guildId].voiceSessions ??= {};
}

function updateVoiceStats(store, guildId, userId, deltaSeconds, member) {
  ensureVoiceStats(store, guildId);
  const stats = store.guilds[guildId].voiceStats.users;
  stats[userId] ??= { totalSeconds: 0, displayName: null, lastSeenAt: null };
  stats[userId].totalSeconds += deltaSeconds;
  stats[userId].lastSeenAt = Date.now();
  if (member) {
    stats[userId].displayName = member.displayName || member.user?.username || stats[userId].displayName || userId;
    stats[userId].username = member.user?.username || stats[userId].username || null;
  }
}

function getVoiceStatsEntries(store, guildId) {
  ensureVoiceStats(store, guildId);
  return Object.entries(store.guilds[guildId].voiceStats.users)
    .map(([userId, data]) => ({ userId, ...data }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds);
}

function getActiveVoiceUsers(store, guildId) {
  ensureVoiceStats(store, guildId);
  return store.guilds[guildId].voiceSessions ?? {};
}

function syncActiveVoiceSessions(store, guildId, guild, now = Date.now()) {
  ensureVoiceStats(store, guildId);
  const sessions = store.guilds[guildId].voiceSessions ?? {};
  for (const [userId, session] of Object.entries(sessions)) {
    const member = guild?.members?.cache.get(userId) ?? null;
    const deltaSeconds = Math.max(0, Math.floor((now - (session.startedAt || now)) / 1000));
    if (deltaSeconds > 0) {
      updateVoiceStats(store, guildId, userId, deltaSeconds, member);
    }
    session.startedAt = now;
    session.displayName = member?.displayName || member?.user?.username || session.displayName || null;
  }
  return sessions;
}

async function buildVoiceStatsMessage(store, guild) {
  ensureVoiceStats(store, guild.id);
  syncActiveVoiceSessions(store, guild.id, guild);
  const stats = getVoiceStatsEntries(store, guild.id);
  const activeSessions = getActiveVoiceUsers(store, guild.id);

  const lines = stats.slice(0, 5).map((entry) => {
    const member = guild.members.cache.get(entry.userId);
    const displayName = member?.displayName || entry.displayName || member?.user?.username || entry.username || entry.userId;
    const isActive = Boolean(activeSessions[entry.userId]);
    return `- ${displayName}: ${formatDuration(entry.totalSeconds)}${isActive ? "（通話中）" : ""}`;
  });

  const embed = new EmbedBuilder()
  .setTitle("💼 社畜時間記録")
    .setDescription(
    "通話に入った時間を社畜時間として記録します。\n" +
    "更新ボタンで最新状態に更新できます。"
    )
    .addFields({
    name: "トップ5（社畜時間）",
      value: lines.length ? lines.join("\n") : "まだ記録がありません。",
    });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("voice_stats:refresh").setLabel("🔄 更新").setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

async function findExistingVoiceStatsPanelMessage(channel) {
  if (!channel?.messages?.fetch) return null;

  const messages = await channel.messages.fetch({ limit: 50 });
  return Array.from(messages.values()).find((message) => {
    const hasVoiceButton = message.components?.some((row) =>
      row.components?.some((component) => component.customId === "voice_stats:refresh")
    );
    const hasVoiceTitle = message.embeds?.some((embed) => embed.title === "🎙️ 通話時間統計");
    return hasVoiceButton && hasVoiceTitle;
  }) ?? null;
}

async function postOrUpdateVoiceStatsPanel(store, guild, channel) {
  const panelPayload = await buildVoiceStatsMessage(store, guild);
  const existing = await findExistingVoiceStatsPanelMessage(channel);

  if (existing) {
    await existing.edit(panelPayload);
    store.guilds[guild.id].voiceStatsPanelMessages = {
      channelId: channel.id,
      messageId: existing.id,
    };
    saveStore(store);
    return existing;
  }

  const message = await channel.send(panelPayload);
  store.guilds[guild.id].voiceStatsPanelMessages = {
    channelId: channel.id,
    messageId: message.id,
  };
  saveStore(store);
  return message;
}

function ensureBackupDir() {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function sanitizeOverwrite(overwrite) {
  return {
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow?.bitfield ?? 0,
    deny: overwrite.deny?.bitfield ?? 0,
  };
}

async function fetchChannelMessages(channel, maxMessages) {
  if (!channel.isTextBased?.()) return [];

  const collected = [];
  let before;

  while (collected.length < maxMessages) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, maxMessages - collected.length), before });
    if (batch.size === 0) break;

    const sorted = Array.from(batch.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    collected.push(...sorted);

    const oldest = sorted[0];
    before = oldest.id;

    if (batch.size < 100) break;
  }

  return collected
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map((message) => ({
      id: message.id,
      content: message.content ?? "",
      authorId: message.author?.id ?? null,
      authorUsername: message.author?.username ?? null,
      createdAt: message.createdAt?.toISOString() ?? null,
      editedAt: message.editedAt?.toISOString() ?? null,
      attachments: Array.from(message.attachments.values()).map((attachment) => ({
        name: attachment.name ?? null,
        url: attachment.url ?? null,
        contentType: attachment.contentType ?? null,
        size: attachment.size ?? null,
      })),
    }));
}

async function createServerBackup(guild) {
  ensureBackupDir();

  const [channelManager, roles, emojis, members] = await Promise.all([
    guild.channels.fetch(),
    guild.roles.fetch(),
    guild.emojis.fetch(),
    guild.members.fetch(),
  ]);

  const channels = Array.from(channelManager.values());

  const channelData = [];
  for (const channel of channels) {
   const channelEntry = {
     id: channel.id,
     name: channel.name,
     type: channel.type,
     topic: channel.topic ?? null,
     parentId: channel.parentId ?? null,
     position: channel.position ?? null,
     nsfw: channel.nsfw ?? false,
     createdAt: channel.createdAt?.toISOString() ?? null,
     permissionOverwrites: Array.from(channel.permissionOverwrites.cache.values()).map(sanitizeOverwrite),
   };

   if (channel.isTextBased?.()) {
     channelEntry.messages = await fetchChannelMessages(channel, MAX_BACKUP_MESSAGES_PER_CHANNEL);
   }

   channelData.push(channelEntry);
  }

  const backup = {
   generatedAt: new Date().toISOString(),
   guild: {
     id: guild.id,
     name: guild.name,
     description: guild.description ?? null,
     iconURL: guild.iconURL({ extension: "png" }) ?? null,
     bannerURL: guild.bannerURL({ extension: "png" }) ?? null,
     ownerId: guild.ownerId,
     memberCount: guild.memberCount,
     features: guild.features ?? [],
     verificationLevel: guild.verificationLevel,
     explicitContentFilter: guild.explicitContentFilter,
     defaultMessageNotifications: guild.defaultMessageNotifications,
     systemChannelId: guild.systemChannelId ?? null,
     afkChannelId: guild.afkChannelId ?? null,
     afkTimeout: guild.afkTimeout,
     preferredLocale: guild.preferredLocale,
     premiumTier: guild.premiumTier,
     vanityURLCode: guild.vanityURLCode ?? null,
   },
   channels: channelData,
   roles: Array.from(roles.values()).map((role) => ({
     id: role.id,
     name: role.name,
     color: role.color,
     hoist: role.hoist,
     mentionable: role.mentionable,
     position: role.position,
     permissions: role.permissions?.bitfield ?? 0,
     managed: role.managed,
     tags: role.tags ?? {},
   })),
   emojis: Array.from(emojis.values()).map((emoji) => ({
     id: emoji.id,
     name: emoji.name,
     animated: emoji.animated,
     available: emoji.available,
     managed: emoji.managed,
     roles: Array.from(emoji.roles?.cache?.values() ?? []).map((role) => role.id),
   })),
   members: Array.from(members.values()).map((member) => ({
     id: member.id,
     username: member.user?.username ?? null,
     displayName: member.displayName,
     bot: member.user?.bot ?? false,
     joinedAt: member.joinedAt?.toISOString() ?? null,
     premiumSince: member.premiumSince?.toISOString() ?? null,
     roles: Array.from(member.roles.cache.values()).filter((role) => role.id !== guild.id).map((role) => role.id),
   })),
  };

  const fileName = `${guild.name.replace(/[^\w.-]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const filePath = path.join(BACKUPS_DIR, fileName);
  fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), "utf8");

  return { filePath, fileName, backup };
}

async function restoreBackupToGuild(backup, guild) {
  const categoryMap = new Map();
  const channelMap = new Map();
  const createdChannels = [];

  const categoryEntries = (backup.channels ?? []).filter((channel) => channel.type === ChannelType.GuildCategory);
  for (const channel of categoryEntries) {
   const created = await guild.channels.create({
     name: channel.name,
     type: ChannelType.GuildCategory,
     position: channel.position ?? undefined,
     reason: `restorebackup from ${backup.guild?.name ?? "backup"}`,
   });
   categoryMap.set(channel.id, created.id);
   channelMap.set(channel.id, created.id);
   createdChannels.push(created);
  }

  const textChannelEntries = (backup.channels ?? []).filter((channel) => channel.type === ChannelType.GuildText);
  for (const channel of textChannelEntries) {
   const created = await guild.channels.create({
     name: channel.name,
     type: ChannelType.GuildText,
     topic: channel.topic ?? undefined,
     parent: channel.parentId ? categoryMap.get(channel.parentId) ?? null : null,
     nsfw: channel.nsfw ?? false,
     position: channel.position ?? undefined,
     reason: `restorebackup from ${backup.guild?.name ?? "backup"}`,
   });
   channelMap.set(channel.id, created.id);
   createdChannels.push(created);
  }

  for (const channel of textChannelEntries) {
   const createdChannel = guild.channels.cache.get(channelMap.get(channel.id));
   if (!createdChannel || !Array.isArray(channel.messages)) continue;

   const orderedMessages = [...channel.messages].sort((a, b) => new Date(a.createdAt ?? 0) - new Date(b.createdAt ?? 0));
   for (const message of orderedMessages) {
     const payload = {};
     if (message.content?.trim()) payload.content = message.content;
     if (message.attachments?.length) {
       const files = [];
       for (const attachment of message.attachments) {
         if (!attachment.url) continue;
         try {
           const response = await fetch(attachment.url);
           if (!response.ok) continue;
           const buffer = Buffer.from(await response.arrayBuffer());
           files.push({
             attachment: buffer,
             name: attachment.name || attachment.url.split("/").pop() || "attachment",
           });
         } catch (error) {
           console.warn(`Failed to download attachment ${attachment.url}:`, error);
         }
       }
       if (files.length) payload.files = files;
     }
     if (payload.content || payload.files?.length) {
       await createdChannel.send(payload);
       await new Promise((resolve) => setTimeout(resolve, 700));
     }
   }
  }

  return createdChannels;
}

/* =========================
   管理パネル（表っぽいEmbed）
   ========================= */
function buildPanelMessage(store, guildId) {
  ensureGuild(store, guildId);
  const lockedCount = store.guilds[guildId].lockedCategories.length;

  const embed = new EmbedBuilder()
    .setTitle("🧩 チャンネル操作パネル")
    .setDescription(
      "ここから **チャンネル作成 / カテゴリ作成 / カテゴリ移動** ができます。\n" +
      "（操作はあなたにだけ表示されます）\n\n" +
      "```text\n" +
      "操作                 | 内容\n" +
      "---------------------|-----------------------------\n" +
      "➕ チャンネル作成       | テキストチャンネル作成（1人10回まで）\n" +
      "📁 カテゴリ作成        | 新しいカテゴリを作成\n" +
      "🚚 チャンネル移動       | カテゴリ間で移動（誰でも）\n" +
      "🔒 ロックカテゴリ数     | " + lockedCount + "\n" +
      "```\n" +
      "※ロックされたカテゴリには **移動できません**（出入り両方ブロック）。"
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel:create_channel").setLabel("➕ チャンネル作成").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:move_channel").setLabel("🚚 チャンネル移動").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:create_category").setLabel("📁 カテゴリ作成").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("panel:my_quota").setLabel("📊 残り回数").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("panel:refresh").setLabel("🔄 更新").setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

/* =========================
   パネル操作の一時状態（token）
   ========================= */
const pending = new Map(); // token -> { userId, kind, name?, channelId?, categoryId? }

function makeToken() {
  return crypto.randomBytes(8).toString("hex");
}
function setPending(token, data, ttlMs = 15 * 60 * 1000) {
  pending.set(token, data);
  setTimeout(() => pending.delete(token), ttlMs).unref?.();
}

function buildCreateFlowComponents(token) {
  const catSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`panel_select:create_category:${token}`)
    .setPlaceholder("作成先カテゴリ（任意）を選んでね")
    .addChannelTypes(ChannelType.GuildCategory)
    .setMinValues(1)
    .setMaxValues(1);

  const rowA = new ActionRowBuilder().addComponents(catSelect);

  const rowB = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`panel_confirm:create:${token}`).setLabel("✅ 作成する").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`panel_clear:create:${token}`).setLabel("📂 カテゴリなし").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`panel_cancel:${token}`).setLabel("✖ キャンセル").setStyle(ButtonStyle.Danger),
  );

  return [rowA, rowB];
}

function buildMoveFlowComponents(token) {
  const chSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`panel_select:move_channel:${token}`)
    .setPlaceholder("移動するチャンネルを選んでね")
    .addChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);

  const catSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`panel_select:move_category:${token}`)
    .setPlaceholder("移動先カテゴリ（任意）を選んでね")
    .addChannelTypes(ChannelType.GuildCategory)
    .setMinValues(1)
    .setMaxValues(1);

  const rowA = new ActionRowBuilder().addComponents(chSelect);
  const rowB = new ActionRowBuilder().addComponents(catSelect);

  const rowC = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`panel_confirm:move:${token}`).setLabel("✅ 移動する").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`panel_clear:move:${token}`).setLabel("📂 カテゴリ解除").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`panel_cancel:${token}`).setLabel("✖ キャンセル").setStyle(ButtonStyle.Danger),
  );

  return [rowA, rowB, rowC];
}

function summarizePending(guild, data) {
  const catName =
    data.categoryId ? (guild.channels.cache.get(data.categoryId)?.name ?? `unknown(${data.categoryId})`) : "（なし）";
  const chName =
    data.channelId ? (guild.channels.cache.get(data.channelId)?.name ?? `unknown(${data.channelId})`) : "（未選択）";

  if (data.kind === "create") {
    return `作成チャンネル：**${data.name}**\n作成先カテゴリ：**${catName}**`;
  }
  if (data.kind === "move") {
    return `移動対象：**#${chName}**\n移動先カテゴリ：**${catName}**`;
  }
  return "状態不明";
}

/* =========================
   Slash Commands 登録
   ========================= */
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("postpanel")
      .setDescription("チャンネル操作パネル（表）を投稿します（管理者用）")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    new SlashCommandBuilder()
      .setName("backup")
      .setDescription("サーバーのバックアップをJSONファイルとして保存します")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    new SlashCommandBuilder()
      .setName("postvoicestats")
      .setDescription("社畜時間記録パネルを投稿します（管理者用）")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

    new SlashCommandBuilder()
      .setName("restorebackup")
      .setDescription("バックアップJSONを読み込んでチャンネルとメッセージ履歴を復元します")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addAttachmentOption((opt) =>
        opt.setName("backup").setDescription("復元するバックアップJSONファイル").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("categorylock")
      .setDescription("移動禁止カテゴリを管理（管理者用）")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("移動禁止カテゴリに追加")
          .addChannelOption((opt) =>
            opt
              .setName("category")
              .setDescription("ロックするカテゴリ")
              .addChannelTypes(ChannelType.GuildCategory)
              .setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("移動禁止カテゴリから削除")
          .addChannelOption((opt) =>
            opt
              .setName("category")
              .setDescription("ロック解除するカテゴリ")
              .addChannelTypes(ChannelType.GuildCategory)
              .setRequired(true)
          )
      )
      .addSubcommand((sub) => sub.setName("list").setDescription("移動禁止カテゴリ一覧を表示")),

    new SlashCommandBuilder()
      .setName("resetchannelquota")
      .setDescription("チャンネル作成回数をリセット（管理者用）")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addUserOption((opt) =>
        opt.setName("user").setDescription("このユーザーだけリセット（省略すると全員リセット）").setRequired(false)
      ),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
  console.log("✅ Slash commands registered.");
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error("Failed to register commands:", e);
  }
});

/* =========================
   メイン：Interaction
   ========================= */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    /* ---------- Slash Commands ---------- */
    if (interaction.isChatInputCommand()) {
      if (!interaction.guild) {
        return interaction.reply({ content: "サーバー内で実行してね。", ephemeral: true });
      }

      const botMember = interaction.guild.members.me;
      const botCanManageChannels = botMember?.permissions?.has(PermissionsBitField.Flags.ManageChannels);

      // /postpanel（管理者のみ）
      if (interaction.commandName === "postpanel") {
        const canRun =
          interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ||
          interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);

        if (!canRun) {
          return interaction.reply({ content: "このコマンドは管理者のみ実行できます。", ephemeral: true });
        }
        if (!botCanManageChannels) {
          return interaction.reply({ content: "Botに **チャンネル管理(Manage Channels)** 権限が必要です。", ephemeral: true });
        }

        const store = loadStore();
        await interaction.channel.send(buildPanelMessage(store, interaction.guildId));
        return interaction.reply({ content: "✅ パネルを投稿しました（ピン留め推奨）", ephemeral: true });
      }

      if (interaction.commandName === "backup") {
        const canRun =
          interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ||
          interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);

        if (!canRun) {
          return interaction.reply({ content: "このコマンドは管理者のみ実行できます。", ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
          const { filePath, fileName, backup } = await createServerBackup(interaction.guild);

          if (BACKUP_CHANNEL_ID) {
            const backupChannel = interaction.client.channels.cache.get(BACKUP_CHANNEL_ID) ?? (await interaction.client.channels.fetch(BACKUP_CHANNEL_ID).catch(() => null));
            if (backupChannel?.isTextBased?.()) {
              await backupChannel.send({
                content: `📦 ${interaction.guild.name} のバックアップを保存しました。`,
                files: [{ attachment: filePath, name: fileName }],
              });
            }
          }

          return interaction.editReply({
            content: `📦 バックアップを保存しました。\n- 収集内容: チャンネル ${backup.channels.length}件 / ロール ${backup.roles.length}件 / 絵文字 ${backup.emojis.length}件 / メンバー ${backup.members.length}人\n- 保存先: ${filePath}`,
          });
        } catch (error) {
          console.error("Backup failed:", error);
          return interaction.editReply({ content: "バックアップの作成に失敗しました。権限やサイズを確認してください。" });
        }
      }

      if (interaction.commandName === "postvoicestats") {
        const canRun =
          interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ||
          interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);

        if (!canRun) {
          return interaction.reply({ content: "このコマンドは管理者のみ実行できます。", ephemeral: true });
        }

        const store = loadStore();
        await postOrUpdateVoiceStatsPanel(store, interaction.guild, interaction.channel);
        return interaction.reply({ content: "✅ 通話時間統計パネルを更新しました。", ephemeral: true });
      }

      if (interaction.commandName === "restorebackup") {
        const canRun =
          interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ||
          interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);

        if (!canRun) {
          return interaction.reply({ content: "このコマンドは管理者のみ実行できます。", ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
          const attachment = interaction.options.getAttachment("backup", true);
          if (!attachment.name?.toLowerCase().endsWith(".json")) {
            return interaction.editReply({ content: "バックアップJSONファイルを添付してください。" });
          }

          const response = await fetch(attachment.url);
          if (!response.ok) {
            return interaction.editReply({ content: "バックアップファイルを取得できませんでした。" });
          }

          const backup = await response.json();
          const restored = await restoreBackupToGuild(backup, interaction.guild);
          return interaction.editReply({
            content: `✅ 復元が完了しました。\n- 作成したカテゴリ/チャンネル: ${restored.length}件\n- メッセージ履歴はテキストチャンネルごとに再送信しました。`,
          });
        } catch (error) {
          console.error("Restore backup failed:", error);
          return interaction.editReply({ content: "復元に失敗しました。ファイル形式や権限を確認してください。" });
        }
      }

      // /categorylock（管理者のみ）
      if (interaction.commandName === "categorylock") {
        const canRun =
          interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ||
          interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);

        if (!canRun) {
          return interaction.reply({ content: "このコマンドは管理者のみ実行できます。", ephemeral: true });
        }

        const store = loadStore();
        const sub = interaction.options.getSubcommand();

        if (sub === "add") {
          const category = interaction.options.getChannel("category", true);
          addLockedCategory(store, interaction.guildId, category.id);
          saveStore(store);
          return interaction.reply({ content: `🔒 ロックしました：**${category.name}**`, ephemeral: true });
        }

        if (sub === "remove") {
          const category = interaction.options.getChannel("category", true);
          removeLockedCategory(store, interaction.guildId, category.id);
          saveStore(store);
          return interaction.reply({ content: `🔓 ロック解除しました：**${category.name}**`, ephemeral: true });
        }

        if (sub === "list") {
          ensureGuild(store, interaction.guildId);
          const ids = store.guilds[interaction.guildId].lockedCategories;

          if (!ids.length) {
            return interaction.reply({ content: "ロック中のカテゴリはありません。", ephemeral: true });
          }

          const lines = ids
            .map((id) => interaction.guild.channels.cache.get(id))
            .filter(Boolean)
            .map((c) => `- ${c.name} (${c.id})`);

          // 消えてるカテゴリIDがあっても一応表示
          const missing = ids.filter((id) => !interaction.guild.channels.cache.get(id));
          missing.forEach((id) => lines.push(`- (deleted?) ${id}`));

          return interaction.reply({ content: `🔒 ロック中カテゴリ:\n${lines.join("\n")}`, ephemeral: true });
        }
      }

      // /resetchannelquota（管理者のみ）
      if (interaction.commandName === "resetchannelquota") {
        const canRun =
          interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator) ||
          interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);

        if (!canRun) {
          return interaction.reply({ content: "このコマンドは管理者のみ実行できます。", ephemeral: true });
        }

        const target = interaction.options.getUser("user", false);
        const store = loadStore();

        if (target) {
          setUserCount(store, interaction.guildId, target.id, 0);
          saveStore(store);
          return interaction.reply({ content: `🔁 ${target} の作成回数をリセットしました。`, ephemeral: true });
        } else {
          resetAllCounts(store, interaction.guildId);
          saveStore(store);
          return interaction.reply({ content: "🔁 サーバー全員の作成回数をリセットしました。", ephemeral: true });
        }
      }

      return;
    }

    /* ---------- Modal Submit（パネル：入力） ---------- */
    if (interaction.isModalSubmit()) {
      if (!interaction.guild) return interaction.reply({ content: "サーバー内で実行してね。", ephemeral: true });

      const botCanManageChannels = interaction.guild.members.me?.permissions?.has(PermissionsBitField.Flags.ManageChannels);
      if (!botCanManageChannels) {
        return interaction.reply({ content: "Botに **チャンネル管理(Manage Channels)** 権限が必要です。", ephemeral: true });
      }

      if (interaction.customId === "panel_modal:create_channel") {
        const name = interaction.fields.getTextInputValue("name").trim();
        if (name.length < 1 || name.length > 100) {
          return interaction.reply({ content: "チャンネル名は1〜100文字にしてね。", ephemeral: true });
        }

        const store = loadStore();
        const used = getUserCount(store, interaction.guildId, interaction.user.id);
        if (used >= MAX_CREATE_PER_USER) {
          return interaction.reply({ content: `作成できるのは最大${MAX_CREATE_PER_USER}回までです。`, ephemeral: true });
        }

        const token = makeToken();
        setPending(token, { userId: interaction.user.id, kind: "create", name, categoryId: null });

        return interaction.reply({
          content: `入力OK ✅\n${summarizePending(interaction.guild, pending.get(token))}\n\nカテゴリを選ぶか、そのまま作成してね👇`,
          components: buildCreateFlowComponents(token),
          ephemeral: true,
        });
      }

      if (interaction.customId === "panel_modal:create_category") {
        const name = interaction.fields.getTextInputValue("name").trim();
        if (name.length < 1 || name.length > 100) {
          return interaction.reply({ content: "カテゴリ名は1〜100文字にしてね。", ephemeral: true });
        }

        await interaction.guild.channels.create({
          name,
          type: ChannelType.GuildCategory,
          reason: `createcategory(panel) by ${interaction.user.tag} (${interaction.user.id})`,
        });

        return interaction.reply({ content: `✅ カテゴリを作成したよ：**${name}**`, ephemeral: true });
      }
    }

    /* ---------- Select Menu（パネル：選択） ---------- */
    if (interaction.isChannelSelectMenu()) {
      if (!interaction.guild) return interaction.reply({ content: "サーバー内で実行してね。", ephemeral: true });

      const parts = interaction.customId.split(":");
      if (parts[0] !== "panel_select") return;

      const kind = parts[1]; // create_category / move_channel / move_category
      const token = parts[2];

      const data = pending.get(token);
      if (!data || data.userId !== interaction.user.id) {
        return interaction.reply({ content: "この操作は無効になったよ（最初からやり直してね）", ephemeral: true });
      }

      const pickedId = interaction.values[0];

      if (kind === "create_category") data.categoryId = pickedId;
      if (kind === "move_channel") data.channelId = pickedId;
      if (kind === "move_category") data.categoryId = pickedId;

      pending.set(token, data);

      const content = `選択を更新したよ ✅\n${summarizePending(interaction.guild, data)}\n\nこのまま確定してね👇`;

      if (data.kind === "create") {
        return interaction.update({ content, components: buildCreateFlowComponents(token) });
      } else {
        return interaction.update({ content, components: buildMoveFlowComponents(token) });
      }
    }

    /* ---------- Buttons（パネル + Step） ---------- */
    if (interaction.isButton()) {
      if (!interaction.guild) return interaction.reply({ content: "サーバー内で実行してね。", ephemeral: true });

      const botMember = interaction.guild.members.me;
      const botCanManageChannels = botMember?.permissions?.has(PermissionsBitField.Flags.ManageChannels);

      // ===== パネル（表）ボタン =====
      if (interaction.customId === "panel:create_channel") {
        if (!botCanManageChannels) {
          return interaction.reply({ content: "Botに **チャンネル管理(Manage Channels)** 権限が必要です。", ephemeral: true });
        }
        const modal = new ModalBuilder()
          .setCustomId("panel_modal:create_channel")
          .setTitle("チャンネル作成");

        const nameInput = new TextInputBuilder()
          .setCustomId("name")
          .setLabel("チャンネル名")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
        return interaction.showModal(modal);
      }

      if (interaction.customId === "panel:create_category") {
        if (!botCanManageChannels) {
          return interaction.reply({ content: "Botに **チャンネル管理(Manage Channels)** 権限が必要です。", ephemeral: true });
        }
        const modal = new ModalBuilder()
          .setCustomId("panel_modal:create_category")
          .setTitle("カテゴリ作成");

        const nameInput = new TextInputBuilder()
          .setCustomId("name")
          .setLabel("カテゴリ名")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
        return interaction.showModal(modal);
      }

      if (interaction.customId === "panel:move_channel") {
        if (!botCanManageChannels) {
          return interaction.reply({ content: "Botに **チャンネル管理(Manage Channels)** 権限が必要です。", ephemeral: true });
        }
        const token = makeToken();
        setPending(token, { userId: interaction.user.id, kind: "move", channelId: null, categoryId: null });

        return interaction.reply({
          content: `移動設定を選んでね👇\n${summarizePending(interaction.guild, pending.get(token))}`,
          components: buildMoveFlowComponents(token),
          ephemeral: true,
        });
      }

      if (interaction.customId === "panel:my_quota") {
        const store = loadStore();
        const used = getUserCount(store, interaction.guildId, interaction.user.id);
        const left = Math.max(0, MAX_CREATE_PER_USER - used);
        return interaction.reply({ content: `あなたの残り作成回数：**${left} / ${MAX_CREATE_PER_USER}**`, ephemeral: true });
      }

      if (interaction.customId === "panel:refresh") {
        const store = loadStore();
        return interaction.update(buildPanelMessage(store, interaction.guildId));
      }

      if (interaction.customId === "voice_stats:refresh") {
        const store = loadStore();
        const panelPayload = await buildVoiceStatsMessage(store, interaction.guild);
        await interaction.update(panelPayload);
        return;
      }

      // ===== パネル（確定/解除/キャンセル） =====
      if (interaction.customId.startsWith("panel_cancel:")) {
        const token = interaction.customId.split(":")[1];
        pending.delete(token);
        return interaction.update({ content: "キャンセルしました。", components: [] });
      }

      if (interaction.customId.startsWith("panel_clear:create:")) {
        const token = interaction.customId.split(":")[2];
        const data = pending.get(token);
        if (!data || data.userId !== interaction.user.id) {
          return interaction.reply({ content: "この操作は無効になったよ。", ephemeral: true });
        }
        data.categoryId = null;
        pending.set(token, data);
        return interaction.update({
          content: `カテゴリなしにしました ✅\n${summarizePending(interaction.guild, data)}\n\n確定してね👇`,
          components: buildCreateFlowComponents(token),
        });
      }

      if (interaction.customId.startsWith("panel_clear:move:")) {
        const token = interaction.customId.split(":")[2];
        const data = pending.get(token);
        if (!data || data.userId !== interaction.user.id) {
          return interaction.reply({ content: "この操作は無効になったよ。", ephemeral: true });
        }
        data.categoryId = null;
        pending.set(token, data);
        return interaction.update({
          content: `カテゴリ解除にしました ✅\n${summarizePending(interaction.guild, data)}\n\n確定してね👇`,
          components: buildMoveFlowComponents(token),
        });
      }

      // 作成確定
      if (interaction.customId.startsWith("panel_confirm:create:")) {
        if (!botCanManageChannels) {
          return interaction.reply({ content: "Botに **チャンネル管理** 権限が必要です。", ephemeral: true });
        }
        const token = interaction.customId.split(":")[2];
        const data = pending.get(token);
        if (!data || data.userId !== interaction.user.id) {
          return interaction.reply({ content: "この操作は無効になったよ。", ephemeral: true });
        }

        const store = loadStore();
        const used = getUserCount(store, interaction.guildId, interaction.user.id);
        if (used >= MAX_CREATE_PER_USER) {
          return interaction.reply({ content: `作成できるのは最大${MAX_CREATE_PER_USER}回までです。`, ephemeral: true });
        }

        if (data.categoryId && isLockedCategory(store, interaction.guildId, data.categoryId)) {
          return interaction.reply({ content: "そのカテゴリはロック中なので作成先にできません。", ephemeral: true });
        }

        const created = await interaction.guild.channels.create({
          name: data.name,
          type: ChannelType.GuildText,
          parent: data.categoryId ?? null,
          reason: `createchannel(panel) by ${interaction.user.tag} (${interaction.user.id})`,
        });

        setUserCount(store, interaction.guildId, interaction.user.id, used + 1);
        saveStore(store);
        pending.delete(token);

        const left = Math.max(0, MAX_CREATE_PER_USER - (used + 1));
        return interaction.update({ content: `✅ 作成したよ：${created}\n残り：**${left} / ${MAX_CREATE_PER_USER}**`, components: [] });
      }

      // 移動確定（誰でもOKだがロックカテゴリは不可）
      if (interaction.customId.startsWith("panel_confirm:move:")) {
        if (!botCanManageChannels) {
          return interaction.reply({ content: "Botに **チャンネル管理** 権限が必要です。", ephemeral: true });
        }
        const token = interaction.customId.split(":")[2];
        const data = pending.get(token);
        if (!data || data.userId !== interaction.user.id) {
          return interaction.reply({ content: "この操作は無効になったよ。", ephemeral: true });
        }
        if (!data.channelId) {
          return interaction.reply({ content: "移動するチャンネルを選んでね。", ephemeral: true });
        }

        const store = loadStore();
        const channel = interaction.guild.channels.cache.get(data.channelId);
        if (!channel) {
          pending.delete(token);
          return interaction.update({ content: "対象チャンネルが見つからなかった…（消えたかも）", components: [] });
        }

        // ロックカテゴリの「出入り両方」禁止
        if (channel.parentId && isLockedCategory(store, interaction.guildId, channel.parentId)) {
          return interaction.reply({ content: "このチャンネルはロックカテゴリ内なので移動できません。", ephemeral: true });
        }
        if (data.categoryId && isLockedCategory(store, interaction.guildId, data.categoryId)) {
          return interaction.reply({ content: "移動先カテゴリがロック中なので移動できません。", ephemeral: true });
        }

        await channel.setParent(data.categoryId ?? null);
        pending.delete(token);

        return interaction.update({ content: `✅ 移動したよ：${channel}`, components: [] });
      }

      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      return interaction.reply({
        content: "エラー：Botにチャンネル管理権限が付与されているか確認してください。",
        ephemeral: true,
      });
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guildId = newState.guild?.id ?? oldState.guild?.id;
  if (!guildId) return;

  const store = loadStore();
  ensureVoiceStats(store, guildId);

  const member = newState.member ?? oldState.member;
  const userId = member?.user?.id;
  if (!userId) return;

  const sessions = store.guilds[guildId].voiceSessions;
  const existing = sessions[userId];
  const now = Date.now();

  if (!oldState.channelId && newState.channelId) {
    sessions[userId] = { startedAt: now, displayName: member.displayName || member.user?.username || null };
    saveStore(store);
    return;
  }

  if (oldState.channelId && !newState.channelId) {
    if (existing) {
      const deltaSeconds = Math.max(0, Math.floor((now - existing.startedAt) / 1000));
      updateVoiceStats(store, guildId, userId, deltaSeconds, member);
      delete sessions[userId];
      saveStore(store);
    }
    return;
  }

  if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
    if (existing) {
      const deltaSeconds = Math.max(0, Math.floor((now - existing.startedAt) / 1000));
      updateVoiceStats(store, guildId, userId, deltaSeconds, member);
    }
    sessions[userId] = { startedAt: now, displayName: member.displayName || member.user?.username || null };
    saveStore(store);
  }
});

client.login(DISCORD_TOKEN);
