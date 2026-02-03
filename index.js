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
const {
  DISCORD_TOKEN,
  GUILD_ID,
  CHANNEL_ID, // /poststeps を実行できるチャンネル（あなたの元コード仕様）
  ROLE_STEP1,
  ROLE_STEP2,
  ROLE_STEP3,
  ROLE_STEP4,
  ROLE_STEP5,
  ROLE_STEP6,
} = process.env;

const STEP_ROLE_IDS = [ROLE_STEP1, ROLE_STEP2, ROLE_STEP3, ROLE_STEP4, ROLE_STEP5, ROLE_STEP6].filter(Boolean);

if (!DISCORD_TOKEN || !GUILD_ID || !CHANNEL_ID || STEP_ROLE_IDS.length !== 6) {
  console.error("Missing env vars. Check DISCORD_TOKEN/GUILD_ID/CHANNEL_ID and ROLE_STEP1..6");
  process.exit(1);
}

/* =========================
   Client（GuildMembers intent なしでOK）
   ========================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

/* =========================
   保存（JSON）
   - ユーザーごとのチャンネル作成回数（最大10）
   - 移動禁止カテゴリ（lockedCategories）
   ========================= */
const MAX_CREATE_PER_USER = 10;

const DATA_DIR = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");

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

/* =========================
   Stepロールのボタン行（あなたの元コード）
   ========================= */
function buildStepRows() {
  const labels = ["Step 1", "Step 2", "Step 3", "Step 4", "Step 5", "Step 6"];

  const buttons = STEP_ROLE_IDS.map((roleId, i) =>
    new ButtonBuilder()
      .setCustomId(`step_toggle:${roleId}`)
      .setLabel(labels[i])
      .setStyle(ButtonStyle.Primary)
  );

  const row1 = new ActionRowBuilder().addComponents(buttons.slice(0, 5));
  const row2 = new ActionRowBuilder().addComponents(buttons.slice(5, 6));

  const clearBtn = new ButtonBuilder()
    .setCustomId("step_clear")
    .setLabel("🧹 全解除")
    .setStyle(ButtonStyle.Secondary);

  row2.addComponents(clearBtn);
  return [row1, row2];
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
      .setName("poststeps")
      .setDescription("Step1〜6のロール付与ボタンを投稿します"),

    new SlashCommandBuilder()
      .setName("postpanel")
      .setDescription("チャンネル操作パネル（表）を投稿します（管理者用）")
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

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
      const botCanManageRoles = botMember?.permissions?.has(PermissionsBitField.Flags.ManageRoles);

      // /poststeps（あなたの元仕様：指定チャンネルのみ）
      if (interaction.commandName === "poststeps") {
        if (interaction.channelId !== CHANNEL_ID) {
          return interaction.reply({ content: "このコマンドは指定チャンネルで実行してください。", ephemeral: true });
        }
        if (!botCanManageRoles) {
          return interaction.reply({ content: "Botに **ロール管理(Manage Roles)** 権限が必要です。", ephemeral: true });
        }

        await interaction.channel.send({
          content:
            "📌 **学習ロードマップ：Stepロール**\n" +
            "ボタンを押すと **付与/解除** できます（複数OK）。",
          components: buildStepRows(),
        });

        return interaction.reply({ content: "投稿しました！", ephemeral: true });
      }

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
      const botCanManageRoles = botMember?.permissions?.has(PermissionsBitField.Flags.ManageRoles);

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

      // ===== Stepボタン（あなたの元機能） =====
      if (!botCanManageRoles) {
        // Stepボタンを押したのに権限がない場合の保険
        if (interaction.customId === "step_clear" || interaction.customId.startsWith("step_toggle:")) {
          return interaction.reply({ content: "Botに **ロール管理(Manage Roles)** 権限が必要です。", ephemeral: true });
        }
      }

      // メンバー取得（REST fetchでOK）
      const member = await interaction.guild.members.fetch(interaction.user.id);

      if (interaction.customId === "step_clear") {
        const owned = STEP_ROLE_IDS.filter((id) => member.roles.cache.has(id));
        if (owned.length === 0) {
          return interaction.reply({ content: "今、Stepロールは付いていません。", ephemeral: true });
        }
        await member.roles.remove(owned);
        return interaction.reply({ content: "🧹 Stepロールを全解除しました。", ephemeral: true });
      }

      if (interaction.customId.startsWith("step_toggle:")) {
        const roleId = interaction.customId.split(":")[1];
        const role = interaction.guild.roles.cache.get(roleId);
        if (!role) {
          return interaction.reply({ content: "ロールが見つかりませんでした。環境変数のIDを確認してね。", ephemeral: true });
        }

        const hasRole = member.roles.cache.has(roleId);
        if (hasRole) {
          await member.roles.remove(roleId);
          return interaction.reply({ content: `❌ ${role.name} を外しました`, ephemeral: true });
        } else {
          await member.roles.add(roleId);
          return interaction.reply({ content: `✅ ${role.name} を付けました`, ephemeral: true });
        }
      }

      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      return interaction.reply({
        content:
          "エラー：Botの権限（Manage Channels / Manage Roles）や、ロール順（BotロールがStepロールより上）を確認して！",
        ephemeral: true,
      });
    }
  }
});

client.login(DISCORD_TOKEN);
