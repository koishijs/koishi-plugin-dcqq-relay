import { Context, Session, segment, Schema } from "koishi";
import { DiscordBot } from "@koishijs/plugin-adapter-discord";
import { GuildMember, Role, snowflake } from "@satorijs/adapter-discord/lib/types";
import { get } from "qface";

interface RelayRelation {
  discordChannel?: string;
  discordGuild?: string;
  forwardChannel: string;
  forwardPlatform: string;
  // discordLogChannel?: string;
}

export interface Config {
  relations: RelayRelation[];
}
export interface RelayTable {
  id: number;
  dcId: string;
  forwardChannel: string;
  forwardId: string;
  deleted: number;
}

declare module "koishi" {
  interface Tables {
    dcqq_relay: RelayTable;
  }
}

export const Config: Schema<Config> = Schema.object({
  relations: Schema.array(
    Schema.object({
      forwardPlatform: Schema.string().required().description("转发的目标平台"),
      forwardChannel: Schema.string().required().description("转发的目标群"),
      discordChannel: Schema.string().required(),
      discordGuild: Schema.string().required(),
    })
  ),
});

export const inject = ["database"] as const;

export async function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('relay')
  ctx.model.extend("dcqq_relay",
    {
      id: "unsigned",
      dcId: "string",
      forwardChannel: "string",
      forwardId: "string",
      deleted: "integer"
    },
    {
      autoInc: true,
    }
  );

  const validCtx = ctx.intersect((session) =>
    [
      ...config.relations.map((v) => 'discord:' + v.discordChannel),
      ...config.relations.map((v) => v.forwardPlatform + ':' + v.forwardChannel),
    ].includes(session.cid)
  );
  let dcDeletedList: string[] = []; // check on edited, send
  ctx.setInterval(() => dcDeletedList = [], 1000 * 3600)

  // ctx.command('test').action(async ({session}) => {
  //   let r = await session.send("OK")
  //   await new Promise((r) => setTimeout(r, 100))
  //   await session.bot.deleteMessage(session.channelId, r[0])
  // })

  validCtx.platform("discord").on("message-deleted", async (session) => {
    let [data] = await ctx.database.get("dcqq_relay", {
      dcId: [session.messageId],
      deleted: [0],
    });
    if (!data) return
    data.deleted = 1;
    dcDeletedList.push(session.messageId)
    const relation = getRelation(session)
    const c = await ctx.database.getChannel(relation.forwardPlatform, relation.forwardChannel, ['assignee'])
    const forwardBot = ctx.bots[`${relation.forwardPlatform}:${c.assignee}`]
    try {
      await forwardBot.deleteMessage(data.forwardChannel, data.forwardId);
    } catch (e) { }
    await ctx.database.upsert("dcqq_relay", [data]);
  });
  validCtx.intersect(v => v.platform !== "discord").on("message-deleted", async (session) => {
    // console.log(session)
    let [data] = await ctx.database.get("dcqq_relay", {
      forwardChannel: session.channelId,
      forwardId: session.messageId,
      deleted: [0],
    });
    if (!data) return
    const relation = getRelation(session)
    let c = await ctx.database.getChannel('discord', relation.discordChannel, ['assignee'])
    const dcBot = ctx.bots[`discord:${c.assignee}`]
    try {
      await dcBot.deleteMessage(relation.discordChannel, data.dcId);
    } catch (e) {
      if (e.response?.data) {
        await session.send("删除 DC 消息失败: " + e.response.data.message);
      }
    } finally {
      await ctx.database.set("dcqq_relay", {
        id: data.id,
        deleted: 0
      }, {
        deleted: 1
      });
    }
  });
  const adaptDiscordMessage = async (session: Session) => {
    const getUserName = (member: Partial<GuildMember>) => {
      // @ts-expect-error
      return `${member.nick || member.user.global_name}(@${member.user.username})`
    }
    const dcBot = session.bot as unknown as DiscordBot
    const msg = await dcBot.internal.getChannelMessage(session.channelId, session.messageId);
    let roles: Role[] = [];
    let members: Record<snowflake, GuildMember> = {};

    let result: segment = <message></message>;
    if (session.quote) {
      let quote = await ctx.database.get("dcqq_relay", {
        dcId: [session.quote.id],
      });
      if (quote.length) {
        result.children.push(segment.quote(quote[0].forwardId));
      }
    }

    let username;
    // @ts-expect-error
    username = msg.author.global_name ? `${msg.author.global_name} (@${msg.author.username})` : `@${msg.author.username}`

    result.children.push(segment.text(`${username}: \n`));
    console.log(session.elements)
    let tmp = await segment.transformAsync(session.elements, {
      face: (attrs) => (
        <img src={`https://cdn.discordapp.com/emojis/${attrs.id}`} />
      ),
      file: (attrs) => `[文件: ${attrs.file}](${attrs.src})`,
      record: (attrs) => `[音频: ${attrs.file}](${attrs.src})`,
      video: (attrs) => `[视频: ${attrs.file}](${attrs.src})`,
      sticker: ({ id }) => segment.image(`https://cdn.discordapp.com/stickers/${id}.png`),
      async sharp(attrs) {
        let channel = await dcBot.internal.getChannel(attrs.id);
        return `[频道: ${channel.name}(${attrs.id})]`;
      },
      async at(attrs) {
        if (attrs.type === "here") {
          return `@${attrs.type}`;
        } else if (attrs.type === "all") {
          return "@everyone";
        }
        if (attrs.id) {
          let member =
            members[attrs.id] ||
            (await dcBot.internal.getGuildMember(session.guildId, attrs.id));
          members[attrs.id] = member;
          let username = getUserName(member)
          return `@${username} `;
        }
        if (attrs.role) {
          if (roles.length === 0) roles = await dcBot.internal.getGuildRoles(session.guildId);
          return `@[身份组]${roles.find((r) => r.id === attrs.role)?.name || "未知"
            } `;
        }
      }
    });
    result.children = result.children.concat(tmp);
    result.children = result.children.concat(
      msg.embeds.map((embed) => {
        let rtn = "";
        rtn += embed.title ? `${embed.title}\n` : "";
        rtn += embed.description ? `${embed.description}\n` : "";
        embed.fields?.forEach((field) => {
          rtn += `${field.name}: ${field.value}\n`;
        });
        return segment.text(rtn);
      })
    );

    return result;
  };

  const getRelation = (session: Session) => config.relations.find(
    (v) => v.discordChannel === session.channelId || v.forwardPlatform + ':' + v.forwardChannel === session.cid
  );

  validCtx.platform("discord").on("message-updated", async (session) => {
    const dcBot = session.bot;
    const dcMsg = await dcBot.internal.getChannelMessage(session.channelId, session.messageId)
    if (dcMsg.application_id === dcBot.selfId) return // avatar refreshed
    if (dcMsg.author.id === dcBot.selfId) return

    let [data] = await ctx.database.get("dcqq_relay", {
      dcId: [session.messageId],
      deleted: [0],
    });
    if (!data && !dcMsg.interaction) return;
    const { forwardChannel, forwardPlatform } = getRelation(session)
    let c = await ctx.database.getChannel(forwardPlatform, forwardChannel, ['assignee'])
    const forwardBot = ctx.bots[`${forwardPlatform}:${c.assignee}`]
    if (data) {
      await ctx.database.upsert("dcqq_relay", [data]);
      try {
        await forwardBot.deleteMessage(data.forwardChannel, data.forwardId);
      } catch (e) { }
    } else {
      // interaction waiting
    }

    const msg = await adaptDiscordMessage(session);
    if (dcMsg.interaction) {
      msg.children = [segment.text(`${dcMsg.interaction.user.username} /${dcMsg.interaction.name}\n`), ...msg.children]
    } else {
      msg.children.push(segment.text("(edited)"));
    }
    data.forwardChannel = forwardChannel;
    const [forwardId] = await forwardBot.sendMessage(forwardChannel, msg);
    data.forwardId = forwardId
    if (dcDeletedList.includes(session.messageId)) {
      try { await forwardBot.deleteMessage(forwardChannel, data.forwardId) } catch (e) { }
    }
    await ctx.database.upsert("dcqq_relay", [data]);
  });

  validCtx.platform("discord").on("message", async (session) => {
    const relation = getRelation(session);
    // const forwardBot = session.app.bots.find((v) => v.platform !== "discord");
    const dcBot = session.bot as unknown as DiscordBot;

    if (!session.elements.length) {
      // call command?
      let remote = await dcBot.internal.getChannelMessage(session.channelId, session.messageId)
      if (remote.interaction) {
        return;
      }
    }

    const msg = await adaptDiscordMessage(session);
    let sent = await ctx.broadcast([relation.forwardPlatform + ':' + relation.forwardChannel], msg)
    // let sent = await forwardBot.sendMessage(relation.forwardChannel, msg);
    for (const sentId of sent.filter((v) => v)) {
      await ctx.database.create("dcqq_relay", {
        forwardChannel: relation.forwardChannel,
        forwardId: sentId,
        dcId: session.messageId,
      });
    }
  });

  validCtx.intersect(v => v.platform !== "discord").on("message", async (session) => {
    const relation = getRelation(session);
    const forwardBot = session.bot;
    if (session.author.id === session.bot.selfId) return;
    let result: segment = <message />;
    result.children.push(
      <author
        name={`[QQ:${session.userId}] ${session.username}`}
        avatar={session.author.avatar}
      />
    );
    if (session.event.message.quote) {
      let [quote] = await ctx.database.get("dcqq_relay", {
        forwardId: [session.event.message.quote.id],
      });
      if (quote) {
        result.children.push(<quote id={quote.dcId} />);
      } else {
        logger.info("quote not found %o", session.event.message.quote);
      }
    }
    let tmp = await segment.transformAsync(session.elements, {
      async at(attrs) {
        if (attrs.id === forwardBot.selfId) return "";
        let name = "Unknown"
        try {
          let info = await forwardBot.getGuildMember(session.guildId, attrs.id);
          name = attrs.name ?? info.nick ?? info.user?.name ?? "Unknown"
        } catch (e) { }
        return `@[QQ: ${attrs.id}]${name} `;
      },
      async img(attrs) {
        return segment.image(attrs.src);
      },
      async video(attrs) {
        return segment.video(attrs.src, {
          file: 'video.mp4'
        });
      },
      audio: '[语音]',
      // face(attrs) {
      //   let alt = get(attrs.id);
      //   return alt ? `[${alt.QDes.slice(1)}]` : `[表情: ${attrs.id}]`;
      // },
      text(attrs) {
        attrs.content = attrs.content.replace(/^(\d+)\./, '$1\u200B.')
        let tmp = []
        let splited = attrs.content.matchAll(/\b((?:[a-z][\w-]+:(?:\/{1,3}|[a-z0-9%])|www\d{0,3}[.]|[a-z0-9.\-]+[.][a-z]{2,4}\/)(?:[^\s()<>]+|\(([^\s()<>]+|(\([^\s()<>]+\)))*\))+(?:\(([^\s()<>]+|(\([^\s()<>]+\)))*\)|[^\s`!()\[\]{};:'".,<>?«»“”‘’]))/g)
        let nowIndex = 0
        for (const item of splited) {
          tmp.push(attrs.content.slice(nowIndex, item.index))
          tmp.push(<a href={item[0]}>Link</a>)
          nowIndex = item.index + item[0].length
        }
        tmp.push(attrs.content.slice(nowIndex))
        return tmp
      }
    });
    result.children = [...result.children, ...tmp];
    const sent = await ctx.broadcast(['discord:' + relation.discordChannel], result)

    for (const sentId of sent) {
      await ctx.database.create("dcqq_relay", {
        forwardChannel: session.channelId,
        forwardId: session.messageId,
        dcId: sentId
      });
    }
  });

  ctx
    .command("relay", "查看同步插件帮助信息")
    .action(
      () => `仓库地址: https://github.com/koishijs/koishi-plugin-dcqq-relay`
    );
}
