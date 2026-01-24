require("dotenv").config();
const http = require('http'); // 1. httpモジュールを追加
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
} = require("discord.js");

// --- Render用の簡易Webサーバー設定 ---
// これがないと、Renderは「Webアプリが起動していない」と判断して数分で終了させてしまいます
http.createServer((req, res) => {
  res.write("Bot is running!");
  res.end();
}).listen(process.env.PORT || 8080); // Renderから指定されるポート、なければ8080
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

// /poststeps を登録
async function registerCommands() {
  try {
    const commands = [
      new SlashCommandBuilder()
        .setName("poststeps")
        .setDescription("Step1〜6のロール付与ボタンを投稿します")
        .toJSON(),
    ];

    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
      body: commands,
    });
    console.log("✅ Slash command registered.");
  } catch (error) {
    console.error("Failed to register commands:", error);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

// ボタン行の作成
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

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "poststeps") return;

      if (interaction.channelId !== CHANNEL_ID) {
        return interaction.reply({
          content: "このコマンドは指定チャンネルで実行してください。",
          ephemeral: true,
        });
      }

      await interaction.channel.send({
        content:
          "📌 **学習ロードマップ：Stepロール**\n" +
          "ボタンを押すと **付与/解除** できます（複数OK）。",
        components: buildStepRows(),
      });

      return interaction.reply({ content: "投稿しました！", ephemeral: true });
    }

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
        content: "エラー：Manage Roles権限とロール順（Botが上）を確認して！",
        ephemeral: true,
      });
    }
  }
});

client.login(DISCORD_TOKEN);