require("dotenv").config();
const http = require("http");
const fs = require("fs");
const path = require("path");

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
} = require("discord.js");

// --- Render用の簡易Webサーバー設定 ---
http
  .createServer((req, res) => {
    res.write("Bot is running!");
    res.end();
  })
  .listen(process.env.PORT || 8080);
// ----------------------------------

const {
  DISCORD_TOKEN,
  GUILD_ID,
  CHANNEL_ID,
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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

/* =========================
   回数・ロック設定の保存（JSON）
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
   Slash Commands 登録
   ========================= */
async function registerCommands() {
  try {
    const commands = [
      new SlashCommandBuilder()
        .setName("poststeps")
        .setDescription("Step1〜6のロール付与ボタンを投稿します"),

      new SlashCommandBuilder()
        .setName("createchannel")
        .setDescription("新しいテキストチャンネルを作成します（1人10回まで）")
        .addStringOption((opt) =>
          opt.setName("name").setDescription("作成するチャンネル名").setRequired(true)
        )
        .addChannelOption((opt) =>
          opt
            .setName("category")
            .setDescription("作成先カテゴリ（省略可）")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false)
        ),

      new SlashCommandBuilder()
        .setName("createcategory")
        .setDescription("新しいカテゴリを作成します")
        .addStringOption((opt) =>
          opt.setName("name").setDescription("作成するカテゴリ名").setRequired(true)
        ),

      new SlashCommandBuilder()
        .setName("movechannel")
        .setDescription("チャンネルを別カテゴリへ移動します（誰でもOK / ロックカテゴリは不可）")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("移動するテキストチャンネル")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addChannelOption((opt) =>
          opt
            .setName("category")
            .setDescription("移動先カテゴリ（省略可：カテゴリ解除）")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false)
        ),

      // 管理者だけ見える/実行できるように（Discord側UIでも制限）
      new SlashCommandBuilder()
        .setName("categorylock")
        .setDescription("移動禁止カテゴリを管理（管理者のみ）")
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
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
      body: commands,
    });
    console.log("✅ Slash commands registered.");
  } catch (error) {
    console.error("Failed to register commands:", error);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

/* =========================
   ボタン行の作成（既存）
   ========================= */
function buildStepRows() {
  const labels = ["Step 1", "Step 2", "Step 3", "Step 4", "Step 5", "Step 6"];

  const buttons = STEP_ROLE_IDS.map((roleId, i) =>
    new ButtonBuilder().setCustomId(`step_toggle:${roleId}`).setLabel(labels[i]).setStyle(ButtonStyle.Primary)
  );

  const row1 = new ActionRowBuilder().addComponents(buttons.slice(0, 5));
  const row2 = new ActionRowBuilder().addComponents(buttons.slice(5, 6));

  const clearBtn = new ButtonBuilder().setCustomId("step_clear").setLabel("🧹 全解除").setStyle(ButtonStyle.Secondary);

  row2.addComponents(clearBtn);
  return [row1, row2];
}

/* =========================
   Interaction ハンドラ
   ========================= */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    /* ---- Slash Commands ---- */
    if (interaction.isChatInputCommand()) {
      if (!interaction.guild) {
        return interaction.reply({ content: "サーバー内で実行してね。", ephemeral: true });
      }

      const botMember = interaction.guild.members.me;
      const botCanManageChannels = botMember?.permissions?.has(PermissionsBitField.Flags.ManageChannels);

      // /poststeps（既存）
      if (interaction.commandName === "poststeps") {
        if (interaction.channelId !== CHANNEL_ID) {
          return interaction.reply({ content: "このコマンドは指定チャンネルで実行してください。", ephemeral: true });
        }

        await interaction.channel.send({
          content: "📌 **学習ロードマップ：Stepロール**\nボタンを押すと **付与/解除** できます（複数OK）。",
          components: buildStepRows(),
        });

        return interaction.reply({ content: "投稿しました！", ephemeral: true });
      }

      // /createchannel（回数制限 + ロックカテゴリ禁止）
      if (interaction.commandName === "createchannel") {
        if (!botCanManageChannels) {
          return interaction.reply({ content: "Botに **チャンネル管理(Manage Channels)** 権限が必要です。", ephemeral: true });
        }

        const name = interaction.options.getString("name", true).trim();
        const category = interaction.options.getChannel("category", false);

        if (name.length < 1 || name.length > 100) {
          return interaction.reply({ content: "チャンネル名は1〜100文字にしてね。", ephemeral: true });
        }

        const store = loadStore();

        if (category?.id && isLockedCategory(store, interaction.guildId, category.id)) {
          return interaction.reply({ content: "そのカテゴリは **移動禁止（ロック）** なので作成先にできません。", ephemeral: true });
        }

        const used = getUserCount(store, interaction.guildId, interaction.user.id);
        if (used >= MAX_CREATE_PER_USER) {
          return interaction.reply({
            content: `作成できるのは **最大${MAX_CREATE_PER_USER}回** までです。管理者にリセットしてもらってね。`,
            ephemeral: true,
          });
        }

        const created = await interaction.guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: category?.id ?? null,
          reason: `createchannel by ${interaction.user.tag} (${interaction.user.id})`,
        });

        setUserCount(store, interaction.guildId, interaction.user.id, used + 1);
        saveStore(store);

        return interaction.reply({
          content: `✅ 作成したよ：${created}（残り ${MAX_CREATE_PER_USER - (used + 1)} 回）`,
          ephemeral: true,
        });
      }

      // /createcategory（カテゴリ作成）
      if (interaction.commandName === "createcategory") {
        if (!botCanManageChannels) {
          return interaction.reply({ content: "Botに **チャンネル管理(Manage Channels)** 権限が必要です。", ephemeral: true });
        }

        const name = interaction.options.getString("name", true).trim();
        if (name.length < 1 || name.length > 100) {
          return interaction.reply({ content: "カテゴリ名は1〜100文字にしてね。", ephemeral: true });
        }

        const category = await interaction.guild.channels.create({
          name,
          type: ChannelType.GuildCategory,
          reason: `createcategory by ${interaction.user.tag} (${interaction.user.id})`,
        });

        return interaction.reply({ content: `✅ カテゴリを作成したよ：**${category.name}**`, ephemeral: true });
      }

      // /movechannel（誰でもOK。ただしロックカテゴリに関わる移動は不可）
      if (interaction.commandName === "movechannel") {
        if (!botCanManageChannels) {
          return interaction.reply({ content: "Botに **チャンネル管理(Manage Channels)** 権限が必要です。", ephemeral: true });
        }

        const channel = interaction.options.getChannel("channel", true);
        const destCategory = interaction.options.getChannel("category", false); // null可

        const store = loadStore();
        const srcCategoryId = channel.parentId; // 元カテゴリ（nullあり）
        const destCategoryId = destCategory?.id ?? null;

        // ロックカテゴリに「入れる」「出す」どちらも禁止
        if (srcCategoryId && isLockedCategory(store, interaction.guildId, srcCategoryId)) {
          return interaction.reply({ content: "このチャンネルは **ロックカテゴリ内** なので移動できません。", ephemeral: true });
        }
        if (destCategoryId && isLockedCategory(store, interaction.guildId, destCategoryId)) {
          return interaction.reply({ content: "移動先カテゴリが **ロック** されているので移動できません。", ephemeral: true });
        }

        await channel.setParent(destCategoryId);
        return interaction.reply({ content: `✅ ${channel} を移動したよ。`, ephemeral: true });
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

          const names = ids
            .map((id) => interaction.guild.channels.cache.get(id))
            .filter(Boolean)
            .map((c) => `- ${c.name} (${c.id})`)
            .join("\n");

          return interaction.reply({ content: `🔒 ロック中カテゴリ:\n${names}`, ephemeral: true });
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

    /* ---- Buttons（既存） ---- */
    if (!interaction.isButton()) return;

    const member = await interaction.guild.members.fetch(interaction.user.id);

    if (interaction.customId === "step_clear") {
      const owned = STEP_ROLE_IDS.filter((id) => member.roles.cache.has(id));
      if (owned.length === 0) {
        return interaction.reply({ content: "今、Stepロールは付いていません。", ephemeral: true });
      }
      await member.roles.remove(owned);
      return interaction.reply({ content: "🧹 Stepロールを全解除しました。", ephemeral: true });
    }

    const [type, roleId] = interaction.customId.split(":");
    if (type !== "step_toggle") return;

    const role = interaction.guild.roles.cache.get(roleId);
    if (!role) {
      return interaction.reply({
        content: "ロールが見つかりませんでした。環境変数のIDを確認してね。",
        ephemeral: true,
      });
    }

    const hasRole = member.roles.cache.has(roleId);
    if (hasRole) {
      await member.roles.remove(roleId);
      return interaction.reply({ content: `❌ ${role.name} を外しました`, ephemeral: true });
    } else {
      await member.roles.add(roleId);
      return interaction.reply({ content: `✅ ${role.name} を付けました`, ephemeral: true });
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      return interaction.reply({
        content: "エラー：Botの権限（Manage Channels / Manage Roles）やロール順（Botが上）を確認して！",
        ephemeral: true,
      });
    }
  }
});

client.login(DISCORD_TOKEN);
