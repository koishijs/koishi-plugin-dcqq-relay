import { Context, Session, segment, Schema, Universal } from "koishi";
import { DiscordBot } from "@koishijs/plugin-adapter-discord";
import { GuildMember, Role, snowflake } from "@satorijs/adapter-discord/lib/types";
import { get } from "qface";

interface RelayRelation {
  discordChannel?: string;
  discordGuild?: string;
  onebotChannel: string;
  // discordLogChannel?: string;
}

export interface Config {
  relations: RelayRelation[];
}
export interface RelayTable {
  id: number;
  dcId: string;
  onebotId: string;
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
      onebotChannel: Schema.string().required().description("转发至的 QQ 群号"),
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
      onebotId: "string",
      deleted: "integer"
    },
    {
      autoInc: true,
    }
  );

  const validCtx = ctx.intersect((session) =>
    [
      ...config.relations.map((v) => v.discordChannel),
      ...config.relations.map((v) => v.onebotChannel),
    ].includes(session.channelId)
  );
  let dcDeletedList: string[] = []; // check on edited, send
  // @ts-ignore
  ctx.setInterval(() => dcDeletedList = [], 1000 * 3600)

  validCtx.platform("discord").on("message-deleted", async (session) => {
    let [data] = await ctx.database.get("dcqq_relay", {
      dcId: [session.messageId],
      deleted: [0],
    });
    if (data) {
      data.deleted = 1;
      dcDeletedList.push(session.messageId)
      await ctx.database.upsert("dcqq_relay", [data]);
      const onebot = session.app.bots.find((v) => v.platform === "onebot");
      try {
        await onebot.deleteMessage("", data.onebotId);
      } catch (e) { }
    }
  });
  validCtx.platform("onebot").on("message-deleted", async (session) => {
    let [data] = await ctx.database.get("dcqq_relay", {
      onebotId: [session.messageId.toString()],
      deleted: [0],
    });
    if (data) {
      const discordChannel = config.relations.find(v => v.onebotChannel === session.channelId);
      const dcBot = session.app.bots.find((v) => v.platform === "discord");
      try {
        await dcBot.deleteMessage(discordChannel.discordChannel, data.dcId);
      } catch (e) {
        if (e.response?.data) {
          await session.send("删除 DC 消息失败: " + e.response.data.message);
        }
      } finally {
        await ctx.database.set("dcqq_relay", {
          onebotId: session.messageId,
          deleted: 0
        }, {
          deleted: 1
        });
      }
    }
  });
  const adaptDiscordMessage = async (session: Session) => {
    const getUserName = (member: Partial<GuildMember>) => {
      if (member.user.discriminator === "0") {
        // @ts-ignore
        return `${member.nick || member.user.global_name}(@${member.user.username})`
      } else {
        if (member.nick && member.nick !== member.user.username) {
          username = `${member.nick}(${member.user.username}#${member.user.discriminator})`;
        } else {
          username = `${member.user.username}#${member.user.discriminator}`;
        }
      }
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
        result.children.push(segment.quote(quote[0].onebotId));
      }
    }

    let username;
    if (msg.author.discriminator === "0") {
      // if(session.discord.member.nick)
      // @ts-ignore
      username = msg.author.global_name ? `${msg.author.global_name} (@${msg.author.username})` : `@${msg.author.username}`
    } else {
      if (session.author.nick && session.author.nick !== session.author.name) {
        username = `${session.author.nick}(${session.author.name}#${session.author.discriminator})`;
      } else {
        username = `${session.author.name}#${session.author.discriminator}`;
      }
    }

    result.children.push(segment.text(`${username}: \n`));
    let tmp = await segment.transformAsync(session.elements, {
      face: (attrs) => (
        <img src={`https://cdn.discordapp.com/emojis/${attrs.id}`} />
      ),
      file: (attrs) => `[文件: ${attrs.file}](${attrs.url})`,
      record: (attrs) => `[音频: ${attrs.file}](${attrs.url})`,
      video: (attrs) => `[视频: ${attrs.file}](${attrs.url})`,
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
    result.children = result.children.concat(
      msg.sticker_items?.map((v) =>
        segment.image(`https://cdn.discordapp.com/stickers/${v.id}.png`)
      ) ?? []
    );

    return result;
  };

  validCtx.platform("discord").on("message-updated", async (session) => {
    const dcBot = session.bot as unknown as DiscordBot;
    const dcMsg = await dcBot.internal.getChannelMessage(session.channelId, session.messageId)
    if (dcMsg.application_id === dcBot.selfId) return
    if (dcMsg.author.id === dcBot.selfId) {
      return
    }
    const onebot = ctx.bots.find((v) => v.platform === "onebot");
    let [data] = await ctx.database.get("dcqq_relay", {
      dcId: [session.messageId],
      deleted: [0],
    });
    if (!data && !dcMsg.interaction) return;

    const onebotChannel = config.relations.find(
      (v) => v.discordChannel === session.channelId
    ).onebotChannel;
    if (data) {
      await ctx.database.upsert("dcqq_relay", [data]);
      try {
        await onebot.deleteMessage("", data.onebotId);
      } catch (e) { }
    } else {
      // @ts-ignore
      data = {
        dcId: session.messageId // interaction waiting
      }
    }

    const msg = await adaptDiscordMessage(session);
    if (dcMsg.interaction) {
      msg.children = [segment.text(`${dcMsg.interaction.user.username} /${dcMsg.interaction.name}\n`), ...msg.children]
    } else {
      msg.children.push(segment.text("(edited)"));
    }
    data.onebotId = (await onebot.sendMessage(onebotChannel, msg))[0];
    if (dcDeletedList.includes(session.messageId)) {
      try { await onebot.deleteMessage(onebotChannel, data.onebotId) } catch (e) { }
    }
    await ctx.database.upsert("dcqq_relay", [data]);
  });

  validCtx.platform("discord").on("message", async (session) => {
    const relation = config.relations.find(
      (v) => v.discordChannel === session.channelId
    );
    const onebot = session.app.bots.find((v) => v.platform === "onebot");
    const dcBot = session.bot as unknown as DiscordBot;

    if (!session.elements.length) {
      // call command?
      let remote = await dcBot.internal.getChannelMessage(session.channelId, session.messageId)
      if (remote.interaction) {
        return;
      }
    }

    const msg = await adaptDiscordMessage(session);
    let sent = await onebot.sendMessage(relation.onebotChannel, msg);
    for (const sentId of sent.filter((v) => v)) {
      await ctx.database.create("dcqq_relay", {
        onebotId: sentId,
        dcId: session.messageId,
      });
    }
  });

  validCtx.platform("onebot").on("message", async (session) => {
    const relation = config.relations.find(v => v.onebotChannel === session.channelId);
    const dcBot = ctx.bots.find(v => v.platform === "discord") as unknown as DiscordBot;
    const onebot = session.bot;
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
        onebotId: [session.event.message.quote.id],
      });
      if (quote) {
        result.children.push(<quote id={quote.dcId} />);
      } else {
        logger.info("quote not found %o", session.event.message.quote);
      }
    }
    let tmp = await segment.transformAsync(session.elements, {
      async at(attrs) {
        if (attrs.id === onebot.selfId) {
          return "";
        }
        let name = ""
        try {
          let info = await onebot.getGuildMember(session.guildId, attrs.id);
          name = info.user?.nick ?? info.user?.name
        } catch (e) { }
        return `@[QQ: ${attrs.id}]${name} `;
      },
      async img(attrs) {
        if (attrs.type === "flash") {
          return "";
        }
        return segment.image(attrs.url ?? attrs.file);
      },
      async video(attrs) {
        return segment.video(attrs.url, {
          file: 'video.mp4'
        });
      },
      audio: '[语音]',
      face(attrs) {
        let alt = get(attrs.id);
        return alt ? `[${alt.QDes.slice(1)}]` : `[表情: ${attrs.id}]`;
      },
      // async forward(attrs) {
      //   let data = await onebot.internal.getForwardMsg(attrs.id);
      //   let msgs: Universal.Message[] = [];
      //   for (const [i, v] of data.entries()) {
      //     const ses = dcBot.session();
      //     // @ts-ignore
      //     let { time, content, group_id, sender } = v;
      //     if (Array.isArray(content)) {
      //       content = "转发消息不处理";
      //     }
      //     let ob = await OneBot.adaptMessage(
      //       onebot,
      //       {
      //         time,
      //         message: content,
      //         message_type: "group",
      //         // @ts-ignore
      //         sender: {
      //           tiny_id: sender.user_id.toString(),
      //           user_id: sender.user_id,
      //           nickname: sender.nickname,
      //         },
      //         message_id: (group_id + time + sender.user_id + i) % 100000000,
      //       },
      //       ses
      //     );
      //     msgs.push(ob);
      //   }
      //   let tmp = (
      //     <message forward>
      //       {msgs.map(v => {
      //         let newElements = segment.transform(v.elements, {
      //           at: (attrs) => `@[QQ: ${attrs.id}]`,
      //           img(attrs) {
      //             if (attrs.type === "flash") {
      //               return "";
      //             }
      //             return segment.image(attrs.url);
      //           },
      //           video(attrs) {
      //             return segment.video(attrs.url);
      //           },
      //           face(attrs) {
      //             let alt = get(attrs.id);
      //             return alt ? `[${alt.QDes.slice(1)}]` : `[表情: ${attrs.id}]`;
      //           }
      //         })
      //         return (
      //           <message>
      //             <author
      //               name={`[QQ: ${v.user.id}] ${v.member.nick}`}
      //               avatar={v.member.avatar}
      //             ></author>
      //             {newElements}
      //           </message>
      //         );
      //       })}
      //     </message>
      //   );
      //   return tmp;
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
    let sent = await dcBot.sendMessage(
      relation.discordChannel,
      result,
      relation.discordGuild
    );

    for (const sentId of sent) {
      await ctx.database.create("dcqq_relay", {
        onebotId: session.messageId,
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
